use tauri::{AppHandle, Runtime};

use crate::{
    Result,
    global::{WireKey, WireModifiers},
};

const CARBON_CMD: i64 = 0x100;
const CARBON_SHIFT: i64 = 0x200;
const CARBON_OPTION: i64 = 0x800;
const CARBON_CONTROL: i64 = 0x1000;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn wire_key(
    enabled: Option<bool>,
    code: Option<i64>,
    modifiers: Option<i64>,
    dom_code: impl FnOnce(u16) -> Option<&'static str>,
) -> Option<WireKey> {
    if enabled != Some(true) {
        return None;
    }
    let modifiers = modifiers?;
    let modifiers = WireModifiers {
        ctrl: modifiers & CARBON_CONTROL != 0,
        alt: modifiers & CARBON_OPTION != 0,
        shift: modifiers & CARBON_SHIFT != 0,
        meta: modifiers & CARBON_CMD != 0,
    };
    if modifiers == WireModifiers::default() {
        return None;
    }
    let code = dom_code(u16::try_from(code?).ok()?)?;
    Some(WireKey {
        code: code.to_owned(),
        modifiers,
    })
}

#[cfg(target_os = "macos")]
fn current_system_shortcuts() -> Vec<WireKey> {
    // SAFETY: this runs on the main thread via run_on_main_thread and the callee releases its array.
    let raw = unsafe { crate::macos::symbolic_hotkeys() };
    raw.into_iter()
        .filter_map(|entry| {
            wire_key(
                entry.enabled,
                entry.code,
                entry.modifiers,
                crate::keycodes::dom_code,
            )
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn current_system_shortcuts() -> Vec<WireKey> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn read_on_main_thread<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<WireKey>> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(current_system_shortcuts());
    })?;
    Ok(receiver.recv().unwrap_or_default())
}

#[cfg(not(target_os = "macos"))]
#[allow(clippy::unnecessary_wraps)]
fn read_on_main_thread<R: Runtime>(_: &AppHandle<R>) -> Result<Vec<WireKey>> {
    Ok(current_system_shortcuts())
}

#[tauri::command]
pub(crate) async fn system_shortcuts<R: Runtime>(app: AppHandle<R>) -> Result<Vec<WireKey>> {
    crate::off_main_thread(app, |app| read_on_main_thread(app)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(mac: u16) -> Option<&'static str> {
        crate::keycodes::dom_code(mac)
    }

    fn mods(ctrl: bool, alt: bool, shift: bool, meta: bool) -> WireModifiers {
        WireModifiers {
            ctrl,
            alt,
            shift,
            meta,
        }
    }

    #[test]
    fn an_enabled_mapped_entry_with_modifiers_is_kept() {
        let key = wire_key(Some(true), Some(0x14), Some(0x300), lookup).unwrap();
        assert_eq!(key.code, "Digit3");
        assert_eq!(key.modifiers, mods(false, false, true, true));
    }

    #[test]
    fn each_carbon_flag_maps_to_its_modifier() {
        let of = |mask| {
            wire_key(Some(true), Some(0x14), Some(mask), lookup)
                .unwrap()
                .modifiers
        };
        assert_eq!(of(CARBON_CMD), mods(false, false, false, true));
        assert_eq!(of(CARBON_SHIFT), mods(false, false, true, false));
        assert_eq!(of(CARBON_OPTION), mods(false, true, false, false));
        assert_eq!(of(CARBON_CONTROL), mods(true, false, false, false));
    }

    #[test]
    fn disabled_unmapped_and_modifierless_entries_are_dropped() {
        assert_eq!(wire_key(Some(false), Some(0x14), Some(0x100), lookup), None);
        assert_eq!(wire_key(None, Some(0x14), Some(0x100), lookup), None);
        assert_eq!(
            wire_key(Some(true), Some(0x7fff), Some(0x100), lookup),
            None
        );
        assert_eq!(wire_key(Some(true), Some(0x14), Some(0), lookup), None);
        assert_eq!(wire_key(Some(true), Some(0x14), Some(0x400), lookup), None);
        assert_eq!(wire_key(Some(true), None, Some(0x100), lookup), None);
        assert_eq!(wire_key(Some(true), Some(0x14), None, lookup), None);
    }
}
