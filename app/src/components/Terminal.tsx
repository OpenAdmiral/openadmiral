import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { RefreshLinearIcon } from "@solar-icons/react";
import { cn } from "@/lib/utils";
import { optionComposedChar } from "@/lib/keys";
import { agentViewDetector } from "@/lib/attach";
import { pasteAction, pathsText, type ClipboardKind } from "@/lib/paste";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * One dark theme in both appearances: Claude Code paints with its own (usually dark)
 * theme, which a white terminal turns into black bands and unreadable dim text. The
 * terminal card is dark in light mode too (--color-term).
 */
const THEME: ITheme = {
  background: "#00000000",
  foreground: "#e5e7eb",
  cursor: "#5c8bff",
  cursorAccent: "#15171c",
  selectionBackground: "#0241e366",
  black: "#1f2937", red: "#ef4444", green: "#22c55e", yellow: "#f59e0b",
  blue: "#5c8bff", magenta: "#c084fc", cyan: "#22d3ee", white: "#e5e7eb",
  brightBlack: "#6b7280", brightRed: "#f87171", brightGreen: "#4ade80", brightYellow: "#fbbf24",
  brightBlue: "#94b8ff", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#ffffff",
};

/** One xterm per agent, kept across agent switches; its element moves between hosts. */
type Live = {
  term: XTerm;
  fit: FitAddon;
  el: HTMLDivElement;
  spawned: boolean;
  exited: boolean;
  /** The attach client dropped into Claude's agent view (/exit typed in the session). */
  left: boolean;
  detect: (chunk: string) => boolean;
  /** While a redraw nudge has the pty one column narrower: that frame is not shown. */
  muted?: boolean;
  onExit?: () => void;
  onLeft?: () => void;
};
const live = new Map<string, Live>();

// One listener for every terminal: output keeps flowing into hidden ones too.
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  listen<{ key: string; data: string }>("pty://data", (e) => {
    const t = live.get(e.payload.key);
    if (!t) return;
    // /exit in an attached session leaves the session running and puts the client in
    // Claude's agent view, a new unregistered process: end that client, not the session.
    if (!t.left && !e.payload.key.startsWith("trust:") && t.detect(e.payload.data)) {
      t.left = true;
      t.exited = true;
      invoke("pty_kill", { key: e.payload.key }).catch(() => {});
      t.onLeft?.();
      return;
    }
    if (!t.left && !t.muted) t.term.write(e.payload.data);
  });
  listen<{ key: string }>("pty://exit", (e) => {
    const t = live.get(e.payload.key);
    if (!t) return;
    t.exited = true;
    invoke("pty_kill", { key: e.payload.key }).catch(() => {});
    t.onExit?.();
  });
  // The window shown again (from the tray, another app): repaint what is on screen.
  window.addEventListener("focus", () => {
    for (const [key, t] of live) if (visible(t)) repaintTerminal(key);
  });
}

function create(key: string): Live {
  const el = document.createElement("div");
  el.style.height = "100%";
  const term = new XTerm({
    fontFamily: '"JetBrains Mono Variable", "SF Mono", Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.25,
    cursorBlink: true,
    cursorStyle: "bar",
    allowTransparency: true,
    macOptionIsMeta: true,
    scrollback: 8000,
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData((data) => invoke("pty_write", { key, data }).catch(() => {}));
  // ⌥ stays Meta for word moves, but a symbol ⌥ composes (Spanish ⌥2 "@") is typed as is.
  term.attachCustomKeyEventHandler((e) => {
    const ch = optionComposedChar(e);
    if (ch === null) return true;
    e.preventDefault();
    invoke("pty_write", { key, data: ch }).catch(() => {});
    return false;
  });
  term.onResize(({ cols, rows }) => invoke("pty_resize", { key, cols, rows }).catch(() => {}));
  // ⌘V as Terminal.app does it: a Finder copy pastes the files' paths (the web clipboard
  // would hand over the file's icon), a raw image sends Ctrl+V for Claude Code to read the
  // image itself, text pastes as text. Capture phase: ahead of xterm's own paste handler.
  el.addEventListener(
    "paste",
    (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      invoke<ClipboardKind>("clipboard_read")
        .catch((): ClipboardKind => ({ kind: text ? "text" : "empty" }))
        .then((clip) => {
          const act = pasteAction(clip, text);
          if (!act) return;
          if (act.type === "text") term.paste(act.data);
          else invoke("pty_write", { key, data: act.data }).catch(() => {});
        });
    },
    true,
  );
  const t: Live ={ term, fit, el, spawned: false, exited: false, left: false, detect: agentViewDetector() };
  live.set(key, t);
  return t;
}

/** A terminal laid out on screen: never fit one that is hidden (display:none) or 0×0. */
const visible = (t: Live) => t.el.isConnected && t.el.offsetParent !== null && t.el.clientWidth > 0 && t.el.clientHeight > 0;

const repaints = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Brings a terminal's screen back in full. Claude Code's fullscreen TUI repaints only
 * what changed, so after the pty was resized while hidden or mid-animation the screen
 * is left stale. Once things settle: fit to the visible size; if that size did not
 * change, nudge the pty one column narrower and back so the TUI gets SIGWINCH and
 * redraws everything; then repaint xterm's own rows. Debounced per terminal.
 * The TUI coalesces resizes: back within one frame (16 ms) it sees no change and
 * redraws nothing, from 60 ms on it redraws in full (measured on `claude attach`).
 * The narrow frame it draws meanwhile is not shown (it would flash text reflowed one
 * column narrower): the redraw at the restored width clears the screen and paints it all.
 */
export function repaintTerminal(key: string, delay = 140) {
  clearTimeout(repaints.get(key));
  repaints.set(
    key,
    setTimeout(() => {
      repaints.delete(key);
      const t = live.get(key);
      if (!t || t.exited || !t.spawned || !visible(t)) return;
      const { cols, rows } = t.term;
      try {
        t.fit.fit();
      } catch {
        return;
      }
      if (t.term.cols === cols && t.term.rows === rows) {
        const unmute = () => (t.muted = false);
        t.muted = true;
        setTimeout(unmute, 1000); // never stays silent, whatever happens below
        invoke("pty_resize", { key, cols: Math.max(2, cols - 1), rows })
          .then(() => new Promise((r) => setTimeout(r, 150)))
          .then(() => {
            unmute();
            return invoke("pty_resize", { key, cols, rows });
          })
          .catch(unmute);
      }
      t.term.refresh(0, t.term.rows - 1);
    }, delay),
  );
}

/** What the terminal shows now (preview checks): non-empty rows, characters, a sample. */
export function screenOf(key: string) {
  const t = live.get(key);
  if (!t) return null;
  const buf = t.term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < t.term.rows; i++) lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
  const filled = lines.filter((l) => l.trim());
  return { rows: t.term.rows, cols: t.term.cols, nonEmptyRows: filled.length, chars: filled.join("").replace(/\s/g, "").length, sample: filled.slice(0, 3).join(" | ").slice(0, 160) };
}

/** Puts the keyboard in an agent's terminal (after it is shown). */
/** Types into an agent's open terminal (no Enter: the user confirms there). False when it has none. */
export function typeIntoTerminal(key: string, text: string) {
  if (!live.has(key)) return false;
  invoke("pty_write", { key, data: text }).catch(() => {});
  focusTerminal(key);
  return true;
}

export function focusTerminal(key: string) {
  // Two frames: the tab's panel becomes visible on the first, xterm can take focus on the second.
  requestAnimationFrame(() => requestAnimationFrame(() => live.get(key)?.term.focus()));
}

/** Ends a terminal for good: its process and its xterm. */
export function disposeTerminal(key: string) {
  const t = live.get(key);
  invoke("pty_kill", { key }).catch(() => {});
  if (!t) return;
  live.delete(key);
  t.term.dispose();
  t.el.remove();
}

async function spawn(key: string, t: Live, argv: string[], cwd: string) {
  t.spawned = true;
  t.exited = false;
  t.left = false;
  t.detect = agentViewDetector();
  await invoke("pty_open", { key, argv, cwd, cols: t.term.cols, rows: t.term.rows });
  // Attaching to a session mid-turn, Claude Code only sends what changes next, so the
  // screen can stay empty until something new arrives. Ask for a full redraw once the
  // attach has settled, and again a little later for a slow one.
  repaintTerminal(key, 1200);
  setTimeout(() => repaintTerminal(key), 4000);
}

export function AgentTerminal({ agentKey, argv, cwd, className, onCloseSession }: { agentKey: string; argv: string[]; cwd: string; className?: string; onCloseSession?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState(false);
  const [left, setLeft] = useState(false);

  useEffect(() => {
    wire();
    const t = live.get(agentKey) ?? create(agentKey);
    t.onExit = () => setExited(true);
    t.onLeft = () => setLeft(true);
    setExited(t.exited);
    setLeft(t.left);
    host.current?.appendChild(t.el);
    // Fit after layout so the PTY starts at the size it is shown at.
    const frame = requestAnimationFrame(() => {
      try { t.fit.fit(); } catch { /* host not laid out yet */ }
      if (!t.spawned) spawn(agentKey, t, argv, cwd).catch((err) => t.term.writeln(`\r\n\x1b[31m${err}\x1b[0m`));
      t.term.focus();
    });
    // Refit and repaint once the size settles (a panel's animation ends, the tab shows
    // again), not on every frame: each fit resizes the pty and makes the TUI redraw.
    const ro = new ResizeObserver(() => repaintTerminal(agentKey));
    if (host.current) ro.observe(host.current);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      t.onExit = undefined;
      t.onLeft = undefined;
      t.el.remove();
    };
    // argv and cwd are fixed for a key: a new agent is a new key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentKey]);

  // Files dropped on the terminal type their paths, as in Terminal.app; it lights up while dragged over.
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    const inside = (p: { x: number; y: number }) => {
      const el = host.current;
      if (!el || el.offsetParent === null) return false;
      const r = el.getBoundingClientRect();
      const x = p.x / window.devicePixelRatio, y = p.y / window.devicePixelRatio;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDropping(inside(p.position));
      else if (p.type === "leave") setDropping(false);
      else if (p.type === "drop") {
        setDropping(false);
        const t = live.get(agentKey);
        if (t && !t.exited && inside(p.position) && p.paths.length) {
          t.term.paste(pathsText(p.paths));
          t.term.focus();
        }
      }
    });
    return () => {
      off.then((f) => f());
    };
  }, [agentKey]);

  const reattach = () => {
    const t = live.get(agentKey);
    if (!t) return;
    t.term.writeln("\r\n\x1b[2m— reattaching —\x1b[0m");
    setExited(false);
    setLeft(false);
    // spawn asks for the full redraws itself.
    spawn(agentKey, t, argv, cwd).catch((err) => t.term.writeln(`\r\n\x1b[31m${err}\x1b[0m`));
    t.term.focus();
  };

  return (
    <div className={cn("relative min-h-0", className)}>
      <div ref={host} className="absolute inset-0" />
      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-end justify-center rounded-xl border-2 border-dashed border-brand-500/70 bg-brand-500/10 pb-6">
          <span className="rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white shadow-lg">Drop to paste the path</span>
        </div>
      )}
      {left && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-canvas/85 backdrop-blur-sm">
          <div className="w-[380px] rounded-2xl border border-line-strong bg-canvas p-5 text-center shadow-xl">
            <p className="text-sm font-semibold text-ink">You left this session</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">It is still running in the background. Typing /exit in an attached session only closes the view, not the session.</p>
            <div className="mt-4 flex justify-center gap-2">
              {onCloseSession && (
                <button onClick={onCloseSession} className="rounded-lg border border-line-strong px-3.5 py-1.5 text-xs font-semibold text-ink-2 transition-all hover:bg-line">
                  Close session
                </button>
              )}
              <button onClick={reattach} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:bg-brand-700">
                <RefreshLinearIcon size={14} />
                Reattach
              </button>
            </div>
          </div>
        </div>
      )}
      {exited && !left && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-line bg-panel/95 px-4 py-2.5 backdrop-blur">
          <span className="text-xs text-ink-2">Detached from the session. It keeps running in OpenAdmiral.</span>
          <button
            onClick={reattach}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-all duration-200 hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
          >
            <RefreshLinearIcon size={14} />
            Reattach
          </button>
        </div>
      )}
    </div>
  );
}
