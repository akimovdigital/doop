// Shared by both shells: ../src-tauri-chromium builds these same sources on
// Tauri 3's CEF runtime. tauri-runtime-cef declares `links`, so its presence
// shows up here as DEP_TAURI_RUNTIME_CEF_RUNTIME; the sources branch on the
// `chromium` cfg set from it, and read the capabilities kept in this crate.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(chromium)");
    let chromium = std::env::var_os("DEP_TAURI_RUNTIME_CEF_RUNTIME").is_some();
    if chromium {
        println!("cargo::rustc-cfg=chromium");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let source = if chromium {
            "../src-tauri/src/dictation.m"
        } else {
            "src/dictation.m"
        };
        build_macos_dictation(source);
    }
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "claude_status",
            "claude_connect",
            "claude_login",
            "claude_install",
            "claude_choose_cli",
            "claude_reset_cli",
            "claude_run",
            "claude_stop",
            "claude_add_extension",
            "codex_add_mcp",
            "fonts_choose_local",
            "fonts_read_local",
            "server_status",
            "server_choose",
            "view_menu_state",
            "app_menu_set",
            "app_menu_state",
            "update_card_ready",
            "update_restart",
            "open_canvas_window",
            "dictation_available",
            "dictation_start",
            "dictation_stop",
        ]));
    let attributes = if chromium {
        // tauri-build watches only its default capabilities path, so a
        // capability removed here would otherwise survive an incremental build
        println!("cargo:rerun-if-changed=../src-tauri/capabilities");
        attributes.capabilities_path_pattern("../src-tauri/capabilities/**/*")
    } else {
        attributes
    };
    tauri_build::try_build(attributes).expect("failed to build desktop permissions");
}

fn build_macos_dictation(source: &str) {
    use std::{env, path::Path, process::Command};

    let out = env::var_os("OUT_DIR").expect("OUT_DIR");
    let source = Path::new(source);
    let object = Path::new(&out).join("doop_dictation.o");
    let archive = Path::new(&out).join("libdoop_dictation.a");
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported macOS target for dictation"),
    };
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    let minimum = env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| "10.13".into());
    let compiled = Command::new("xcrun")
        .args(["--sdk", "macosx", "clang", "-arch", arch, "-fobjc-arc", "-fblocks", "-c"])
        .arg(format!("-mmacosx-version-min={minimum}"))
        .arg(source)
        .arg("-o")
        .arg(&object)
        .status()
        .expect("run clang for dictation");
    assert!(compiled.success(), "compile the macOS dictation bridge");
    let archived = Command::new("xcrun")
        .args(["--sdk", "macosx", "ar", "crs"])
        .arg(&archive)
        .arg(&object)
        .status()
        .expect("archive the macOS dictation bridge");
    assert!(archived.success(), "archive the macOS dictation bridge");
    println!("cargo:rustc-link-search=native={}", Path::new(&out).display());
    println!("cargo:rustc-link-lib=static=doop_dictation");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,Speech");
}
