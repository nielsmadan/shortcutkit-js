use std::{
    env, fs, io,
    path::{Path, PathBuf},
    str::FromStr,
    thread,
    time::Duration,
};

use muda::accelerator::Accelerator;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

const SMOKE_ENV: &str = "SHORTCUTKIT_EXAMPLE_SMOKE";
const SMOKE_TIMEOUT: Duration = Duration::from_secs(60);

fn smoke() -> bool {
    env::var(SMOKE_ENV).is_ok_and(|value| value == "1")
}

fn results_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../results")
}

fn reset_dir(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    fs::create_dir_all(dir)
}

fn results_file() -> PathBuf {
    results_dir().join(format!("{}-smoke.json", env::consts::OS))
}

fn clear_results_file() -> io::Result<()> {
    match fs::remove_file(results_file()) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn write_results(json: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(results_dir())?;
    let path = results_file();
    fs::write(&path, json)?;
    Ok(path)
}

#[tauri::command]
fn smoke_report(line: String) {
    println!("smoke: {line}");
}

#[tauri::command]
fn smoke_finish(app: AppHandle, json: String, passed: bool) -> Result<(), String> {
    let written = write_results(&json);
    match &written {
        Ok(path) => println!("smoke: results written to {}", path.display()),
        Err(error) => eprintln!("smoke: cannot write results: {error}"),
    }
    println!("smoke: {}", if passed { "passed" } else { "FAILED" });
    app.exit(if passed && written.is_ok() { 0 } else { 1 });
    written.map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn smoke_global_registered(app: AppHandle, shortcut: String) -> bool {
    app.global_shortcut().is_registered(shortcut.as_str())
}

#[tauri::command]
fn smoke_parse_accelerator(accelerator: String) -> Result<(), String> {
    Accelerator::from_str(&accelerator)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn shortcutkit_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    if !smoke() {
        return tauri_plugin_shortcutkit::init();
    }
    let store = results_dir().join("smoke-store");
    if let Err(error) = reset_dir(&store).and_then(|()| clear_results_file()) {
        eprintln!("smoke: cannot reset {}: {error}", results_dir().display());
        std::process::exit(1);
    }
    tauri_plugin_shortcutkit::Builder::new()
        .directory(store)
        .build()
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(!smoke());
    #[cfg(windows)]
    let builder = builder.plugin(
        tauri_plugin_prevent_default::Builder::new()
            .with_flags(tauri_plugin_prevent_default::Flags::empty())
            .platform(
                tauri_plugin_prevent_default::PlatformOptions::new()
                    .browser_accelerator_keys(false),
            )
            .build(),
    );
    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(shortcutkit_plugin())
        .setup(|app| {
            if smoke() {
                // Accessory keeps the smoke run from taking focus or showing a Dock icon.
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                let handle = app.handle().clone();
                thread::spawn(move || {
                    thread::sleep(SMOKE_TIMEOUT);
                    eprintln!("smoke: timed out after {} s", SMOKE_TIMEOUT.as_secs());
                    handle.exit(1);
                });
            } else if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                window.set_focus()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            smoke_report,
            smoke_finish,
            smoke_global_registered,
            smoke_parse_accelerator
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
