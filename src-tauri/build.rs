fn main() {
    // tauri-build ne surveille que tauri.conf.json : sans ça, des icônes régénérées
    // (`pnpm tauri icon …`) ne sont pas réintégrées à l'exécutable ni à l'icône de fenêtre.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
