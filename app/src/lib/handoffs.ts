import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

/** A hand-off the backend is carrying out (see src-tauri/src/handoff.rs). */
export type Handoff = {
  sessionId: string;
  name: string;
  cwd: string;
  requestedAt: number;
  state: "requested" | "served" | "resuming" | "error" | "expired";
  error?: string;
  /** "terminal": an interactive session asked to exit first; "ended": resumed straight away. */
  from?: "terminal" | "ended";
};

/** The session it now runs under: `to` differs from `from` when claude started a copy. */
export type HandoffDone = { from: string; to: string };

export function useHandoffs(onDone: (done: HandoffDone) => void) {
  const [list, setList] = useState<Handoff[]>([]);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    invoke<Handoff[]>("handoff_list").then(setList).catch(() => {});
    const offs = [
      listen<Handoff[]>("openadmiral://handoffs", (e) => setList(e.payload)),
      listen<HandoffDone>("openadmiral://handoff-done", (e) => done.current(e.payload)),
    ];
    return () => offs.forEach((p) => p.then((off) => off()));
  }, []);
  return list;
}

export const startHandoff = (sessionId: string, name: string, cwd: string) => invoke("handoff_start", { sessionId, name, cwd });
export const cancelHandoff = (sessionId: string) => invoke("handoff_cancel", { sessionId });
