// Only the local Doop Dev WKWebView may use the OS microphone bridge.
use std::ffi::{c_char, CStr, CString};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{ipc::Channel, Runtime, WebviewWindow};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DictationEvent {
    Result {
        transcript: String,
        #[serde(rename = "final")]
        final_result: bool,
    },
    End,
    Error,
}

struct Active {
    id: u64,
    owner: String,
    token: String,
    events: Channel<DictationEvent>,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

extern "C" {
    fn doop_dictation_available(locale: *const c_char) -> bool;
    fn doop_dictation_start(
        id: u64,
        locale: *const c_char,
        callback: extern "C" fn(u64, u32, *const c_char),
    );
    fn doop_dictation_stop(id: u64, cancel: bool);
}

fn is_dev_window<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    window.url().is_ok_and(|url| {
        url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(4437)
    })
}

extern "C" fn speech_event(id: u64, kind: u32, text: *const c_char) {
    let Ok(mut active) = ACTIVE.lock() else { return };
    let Some(session) = active.as_ref().filter(|session| session.id == id) else {
        return;
    };
    let events = session.events.clone();
    if kind >= 2 {
        active.take();
    }
    drop(active);
    let event = match kind {
        0 | 1 if !text.is_null() => DictationEvent::Result {
            // The bridge keeps the Objective-C string alive through this call.
            transcript: unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned(),
            final_result: kind == 1,
        },
        2 => DictationEvent::End,
        _ => DictationEvent::Error,
    };
    let _ = events.send(event);
}

#[tauri::command]
pub fn dictation_available<R: Runtime>(window: WebviewWindow<R>, locale: String) -> bool {
    is_dev_window(&window)
        && locale.len() <= 32
        && CString::new(locale)
            .is_ok_and(|locale| unsafe { doop_dictation_available(locale.as_ptr()) })
}

#[tauri::command]
pub fn dictation_start<R: Runtime>(
    window: WebviewWindow<R>,
    token: String,
    locale: String,
    events: Channel<DictationEvent>,
) -> Result<(), String> {
    if !dictation_available(window.clone(), locale.clone()) || token.len() > 64 {
        return Err("Dictation is unavailable".into());
    }
    let language = CString::new(locale).map_err(|_| "Invalid dictation locale")?;
    let owner = window.label().to_string();
    let mut active = ACTIVE.lock().map_err(|_| "Could not open dictation")?;
    if active.as_ref().is_some_and(|session| session.owner != owner) {
        return Err("Dictation is already open in another window".into());
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let previous = active.replace(Active {
        id,
        owner,
        token,
        events,
    });
    drop(active);
    if let Err(error) = window.run_on_main_thread(move || unsafe {
        doop_dictation_start(id, language.as_ptr(), speech_event)
    }) {
        if let Ok(mut active) = ACTIVE.lock() {
            if active.as_ref().is_some_and(|session| session.id == id) {
                *active = previous;
            }
        }
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn dictation_stop<R: Runtime>(
    window: WebviewWindow<R>,
    token: String,
    cancel: bool,
) -> Result<(), String> {
    if !is_dev_window(&window) {
        return Err("Dictation is unavailable".into());
    }
    if let Some(id) = session_for(window.label(), Some(&token)) {
        window
            .run_on_main_thread(move || unsafe { doop_dictation_stop(id, cancel) })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn session_for(owner: &str, token: Option<&str>) -> Option<u64> {
    ACTIVE
        .lock()
        .ok()?
        .as_ref()
        .filter(|session| session.owner == owner && token.is_none_or(|token| session.token == token))
        .map(|session| session.id)
}

pub fn cancel_window<R: Runtime>(window: &tauri::Window<R>) {
    if let Some(id) = session_for(window.label(), None) {
        let _ = window.run_on_main_thread(move || unsafe { doop_dictation_stop(id, true) });
    }
}
