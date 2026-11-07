//! Workspaces: a new agent in a checkout of its own, started from an existing branch, a
//! pull request or an issue (New agent → Start from). A branch or a pull request gets a git
//! worktree made here under `.claude/worktrees/<name>`, the same place `claude -w` uses; an
//! issue starts a fresh worktree (`claude -w`) with the issue as its first instruction.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum StartFrom {
    Branch(String),
    Pr(String),
    Issue(String),
}

/// Where the agent starts and what it is told first.
#[derive(Debug, Default)]
pub struct Prepared {
    /// A worktree made here: start the agent in it, without `-w`.
    pub cwd: Option<PathBuf>,
    /// For an issue: start with `claude -w <name>`.
    pub worktree: Option<String>,
    /// Put before the person's own first instruction.
    pub brief: Option<String>,
    /// A name for the agent, when the person gave none.
    pub name: Option<String>,
}

fn run(dir: &Path, program: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(program).env("PATH", crate::login_path()).env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1").current_dir(dir).args(args).output().map_err(|e| format!("{program}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("{program} {} failed", args.join(" ")) } else { err })
    }
}

/// A pull request or issue number from "123", "#123" or a GitHub URL.
pub fn number_of(s: &str) -> Option<String> {
    let s = s.trim().trim_end_matches('/');
    let tail = s.rsplit('/').next().unwrap_or(s).trim_start_matches('#');
    (!tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit())).then(|| tail.to_string())
}

/// `.claude/worktrees/<slug>` in the repo, not taken yet (a number is added if it is).
fn free_path(root: &Path, slug: &str) -> PathBuf {
    let base = root.join(".claude").join("worktrees");
    let mut path = base.join(slug);
    let mut n = 2;
    while path.exists() {
        path = base.join(format!("{slug}-{n}"));
        n += 1;
    }
    path
}

/// A fresh worktree on a new branch `oa/<name>`, for an agent that has no `-w` of its own (Codex).
pub fn new_worktree(cwd: &str, name: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(run(Path::new(cwd), "git", &["rev-parse", "--show-toplevel"]).map_err(|_| "A worktree needs a folder in a git repository.")?);
    let slug = crate::worktree_slug(name);
    let path = free_path(&root, &slug);
    let leaf = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(slug);
    run(&root, "git", &["worktree", "add", "-b", &format!("oa/{leaf}"), &path.to_string_lossy()])?;
    Ok(path)
}

pub fn prepare(cwd: &str, from: &StartFrom) -> Result<Prepared, String> {
    let dir = Path::new(cwd);
    let root = PathBuf::from(run(dir, "git", &["rev-parse", "--show-toplevel"]).map_err(|_| "Start from needs a folder in a git repository.")?);
    match from {
        StartFrom::Branch(b) => {
            let branch = b.trim().trim_start_matches("origin/");
            if branch.is_empty() {
                return Err("Which branch?".into());
            }
            let path = free_path(&root, &crate::worktree_slug(branch));
            let p = path.to_string_lossy().to_string();
            let local = run(&root, "git", &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
            if local {
                run(&root, "git", &["worktree", "add", &p, branch])?;
            } else {
                run(&root, "git", &["fetch", "origin", branch]).map_err(|e| format!("No branch {branch} here or on origin: {e}"))?;
                run(&root, "git", &["worktree", "add", "--track", "-b", branch, &p, &format!("origin/{branch}")])?;
            }
            Ok(Prepared { cwd: Some(path), name: Some(branch.to_string()), ..Default::default() })
        }
        StartFrom::Pr(v) => {
            let n = number_of(v).ok_or("A pull request number or link, like 123 or …/pull/123.")?;
            let title = run(&root, "gh", &["pr", "view", &n, "--json", "title", "--jq", ".title"]).map_err(|e| format!("Pull request #{n}: {e}"))?;
            let path = free_path(&root, &format!("pr-{n}"));
            let p = path.to_string_lossy().to_string();
            // A detached checkout first; `gh pr checkout` then puts the PR's branch in it (forks too).
            run(&root, "git", &["worktree", "add", "--detach", &p])?;
            if let Err(e) = run(&path, "gh", &["pr", "checkout", &n]) {
                let _ = run(&root, "git", &["worktree", "remove", "--force", &p]);
                return Err(format!("Pull request #{n}: {e}"));
            }
            Ok(Prepared {
                cwd: Some(path),
                name: Some(format!("pr-{n}")),
                brief: Some(format!("You are on the branch of pull request #{n}, \"{title}\". Read it with `gh pr view {n} --comments` before you start.")),
                ..Default::default()
            })
        }
        StartFrom::Issue(v) => {
            let n = number_of(v).ok_or("An issue number or link, like 42 or …/issues/42.")?;
            let issue = run(&root, "gh", &["issue", "view", &n, "--json", "title,body,url"]).map_err(|e| format!("Issue #{n}: {e}"))?;
            let j: serde_json::Value = serde_json::from_str(&issue).map_err(|e| e.to_string())?;
            let title = j["title"].as_str().unwrap_or("").to_string();
            let body = j["body"].as_str().unwrap_or("").chars().take(6000).collect::<String>();
            let url = j["url"].as_str().unwrap_or("");
            let slug = crate::worktree_slug(&format!("issue-{n}-{title}"));
            Ok(Prepared {
                worktree: Some(slug.chars().take(40).collect::<String>().trim_end_matches('-').to_string()),
                name: Some(format!("issue-{n}")),
                brief: Some(format!("Work on issue #{n}: {title}\n{url}\n\n{body}")),
                ..Default::default()
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    #[test]
    fn a_branch_gets_a_worktree_of_its_own() {
        let dir = std::env::temp_dir().join(format!("oa-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| assert!(Command::new("git").current_dir(&dir).args(args).output().unwrap().status.success(), "git {args:?}");
        git(&["init", "-q", "-b", "main"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
        git(&["branch", "feat/x"]);
        let p = super::prepare(dir.to_str().unwrap(), &super::StartFrom::Branch("feat/x".into())).unwrap();
        let wt = p.cwd.unwrap();
        assert!(wt.ends_with(".claude/worktrees/feat-x"));
        let head = Command::new("git").current_dir(&wt).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "feat/x");
        assert_eq!(p.name.as_deref(), Some("feat/x"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn numbers_from_links() {
        assert_eq!(super::number_of("123").as_deref(), Some("123"));
        assert_eq!(super::number_of("#42").as_deref(), Some("42"));
        assert_eq!(super::number_of("https://github.com/o/r/pull/77/").as_deref(), Some("77"));
        assert_eq!(super::number_of("https://github.com/o/r/issues/9").as_deref(), Some("9"));
        assert_eq!(super::number_of("main"), None);
    }
}
