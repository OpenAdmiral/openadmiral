//! Pseudo-terminals hosting `claude attach <id>`: one per agent, kept alive
//! while the person switches between agents, keyed by the frontend.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

struct Pty {
    /// Tells a reopened terminal apart from the one whose reader just ended.
    generation: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys(Mutex<HashMap<String, Pty>>);

static GENERATION: AtomicU64 = AtomicU64::new(1);

/// Keys of agent terminals are session ids; the trust prompt's start with `trust:`.
fn attached_sessions(map: &HashMap<String, Pty>) -> Vec<String> {
    map.keys().filter(|k| !k.starts_with("trust:")).cloned().collect()
}

/// `~/.claude/openadmiral/attached.json`: the sessions shown in an embedded terminal,
/// so the statusline stays quiet for them (docs/CONTRACT.md). Temp file + rename.
pub fn write_attached(sessions: &[String]) {
    if crate::preview() {
        return;
    }
    let path = crate::admiral_dir().join("attached.json");
    let tmp = path.with_extension("json.tmp");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let body = serde_json::json!({ "updatedAt": now, "sessions": sessions }).to_string();
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(tmp, path);
    }
}

pub fn refresh_attached(app: &AppHandle) {
    let sessions = attached_sessions(&app.state::<Ptys>().0.lock().unwrap());
    write_attached(&sessions);
}

/// Ends the terminal for `key`, if any; the session it attached to keeps running.
pub fn close(app: &AppHandle, key: &str) {
    if let Some(mut pty) = app.state::<Ptys>().0.lock().unwrap().remove(key) {
        let _ = pty.child.kill();
    }
    refresh_attached(app);
}

#[derive(Serialize, Clone)]
struct PtyData {
    key: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    key: String,
}

/// Opens `argv` in `cwd` under `key`; a key already open is left as is, so a
/// remounted terminal view re-joins the running process.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    ptys: State<'_, Ptys>,
    key: String,
    argv: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    let mut map = ptys.0.lock().unwrap();
    if map.contains_key(&key) {
        return Ok(false);
    }
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let (program, args) = argv.split_first().ok_or("empty argv")?;
    let program = match program.as_str() {
        "claude" => crate::claude_bin().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| program.clone()),
        _ => program.clone(),
    };
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(&cwd);
    cmd.env("PATH", crate::login_path());
    for k in crate::inherited_claude_vars() {
        cmd.env_remove(k);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // A colour switch the app inherited (it was opened from a shell that had one, e.g.
    // a Claude Code session's NO_COLOR) must not turn the embedded Claude Code grey.
    cmd.env_remove("NO_COLOR");
    cmd.env_remove("FORCE_COLOR");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
    let reader_key = key.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        // Bytes of a UTF-8 sequence split across reads wait for the next read.
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&carry) {
                        Ok(_) => carry.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => carry.len(),
                    };
                    let data = String::from_utf8_lossy(&carry[..valid]).into_owned();
                    carry.drain(..valid);
                    let _ = app.emit("pty://data", PtyData { key: reader_key.clone(), data });
                }
            }
        }
        {
            let state = app.state::<Ptys>();
            let mut map = state.0.lock().unwrap();
            if map.get(&reader_key).is_some_and(|p| p.generation == generation) {
                map.remove(&reader_key);
            }
            write_attached(&attached_sessions(&map));
        }
        let _ = app.emit("pty://exit", PtyExit { key: reader_key });
    });

    map.insert(key, Pty { generation, master: pair.master, writer, child });
    write_attached(&attached_sessions(&map));
    Ok(true)
}

#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, key: String, data: String) -> Result<(), String> {
    let mut map = ptys.0.lock().unwrap();
    let pty = map.get_mut(&key).ok_or("no such terminal")?;
    pty.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, key: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.0.lock().unwrap();
    let pty = map.get(&key).ok_or("no such terminal")?;
    pty.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(app: AppHandle, key: String) {
    close(&app, &key);
}
