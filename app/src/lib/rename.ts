import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "./types";

/** How long the CLI gets to report the new name before the label goes back. */
export const RENAME_TIMEOUT_MS = 10_000;

/** Rename needs the mod running in that session, recent enough to run `/rename` for us. */
export const canRename = (a: Agent) => !!a.cli && !!a.session?.commands?.includes("rename");

/** Running but its mod predates Rename (loaded before the update): say how to get it, rather than hide it. */
export const renameNeedsReload = (a: Agent) => !!a.cli && a.status !== "ended" && !canRename(a);

/** Asks for the inline name editor on an agent (menus fire this; App listens). */
export const requestRename = (a: Agent) => window.dispatchEvent(new CustomEvent("openadmiral:rename", { detail: a.id }));

/** A trimmed name, or null when there is nothing to save. */
export function cleanName(raw: string, current: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  return name && name !== current ? name : null;
}

type Pending = { name: string; old: string; at: number };

/**
 * Renames through the OpenAdmiral plugin (`fill/<id>.json` with `{ command: 'rename' }`), showing
 * the new name at once. The CLI's own row confirms it; if it has not within
 * RENAME_TIMEOUT_MS the label goes back and `onFail` explains.
 * `migrate(old, next)` moves the sidebar-order entry, which is keyed by name.
 */
export function useRename(raw: Agent[], now: number, migrate: (a: Agent, from: string, to: string) => void, onFail: (text: string) => void) {
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const migrateRef = useRef(migrate);
  migrateRef.current = migrate;

  useEffect(() => {
    const on = (e: Event) => setEditing((e as CustomEvent<string>).detail);
    window.addEventListener("openadmiral:rename", on);
    return () => window.removeEventListener("openadmiral:rename", on);
  }, []);

  // Confirmed by the CLI, or timed out.
  useEffect(() => {
    const ids = Object.keys(pending);
    if (!ids.length) return;
    let changed = false;
    const next = { ...pending };
    for (const id of ids) {
      const p = pending[id];
      const a = raw.find((x) => x.id === id);
      if (a?.cli?.name === p.name) {
        delete next[id];
        changed = true;
      } else if (now - p.at > RENAME_TIMEOUT_MS || (a && !a.cli)) {
        delete next[id];
        changed = true;
        if (a) migrateRef.current({ ...a, name: p.name }, p.name, p.old);
        onFail(`Could not rename ${p.old}: the session did not take the new name.`);
      }
    }
    if (changed) setPending(next);
  }, [raw, now, pending, onFail]);

  const commit = useCallback(
    async (a: Agent, input: string) => {
      setEditing(null);
      const old = a.cli?.name ?? a.session?.name ?? a.name;
      const name = cleanName(input, old);
      if (!name) return;
      try {
        await invoke("rename_session", { sessionId: a.id, name });
      } catch (e) {
        onFail(String(e));
        return;
      }
      migrateRef.current(a, old, name);
      setPending((p) => ({ ...p, [a.id]: { name, old, at: Date.now() } }));
    },
    [onFail],
  );

  // The optimistic label: name and the CLI's name (the sidebar order's key) both.
  const agents = useMemo(
    () =>
      Object.keys(pending).length === 0
        ? raw
        : raw.map((a) => {
            const p = pending[a.id];
            return p ? { ...a, name: p.name, cli: a.cli && { ...a.cli, name: p.name } } : a;
          }),
    [raw, pending],
  );

  return { agents, editing, start: setEditing, cancel: () => setEditing(null), commit };
}
