// Tauri entry — registers the fs plugin so the SolidJS side can read the
// bundled `texlive-wasm/` resource directory at runtime.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running texlive-wasm tauri example");
}
