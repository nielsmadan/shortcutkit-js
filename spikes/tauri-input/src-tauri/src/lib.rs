use std::{env, fs, path::PathBuf, thread, time::Duration};

use tauri::Manager;

const SMOKE_ENV: &str = "SHORTCUTKIT_SPIKE_SMOKE";

fn smoke() -> bool {
    env::var_os(SMOKE_ENV).is_some()
}

#[tauri::command]
fn spike_info() -> serde_json::Value {
    serde_json::json!({
        "os": env::consts::OS,
        "arch": env::consts::ARCH,
        "smoke": smoke(),
    })
}

#[tauri::command]
fn save_results(app: tauri::AppHandle, kind: String, json: String) -> Result<String, String> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../results");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{kind}.json", env::consts::OS));
    fs::write(&path, json).map_err(|e| e.to_string())?;
    println!("spike results written to {}", path.display());
    if smoke() {
        app.exit(0);
    }
    Ok(path.display().to_string())
}

#[tauri::command]
fn report(line: String) {
    println!("spike: {line}");
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(!smoke());
    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            if smoke() {
                // Accessory keeps the smoke run from taking focus or showing a Dock icon.
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                let handle = app.handle().clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(60));
                    eprintln!("spike: smoke run timed out");
                    handle.exit(1);
                });
            } else if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                window.set_focus()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![spike_info, save_results, report])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
