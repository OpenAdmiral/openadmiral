//! Which background job a session id belongs to.
//!
//! `/clear` keeps a background job (its short `id`, the FIRST session id's
//! prefix) but gives the session a new id; the OpenAdmiral plugin then writes
//! `supersededBy: <new id>` on the old session file. While the job runs,
//! `claude agents --json` shows the new id as its `sessionId`; once it is
//! stopped, `claude agents --json --all` lists it under its ORIGINAL session id
//! again. So a post-/clear id has no row of its own in `--all`: walk the
//! `supersededBy` links back to the first id and match the rows by any id in
//! that chain, or by the job id being the chain origin's prefix.
//!
//! Resuming: `claude --bg --resume <the row's sessionId>` with no flags wakes
//! that same job on its latest (post-/clear) conversation. The job id or the
//! post-/clear id starts a copy / a second job instead (tried 2026-10-08).

use serde_json::Value;
use std::path::Path;

/// A background job as `claude agents --json [--all]` lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    /// Short job id: what `claude stop` / `claude rm` / `claude attach` take.
    pub id: String,
    /// The session id the CLI lists the job under: the live one while it runs,
    /// the original one once it stopped. Pass this to `--resume`.
    pub session_id: String,
    pub name: Option<String>,
}

/// `old id → new id` links from the mod's session files (`supersededBy`).
pub fn read_links(sessions_dir: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(sessions_dir) else { return vec![] };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|s| serde_json::from_str::<Value>(&s).ok())
        .filter_map(|v| Some((v.get("sessionId")?.as_str()?.to_string(), v.get("supersededBy")?.as_str()?.to_string())))
        .collect()
}

/// Every id this session has had, newest first: `[session_id, …, first id]`.
pub fn chain(session_id: &str, links: &[(String, String)]) -> Vec<String> {
    let mut out = vec![session_id.to_string()];
    // Ends by itself: each step adds an id not yet in `out`, so a link cycle cannot hang it.
    // No step limit: a job cleared after every task for weeks has a long chain.
    loop {
        let cur = out.last().unwrap();
        match links.iter().find(|(old, new)| new == cur && !out.contains(old)) {
            Some((old, _)) => out.push(old.clone()),
            None => break,
        }
    }
    out
}

/// The background job (not an interactive session) behind any id in `chain`.
/// A row matches by its `sessionId`, or by its job id being the prefix of the
/// chain's origin (the first session id, which names the job).
pub fn find(rows: &Value, chain: &[String]) -> Option<Job> {
    let rows = rows.as_array()?;
    let s = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).map(str::to_owned);
    let job = |r: &Value| {
        Some(Job { id: s(r, "id").unwrap_or_else(|| s(r, "sessionId").unwrap_or_default().chars().take(8).collect()), session_id: s(r, "sessionId")?, name: s(r, "name") })
    };
    let background = |r: &&Value| r.get("kind").and_then(Value::as_str) != Some("interactive");
    for id in chain {
        if let Some(r) = rows.iter().filter(background).find(|r| r.get("sessionId").and_then(Value::as_str) == Some(id.as_str())) {
            return job(r);
        }
    }
    let origin = chain.last()?;
    rows.iter()
        .filter(background)
        .find(|r| r.get("id").and_then(Value::as_str).is_some_and(|j| j.len() >= 8 && origin.starts_with(j)))
        .and_then(job)
}

/// The chain of `session_id` read from ~/.claude/openadmiral/sessions.
pub fn chain_of(session_id: &str) -> Vec<String> {
    chain(session_id, &read_links(&crate::admiral_dir().join("sessions")))
}

/// The job behind `session_id` in these CLI rows (`claude agents --json`, or `--all`).
pub fn job_of(rows: &Value, session_id: &str) -> Option<Job> {
    find(rows, &chain_of(session_id))
}

/// Is any id this session has had running (as a job, or an interactive session)?
/// Listed with a process. The CLI also lists background jobs that have none (left
/// idle for long, or whose process died): those are parked, serve nothing (their
/// plugin does not run, so Up next waits) and need `claude respawn` to wake.
pub fn is_awake(live: &Value, session_id: &str) -> bool {
    awake_in(live, &chain_of(session_id))
}

fn awake_in(live: &Value, chain: &[String]) -> bool {
    let Some(rows) = live.as_array() else { return false };
    let origin = chain.last().map(String::as_str).unwrap_or("");
    rows.iter().any(|r| {
        let sid = r.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let id = r.get("id").and_then(Value::as_str).unwrap_or("");
        let ours = chain.iter().any(|c| c == sid) || (id.len() >= 8 && origin.starts_with(id));
        ours && r.get("pid").is_some_and(|p| !p.is_null())
    })
}

pub fn is_running(live: &Value, session_id: &str) -> bool {
    let ids = chain_of(session_id);
    ids.iter().any(|id| crate::is_listed(live, id)) || find(live, &ids).is_some()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_listed_job_without_a_process_is_parked() {
        use serde_json::json;
        let rows = json!([{ "id": "abcd1234", "sessionId": "abcd1234-x", "pid": null }, { "id": "efgh5678", "sessionId": "efgh5678-y", "pid": 42 }]);
        assert!(!super::awake_in(&rows, &["abcd1234-x".into()]));
        assert!(super::awake_in(&rows, &["efgh5678-y".into()]));
        assert!(!super::awake_in(&rows, &["zzz".into()]));
    }

    use super::*;
    use serde_json::json;

    const ORIGIN: &str = "14ff2229-c7d1-4128-878f-fce155fac943";
    const CLEARED: &str = "92b27520-43b0-4db1-9e43-26d221c305bf";
    const TWICE: &str = "aa11bb22-0000-4000-8000-000000000003";

    fn links() -> Vec<(String, String)> {
        vec![(ORIGIN.into(), CLEARED.into()), (CLEARED.into(), TWICE.into()), ("x".into(), "y".into())]
    }

    #[test]
    fn walks_superseded_links_back_to_the_first_id() {
        assert_eq!(chain(TWICE, &links()), vec![TWICE, CLEARED, ORIGIN]);
        assert_eq!(chain(CLEARED, &links()), vec![CLEARED, ORIGIN]);
        assert_eq!(chain(ORIGIN, &links()), vec![ORIGIN]);
        assert_eq!(chain("other", &links()), vec!["other"]);
        // A cycle ends instead of looping.
        let cyc = vec![("a".to_string(), "b".to_string()), ("b".to_string(), "a".to_string())];
        assert_eq!(chain("a", &cyc), vec!["a", "b"]);
    }

    #[test]
    fn a_stopped_job_is_found_from_its_post_clear_id() {
        // After /clear + stop, `--all` lists the job under its ORIGINAL id.
        let all = json!([
            { "id": "e421b341", "kind": "background", "sessionId": "e421b341-8056-4592-8e48-072a8b789b4b", "state": "done" },
            { "id": "14ff2229", "kind": "background", "sessionId": ORIGIN, "name": "admiral-rtest-31", "state": "done" },
        ]);
        let want = Some(Job { id: "14ff2229".into(), session_id: ORIGIN.into(), name: Some("admiral-rtest-31".into()) });
        assert_eq!(find(&all, &chain(CLEARED, &links())), want);
        assert_eq!(find(&all, &chain(TWICE, &links())), want);
        // Without the mod's links there is nothing to tie the new id to the job.
        assert_eq!(find(&all, &chain(CLEARED, &[])), None);
    }

    #[test]
    fn a_running_job_is_listed_under_its_live_id() {
        let live = json!([{ "id": "14ff2229", "kind": "background", "sessionId": CLEARED, "status": "idle" }]);
        assert_eq!(find(&live, &chain(CLEARED, &[])).map(|j| j.id), Some("14ff2229".into()));
        // The pre-clear id finds it too: by the job id being its prefix.
        assert_eq!(find(&live, &[ORIGIN.to_string()]).map(|j| j.session_id), Some(CLEARED.into()));
    }

    #[test]
    fn interactive_sessions_and_strangers_are_not_jobs() {
        let rows = json!([
            { "id": "14ff2229", "kind": "interactive", "sessionId": ORIGIN },
            { "id": "92b27520", "kind": "background", "sessionId": "92b27520-ffff-4000-8000-000000000000" },
        ]);
        assert_eq!(find(&rows, &chain(CLEARED, &links())), None);
        assert_eq!(find(&json!([]), &[ORIGIN.to_string()]), None);
        assert_eq!(find(&json!({}), &[ORIGIN.to_string()]), None);
    }

    #[test]
    fn an_exact_session_id_wins_over_a_prefix_match() {
        // A copy started from the job has its own id; asking for the copy finds the copy.
        let rows = json!([
            { "id": "14ff2229", "kind": "background", "sessionId": ORIGIN },
            { "id": "0076ba14", "kind": "background", "sessionId": "0076ba14-c88a-4a20-b438-74d475691bbb" },
        ]);
        let copy = find(&rows, &["0076ba14-c88a-4a20-b438-74d475691bbb".to_string()]).unwrap();
        assert_eq!(copy.id, "0076ba14");
    }

    #[test]
    fn a_long_lived_job_cleared_many_times_still_reaches_its_origin() {
        // A job kept for weeks: /clear after every task, 40 times.
        let ids: Vec<String> = (0..=40).map(|n| format!("{n:08x}-0000-4000-8000-000000000000")).collect();
        let links: Vec<(String, String)> = ids.windows(2).map(|w| (w[0].clone(), w[1].clone())).collect();
        let got = chain(ids.last().unwrap(), &links);
        assert_eq!(got.len(), 41);
        assert_eq!(got.last(), ids.first());
        let rows = json!([{ "id": "00000000", "kind": "background", "sessionId": ids[0], "state": "done" }]);
        assert_eq!(find(&rows, &got).map(|j| j.id), Some("00000000".into()));
    }
}
