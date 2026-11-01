use std::collections::BTreeMap;

use tauri::{AppHandle, Runtime};

use crate::Result;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn printable(text: String) -> Option<String> {
    (!text.is_empty() && !text.chars().any(char::is_control)).then_some(text)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn layout_map(
    translated: impl IntoIterator<Item = (&'static str, String)>,
) -> BTreeMap<String, String> {
    translated
        .into_iter()
        .filter_map(|(code, text)| printable(text).map(|text| (code.to_owned(), text)))
        .collect()
}

#[cfg(target_os = "macos")]
fn current_layout<R: Runtime>(app: &AppHandle<R>) -> Result<Option<BTreeMap<String, String>>> {
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        // SAFETY: this closure runs on the main thread via run_on_main_thread.
        let translated = unsafe { crate::macos::translate_all(crate::keycodes::entries()) };
        let _ = sender.send(translated.map(layout_map));
    })?;
    Ok(receiver.recv().ok().flatten())
}

#[cfg(not(target_os = "macos"))]
#[allow(clippy::unnecessary_wraps)]
fn current_layout<R: Runtime>(_: &AppHandle<R>) -> Result<Option<BTreeMap<String, String>>> {
    Ok(None)
}

#[tauri::command]
pub(crate) async fn keyboard_layout<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<BTreeMap<String, String>>> {
    crate::off_main_thread(app, |app| current_layout(app)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_control_results_are_dropped() {
        let map = layout_map([
            ("KeyA", "a".to_owned()),
            ("ShiftLeft", String::new()),
            ("Enter", "\r".to_owned()),
            ("Backspace", "\u{8}".to_owned()),
            ("Digit1", "&".to_owned()),
            ("KeyE", "é".to_owned()),
        ]);
        let entries: Vec<_> = map.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(entries, [("Digit1", "&"), ("KeyA", "a"), ("KeyE", "é")]);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn there_is_no_native_layout_off_macos() {
        use tauri::test::{mock_builder, mock_context, noop_assets};
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        assert_eq!(current_layout(app.handle()).unwrap(), None);
    }
}
