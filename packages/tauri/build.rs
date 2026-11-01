const COMMANDS: &[&str] = &[
    "load_state",
    "save_state",
    "sync_global_hotkeys",
    "detach_global_hotkeys",
    "global_hotkeys_state",
    "keyboard_layout",
    "system_shortcuts",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
