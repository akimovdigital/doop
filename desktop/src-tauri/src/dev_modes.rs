//! Two separate editor windows in the local macOS build.

use tauri::menu::{CheckMenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::ShellRuntime;

const DEV_ID: &str = "digital.akimov.doop-test";
pub const WINDOW_MENU_ID: &str = "shell-window";
const SHOW_LOCAL: &str = "dev-show-local";
const SHOW_CLOUD: &str = "dev-show-cloud";
pub const CLOUD_WINDOW: &str = "dev-cloud";
const LOCAL_TITLE: &str = "Local Dev";
const CLOUD_TITLE: &str = "Doop Cloud";
const CLOUD_ENTRY: &str = "https://doop.design/auth";

pub fn enabled(app: &AppHandle) -> bool {
    app.config().identifier == DEV_ID
}

pub fn append_modes(app: &AppHandle, menu: &Submenu<ShellRuntime>) -> tauri::Result<()> {
    if enabled(app) {
        let cloud_focused = crate::focused_shell_window(app)
            .is_some_and(|window| window.label() == CLOUD_WINDOW);
        menu.append_items(&[
            &CheckMenuItem::with_id(app, SHOW_LOCAL, LOCAL_TITLE, true, !cloud_focused, None::<&str>)?,
            &CheckMenuItem::with_id(app, SHOW_CLOUD, CLOUD_TITLE, true, cloud_focused, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
        ])?;
    }
    Ok(())
}

pub fn sync_checkmarks(app: &AppHandle, label: &str) {
    let Some(item) = app.menu().and_then(|menu| menu.get(WINDOW_MENU_ID)) else {
        return;
    };
    let Some(window_menu) = item.as_submenu() else {
        return;
    };
    let cloud = label == CLOUD_WINDOW;
    for (id, checked) in [(SHOW_LOCAL, !cloud), (SHOW_CLOUD, cloud)] {
        if let Some(item) = window_menu.get(id) {
            if let Some(check) = item.as_check_menuitem() {
                let _ = check.set_checked(checked);
            }
        }
    }
}

pub fn local_title(app: &AppHandle, label: &str) -> &'static str {
    if enabled(app) && label == "main" {
        LOCAL_TITLE
    } else {
        "doop"
    }
}

fn bring_forward(window: &WebviewWindow<ShellRuntime>) -> tauri::Result<()> {
    window.show()?;
    window.unminimize()?;
    window.set_focus()
}

pub fn handle_menu(app: &AppHandle, id: &str) -> bool {
    if !enabled(app) || !matches!(id, SHOW_LOCAL | SHOW_CLOUD) {
        return false;
    }

    let result = if id == SHOW_CLOUD {
        show_cloud(app)
    } else {
        show_local(app)
    };
    match result {
        Ok(label) => sync_checkmarks(app, label),
        Err(error) => {
            eprintln!("Could not open the Doop editor window: {error}");
            rfd::MessageDialog::new()
                .set_title("Doop Dev")
                .set_description("Could not open the requested editor window.")
                .show();
        }
    }
    true
}

fn show_local(app: &AppHandle) -> tauri::Result<&'static str> {
    let window = match app.get_webview_window("main") {
        Some(window) => window,
        None => {
            let entry = Url::parse(&format!("{}/auth", crate::base_url()))
                .map_err(tauri::Error::InvalidUrl)?;
            crate::build_canvas_window(app, "main", entry, false, false)?
        }
    };
    bring_forward(&window)?;
    Ok("main")
}

fn cloud_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && matches!(url.host_str(), Some("doop.design" | "www.doop.design"))
}

fn stay_in_cloud(url: &Url) -> bool {
    if url.scheme() == "blob" {
        return Url::parse(url.path()).is_ok_and(|inner| cloud_origin(&inner));
    }
    matches!(url.as_str(), "about:blank" | "about:srcdoc") || cloud_origin(url)
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "https" | "mailto" | "tel") {
        let _ = app.opener().open_url(url.as_str(), None::<String>);
    }
}

fn show_cloud(app: &AppHandle) -> tauri::Result<&'static str> {
    if let Some(window) = app.get_webview_window(CLOUD_WINDOW) {
        bring_forward(&window)?;
        return Ok(CLOUD_WINDOW);
    }

    let popup_app = app.clone();
    // Keep the hosted page in browser mode with its own persistent WebKit data
    // store. Only the local windows are named in capabilities/default.json.
    let builder = WebviewWindowBuilder::new(
        app,
        CLOUD_WINDOW,
        WebviewUrl::External(Url::parse(CLOUD_ENTRY).map_err(tauri::Error::InvalidUrl)?),
    )
    .title(CLOUD_TITLE)
    .inner_size(1280.0, 840.0)
    .min_inner_size(900.0, 600.0)
    .data_store_identifier(*b"doop-dev-cloud01")
    .on_navigation(stay_in_cloud)
    .on_new_window(move |url, _| {
        open_external(&popup_app, &url);
        NewWindowResponse::Deny
    });
    let window = crate::with_export_downloads(app, builder).build()?;
    bring_forward(&window)?;
    Ok(CLOUD_WINDOW)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_cloud_pages_and_their_blob_downloads_in_the_window() {
        for url in [
            CLOUD_ENTRY,
            "https://www.doop.design/c/abc",
            "blob:https://doop.design/attachment",
            "about:blank",
            "about:srcdoc",
        ] {
            assert!(stay_in_cloud(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn keeps_loopback_other_hosts_and_app_links_out_of_the_cloud_window() {
        for url in [
            "http://127.0.0.1:4437/auth",
            "http://doop.design/auth",
            "https://doop.design:4000/auth",
            "https://doop.design.example.org/auth",
            "https://doop.design@other.example/auth",
            "blob:https://other.example/attachment",
            "doop://auth",
            "file:///etc/hosts",
        ] {
            assert!(!stay_in_cloud(&Url::parse(url).unwrap()), "{url}");
        }
    }
}
