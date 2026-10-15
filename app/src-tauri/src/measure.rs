//! What the app measures for progress itself, without Claude's reports (docs/CONTRACT.md):
//! the tail of a background command's output file, and how long past turns took in a
//! project (Claude Code's `turn_duration` rows), for an ETA before or without reports.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TAIL_BYTES: u64 = 8 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tail {
    path: String,
    size: u64,
    modified_at: u64,
    tail: String,
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Only Claude Code's background task output files: the webview cannot read anything else this way.
fn is_task_output(path: &Path) -> bool {
    let temp = |p: &Path| p.starts_with("/tmp") || p.starts_with("/private/tmp") || p.starts_with("/private/var/folders") || p.starts_with(std::env::temp_dir());
    path.extension().is_some_and(|e| e == "output") && path.components().any(|c| c.as_os_str() == "tasks") && temp(path) && !path.to_string_lossy().contains("..")
}

fn tail_of(path: &Path) -> Option<Tail> {
    let mut f = std::fs::File::open(path).ok()?;
    let meta = f.metadata().ok()?;
    let size = meta.len();
    f.seek(SeekFrom::Start(size.saturating_sub(TAIL_BYTES))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(Tail { path: path.to_string_lossy().into(), size, modified_at: meta.modified().map(ms).unwrap_or(0), tail: String::from_utf8_lossy(&buf).into() })
}

/// The last few KB of each background command's output, with its size and last write.
#[tauri::command]
pub fn job_tails(paths: Vec<String>) -> Vec<Tail> {
    paths.iter().map(PathBuf::from).filter(|p| is_task_output(p)).filter_map(|p| tail_of(&p)).collect()
}

/// Per transcript: when it was last read, and its turn durations.
#[derive(Default)]
pub struct History(Mutex<HashMap<PathBuf, (SystemTime, Vec<u64>)>>);

const HISTORY_DAYS: u64 = 90;
const HISTORY_KEPT: usize = 1000;

/// `durationMs` of every main-conversation `turn_duration` row in a transcript.
fn durations(text: &str) -> Vec<u64> {
    text.lines()
        .filter(|l| l.contains("\"turn_duration\""))
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|v| v.get("subtype").and_then(|s| s.as_str()) == Some("turn_duration") && v.get("isSidechain").and_then(|s| s.as_bool()) != Some(true))
        .filter_map(|v| v.get("durationMs").and_then(|d| d.as_u64()))
        .collect()
}

/// How long this project's turns took (newest last), from its transcripts of the last 90 days.
#[tauri::command]
pub async fn turn_history(history: tauri::State<'_, History>, cwd: String) -> Result<Vec<u64>, String> {
    let dir = crate::claude_home().join("projects").join(crate::transcript::escape(&cwd));
    let cutoff = SystemTime::now() - Duration::from_secs(HISTORY_DAYS * 86_400);
    let mut files: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| Some((p.metadata().ok()?.modified().ok()?, p)))
        .filter(|(m, _)| *m >= cutoff)
        .collect();
    files.sort();
    let mut cache = history.0.lock().map_err(|e| e.to_string())?;
    let mut all = Vec::new();
    for (modified, path) in files {
        let fresh = cache.get(&path).is_some_and(|(at, _)| *at == modified);
        if !fresh {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            cache.insert(path.clone(), (modified, durations(&text)));
        }
        all.extend_from_slice(&cache[&path].1);
    }
    let skip = all.len().saturating_sub(HISTORY_KEPT);
    Ok(all.split_off(skip))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_task_output_files_can_be_read() {
        assert!(is_task_output(Path::new("/private/tmp/claude-502/-Users-x/aee3888e/tasks/bnf211hsl.output")));
        assert!(!is_task_output(Path::new("/Users/x/.ssh/id_rsa")));
        assert!(!is_task_output(Path::new("/private/tmp/claude-502/x/tasks/../../../etc/passwd.output")));
        assert!(!is_task_output(Path::new("/Users/x/tasks/a.output")));
    }

    #[test]
    fn turn_durations_come_from_the_main_conversation() {
        let text = [
            r#"{"type":"system","subtype":"turn_duration","durationMs":52490,"isSidechain":false}"#,
            r#"{"type":"system","subtype":"turn_duration","durationMs":999,"isSidechain":true}"#,
            r#"{"type":"user","message":{"content":"turn_duration in a prompt"}}"#,
            r#"{"type":"system","subtype":"turn_duration","durationMs":719805}"#,
        ]
        .join("\n");
        assert_eq!(durations(&text), vec![52490, 719805]);
    }
}
