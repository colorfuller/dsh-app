use serde_json::{json, Value};
use std::{
    fs::{create_dir_all, OpenOptions},
    io::{BufRead, BufReader},
    io::Write,
    path::Path,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, RunEvent, WindowEvent,
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const STDERR_TAIL_LIMIT: usize = 30;

/// The running core process. One shell owns one dsh server.
pub struct ServerProcess(Mutex<Option<Child>>);

/// The loopback URL reported by `DSH_READY`.
pub struct ReadyUrl(Mutex<Option<String>>);

/// Whether the core reported readiness.
pub struct Ready(AtomicBool);

/// When the core last wrote any line to stdout/stderr.
pub struct LastActivity(Mutex<Instant>);

/// Where the shell-side log file lives.
pub struct ShellLogPath(PathBuf);

/// The most recent core stderr lines, included in the exited status payload.
pub struct StderrTail(Mutex<Vec<String>>);

fn shell_log_path<R: tauri::Runtime>(manager: &impl tauri::Manager<R>) -> PathBuf {
    if let Ok(dir) = manager.path().app_data_dir() {
        return dir.join("logs").join("shell.log");
    }
    std::env::temp_dir().join("dsh-app-logs").join("shell.log")
}

fn append_log(path: &Path, line: &str) {
    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{seconds}] {line}");
}

/// Strip the Windows verbatim (`\\?\`) prefix so a path can safely be passed
/// as a child-process argv element; verbatim paths confuse Windows command
/// line parsing (e.g. `\\?\D:\...` arrives as `D:`).
fn env_friendly_path(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let raw = path.to_string_lossy();
        let stripped = if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            format!("\\{rest}")
        } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            raw.to_string()
        };
        return PathBuf::from(stripped);
    }
    #[cfg(not(target_os = "windows"))]
    {
        path
    }
}

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
    let mut payload = payload.clone();
    let state = payload.get("state").and_then(Value::as_str).unwrap_or("starting");
    if matches!(state, "error" | "exited") && payload.get("log").is_none() {
        if let Some(path) = app.try_state::<ShellLogPath>() {
            payload["log"] = json!(path.0.display().to_string());
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let script = format!(
            "window.dshStatus({});",
            serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_string())
        );
        let _ = window.eval(&script);
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn setup_tray(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let toggle_item = MenuItem::with_id(app, "toggle", "显示/隐藏主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("DeepSeek Harness")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn stop_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerProcess>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            if let Some(log) = app.try_state::<ShellLogPath>() {
                append_log(&log.0, "stopping core (window close / timeout / exit)");
            }
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
    let shell_log = shell_log_path(app);
    append_log(
        &shell_log,
        &format!("--- dsh-app shell starting (pid {}) ---", std::process::id()),
    );
    let sidecar = sidecar_path();
    if !sidecar.exists() {
        append_log(&shell_log, &format!("sidecar missing at {}", sidecar.display()));
        return Err(format!(
            "core sidecar missing at {}; run the full build first",
            sidecar.display()
        )
        .into());
    }
    let mut command = Command::new(sidecar);
    command
        .arg("--no-open")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Tell the core where the app resources live (bundled runtime/ and
    // npm-cli/). The core itself resolves user-installed runtimes under
    // $DSH_HOME/runtime and falls back to these resources.
    if let Ok(resource_dir) = app.path().resource_dir() {
        command.env("DSH_RESOURCE_DIR", env_friendly_path(resource_dir));
    }
    // Used as a writable dsh-home fallback when ~/.dsh is locked down.
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        command.env("DSH_APP_DATA_DIR", env_friendly_path(app_data_dir));
    }
    hide_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start core: {error}"))?;
    append_log(&shell_log, &format!("core spawned (pid {})", child.id()));
    let stdout = child.stdout.take().ok_or("core stdout is not piped")?;
    let stderr = child.stderr.take().ok_or("core stderr is not piped")?;

    app.manage(ServerProcess(Mutex::new(Some(child))));
    app.manage(ReadyUrl(Mutex::new(None)));
    app.manage(Ready(AtomicBool::new(false)));
    app.manage(LastActivity(Mutex::new(Instant::now())));
    app.manage(ShellLogPath(shell_log.clone()));
    app.manage(StderrTail(Mutex::new(Vec::new())));

    if let Err(error) = setup_tray(app) {
        append_log(&shell_log, &format!("tray setup failed: {error}"));
    }

    let app_handle = app.handle().clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            *app_handle.state::<LastActivity>().0.lock().unwrap() = Instant::now();
            append_log(&app_handle.state::<ShellLogPath>().0, &format!("[out] {line}"));
            if let Some(json_text) = line.strip_prefix("DSH_STATUS ") {
                if let Ok(payload) = serde_json::from_str::<Value>(json_text) {
                    eval_status(&app_handle, &payload);
                }
            } else if let Some(json_text) = line.strip_prefix("DSH_READY ") {
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
            *app_handle.state::<LastActivity>().0.lock().unwrap() = Instant::now();
            append_log(&app_handle.state::<ShellLogPath>().0, &format!("[err] {line}"));
            {
                let tail_state = app_handle.state::<StderrTail>();
                let mut tail = tail_state.0.lock().unwrap();
                tail.push(line.clone());
                if tail.len() > STDERR_TAIL_LIMIT {
                    tail.remove(0);
                }
            }
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
                let mut message = format!("服务进程已退出（{}）", status);
                if let Some(tail_state) = app_handle.try_state::<StderrTail>() {
                    let lines = tail_state.0.lock().unwrap();
                    if !lines.is_empty() {
                        message.push_str(&format!("\n最近输出：\n{}", lines.join("\n")));
                    }
                }
                append_log(
                    &app_handle.state::<ShellLogPath>().0,
                    &format!("core exited ({status})"),
                );
                eval_status(
                    &app_handle,
                    &json!({ "state": "exited", "message": message }),
                );
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }
    });

    let app_handle = app.handle().clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        if app_handle.state::<Ready>().0.load(Ordering::SeqCst) {
            return;
        }
        let Some(state) = app_handle.try_state::<LastActivity>() else {
            return;
        };
        let last = *state.0.lock().unwrap();
        if last.elapsed() > STARTUP_TIMEOUT {
            stop_server(&app_handle);
            eval_status(
                &app_handle,
                &json!({
                    "state": "error",
                    "message": "启动超时（90 秒无活动输出），请检查网络或日志后重试"
                }),
            );
            return;
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .setup(setup_server)
        .on_window_event(|window, event| {
            // 关闭窗口时隐藏到托盘，服务继续在后台运行；退出请使用托盘菜单。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
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
