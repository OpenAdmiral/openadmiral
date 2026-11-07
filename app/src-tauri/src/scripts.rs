//! Workspace scripts, the way Conductor runs them, so a repo set up for Conductor works
//! here unchanged: `setup` after a worktree is made, `run` from the Run tab, `archive`
//! before a workspace is archived. Read from `<repo>/.conductor/settings.toml` (with its
//! `settings.local.toml`), else the older `<repo>/conductor.json`; a repo with neither can
//! keep its scripts in OpenAdmiral (Run tab → Scripts), stored in the app's data folder.
//!
//! Scripts run in the workspace folder, in a non-interactive shell, with Conductor's
//! variables (CONDUCTOR_WORKSPACE_NAME, _PATH, _ROOT_PATH, _DEFAULT_BRANCH, _PORT,
//! _IS_LOCAL) and the same under OPENADMIRAL_*. Each workspace gets ten ports from
//! CONDUCTOR_PORT on, kept for it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scripts {
    pub setup: Option<String>,
    pub run: Vec<RunAction>,
    pub archive: Option<String>,
    /// "nonconcurrent": starting one run action stops the others.
    pub run_mode: Option<String>,
    /// Pages to open, with `$((CONDUCTOR_PORT+N))` already worked out by the UI from `port`.
    pub preview_urls: Vec<(String, String)>,
    /// Where they came from: ".conductor/settings.toml", "conductor.json" or "OpenAdmiral".
    pub source: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunAction {
    pub id: String,
    pub command: String,
    pub default: bool,
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").env("PATH", crate::login_path()).arg("-C").arg(dir).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

/// The checkout a folder is in, and the repo's main checkout (a worktree's "root path").
pub fn roots(cwd: &Path) -> Option<(PathBuf, PathBuf)> {
    let top = PathBuf::from(git(cwd, &["rev-parse", "--show-toplevel"])?);
    let common = git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).map(PathBuf::from);
    let main = common.and_then(|c| c.parent().map(Path::to_path_buf)).unwrap_or_else(|| top.clone());
    Some((top, main))
}

/// Conductor's TOML settings: `[scripts]` with setup, archive, run (a string or `run.<id>` tables).
pub fn parse_toml(text: &str) -> Scripts {
    let Ok(v) = text.parse::<toml::Table>() else { return Scripts::default() };
    let mut s = Scripts::default();
    if let Some(sc) = v.get("scripts").and_then(|x| x.as_table()) {
        s.setup = sc.get("setup").and_then(|x| x.as_str()).map(str::to_string);
        s.archive = sc.get("archive").and_then(|x| x.as_str()).map(str::to_string);
        s.run_mode = sc.get("run_mode").and_then(|x| x.as_str()).map(str::to_string);
        match sc.get("run") {
            Some(toml::Value::String(c)) => s.run.push(RunAction { id: "run".into(), command: c.clone(), default: true }),
            Some(toml::Value::Table(t)) => {
                for (id, a) in t {
                    let Some(a) = a.as_table() else { continue };
                    if a.get("hide").and_then(|x| x.as_bool()) == Some(true) || a.get("available_in").and_then(|x| x.as_str()) == Some("cloud") {
                        continue;
                    }
                    let Some(cmd) = a.get("command").and_then(|x| x.as_str()) else { continue };
                    let args: Vec<String> = a.get("args").and_then(|x| x.as_array()).map(|xs| xs.iter().filter_map(|x| x.as_str()).map(shell_word).collect()).unwrap_or_default();
                    let command = if args.is_empty() { cmd.to_string() } else { format!("{cmd} {}", args.join(" ")) };
                    s.run.push(RunAction { id: id.clone(), command, default: a.get("default").and_then(|x| x.as_bool()).unwrap_or(false) });
                }
            }
            _ => {}
        }
    }
    if let Some(urls) = v.get("preview_urls").and_then(|x| x.as_array()) {
        for u in urls.iter().filter_map(|u| u.as_table()) {
            if let (Some(n), Some(url)) = (u.get("name").and_then(|x| x.as_str()), u.get("url").and_then(|x| x.as_str())) {
                s.preview_urls.push((n.to_string(), url.to_string()));
            }
        }
    }
    s
}

fn shell_word(w: &str) -> String {
    if w.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
        w.to_string()
    } else {
        format!("'{}'", w.replace('\'', "'\\''"))
    }
}

/// The older `conductor.json`: `{ "scripts": { "setup", "run", "archive" }, "runScriptMode" }`.
pub fn parse_json(text: &str) -> Scripts {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else { return Scripts::default() };
    let sc = &v["scripts"];
    Scripts {
        setup: sc["setup"].as_str().map(str::to_string),
        archive: sc["archive"].as_str().map(str::to_string),
        run: sc["run"].as_str().map(|c| vec![RunAction { id: "run".into(), command: c.to_string(), default: true }]).unwrap_or_default(),
        run_mode: v["runScriptMode"].as_str().map(str::to_string),
        ..Default::default()
    }
}

fn own_path(app: &AppHandle) -> Option<PathBuf> {
    crate::app_data_dir(app).map(|d| d.join("workspace-scripts.json"))
}

fn own_all(app: &AppHandle) -> BTreeMap<String, Scripts> {
    own_path(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// A repo's scripts: Conductor's settings (TOML, its local overrides on top), else conductor.json, else OpenAdmiral's own.
pub fn scripts_for(app: &AppHandle, main: &Path) -> Scripts {
    let dir = main.join(".conductor");
    if let Ok(t) = std::fs::read_to_string(dir.join("settings.toml")) {
        let mut s = parse_toml(&t);
        if let Ok(local) = std::fs::read_to_string(dir.join("settings.local.toml")) {
            let l = parse_toml(&local);
            s.setup = l.setup.or(s.setup);
            s.archive = l.archive.or(s.archive);
            s.run_mode = l.run_mode.or(s.run_mode);
            if !l.run.is_empty() {
                s.run = l.run;
            }
        }
        s.source = Some(".conductor/settings.toml".into());
        return s;
    }
    if let Ok(t) = std::fs::read_to_string(main.join("conductor.json")) {
        let mut s = parse_json(&t);
        s.source = Some("conductor.json".into());
        return s;
    }
    let mut s = own_all(app).remove(&main.to_string_lossy().to_string()).unwrap_or_default();
    s.source = Some("OpenAdmiral".into());
    s
}

/// The first of a workspace's ten ports: the one it had, or the next free block from 55100.
fn port_for(app: &AppHandle, workspace: &Path) -> u16 {
    let path = crate::app_data_dir(app).map(|d| d.join("ports.json"));
    let mut all: BTreeMap<String, u16> = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let key = workspace.to_string_lossy().to_string();
    if let Some(p) = all.get(&key) {
        return *p;
    }
    let taken: Vec<u16> = all.values().copied().collect();
    let port = (0..1000u16).map(|i| 55100 + i * 10).find(|p| !taken.contains(p)).unwrap_or(55100);
    all.insert(key, port);
    if let Some(p) = path {
        let _ = std::fs::create_dir_all(p.parent().unwrap());
        let _ = std::fs::write(p, serde_json::to_string_pretty(&all).unwrap_or_default());
    }
    port
}

/// The variables a script (or a Run tab) gets, Conductor's names and ours.
pub fn env_for(app: &AppHandle, workspace: &Path) -> Vec<(String, String)> {
    let (_, main) = roots(workspace).unwrap_or((workspace.to_path_buf(), workspace.to_path_buf()));
    let name = workspace.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let default = git(&main, &["rev-parse", "--abbrev-ref", "origin/HEAD"]).map(|b| b.trim_start_matches("origin/").to_string()).unwrap_or_else(|| "main".into());
    let port = port_for(app, workspace).to_string();
    let pairs = [
        ("WORKSPACE_NAME", name),
        ("WORKSPACE_PATH", workspace.to_string_lossy().to_string()),
        ("ROOT_PATH", main.to_string_lossy().to_string()),
        ("DEFAULT_BRANCH", default),
        ("PORT", port),
        ("IS_LOCAL", "1".into()),
    ];
    pairs.iter().flat_map(|(k, v)| [(format!("CONDUCTOR_{k}"), v.clone()), (format!("OPENADMIRAL_{k}"), v.clone())]).collect()
}

/// A script through the platform's shell.
pub fn shell(script: &str) -> Vec<String> {
    if cfg!(windows) {
        vec!["cmd".into(), "/C".into(), script.into()]
    } else {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        vec![sh, "-lc".into(), script.into()]
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScriptEvent {
    kind: &'static str,
    workspace: String,
    state: &'static str,
    log: String,
}

/// Runs `setup` or `archive` for a workspace and waits; its output goes to a log in the
/// app's data folder, and the windows hear when it starts and how it ended.
pub fn run_blocking(app: &AppHandle, kind: &'static str, script: &str, workspace: &Path) -> Result<(), String> {
    let log = crate::app_data_dir(app).ok_or("no app data dir")?.join("scripts").join(format!("{}-{kind}.log", crate::worktree_slug(&workspace.to_string_lossy())));
    let _ = std::fs::create_dir_all(log.parent().unwrap());
    let file = std::fs::File::create(&log).map_err(|e| e.to_string())?;
    let tell = |state| {
        let _ = app.emit("openadmiral://script", ScriptEvent { kind, workspace: workspace.to_string_lossy().to_string(), state, log: log.to_string_lossy().to_string() });
    };
    tell("running");
    let argv = shell(script);
    let status = Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(workspace)
        .env("PATH", crate::login_path())
        .envs(env_for(app, workspace))
        .stdout(file.try_clone().map_err(|e| e.to_string())?)
        .stderr(file)
        .status()
        .map_err(|e| e.to_string())?;
    tell(if status.success() { "done" } else { "failed" });
    if status.success() {
        Ok(())
    } else {
        Err(format!("The {kind} script failed (log: {})", log.display()))
    }
}

/// After a worktree is made: its setup script, in the background, if the repo has one.
pub fn setup_in_background(app: &AppHandle, workspace: PathBuf) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Some((_, main)) = roots(&workspace) else { return };
        if let Some(setup) = scripts_for(&app, &main).setup.filter(|s| !s.trim().is_empty()) {
            let _ = run_blocking(&app, "setup", &setup, &workspace);
        }
    });
}

/// What the Run tab needs: the scripts, the workspace's port and the variables.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub scripts: Scripts,
    pub port: u16,
    pub env: Vec<(String, String)>,
    pub path: String,
    pub root: String,
    /// A worktree of its own (not the repo's main checkout): it can be archived.
    pub worktree: bool,
}

#[tauri::command]
pub fn workspace_info(app: AppHandle, cwd: String) -> Result<Workspace, String> {
    let (top, main) = roots(Path::new(&cwd)).ok_or("Not a git repository.")?;
    Ok(Workspace {
        scripts: scripts_for(&app, &main),
        port: port_for(&app, &top),
        env: env_for(&app, &top),
        path: top.to_string_lossy().to_string(),
        root: main.to_string_lossy().to_string(),
        worktree: top != main,
    })
}

/// Scripts kept by OpenAdmiral for a repo without Conductor's files.
#[tauri::command]
pub fn workspace_scripts_save(app: AppHandle, cwd: String, setup: Option<String>, run: Option<String>, archive: Option<String>) -> Result<(), String> {
    let (_, main) = roots(Path::new(&cwd)).ok_or("Not a git repository.")?;
    let clean = |s: Option<String>| s.map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
    let mut all = own_all(&app);
    all.insert(
        main.to_string_lossy().to_string(),
        Scripts { setup: clean(setup), archive: clean(archive), run: clean(run).map(|c| vec![RunAction { id: "run".into(), command: c, default: true }]).unwrap_or_default(), ..Default::default() },
    );
    let path = own_path(&app).ok_or("no app data dir")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(path, serde_json::to_string_pretty(&all).unwrap_or_default()).map_err(|e| e.to_string())
}

/// Runs the setup script again (Run tab → Run setup).
#[tauri::command]
pub async fn workspace_setup(app: AppHandle, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (top, main) = roots(Path::new(&cwd)).ok_or("Not a git repository.")?;
        let setup = scripts_for(&app, &main).setup.filter(|s| !s.trim().is_empty()).ok_or("This repo has no setup script.")?;
        run_blocking(&app, "setup", &setup, &top)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Archives a workspace: its archive script, then its uncommitted changes kept in a git ref
/// (refs/openadmiral/archived/<name>), then the worktree removed. The branch stays.
#[tauri::command]
pub async fn workspace_archive(app: AppHandle, cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (top, main) = roots(Path::new(&cwd)).ok_or("Not a git repository.")?;
        if top == main {
            return Err("This is the repo's main checkout, not a workspace of its own.".into());
        }
        if let Some(archive) = scripts_for(&app, &main).archive.filter(|s| !s.trim().is_empty()) {
            run_blocking(&app, "archive", &archive, &top)?;
        }
        let name = top.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "workspace".into());
        let mut kept = String::new();
        // Uncommitted work (untracked files too) as a commit no branch points at, kept under a ref.
        let _ = git(&top, &["add", "-A"]);
        if let Some(sha) = git(&top, &["stash", "create", &format!("OpenAdmiral: {name} when archived")]) {
            let r = format!("refs/openadmiral/archived/{name}");
            git(&main, &["update-ref", &r, &sha]).ok_or("Could not keep the uncommitted changes.")?;
            kept = format!(" Its uncommitted changes are kept in {r} (git stash apply {r}).");
        }
        let branch = git(&top, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
        let out = Command::new("git").env("PATH", crate::login_path()).arg("-C").arg(&main).args(["worktree", "remove", "--force"]).arg(&top).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(format!("Archived {name}; its branch {branch} stays.{kept}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_conductors_toml() {
        let s = parse_toml(
            r#"
[scripts]
setup = "pnpm install"
archive = "docker compose down"
run_mode = "nonconcurrent"
[scripts.run.web]
command = "pnpm"
args = ["dev", "--port", "$CONDUCTOR_PORT"]
default = true
[scripts.run.hidden]
command = "x"
hide = true
[[preview_urls]]
name = "App"
url = "http://localhost:$((CONDUCTOR_PORT+0))"
"#,
        );
        assert_eq!(s.setup.as_deref(), Some("pnpm install"));
        assert_eq!(s.archive.as_deref(), Some("docker compose down"));
        assert_eq!(s.run, vec![RunAction { id: "web".into(), command: "pnpm dev --port '$CONDUCTOR_PORT'".into(), default: true }]);
        assert_eq!(s.preview_urls.len(), 1);
    }

    #[test]
    fn reads_the_older_json() {
        let s = parse_json(r#"{"scripts":{"setup":"npm i","run":"npm run dev"},"runScriptMode":"concurrent"}"#);
        assert_eq!(s.setup.as_deref(), Some("npm i"));
        assert_eq!(s.run[0].command, "npm run dev");
    }

    #[test]
    fn a_run_string_is_one_action() {
        assert_eq!(parse_toml("[scripts]\nrun = \"make dev\"").run, vec![RunAction { id: "run".into(), command: "make dev".into(), default: true }]);
    }
}
