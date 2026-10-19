fn main() {
    // The Common Controls v6 manifest is linked into every executable (app and
    // unit tests) instead of being added by tauri-build as a resource to the app
    // only: a test binary without it fails to load (TaskDialogIndirect missing).
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("app-manifest.xml");
    println!("cargo:rerun-if-changed=app-manifest.xml");
    // The exe's icon resource is made here from icons/icon.ico: a new icon
    // must rebuild it (otherwise the previous icon stays in the exe).
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri-build failed");
}
