use std::{
    path::PathBuf,
    sync::{Arc, Mutex, PoisonError},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Runtime, Webview, WindowEvent,
    plugin::{Builder as PluginBuilder, TauriPlugin},
    webview::PageLoadEvent,
};
use tauri_plugin_global_shortcut::GlobalShortcut;

mod error;
mod global;
mod global_os;
mod keycodes;
mod layout;
#[cfg(target_os = "macos")]
mod macos;
mod store;
mod system;

pub use error::{Error, Result};
use global::{Coordinator, WireGlobalBinding};
use global_os::{GlobalHotkeys, GlobalState, HotkeyOs, PluginOs, Routing};
use layout::keyboard_layout;
use store::{StateSnapshot, StateStore};
use system::system_shortcuts;

const STATE_EVENT: &str = "shortcutkit://state";
const GLOBAL_STATE_EVENT: &str = "shortcutkit://global-state";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    file: String,
    revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResponse {
    revision: u64,
}

async fn off_main_thread<R, T, F>(app: AppHandle<R>, body: F) -> Result<T>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&AppHandle<R>) -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || body(&app)).await?
}

#[tauri::command]
async fn load_state<R: Runtime>(app: AppHandle<R>, file: String) -> Result<StateSnapshot> {
    off_main_thread(app, move |app| app.state::<StateStore>().load(&file)).await
}

#[tauri::command]
async fn save_state<R: Runtime>(
    app: AppHandle<R>,
    file: String,
    state: Value,
) -> Result<SaveResponse> {
    off_main_thread(app, move |app| {
        let revision = app.state::<StateStore>().save(&file, &state, |revision| {
            let event = StateEvent {
                file: file.clone(),
                revision,
            };
            if let Err(error) = app.emit(STATE_EVENT, event) {
                log::warn!("shortcutkit: cannot announce {file} revision {revision}: {error}");
            }
        })?;
        Ok(SaveResponse { revision })
    })
    .await
}

#[derive(Default)]
struct Globals {
    hotkeys: Mutex<GlobalHotkeys>,
    routing: Arc<Mutex<Routing>>,
}

fn apply_if_changed(
    hotkeys: &mut GlobalHotkeys,
    op: impl FnOnce(&mut Coordinator) -> bool,
    os: &impl HotkeyOs,
) -> Option<(GlobalState, Routing)> {
    op(hotkeys.coordinator()).then(|| hotkeys.apply(os))
}

fn page_load_label<R: Runtime>(webview: &Webview<R>, event: PageLoadEvent) -> Option<String> {
    (event == PageLoadEvent::Started).then(|| webview.label().to_owned())
}

fn is_destroyed(event: &WindowEvent) -> bool {
    matches!(event, WindowEvent::Destroyed)
}

// Runs on the main thread only, so OS calls that hop to it run inline under the lock.
fn update_globals<R: Runtime>(
    app: &AppHandle<R>,
    op: impl FnOnce(&mut Coordinator) -> bool,
) -> Result<GlobalState> {
    let shortcuts = app
        .try_state::<GlobalShortcut<R>>()
        .ok_or(Error::GlobalShortcutMissing)?;
    let globals = app.state::<Globals>();
    let mut hotkeys = globals
        .hotkeys
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let os = PluginOs {
        shortcuts: shortcuts.inner(),
        routing: Arc::clone(&globals.routing),
    };
    let Some((state, routing)) = apply_if_changed(&mut hotkeys, op, &os) else {
        return Ok(hotkeys.state());
    };
    *globals
        .routing
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = routing;
    if let Err(error) = app.emit(GLOBAL_STATE_EVENT, &state) {
        log::warn!(
            "shortcutkit: cannot announce global hotkeys version {}: {error}",
            state.version
        );
    }
    Ok(state)
}

#[tauri::command]
fn sync_global_hotkeys<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    attachment: String,
    bindings: Vec<WireGlobalBinding>,
    paused: bool,
) -> Result<GlobalState> {
    let window = webview.window().label().to_owned();
    update_globals(&app, |coordinator| {
        coordinator.sync(&attachment, webview.label(), &window, bindings, paused);
        true
    })
}

#[tauri::command]
fn detach_global_hotkeys<R: Runtime>(app: AppHandle<R>, attachment: String) -> Result<GlobalState> {
    update_globals(&app, |coordinator| coordinator.detach(&attachment))
}

#[tauri::command]
fn global_hotkeys_state<R: Runtime>(app: AppHandle<R>) -> Result<GlobalState> {
    update_globals(&app, |_| false)
}

#[derive(Debug, Default)]
pub struct Builder {
    directory: Option<PathBuf>,
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn directory(mut self, dir: impl Into<PathBuf>) -> Self {
        self.directory = Some(dir.into());
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        PluginBuilder::new("shortcutkit")
            .invoke_handler(tauri::generate_handler![
                load_state,
                save_state,
                sync_global_hotkeys,
                detach_global_hotkeys,
                global_hotkeys_state,
                keyboard_layout,
                system_shortcuts,
            ])
            .setup(move |app, _api| {
                let dir = match self.directory {
                    Some(dir) => dir,
                    None => app.path().app_config_dir()?,
                };
                app.manage(StateStore::new(dir));
                app.manage(Globals::default());
                Ok(())
            })
            .on_page_load(|webview, payload| {
                if let Some(label) = page_load_label(webview, payload.event()) {
                    let _ = update_globals(webview.app_handle(), |c| c.page_loaded(&label));
                }
            })
            .on_event(|app, event| {
                if let RunEvent::WindowEvent { label, event, .. } = event
                    && is_destroyed(event)
                {
                    let _ = update_globals(app, |c| c.window_destroyed(label));
                }
            })
            .build()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}

#[cfg(test)]
mod tests {
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
    use tauri_plugin_global_shortcut::Shortcut;

    use super::*;
    use crate::global::tests::binding;

    struct NullOs;

    impl HotkeyOs for NullOs {
        fn is_registered(&self, _: Shortcut) -> bool {
            false
        }

        fn register(&self, _: Shortcut) -> std::result::Result<(), String> {
            Ok(())
        }

        fn unregister(&self, _: Shortcut) -> std::result::Result<(), String> {
            Ok(())
        }
    }

    fn synced() -> GlobalHotkeys {
        let mut hotkeys = GlobalHotkeys::default();
        hotkeys
            .coordinator()
            .sync("a", "a", "a", vec![binding("show", 0, "KeyK")], false);
        hotkeys.apply(&NullOs);
        hotkeys
    }

    #[test]
    fn nothing_is_applied_or_bumped_when_the_operation_changed_nothing() {
        let mut hotkeys = synced();
        let before = hotkeys.state();
        assert!(apply_if_changed(&mut hotkeys, |_| false, &NullOs).is_none());
        assert_eq!(hotkeys.state(), before);
    }

    #[test]
    fn a_change_is_applied_and_bumps_the_version() {
        let mut hotkeys = synced();
        let version = hotkeys.state().version;
        let (state, _) = apply_if_changed(&mut hotkeys, |c| c.detach("a"), &NullOs).unwrap();
        assert_eq!(state.version, version + 1);
        assert_eq!(state.owner, None);
    }

    #[test]
    fn detaching_an_unknown_attachment_applies_and_bumps_nothing() {
        let mut hotkeys = synced();
        let before = hotkeys.state();
        assert!(apply_if_changed(&mut hotkeys, |c| c.detach("never-synced"), &NullOs).is_none());
        assert_eq!(hotkeys.state(), before);
        assert_eq!(before.owner.as_deref(), Some("a"));
    }

    #[test]
    fn only_a_destroyed_window_event_hands_over() {
        assert!(is_destroyed(&WindowEvent::Destroyed));
        assert!(!is_destroyed(&WindowEvent::Focused(true)));
        assert!(!is_destroyed(&WindowEvent::Focused(false)));
    }

    #[test]
    fn only_a_started_page_load_names_a_label() {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let webview = webview.as_ref().to_owned();
        assert_eq!(
            page_load_label(&webview, PageLoadEvent::Started),
            Some("main".to_owned())
        );
        assert_eq!(page_load_label(&webview, PageLoadEvent::Finished), None);
    }

    #[test]
    fn updating_without_the_global_shortcut_plugin_is_an_error() {
        let app = mock_builder()
            .plugin(Builder::new().directory(std::env::temp_dir()).build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let handle: &AppHandle<MockRuntime> = app.handle();
        assert!(matches!(
            update_globals(handle, |_| true),
            Err(Error::GlobalShortcutMissing)
        ));
    }
}
