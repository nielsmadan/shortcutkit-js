use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    str::FromStr,
    sync::{Arc, Mutex, PoisonError},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcut, Modifiers, Shortcut, ShortcutState};

use crate::global::{BindingKey, Coordinator, DesiredHotkey, Owner, WireKey};

pub const GLOBAL_PRESSED_EVENT: &str = "shortcutkit://global-pressed";
const REGISTERED_ELSEWHERE: &str = "registered elsewhere in the app";
const NEEDS_MODIFIER: &str = "global hotkeys need a modifier";

pub trait HotkeyOs {
    fn is_registered(&self, shortcut: Shortcut) -> bool;
    fn register(&self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RegistrationResult {
    Registered,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub id: BindingKey,
    pub key: WireKey,
    pub result: RegistrationResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalState {
    pub version: u64,
    pub owner: Option<String>,
    pub paused: bool,
    pub registrations: Vec<Registration>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PressedEvent {
    pub attachment: String,
    pub id: BindingKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Press {
    pub webview: String,
    pub events: Vec<PressedEvent>,
}

#[derive(Debug, Default)]
pub struct Routing {
    owner: Option<Owner>,
    paused: bool,
    targets: HashMap<u32, Vec<BindingKey>>,
}

impl Routing {
    pub fn route(&self, shortcut_id: u32) -> Option<Press> {
        if self.paused {
            return None;
        }
        let owner = self.owner.as_ref()?;
        let ids = self.targets.get(&shortcut_id)?;
        Some(Press {
            webview: owner.webview.clone(),
            events: ids
                .iter()
                .map(|id| PressedEvent {
                    attachment: owner.attachment.clone(),
                    id: id.clone(),
                })
                .collect(),
        })
    }
}

pub fn to_shortcut(key: &WireKey) -> Result<Shortcut, String> {
    let code = Code::from_str(&key.code).map_err(|_| format!("unknown key code {:?}", key.code))?;
    let m = key.modifiers;
    let mods = [
        (m.meta, Modifiers::SUPER),
        (m.ctrl, Modifiers::CONTROL),
        (m.alt, Modifiers::ALT),
        (m.shift, Modifiers::SHIFT),
    ]
    .into_iter()
    .filter(|(on, _)| *on)
    .fold(Modifiers::empty(), |all, (_, flag)| all | flag);
    if mods.is_empty() && !is_function_key(&key.code) {
        return Err(NEEDS_MODIFIER.to_owned());
    }
    Ok(Shortcut::new(Some(mods), code))
}

fn is_function_key(code: &str) -> bool {
    code.strip_prefix('F')
        .filter(|n| n.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=24).contains(&n))
}

#[derive(Debug, Default)]
pub struct GlobalHotkeys {
    coordinator: Coordinator,
    applied: BTreeMap<u32, Shortcut>,
    registrations: Vec<Registration>,
    version: u64,
}

impl GlobalHotkeys {
    pub fn coordinator(&mut self) -> &mut Coordinator {
        &mut self.coordinator
    }

    pub fn state(&self) -> GlobalState {
        GlobalState {
            version: self.version,
            owner: self.coordinator.owner().map(|o| o.attachment),
            paused: self.coordinator.paused(),
            registrations: self.registrations.clone(),
        }
    }

    pub fn apply(&mut self, os: &impl HotkeyOs) -> (GlobalState, Routing) {
        let wanted: Vec<(DesiredHotkey, Result<Shortcut, String>)> = self
            .coordinator
            .desired()
            .into_iter()
            .map(|desired| {
                let shortcut = to_shortcut(&desired.key);
                (desired, shortcut)
            })
            .collect();
        let wanted_ids: BTreeSet<u32> = wanted
            .iter()
            .filter_map(|(_, shortcut)| shortcut.as_ref().ok().map(Shortcut::id))
            .collect();
        let stale: Vec<Shortcut> = self
            .applied
            .values()
            .filter(|shortcut| !wanted_ids.contains(&shortcut.id()))
            .copied()
            .collect();
        for shortcut in stale {
            match os.unregister(shortcut) {
                Ok(()) => {
                    self.applied.remove(&shortcut.id());
                }
                Err(error) => log::warn!("shortcutkit: cannot unregister {shortcut}: {error}"),
            }
        }
        let outcomes: Vec<(DesiredHotkey, Result<Shortcut, String>)> = wanted
            .into_iter()
            .map(|(desired, shortcut)| {
                let outcome = shortcut.and_then(|shortcut| self.ensure(os, shortcut));
                (desired, outcome)
            })
            .collect();
        if !self.coordinator.paused() {
            self.registrations = registrations(&self.coordinator, &outcomes);
        }
        let routing = Routing {
            owner: self.coordinator.owner(),
            paused: self.coordinator.paused(),
            targets: outcomes
                .iter()
                .filter_map(|(desired, outcome)| {
                    outcome
                        .as_ref()
                        .ok()
                        .map(|shortcut| (shortcut.id(), desired.ids.clone()))
                })
                .collect(),
        };
        self.version += 1;
        (self.state(), routing)
    }

    fn ensure(&mut self, os: &impl HotkeyOs, shortcut: Shortcut) -> Result<Shortcut, String> {
        if self.applied.contains_key(&shortcut.id()) {
            return Ok(shortcut);
        }
        if os.is_registered(shortcut) {
            return Err(REGISTERED_ELSEWHERE.to_owned());
        }
        os.register(shortcut)?;
        self.applied.insert(shortcut.id(), shortcut);
        Ok(shortcut)
    }
}

fn registrations(
    coordinator: &Coordinator,
    outcomes: &[(DesiredHotkey, Result<Shortcut, String>)],
) -> Vec<Registration> {
    coordinator
        .owner_bindings()
        .iter()
        .filter_map(|binding| {
            let (_, outcome) = outcomes.iter().find(|(d, _)| d.key == binding.key)?;
            Some(match outcome {
                Ok(_) => Registration {
                    id: binding.id.clone(),
                    key: binding.key.clone(),
                    result: RegistrationResult::Registered,
                    error: None,
                },
                Err(error) => Registration {
                    id: binding.id.clone(),
                    key: binding.key.clone(),
                    result: RegistrationResult::Failed,
                    error: Some(error.clone()),
                },
            })
        })
        .collect()
}

pub struct PluginOs<'a, R: Runtime> {
    pub shortcuts: &'a GlobalShortcut<R>,
    pub routing: Arc<Mutex<Routing>>,
}

impl<R: Runtime> HotkeyOs for PluginOs<'_, R> {
    fn is_registered(&self, shortcut: Shortcut) -> bool {
        self.shortcuts.is_registered(shortcut)
    }

    fn register(&self, shortcut: Shortcut) -> Result<(), String> {
        let routing = Arc::clone(&self.routing);
        self.shortcuts
            .on_shortcut(shortcut, move |app, _shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                let press = routing
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .route(event.id);
                if let Some(press) = press {
                    emit_press(app, press);
                }
            })
            .map_err(|error| error.to_string())
    }

    fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
        self.shortcuts
            .unregister(shortcut)
            .map_err(|error| error.to_string())
    }
}

fn emit_press<R: Runtime>(app: &AppHandle<R>, press: Press) {
    let target = EventTarget::webview(press.webview.as_str());
    for event in press.events {
        if let Err(error) = app.emit_to(target.clone(), GLOBAL_PRESSED_EVENT, event) {
            log::warn!("shortcutkit: cannot deliver a global hotkey press: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::global::{
        WireGlobalBinding, WireModifiers,
        tests::{binding, id, key},
    };

    #[derive(Default)]
    struct FakeOs {
        registered: RefCell<BTreeSet<u32>>,
        elsewhere: BTreeSet<u32>,
        refuse: RefCell<BTreeSet<u32>>,
        refuse_unregister: RefCell<BTreeSet<u32>>,
        log: RefCell<Vec<String>>,
    }

    impl FakeOs {
        fn with_elsewhere(code: &str) -> Self {
            Self {
                elsewhere: [shortcut_id(code)].into(),
                ..Self::default()
            }
        }

        fn refuse_once(&self, code: &str) {
            self.refuse.borrow_mut().insert(shortcut_id(code));
        }

        fn refuse_unregister_once(&self, code: &str) {
            self.refuse_unregister
                .borrow_mut()
                .insert(shortcut_id(code));
        }

        fn take_log(&self) -> Vec<String> {
            self.log.take()
        }

        fn holds(&self, code: &str) -> bool {
            self.registered.borrow().contains(&shortcut_id(code))
        }
    }

    impl HotkeyOs for FakeOs {
        fn is_registered(&self, shortcut: Shortcut) -> bool {
            self.elsewhere.contains(&shortcut.id())
                || self.registered.borrow().contains(&shortcut.id())
        }

        fn register(&self, shortcut: Shortcut) -> Result<(), String> {
            self.log.borrow_mut().push(format!("+{}", shortcut.key));
            if self.refuse.borrow_mut().remove(&shortcut.id()) {
                return Err("refused by the OS".to_owned());
            }
            self.registered.borrow_mut().insert(shortcut.id());
            Ok(())
        }

        fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
            self.log.borrow_mut().push(format!("-{}", shortcut.key));
            if self.refuse_unregister.borrow_mut().remove(&shortcut.id()) {
                return Err("unregister refused by the OS".to_owned());
            }
            self.registered.borrow_mut().remove(&shortcut.id());
            Ok(())
        }
    }

    fn shortcut_id(code: &str) -> u32 {
        to_shortcut(&key(code, true)).unwrap().id()
    }

    fn registered(action: &str, index: u32, code: &str) -> Registration {
        Registration {
            id: id(action, index),
            key: key(code, true),
            result: RegistrationResult::Registered,
            error: None,
        }
    }

    fn failed(action: &str, index: u32, code: &str, error: &str) -> Registration {
        Registration {
            id: id(action, index),
            key: key(code, true),
            result: RegistrationResult::Failed,
            error: Some(error.to_owned()),
        }
    }

    fn pressed(attachment: &str, action: &str, index: u32) -> PressedEvent {
        PressedEvent {
            attachment: attachment.to_owned(),
            id: id(action, index),
        }
    }

    struct Harness {
        os: FakeOs,
        hotkeys: GlobalHotkeys,
        routing: Routing,
        state: GlobalState,
    }

    impl Harness {
        fn new(os: FakeOs) -> Self {
            Self {
                os,
                hotkeys: GlobalHotkeys::default(),
                routing: Routing::default(),
                state: GlobalHotkeys::default().state(),
            }
        }

        fn run(&mut self, op: impl FnOnce(&mut Coordinator)) -> Vec<String> {
            op(self.hotkeys.coordinator());
            let (state, routing) = self.hotkeys.apply(&self.os);
            assert!(state.version > self.state.version);
            self.state = state;
            self.routing = routing;
            self.os.take_log()
        }

        fn sync(&mut self, attachment: &str, bindings: Vec<WireGlobalBinding>) -> Vec<String> {
            self.sync_paused(attachment, bindings, false)
        }

        fn sync_paused(
            &mut self,
            attachment: &str,
            bindings: Vec<WireGlobalBinding>,
            paused: bool,
        ) -> Vec<String> {
            self.run(|c| c.sync(attachment, attachment, attachment, bindings, paused))
        }

        fn press(&self, code: &str) -> Option<Press> {
            self.routing.route(shortcut_id(code))
        }
    }

    fn show_k() -> Vec<WireGlobalBinding> {
        vec![binding("show", 0, "KeyK")]
    }

    #[test]
    fn maps_modifiers_and_codes() {
        let shortcut = to_shortcut(&WireKey {
            code: "F18".to_owned(),
            modifiers: WireModifiers {
                ctrl: true,
                alt: true,
                shift: true,
                meta: true,
            },
        })
        .unwrap();
        assert_eq!(shortcut.key, Code::F18);
        assert_eq!(
            shortcut.mods,
            Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT
        );
        assert_eq!(
            to_shortcut(&key("NotAKey", true)),
            Err("unknown key code \"NotAKey\"".to_owned())
        );
    }

    fn bare(action: &str, code: &str) -> WireGlobalBinding {
        WireGlobalBinding {
            id: id(action, 0),
            key: key(code, false),
        }
    }

    #[test]
    fn a_global_hotkey_without_a_modifier_needs_a_function_key() {
        assert_eq!(
            to_shortcut(&key("KeyK", false)),
            Err("global hotkeys need a modifier".to_owned())
        );
        assert_eq!(
            to_shortcut(&key("MediaPlayPause", false)),
            Err("global hotkeys need a modifier".to_owned())
        );
        assert_eq!(
            to_shortcut(&key("F25", false)),
            Err("global hotkeys need a modifier".to_owned())
        );
        for (code, expected) in [("F1", Code::F1), ("F13", Code::F13), ("F24", Code::F24)] {
            let shortcut = to_shortcut(&key(code, false)).unwrap();
            assert_eq!(
                (shortcut.key, shortcut.mods),
                (expected, Modifiers::empty())
            );
        }
        let shift_k = WireKey {
            code: "KeyK".to_owned(),
            modifiers: WireModifiers {
                shift: true,
                ..WireModifiers::default()
            },
        };
        assert_eq!(to_shortcut(&shift_k).unwrap().mods, Modifiers::SHIFT);
    }

    #[test]
    fn a_bare_key_is_reported_failed_and_a_bare_function_key_is_registered() {
        let mut h = Harness::new(FakeOs::default());
        assert_eq!(
            h.sync("a", vec![bare("show", "KeyK"), bare("hide", "F13")]),
            vec!["+F13"]
        );
        assert_eq!(
            h.state.registrations,
            vec![
                Registration {
                    id: id("show", 0),
                    key: key("KeyK", false),
                    result: RegistrationResult::Failed,
                    error: Some("global hotkeys need a modifier".to_owned()),
                },
                Registration {
                    id: id("hide", 0),
                    key: key("F13", false),
                    result: RegistrationResult::Registered,
                    error: None,
                },
            ]
        );
    }

    #[test]
    fn a_failed_unregister_keeps_the_shortcut_and_is_retried_on_the_next_operation() {
        let mut h = Harness::new(FakeOs::default());
        h.sync(
            "a",
            vec![binding("show", 0, "KeyK"), binding("hide", 0, "KeyH")],
        );
        h.os.refuse_unregister_once("KeyH");
        assert_eq!(
            h.sync(
                "a",
                vec![binding("show", 0, "KeyK"), binding("hide", 0, "KeyJ")]
            ),
            vec!["-KeyH", "+KeyJ"]
        );
        assert!(h.os.holds("KeyH"));
        assert_eq!(h.press("KeyH"), None);
        assert_eq!(
            h.state.registrations,
            vec![registered("show", 0, "KeyK"), registered("hide", 0, "KeyJ")]
        );
        assert_eq!(h.sync("b", vec![]), vec!["-KeyH"]);
        assert!(!h.os.holds("KeyH"));
    }

    #[test]
    fn a_second_binding_that_fails_to_register_leaves_the_first_registered() {
        let mut h = Harness::new(FakeOs::default());
        h.os.refuse_once("KeyH");
        assert_eq!(
            h.sync(
                "a",
                vec![binding("show", 0, "KeyK"), binding("hide", 0, "KeyH")]
            ),
            vec!["+KeyK", "+KeyH"]
        );
        assert_eq!(
            h.state.registrations,
            vec![
                registered("show", 0, "KeyK"),
                failed("hide", 0, "KeyH", "refused by the OS")
            ]
        );
        assert!(h.press("KeyK").is_some());
        assert_eq!(h.press("KeyH"), None);
    }

    #[test]
    fn the_first_attach_owns_and_registers() {
        let mut h = Harness::new(FakeOs::default());
        assert_eq!(h.sync("a", show_k()), vec!["+KeyK"]);
        assert_eq!(h.state.owner.as_deref(), Some("a"));
        assert_eq!(h.state.registrations, vec![registered("show", 0, "KeyK")]);
        assert!(h.os.holds("KeyK"));
        assert_eq!(
            h.press("KeyK"),
            Some(Press {
                webview: "a".to_owned(),
                events: vec![pressed("a", "show", 0)],
            })
        );
    }

    #[test]
    fn a_second_attach_registers_nothing_and_presses_go_to_the_owner() {
        let mut h = Harness::new(FakeOs::default());
        h.sync("a", show_k());
        assert_eq!(
            h.sync("b", vec![binding("show", 0, "KeyJ")]),
            Vec::<String>::new()
        );
        assert_eq!(h.state.owner.as_deref(), Some("a"));
        assert_eq!(h.press("KeyK").map(|p| p.webview), Some("a".to_owned()));
        assert_eq!(h.press("KeyJ"), None);
    }

    #[test]
    fn owner_detach_page_load_and_destroy_hand_over() {
        let mut h = Harness::new(FakeOs::default());
        h.sync("a", show_k());
        h.sync("b", vec![binding("show", 0, "KeyB")]);
        h.sync("c", vec![binding("show", 0, "KeyC")]);
        h.sync("d", vec![binding("show", 0, "KeyD")]);

        assert_eq!(h.run(|c| assert!(c.detach("a"))), vec!["-KeyK", "+KeyB"]);
        assert_eq!(h.state.owner.as_deref(), Some("b"));
        assert_eq!(h.press("KeyB").map(|p| p.webview), Some("b".to_owned()));

        assert_eq!(
            h.run(|c| assert!(c.page_loaded("b"))),
            vec!["-KeyB", "+KeyC"]
        );
        assert_eq!(h.state.owner.as_deref(), Some("c"));

        assert_eq!(
            h.run(|c| assert!(c.window_destroyed("c"))),
            vec!["-KeyC", "+KeyD"]
        );
        assert_eq!(h.state.owner.as_deref(), Some("d"));
        assert_eq!(
            h.press("KeyD"),
            Some(Press {
                webview: "d".to_owned(),
                events: vec![pressed("d", "show", 0)],
            })
        );
    }

    #[test]
    fn a_pause_from_any_attachment_unregisters_and_unpausing_re_registers() {
        let mut h = Harness::new(FakeOs::default());
        h.sync("a", show_k());
        assert_eq!(h.sync_paused("b", vec![], true), vec!["-KeyK"]);
        assert!(h.state.paused);
        assert!(!h.os.holds("KeyK"));
        assert_eq!(h.press("KeyK"), None);
        assert_eq!(h.state.registrations, vec![registered("show", 0, "KeyK")]);
        assert_eq!(h.sync_paused("b", vec![], false), vec!["+KeyK"]);
        assert!(!h.state.paused);
        assert!(h.os.holds("KeyK"));
    }

    #[test]
    fn detach_page_load_and_destroy_of_the_pausing_attachment_unpause() {
        let ops: [fn(&mut Coordinator); 3] = [
            |c| assert!(c.detach("b")),
            |c| assert!(c.page_loaded("b")),
            |c| assert!(c.window_destroyed("b")),
        ];
        for op in ops {
            let mut h = Harness::new(FakeOs::default());
            h.sync("a", show_k());
            h.sync_paused("b", vec![], true);
            assert_eq!(h.run(op), vec!["+KeyK"]);
            assert!(!h.state.paused);
            assert!(h.press("KeyK").is_some());
        }
    }

    #[test]
    fn a_changed_binding_is_swapped_and_unchanged_ones_are_untouched() {
        let mut h = Harness::new(FakeOs::default());
        h.sync(
            "a",
            vec![binding("show", 0, "KeyK"), binding("hide", 0, "KeyH")],
        );
        assert_eq!(
            h.sync(
                "a",
                vec![binding("show", 0, "KeyK"), binding("hide", 0, "KeyJ")]
            ),
            vec!["-KeyH", "+KeyJ"]
        );
        assert_eq!(
            h.state.registrations,
            vec![registered("show", 0, "KeyK"), registered("hide", 0, "KeyJ")]
        );
        assert_eq!(
            h.press("KeyJ").map(|p| p.events),
            Some(vec![pressed("a", "hide", 0)])
        );
    }

    #[test]
    fn duplicate_keys_register_once_and_press_every_binding() {
        let mut h = Harness::new(FakeOs::default());
        assert_eq!(
            h.sync(
                "a",
                vec![binding("show", 0, "KeyK"), binding("hide", 1, "KeyK")]
            ),
            vec!["+KeyK"]
        );
        assert_eq!(
            h.state.registrations,
            vec![registered("show", 0, "KeyK"), registered("hide", 1, "KeyK")]
        );
        assert_eq!(
            h.press("KeyK").map(|p| p.events),
            Some(vec![pressed("a", "show", 0), pressed("a", "hide", 1)])
        );
    }

    #[test]
    fn a_failed_register_is_retried_on_the_next_operation() {
        let mut h = Harness::new(FakeOs::default());
        h.os.refuse_once("KeyK");
        assert_eq!(h.sync("a", show_k()), vec!["+KeyK"]);
        assert_eq!(
            h.state.registrations,
            vec![failed("show", 0, "KeyK", "refused by the OS")]
        );
        assert_eq!(h.press("KeyK"), None);
        assert_eq!(h.sync("b", vec![]), vec!["+KeyK"]);
        assert_eq!(h.state.registrations, vec![registered("show", 0, "KeyK")]);
        assert!(h.press("KeyK").is_some());
    }

    #[test]
    fn an_unknown_code_is_reported_failed() {
        let mut h = Harness::new(FakeOs::default());
        assert_eq!(
            h.sync("a", vec![binding("show", 0, "NotAKey")]),
            Vec::<String>::new()
        );
        assert_eq!(
            h.state.registrations,
            vec![failed("show", 0, "NotAKey", "unknown key code \"NotAKey\"")]
        );
    }

    #[test]
    fn a_shortcut_registered_elsewhere_is_failed_and_never_unregistered() {
        let mut h = Harness::new(FakeOs::with_elsewhere("KeyK"));
        assert_eq!(h.sync("a", show_k()), Vec::<String>::new());
        assert_eq!(
            h.state.registrations,
            vec![failed("show", 0, "KeyK", "registered elsewhere in the app")]
        );
        assert_eq!(h.press("KeyK"), None);
        assert_eq!(h.sync("a", vec![]), Vec::<String>::new());
        assert_eq!(h.run(|c| assert!(c.detach("a"))), Vec::<String>::new());
    }

    #[test]
    fn presses_are_dropped_while_paused() {
        let mut h = Harness::new(FakeOs::default());
        h.sync("a", show_k());
        assert!(h.press("KeyK").is_some());
        let paused = Routing {
            paused: true,
            ..std::mem::take(&mut h.routing)
        };
        assert_eq!(paused.route(shortcut_id("KeyK")), None);
    }

    #[test]
    fn version_increases_on_every_change() {
        let mut h = Harness::new(FakeOs::default());
        h.sync("a", show_k());
        assert_eq!(h.state.version, 1);
        h.sync("a", show_k());
        assert_eq!(h.state.version, 2);
        h.run(|c| assert!(c.detach("a")));
        assert_eq!(h.state.version, 3);
        assert_eq!(h.hotkeys.state(), h.state);
    }

    #[test]
    fn global_state_serializes_to_the_wire_format() {
        let mut h = Harness::new(FakeOs::default());
        h.os.refuse_once("KeyK");
        h.sync("a", show_k());
        assert_eq!(
            serde_json::to_value(&h.state).unwrap(),
            serde_json::json!({
                "version": 1,
                "owner": "a",
                "paused": false,
                "registrations": [{
                    "id": { "contextId": "app", "actionId": "show", "bindingIndex": 0 },
                    "key": {
                        "code": "KeyK",
                        "modifiers": { "ctrl": false, "alt": false, "shift": false, "meta": true },
                    },
                    "result": "failed",
                    "error": "refused by the OS",
                }],
            })
        );
    }
}
