/**
 * The agent the last "needs you" notification was about. macOS does not tell a
 * Tauri app that its notification was clicked, only that the window came
 * forward; so when OpenAdmiral is focused soon after one, it opens that agent.
 */
const WINDOW_MS = 10 * 60_000;
let pending: { agentId: string; at: number } | null = null;

export function noteAttention(agentId: string, at = Date.now()) {
  pending = { agentId, at };
}

/** The agent to open on focus, once: only a recent notification, and only while it still needs you. */
export function takeAttention(stillWaiting: (agentId: string) => boolean, now = Date.now()) {
  const p = pending;
  pending = null;
  return p && now - p.at < WINDOW_MS && stillWaiting(p.agentId) ? p.agentId : null;
}
