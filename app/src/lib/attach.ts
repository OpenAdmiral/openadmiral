/**
 * `claude attach` drops into Claude's own agent view when the person types
 * /exit in the attached session: the session keeps running in the background,
 * and the client starts a new, unregistered process of its own. Two signals
 * mark the switch: the terminal title becomes "claude agents", and the view's
 * prompt reads "describe a task for a new session".
 */
const TITLE = /\x1b\]0;[^\x07\x1b]*claude agents/;
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
const PHRASE = "describeataskforanewsession";

/** Escapes out, all whitespace out (the TUI moves the cursor between words), lower case. */
export const normalize = (text: string) => text.replace(ESCAPES, "").replace(/\s+/g, "").toLowerCase();

/**
 * Feeds terminal output in order; answers true once the agent view shows up.
 * Keeps a short tail so a phrase split across chunks is still found.
 */
export function agentViewDetector() {
  let tail = "";
  return (chunk: string) => {
    const text = tail + chunk;
    tail = text.slice(-400);
    return TITLE.test(text) || normalize(text).includes(PHRASE);
  };
}
