use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{App, AppHandle, Manager, RunEvent, WindowEvent};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

/// The running core process. One shell owns one dsh server.
pub struct ServerProcess(Mutex<Option<Child>>);

/// The loopback URL reported by `DSH_READY`.
pub struct ReadyUrl(Mutex<Option<String>>);

/// Whether the core reported readiness.
pub struct Ready(AtomicBool);

/// Sidecar file name required by Tauri's `externalBin` convention.
fn sidecar_file_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        if cfg!(target_arch = "x86_64") {
            "dsh-core-x86_64-pc-windows-msvc.exe"
        } else {
            "dsh-core-aarch64-pc-windows-msvc.exe"
        }
    }
    #[cfg(target_os = "macos")]
    {
        if cfg!(target_arch = "x86_64") {
            "dsh-core-x86_64-apple-darwin"
        } else {
            "dsh-core-aarch64-apple-darwin"
        }
    }
    #[cfg(target_os = "linux")]
    {
        if cfg!(target_arch = "x86_64") {
            "dsh-core-x86_64-unknown-linux-gnu"
        } else {
            "dsh-core-aarch64-unknown-linux-gnu"
        }
    }
}

fn sidecar_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .expect("current executable path")
        .parent()
        .expect("executable directory")
        .to_path_buf();
    // Tauri copies external binaries from `binaries/<name>-<triple>` into the
    // build output and final bundle without the triple suffix.
    let plain_name = if cfg!(target_os = "windows") {
        "dsh-core.exe"
    } else {
        "dsh-core"
    };
    let plain = exe_dir.join(plain_name);
    if plain.exists() {
        return plain;
    }
    exe_dir.join(sidecar_file_name())
}

/// Resolve the on-disk dsh runtime: dev prefers the checked-out copy, and the
/// packaged app falls back to the `runtime/` resource next to the exe.
fn runtime_dir() -> Option<PathBuf> {
    let manifest_runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime");
    if manifest_runtime.is_dir() {
        return Some(manifest_runtime);
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let exe_runtime = exe_dir.join("runtime");
    if exe_runtime.is_dir() {
        return Some(exe_runtime);
    }
    None
}

#[cfg(target_os = "windows")]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console(_command: &mut Command) {}

/// Push a status payload into the WebView2 window without a JS dependency.
fn eval_status(app: &AppHandle, payload: &Value) {
    if let Some(window) = app.get_webview_window("main") {
        let script = format!(
            "window.dshStatus({});",
            serde_json::to_string(payload).unwrap_or_else(|_| "null".to_string())
        );
        let _ = window.eval(&script);
    }
}

fn stop_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerProcess>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            #[cfg(target_os = "windows")]
            {
                // The core is a supervisor: terminate the whole tree so the
                // plain-Node dsh child cannot outlive the shell.
                let mut killer = Command::new("taskkill");
                killer.args(["/PID", &child.id().to_string(), "/T", "/F"]);
                hide_console(&mut killer);
                let _ = killer.status();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}

fn setup_server(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let sidecar = sidecar_path();
    if !sidecar.exists() {
        return Err(format!(
            "core sidecar missing at {}; run the full build first",
            sidecar.display()
        )
        .into());
    }
    let runtime = runtime_dir().ok_or_else(|| "dsh runtime directory not found".to_string())?;

    let mut command = Command::new(sidecar);
    command
        .arg("--no-open")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("DSH_RUNTIME_DIR", runtime);
    hide_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start core: {error}"))?;
    let stdout = child.stdout.take().ok_or("core stdout is not piped")?;
    let stderr = child.stderr.take().ok_or("core stderr is not piped")?;

    app.manage(ServerProcess(Mutex::new(Some(child))));
    app.manage(ReadyUrl(Mutex::new(None)));
    app.manage(Ready(AtomicBool::new(false)));

    let app_handle = app.handle().clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(json_text) = line.strip_prefix("DSH_READY ") {
                if let Ok(payload) = serde_json::from_str::<Value>(json_text) {
                    let url = payload
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if !url.is_empty() {
                        app_handle.state::<Ready>().0.store(true, Ordering::SeqCst);
                        *app_handle.state::<ReadyUrl>().0.lock().unwrap() = Some(url.clone());
                        // The status window becomes the Web UI window: navigate
                        // it to the loopback URL once dsh reports readiness.
                        if let Some(window) = app_handle.get_webview_window("main") {
                            if let Ok(target) = url::Url::parse(&url) {
                                let _ = window.navigate(target);
                            }
                        }
                    }
                }
            }
        }
    });

    let app_handle = app.handle().clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(json_text) = line.strip_prefix("DSH_ERROR ") {
                if let Ok(mut payload) = serde_json::from_str::<Value>(json_text) {
                    payload
                        .as_object_mut()
                        .map(|object| object.insert("state".to_string(), json!("error")));
                    eval_status(&app_handle, &payload);
                }
            }
        }
    });

    let app_handle = app.handle().clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        let Some(state) = app_handle.try_state::<ServerProcess>() else {
            break;
        };
        let mut guard = state.0.lock().unwrap();
        let Some(child) = guard.as_mut() else {
            break;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                guard.take();
                drop(guard);
                eval_status(
                    &app_handle,
                    &json!({
                        "state": "exited",
                        "message": format!("服务进程已退出（{}）", status)
                    }),
                );
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }
    });

    let app_handle = app.handle().clone();
    thread::spawn(move || {
        thread::sleep(STARTUP_TIMEOUT);
        if app_handle.state::<Ready>().0.load(Ordering::SeqCst) {
            return;
        }
        stop_server(&app_handle);
        eval_status(
            &app_handle,
            &json!({
                "state": "error",
                "message": "启动超时（90 秒），请查看日志后重试"
            }),
        );
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(setup_server)
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                stop_server(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. }) {
                stop_server(app_handle);
            }
        });
}
