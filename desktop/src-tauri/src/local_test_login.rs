//! Start the installed local test app with a regular Doop session.
use std::time::Duration;

use serde::Deserialize;
use tauri::webview::Cookie;
use tauri::{AppHandle, Manager, Url, WebviewWindow};

const ORIGIN: &str = "http://127.0.0.1:4437";
const APP_ID: &str = "digital.akimov.doop-test";
const SESSION_COOKIE: &str = "better-auth.session_token";

#[derive(Deserialize)]
struct Account {
    email: String,
    password: String,
    canvas_id: String,
}

#[derive(Deserialize)]
struct Canvas {
    id: String,
}

pub fn enabled(app: &AppHandle) -> bool {
    option_env!("DOOP_TEST_LOGIN") == Some("1")
        && app.config().identifier == APP_ID
        && crate::server::active(app) == ORIGIN
}

pub fn start(window: WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        let target = match startup_url(&window).await {
            Some(target) => target,
            None => {
                eprintln!("Doop Test automatic sign-in failed.");
                format!("{ORIGIN}/auth").parse().expect("valid sign-in URL")
            }
        };
        if window.navigate(target).is_err() {
            eprintln!("Doop Test could not open its start page.");
        }
    });
}

async fn startup_url(window: &WebviewWindow) -> Option<Url> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let root = Url::parse(ORIGIN).ok()?;
    let existing = window.cookies().unwrap_or_default();
    if let Some(cookie) = existing.iter().find(|cookie| is_local_session(cookie)) {
        let response = canvas_list_response(&client, cookie).await.ok()?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            let canvases: Vec<Canvas> = response.error_for_status().ok()?.json().await.ok()?;
            let target = canvases
                .first()
                .and_then(|canvas| canvas_url(&canvas.id))
                .unwrap_or(root);
            eprintln!("Doop Test reused its local session.");
            return Some(target);
        }
    }

    let config = window.path().app_data_dir().ok()?.join("local-test-account.json");
    let account: Account = serde_json::from_slice(&std::fs::read(config).ok()?).ok()?;
    let response = client
        .post(format!("{ORIGIN}/api/auth/sign-in/email"))
        .header(reqwest::header::ORIGIN, ORIGIN)
        .json(&serde_json::json!({
            "email": account.email,
            "password": account.password,
            "rememberMe": true,
        }))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let mut cookie = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| Cookie::parse(value.to_str().ok()?).ok())
        .find(|cookie| cookie.name() == SESSION_COOKIE && cookie.http_only() == Some(true))?
        .into_owned();

    let canvases: Vec<Canvas> = canvas_list_response(&client, &cookie)
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let target = canvases
        .iter()
        .find(|canvas| canvas.id == account.canvas_id)
        .and_then(|canvas| canvas_url(&canvas.id))
        .unwrap_or(root);
    cookie.set_domain("127.0.0.1");
    cookie.set_path("/");
    window.set_cookie(cookie).ok()?;
    eprintln!("Doop Test signed in to its local test account.");
    Some(target)
}

fn is_local_session(cookie: &Cookie<'_>) -> bool {
    cookie.name() == SESSION_COOKIE
        && cookie.domain().map(|domain| domain.trim_start_matches('.')) == Some("127.0.0.1")
        && cookie.http_only() == Some(true)
}

async fn canvas_list_response(
    client: &reqwest::Client,
    cookie: &Cookie<'_>,
) -> reqwest::Result<reqwest::Response> {
    client
        .get(format!("{ORIGIN}/api/canvases"))
        .header(
            reqwest::header::COOKIE,
            format!("{}={}", cookie.name(), cookie.value()),
        )
        .send()
        .await
}

fn canvas_url(id: &str) -> Option<Url> {
    let mut target = Url::parse(ORIGIN).ok()?;
    target.path_segments_mut().ok()?.extend(["c", id]);
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_loopback_session() {
        let mut cookie = Cookie::new(SESSION_COOKIE, "test");
        cookie.set_domain("127.0.0.1");
        cookie.set_http_only(true);
        assert!(is_local_session(&cookie));

        cookie.set_domain("doop.design");
        assert!(!is_local_session(&cookie));
    }
}
