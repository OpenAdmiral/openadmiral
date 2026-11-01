import { invoke } from "@tauri-apps/api/core";
import { debugTrace, popupMenu, setMenuErrorHandler, trace, type MenuEntry } from "./menu";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useRef, useState } from "react";
import { startHandoff } from "./handoffs";
import { canRename, renameNeedsReload, requestRename } from "./rename";
import { untrustedFolder, type TrustAsk } from "./trust";
import type { Agent } from "./types";

export type AgentActions = {
  close: (a: Agent) => void;
  forceQuit: (a: Agent) => void; // asks first
  remove: (a: Agent) => void;
  closeAndRemove: (a: Agent) => void;
  resume: (a: Agent) => void;
  rename: (a: Agent) => void;
  restart: (a: Agent) => void; // asks first
  float: (a: Agent) => void;
};

const running = (a: Agent) => !!a.cli;

/** What each session action does, in one line: the menu, the notices and the dialogs say the same thing. */
export const ACTION_HELP = {
  close: "Ends the session after the current turn. Nothing is lost; resume it later.",
  force: "Stops it immediately, even mid-turn. Use when it's stuck; the current turn is cut short.",
  resume: "Reopens a closed session here, same conversation.",
  rename: "Gives the session a new name (runs /rename in it).",
  remove: "Hides it from OpenAdmiral. The conversation stays available with claude --resume.",
  closeRemove: "Closes the session after the current turn, then hides it from OpenAdmiral.",
  float: "Shows it in a window of its own, to carry to another desktop. Same session.",
  restart: "Restarts it on the installed Claude Code after the current turn. Same conversation; background shells keep running.",
} as const;

/** The header's popover: every action explains itself, a disabled one says why. */
export function agentActionItems(a: Agent, actions: AgentActions) {
  const on = running(a);
  return [
    ...(a.update ? [{ id: "restart", label: `Restart to Update (${a.update.to})`, description: ACTION_HELP.restart, run: () => actions.restart(a) }] : []),
    { id: "float", label: "Open in New Window", description: ACTION_HELP.float, run: () => actions.float(a) },
    { id: "close", label: "Close", shortcut: "⌘W", description: ACTION_HELP.close, disabledReason: on ? undefined : "Not running.", run: () => actions.close(a) },
    { id: "force", label: "Force Quit…", danger: true, description: ACTION_HELP.force, disabledReason: on ? undefined : "Not running.", run: () => actions.forceQuit(a) },
    ...(canRename(a) || renameNeedsReload(a)
      ? [{ id: "rename", label: "Rename…", description: ACTION_HELP.rename, disabledReason: canRename(a) ? undefined : "Run /reload-plugins in this session first.", run: () => actions.rename(a) }]
      : []),
    { id: "resume", label: "Resume in OpenAdmiral", description: ACTION_HELP.resume, disabledReason: on ? "It is already running." : undefined, run: () => actions.resume(a) },
    on
      ? { id: "close-remove", label: "Close and Remove", description: ACTION_HELP.closeRemove, run: () => actions.closeAndRemove(a) }
      : { id: "remove", label: "Remove from List", description: ACTION_HELP.remove, run: () => actions.remove(a) },
  ];
}

/** The agent's menu entries; ids carry the session, so a late click still acts on the right agent. */
export function agentMenuEntries(a: Agent, actions: AgentActions, extra: { text: string; action: () => void }[] = []): MenuEntry[] {
  const entries: MenuEntry[] = [
    ...(a.update ? [{ id: `agent:restart:${a.id}`, text: `Restart to Update (${a.update.to})…`, action: () => actions.restart(a) }, { separator: true as const }] : []),
    { id: `agent:float:${a.id}`, text: "Open in New Window", action: () => actions.float(a) },
    { separator: true },
    { id: `agent:close:${a.id}`, text: "Close", accelerator: "CmdOrCtrl+W", enabled: running(a), action: () => actions.close(a) },
    { id: `agent:force:${a.id}`, text: "Force Quit…", enabled: running(a), action: () => actions.forceQuit(a) },
    { separator: true },
    ...(canRename(a) ? [{ id: `agent:rename:${a.id}`, text: "Rename…", action: () => actions.rename(a) }] : []),
    ...(renameNeedsReload(a) ? [{ id: `agent:rename:${a.id}`, text: "Rename… — /reload-plugins in it first", enabled: false, action: () => {} }] : []),
    { id: `agent:resume:${a.id}`, text: "Resume in OpenAdmiral", enabled: !running(a), action: () => actions.resume(a) },
    running(a)
      ? { id: `agent:remove:${a.id}`, text: "Remove from List — close it first", enabled: false, action: () => {} }
      : { id: `agent:remove:${a.id}`, text: "Remove from List", action: () => actions.remove(a) },
    ...(running(a) ? [{ id: `agent:close-remove:${a.id}`, text: "Close and Remove", action: () => actions.closeAndRemove(a) }] : []),
  ];
  if (extra.length) entries.push({ separator: true }, ...extra.map((x, i) => ({ id: `extra:${i}`, text: x.text, action: x.action })));
  return entries;
}

/** The agent's native menu, from the header's overflow button or the sidebar row. */
export const openAgentMenu = (a: Agent, actions: AgentActions, extra: { text: string; action: () => void }[] = []) => popupMenu(agentMenuEntries(a, actions, extra));

/** Right-click in the agent list (full sidebar or rail): on an agent, its menu plus Reset Order; elsewhere, the list's own. */
export const listMenus = (actions: AgentActions, list: { onClearEnded: () => void; onResetOrder: () => void; onNewSpace?: () => void }) => ({
  agent: (e: { preventDefault: () => void; stopPropagation: () => void }, a: Agent) => {
    e.preventDefault();
    e.stopPropagation();
    openAgentMenu(a, actions, [{ text: "Reset Order", action: list.onResetOrder }]);
  },
  empty: (e: { preventDefault: () => void }) => {
    e.preventDefault();
    popupMenu([
      ...(list.onNewSpace ? [{ id: "sidebar:new-space", text: "New Project", action: list.onNewSpace }, { separator: true as const }] : []),
      { id: "sidebar:clear-ended", text: "Clear Ended Sessions…", action: list.onClearEnded },
      { id: "sidebar:reset-order", text: "Reset Order", action: list.onResetOrder },
    ]);
  },
});

export type Notice = { id: number; text: string; tone: "info" | "error"; action?: { label: string; run: () => void } };

/**
 * Close / force quit / remove, plus what the UI shows meanwhile: sessions asked
 * to close after their turn, the pending confirmation, and short notices.
 */
export function useLifecycle(agents: Agent[]) {
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: string; run: () => Promise<void> } | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  // Sessions to remove from the list as soon as they have closed.
  const [removeAfterClose, setRemoveAfterClose] = useState<Set<string>>(new Set());

  const notify = useCallback((text: string, tone: Notice["tone"] = "info", action?: Notice["action"]) => {
    const id = Date.now() + Math.random();
    setNotices((n) => [...n, { id, text, tone, action }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), tone === "error" ? 7000 : action ? 8000 : 3500);
  }, []);

  useEffect(() => setMenuErrorHandler((m) => notify(m, "error")), [notify]);

  // A session asked to close stops being "closing" once the CLI no longer lists it.
  useEffect(() => {
    setClosing((prev) => {
      const next = new Set([...prev].filter((id) => agents.some((a) => a.id === id && a.cli)));
      return next.size === prev.size ? prev : next;
    });
  }, [agents]);

  const removeNow = async (a: Agent) => {
    try {
      const removed = await invoke<string[]>("agent_remove", { sessionId: a.id });
      if (debugTrace) trace(`agent_remove ${a.id.slice(0, 8)} → ${JSON.stringify(removed)}`);
      notify(`Removed ${a.name} from OpenAdmiral${removed.length ? ` (${removed.length} file${removed.length > 1 ? "s" : ""})` : ""}. The conversation stays available with claude --resume ${a.id.slice(0, 8)}.`);
    } catch (e) {
      if (debugTrace) trace(`agent_remove ${a.id.slice(0, 8)} failed: ${e}`);
      notify(String(e), "error");
    }
  };

  useEffect(() => {
    for (const id of removeAfterClose) {
      const a = agents.find((x) => x.id === id);
      if (a && !a.cli) {
        setRemoveAfterClose((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
        removeNow(a);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, removeAfterClose]);

  // Sessions waiting for their turn to end, to restart (src-tauri/src/restart.rs).
  const [restarting, setRestarting] = useState<string[]>([]);
  const [trustAsks, setTrustAsks] = useState<TrustAsk[]>([]);
  const agentsNow = useRef(agents);
  agentsNow.current = agents;
  useEffect(() => {
    invoke<string[]>("agent_restarts").then(setRestarting, () => {});
    const offs = [
      listen<string[]>("openadmiral://restarts", (e) => setRestarting(e.payload)),
      // Sent to the one window that shows the session (restart.rs).
      getCurrentWebviewWindow().listen<{ sessionId: string; error?: string | null }>("openadmiral://restart-done", (e) => {
        const a = agentsNow.current.find((x) => x.id === e.payload.sessionId);
        const name = a?.name ?? "The session";
        const error = e.payload.error;
        const folder = error ? untrustedFolder(error, a?.cwd ?? "") : null;
        if (folder) setTrustAsks((l) => [...l.filter((t) => t.sessionId !== e.payload.sessionId), { sessionId: e.payload.sessionId, name, folder }]);
        else if (error) notify(`${name} did not restart: ${error}`, "error");
        else notify(`${name} restarted on the installed Claude Code.`);
      }),
    ];
    // OPENADMIRAL_TIP=restart-trust:<folder> (preview): the question, without a failed restart.
    const tip = (e: Event) => {
      const d = String((e as CustomEvent).detail);
      const a = agentsNow.current[0];
      if (d.startsWith("restart-trust:") && a) setTrustAsks([{ sessionId: a.id, name: a.name, folder: d.slice(14) }]);
    };
    window.addEventListener("openadmiral:tip", tip);
    return () => {
      window.removeEventListener("openadmiral:tip", tip);
      offs.forEach((p) => void p.then((off) => off()));
    };
  }, [notify]);

  const trustAsk = trustAsks[0] ?? null;
  // Accepted once for a folder: every session waiting on that folder goes again.
  const trustRetry = () => {
    if (!trustAsk) return;
    for (const t of trustAsks) if (t.folder === trustAsk.folder) void invoke("agent_restart", { sessionId: t.sessionId }).catch((e) => notify(String(e), "error"));
    setTrustAsks((l) => l.filter((t) => t.folder !== trustAsk.folder));
  };
  const trustCancel = () => setTrustAsks((l) => l.slice(1));

  const actions: AgentActions = {
    // Its window if it has one, else a new one (float.rs).
    float: (a) => void invoke("float_open", { sessionId: a.id, title: a.name }).catch((e) => notify(String(e), "error")),
    restart: (a) => {
      const shells = (a.session?.jobs ?? []).filter((j) => j.status === "running").map((j) => j.label || "a background command");
      setConfirm({
        title: `Restart ${a.name} to update?`,
        body: `It moves to Claude Code ${a.update?.to ?? "as installed"} when its current turn ends. The conversation and its context stay.${shells.length ? ` Still running, and they keep running: ${shells.join(", ")}.` : ""}`,
        action: "Restart",
        run: async () => {
          await invoke("agent_restart", { sessionId: a.id }).catch((e) => notify(String(e), "error"));
        },
      });
    },
    rename: requestRename,
    close: async (a) => {
      try {
        const how = await invoke<string>("agent_close", { sessionId: a.id });
        if (how === "requested") {
          setClosing((s) => new Set(s).add(a.id));
          notify(`${a.name} closes after its current turn. Nothing is lost; resume it later.`);
        } else notify(`${a.name} closed. Nothing is lost; resume it later.`);
      } catch (e) {
        notify(String(e), "error");
      }
    },
    forceQuit: (a) =>
      setConfirm({
        title: `Force quit ${a.name}?`,
        body: `${ACTION_HELP.force} The conversation is kept up to the last saved message and can be resumed.`,
        action: "Force Quit",
        run: async () => {
          try {
            const how = await invoke<string>("agent_force_quit", { sessionId: a.id });
            notify(how === "killed" ? `${a.name} did not stop on its own and was killed.` : `${a.name} was stopped.`);
          } catch (e) {
            notify(String(e), "error");
          }
        },
      }),
    remove: (a) => removeNow(a),
    closeAndRemove: async (a) => {
      try {
        const how = await invoke<string>("agent_close", { sessionId: a.id });
        setRemoveAfterClose((s) => new Set(s).add(a.id));
        if (how === "requested") {
          setClosing((s) => new Set(s).add(a.id));
          notify(`${a.name} closes after its current turn, then leaves the list.`);
        }
      } catch (e) {
        notify(String(e), "error");
      }
    },
    resume: (a) => {
      startHandoff(a.id, a.cli?.name ?? a.session?.name ?? a.name, a.cwd).catch((e) => notify(String(e), "error"));
    },
  };

  const clearEnded = (list: Agent[]) => {
    const ended = list.filter((a) => !a.cli && a.status === "ended");
    if (!ended.length) return notify("No ended sessions to clear.");
    setConfirm({
      title: `Clear ${ended.length} ended session${ended.length > 1 ? "s" : ""}?`,
      body: "They leave the list. Their conversations stay on disk and can be resumed with claude --resume.",
      action: "Clear",
      run: async () => {
        for (const a of ended) await invoke("agent_remove", { sessionId: a.id }).catch(() => {});
        notify(`Cleared ${ended.length} ended session${ended.length > 1 ? "s" : ""}.`);
      },
    });
  };

  return { actions, closing, restarting, trustAsk, trustRetry, trustCancel, confirm, setConfirm, notices, clearEnded, notify };
}
