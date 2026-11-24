//! Start the installed local test app with a regular Doop session.
use std::time::Duration;

use serde::Deserialize;
use tauri::webview::Cookie;
use tauri::{AppHandle, Manager, Url, WebviewWindow};

const ORIGIN: &str = "http://127.0.0.1:4437";
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
        && app.config().identifier == crate::DEV_BUNDLE_IDENTIFIER
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
    let existing = window.cookies_for_url(root.clone()).unwrap_or_default();
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
    let cookie = response
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
    #[cfg(not(chromium))]
    {
        let mut cookie = cookie;
        cookie.set_domain("127.0.0.1");
        cookie.set_path("/");
        window.set_cookie(cookie).ok()?;
    }
    #[cfg(chromium)]
    chromium::store_cookie(window, &cookie).await?;
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

#[cfg(chromium)]
mod chromium {
    use super::{Duration, ORIGIN, WebviewWindow};
    use cef::{rc::*, *};
    use tauri::async_runtime::{Sender, channel};

    cef::wrap_set_cookie_callback! {
        struct SessionInstalled { result: Sender<bool> }
        impl SetCookieCallback {
            fn on_complete(&self, success: i32) {
                let _ = self.result.try_send(success != 0);
            }
        }
    }

    fn cef_cookie(cookie: &tauri::webview::Cookie<'_>) -> cef::Cookie {
        use std::time::{SystemTime, UNIX_EPOCH};
        use tauri::webview::cookie::SameSite;

        let expires = cookie
            .max_age()
            .and_then(|age| {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
                Some(now.as_secs_f64() + age.whole_seconds() as f64)
            })
            .or_else(|| cookie.expires_datetime().map(|date| date.unix_timestamp() as f64));
        let mut cef_cookie = cef::Cookie {
            name: cookie.name().into(),
            value: cookie.value().into(),
            path: "/".into(),
            secure: cookie.secure().unwrap_or(false).into(),
            httponly: 1,
            same_site: match cookie.same_site() {
                Some(SameSite::Strict) => CookieSameSite::STRICT_MODE,
                Some(SameSite::Lax) => CookieSameSite::LAX_MODE,
                Some(SameSite::None) => CookieSameSite::NO_RESTRICTION,
                None => CookieSameSite::UNSPECIFIED,
            },
            ..Default::default()
        };
        if let Some(expires) = expires {
            cef_cookie.has_expires = 1;
            cef_cookie.expires = Basetime {
                val: crate::webkit_migration::chromium_time(expires),
            };
        }
        cef_cookie
    }

    // The alpha Tauri wrapper infers the URL from the current frame (here
    // about:blank) and drops expiry and SameSite. Use the CEF request
    // context with the loopback URL and wait for the write before navigating.
    pub(super) async fn store_cookie(
        window: &WebviewWindow,
        cookie: &tauri::webview::Cookie<'_>,
    ) -> Option<()> {
        let cookie = cookie.clone().into_owned();
        let (result, mut installed) = channel(1);
        window
            .with_webview(move |webview| {
                let Some(manager) = webview
                    .downcast_ref::<tauri_runtime_cef::Webview>()
                    .and_then(|webview| webview.browser().host())
                    .and_then(|host| host.request_context())
                    .and_then(|context| context.cookie_manager(None))
                else {
                    return;
                };
                let mut callback = SessionInstalled::new(result);
                manager.set_cookie(
                    Some(&ORIGIN.into()),
                    Some(&cef_cookie(&cookie)),
                    Some(&mut callback),
                );
            })
            .ok()?;
        tokio::time::timeout(Duration::from_secs(2), installed.recv())
            .await
            .ok()?
            .filter(|success| *success)
            .map(|_| ())
    }
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
