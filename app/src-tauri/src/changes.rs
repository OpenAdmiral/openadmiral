//! An agent's changes, for the Changes tab: everything its checkout differs from where
//! its branch started (the merge base with the default branch), committed or not, plus
//! new files git does not track yet. On the default branch itself, only what is not
//! committed. Read-only: plain `git diff`, nothing is staged or written.

use serde::Serialize;
use std::process::Command;

/// Per file and in total: past this the diff is cut, and the tab says so.
const FILE_MAX: usize = 300_000;
const TOTAL_MAX: usize = 2_000_000;
const UNTRACKED_MAX: usize = 60;

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// The path before a rename.
    pub from: Option<String>,
    /// "added", "deleted", "renamed", "modified".
    pub status: &'static str,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
    /// The unified diff's hunks (from the first "@@"), "" for a binary file.
    pub hunks: String,
    pub truncated: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub root: String,
    pub branch: Option<String>,
    /// What the changes are measured against: "origin/main", or "HEAD" for uncommitted only.
    pub base: String,
    pub default_branch: Option<String>,
    /// Commits on this branch since the base.
    pub commits: usize,
    pub files: Vec<FileChange>,
    pub truncated: bool,
}

fn git(root: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git").env("PATH", crate::login_path()).arg("-C").arg(root).args(args).output().ok()?;
    // `diff --no-index` answers 1 when the files differ: that is its success.
    (out.status.success() || out.status.code() == Some(1)).then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn trimmed(root: &str, args: &[&str]) -> Option<String> {
    git(root, args).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The branch new work starts from: origin's HEAD, else a local main or master.
fn default_branch(root: &str) -> Option<String> {
    if let Some(h) = trimmed(root, &["rev-parse", "--abbrev-ref", "origin/HEAD"]).filter(|h| h != "origin/HEAD") {
        return Some(h);
    }
    ["main", "master"].into_iter().find(|b| trimmed(root, &["rev-parse", "--verify", "--quiet", b]).is_some()).map(str::to_string)
}

#[tauri::command]
pub async fn agent_changes(cwd: String) -> Result<Changes, String> {
    tauri::async_runtime::spawn_blocking(move || read(&cwd)).await.map_err(|e| e.to_string())?
}

fn read(cwd: &str) -> Result<Changes, String> {
    let root = trimmed(cwd, &["rev-parse", "--show-toplevel"]).ok_or("This folder is not in a git repository.")?;
    let branch = trimmed(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD");
    let default = default_branch(&root);
    let on_default = match (&branch, &default) {
        (Some(b), Some(d)) => d == b || d.strip_prefix("origin/") == Some(b.as_str()),
        _ => true,
    };
    let (base, against) = match (&default, on_default) {
        (Some(d), false) => match trimmed(&root, &["merge-base", "HEAD", d]) {
            Some(sha) => (d.clone(), sha),
            None => ("HEAD".to_string(), "HEAD".to_string()),
        },
        _ => ("HEAD".to_string(), "HEAD".to_string()),
    };
    let commits = if against == "HEAD" { 0 } else { trimmed(&root, &["rev-list", "--count", &format!("{against}..HEAD")]).and_then(|n| n.parse().ok()).unwrap_or(0) };

    let diff = git(&root, &["diff", "--no-color", "--no-ext-diff", "-M", &against]).unwrap_or_default();
    let mut files = parse(&diff);
    let untracked = git(&root, &["ls-files", "--others", "--exclude-standard", "-z"]).unwrap_or_default();
    for path in untracked.split('\0').filter(|p| !p.is_empty()).take(UNTRACKED_MAX) {
        let full = std::path::Path::new(&root).join(path);
        if std::fs::metadata(&full).map(|m| m.len() > FILE_MAX as u64).unwrap_or(true) {
            files.push(FileChange { path: path.to_string(), status: "added", truncated: true, ..Default::default() });
            continue;
        }
        let one = git(&root, &["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path]).unwrap_or_default();
        files.extend(parse(&one).into_iter().map(|mut f| {
            f.path = path.to_string();
            f.status = "added";
            f
        }));
    }
    let mut total = 0;
    let mut truncated = false;
    for f in files.iter_mut() {
        total += f.hunks.len();
        if total > TOTAL_MAX {
            f.hunks.clear();
            f.truncated = true;
            truncated = true;
        }
    }
    Ok(Changes { root, branch, base, default_branch: default, commits, files, truncated })
}

/// A unified diff split by file: path, kind, counts and the hunks.
pub fn parse(diff: &str) -> Vec<FileChange> {
    let mut files = Vec::new();
    for chunk in diff.split("\ndiff --git ").map(|c| c.strip_prefix("diff --git ").unwrap_or(c)) {
        if chunk.trim().is_empty() {
            continue;
        }
        let mut f = FileChange { status: "modified", ..Default::default() };
        let header_end = chunk.find("\n@@").map(|i| i + 1).unwrap_or(chunk.len());
        let header = &chunk[..header_end];
        // "a/x b/x" on the first line; the ---/+++ lines are surer when present.
        if let Some(first) = header.lines().next() {
            if let Some((a, b)) = first.split_once(" b/") {
                f.path = b.to_string();
                f.from = Some(a.trim_start_matches("a/").to_string());
            }
        }
        for line in header.lines() {
            if line.starts_with("new file mode") {
                f.status = "added";
            } else if line.starts_with("deleted file mode") {
                f.status = "deleted";
            } else if let Some(p) = line.strip_prefix("rename to ") {
                f.status = "renamed";
                f.path = p.to_string();
            } else if let Some(p) = line.strip_prefix("rename from ") {
                f.from = Some(p.to_string());
            } else if let Some(p) = line.strip_prefix("+++ b/") {
                f.path = p.to_string();
            } else if line.starts_with("--- a/") && f.status == "deleted" {
                f.path = line[6..].to_string();
            } else if line.starts_with("Binary files") {
                f.binary = true;
            }
        }
        if f.status != "renamed" {
            f.from = None;
        }
        let hunks = &chunk[header_end..];
        for line in hunks.lines() {
            if line.starts_with('+') {
                f.additions += 1;
            } else if line.starts_with('-') {
                f.deletions += 1;
            }
        }
        if hunks.len() > FILE_MAX {
            let mut cut = FILE_MAX;
            while !hunks.is_char_boundary(cut) {
                cut -= 1;
            }
            f.hunks = hunks[..cut].to_string();
            f.truncated = true;
        } else {
            f.hunks = hunks.trim_end_matches('\n').to_string();
        }
        files.push(f);
    }
    files
}

#[cfg(test)]
mod tests {
    use super::parse;

    const DIFF: &str = "diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 keep
-old
+new
+more
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.md b/new name.md
similarity index 90%
rename from old name.md
rename to new name.md
diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
";

    #[test]
    fn splits_a_diff_by_file() {
        let f = parse(DIFF);
        assert_eq!(f.len(), 4);
        assert_eq!((f[0].path.as_str(), f[0].status, f[0].additions, f[0].deletions), ("src/a.ts", "modified", 2, 1));
        assert!(f[0].hunks.starts_with("@@ -1,2 +1,3 @@"));
        assert_eq!((f[1].path.as_str(), f[1].status, f[1].deletions), ("gone.txt", "deleted", 1));
        assert_eq!((f[2].path.as_str(), f[2].status, f[2].from.as_deref()), ("new name.md", "renamed", Some("old name.md")));
        assert!(f[3].binary && f[3].status == "added" && f[3].path == "logo.png");
    }
}
