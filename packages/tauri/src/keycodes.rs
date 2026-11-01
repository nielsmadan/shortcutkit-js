// Portions adapted from Chromium (BSD-3-Clause); see THIRD_PARTY_NOTICES.md

const MAC_CODES: [(&str, u16); 119] = [
    ("KeyA", 0x0000),
    ("KeyB", 0x000b),
    ("KeyC", 0x0008),
    ("KeyD", 0x0002),
    ("KeyE", 0x000e),
    ("KeyF", 0x0003),
    ("KeyG", 0x0005),
    ("KeyH", 0x0004),
    ("KeyI", 0x0022),
    ("KeyJ", 0x0026),
    ("KeyK", 0x0028),
    ("KeyL", 0x0025),
    ("KeyM", 0x002e),
    ("KeyN", 0x002d),
    ("KeyO", 0x001f),
    ("KeyP", 0x0023),
    ("KeyQ", 0x000c),
    ("KeyR", 0x000f),
    ("KeyS", 0x0001),
    ("KeyT", 0x0011),
    ("KeyU", 0x0020),
    ("KeyV", 0x0009),
    ("KeyW", 0x000d),
    ("KeyX", 0x0007),
    ("KeyY", 0x0010),
    ("KeyZ", 0x0006),
    ("Digit1", 0x0012),
    ("Digit2", 0x0013),
    ("Digit3", 0x0014),
    ("Digit4", 0x0015),
    ("Digit5", 0x0017),
    ("Digit6", 0x0016),
    ("Digit7", 0x001a),
    ("Digit8", 0x001c),
    ("Digit9", 0x0019),
    ("Digit0", 0x001d),
    ("Enter", 0x0024),
    ("Escape", 0x0035),
    ("Backspace", 0x0033),
    ("Tab", 0x0030),
    ("Space", 0x0031),
    ("Minus", 0x001b),
    ("Equal", 0x0018),
    ("BracketLeft", 0x0021),
    ("BracketRight", 0x001e),
    ("Backslash", 0x002a),
    ("Semicolon", 0x0029),
    ("Quote", 0x0027),
    ("Backquote", 0x0032),
    ("Comma", 0x002b),
    ("Period", 0x002f),
    ("Slash", 0x002c),
    ("CapsLock", 0x0039),
    ("F1", 0x007a),
    ("F2", 0x0078),
    ("F3", 0x0063),
    ("F4", 0x0076),
    ("F5", 0x0060),
    ("F6", 0x0061),
    ("F7", 0x0062),
    ("F8", 0x0064),
    ("F9", 0x0065),
    ("F10", 0x006d),
    ("F11", 0x0067),
    ("F12", 0x006f),
    ("Insert", 0x0072),
    ("Home", 0x0073),
    ("PageUp", 0x0074),
    ("Delete", 0x0075),
    ("End", 0x0077),
    ("PageDown", 0x0079),
    ("ArrowRight", 0x007c),
    ("ArrowLeft", 0x007b),
    ("ArrowDown", 0x007d),
    ("ArrowUp", 0x007e),
    ("NumLock", 0x0047),
    ("NumpadDivide", 0x004b),
    ("NumpadMultiply", 0x0043),
    ("NumpadSubtract", 0x004e),
    ("NumpadAdd", 0x0045),
    ("NumpadEnter", 0x004c),
    ("Numpad1", 0x0053),
    ("Numpad2", 0x0054),
    ("Numpad3", 0x0055),
    ("Numpad4", 0x0056),
    ("Numpad5", 0x0057),
    ("Numpad6", 0x0058),
    ("Numpad7", 0x0059),
    ("Numpad8", 0x005b),
    ("Numpad9", 0x005c),
    ("Numpad0", 0x0052),
    ("NumpadDecimal", 0x0041),
    ("IntlBackslash", 0x000a),
    ("ContextMenu", 0x006e),
    ("NumpadEqual", 0x0051),
    ("F13", 0x0069),
    ("F14", 0x006b),
    ("F15", 0x0071),
    ("F16", 0x006a),
    ("F17", 0x0040),
    ("F18", 0x004f),
    ("F19", 0x0050),
    ("F20", 0x005a),
    ("AudioVolumeMute", 0x004a),
    ("AudioVolumeUp", 0x0048),
    ("AudioVolumeDown", 0x0049),
    ("NumpadComma", 0x005f),
    ("IntlRo", 0x005e),
    ("IntlYen", 0x005d),
    ("Lang1", 0x0068),
    ("Lang2", 0x0066),
    ("ControlLeft", 0x003b),
    ("ShiftLeft", 0x0038),
    ("AltLeft", 0x003a),
    ("MetaLeft", 0x0037),
    ("ControlRight", 0x003e),
    ("ShiftRight", 0x003c),
    ("AltRight", 0x003d),
    ("MetaRight", 0x0036),
];

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn entries() -> impl Iterator<Item = (&'static str, u16)> {
    MAC_CODES.iter().copied()
}

#[cfg(test)]
pub(crate) fn mac_key_code(code: &str) -> Option<u16> {
    MAC_CODES
        .iter()
        .find_map(|&(name, mac)| (name == code).then_some(mac))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn dom_code(mac: u16) -> Option<&'static str> {
    MAC_CODES
        .iter()
        .find_map(|&(name, value)| (value == mac).then_some(name))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn every_code_round_trips() {
        for (code, _) in entries() {
            let mac = mac_key_code(code).unwrap();
            assert_eq!(dom_code(mac), Some(code));
        }
    }

    #[test]
    fn known_keys_have_their_mac_codes() {
        let expected = [
            ("KeyA", 0x00),
            ("IntlBackslash", 0x0a),
            ("IntlYen", 0x5d),
            ("IntlRo", 0x5e),
            ("NumpadComma", 0x5f),
            ("Lang1", 0x68),
            ("Lang2", 0x66),
        ];
        for (code, mac) in expected {
            assert_eq!(mac_key_code(code), Some(mac), "{code}");
        }
    }

    #[test]
    fn codes_and_mac_values_are_unique() {
        let codes = entries().map(|(code, _)| code);
        assert_eq!(codes.collect::<HashSet<_>>().len(), MAC_CODES.len());
        let macs = MAC_CODES.iter().map(|&(_, mac)| mac);
        assert_eq!(macs.collect::<HashSet<_>>().len(), MAC_CODES.len());
    }

    #[test]
    fn unmapped_values_have_no_code() {
        assert_eq!(mac_key_code("NoSuchKey"), None);
        assert_eq!(dom_code(0xffff), None);
    }
}
