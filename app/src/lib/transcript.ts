import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { AdmiralSession } from "./types";

/** One prompt and what followed it, from src-tauri/src/transcript.rs. */
export type Turn = {
  index: number;
  prompt: string;
  kind: "prompt" | "command" | "shell";
  at?: string;
  endAt?: string;
  reply: string;
  tools: { name: string; summary: string; at?: string; input?: string; result?: string; isError?: boolean }[];
  /** "queue" when OpenAdmiral's Up next submitted it; another plugin's name otherwise. */
  source?: string;
};

export type TranscriptTask = { id: string; subject: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

type Update = { sessionId: string; from: number; turns: Turn[]; tasks: TranscriptTask[]; tasksAt?: string; found: boolean };

export type Transcript = { turns: Turn[]; tasks: TranscriptTask[]; tasksAt?: number; found: boolean; loading: boolean };

/** Follows a session's transcript while mounted; the backend tails the file. */
export function useTranscript(sessionId: string, cwd: string): Transcript {
  const [t, setT] = useState<Transcript>({ turns: [], tasks: [], found: true, loading: true });
  useEffect(() => {
    let alive = true;
    const apply = (u: Update) =>
      setT((prev) => ({
        turns: [...prev.turns.slice(0, u.from), ...u.turns],
        tasks: u.tasks,
        tasksAt: u.tasksAt ? Date.parse(u.tasksAt) : undefined,
        found: u.found,
        loading: false,
      }));
    setT({ turns: [], tasks: [], found: true, loading: true });
    invoke<Update>("transcript_open", { sessionId, cwd })
      .then((u) => alive && apply(u))
      .catch(() => alive && setT((p) => ({ ...p, found: false, loading: false })));
    const off = listen<Update>("transcript://update", (e) => alive && e.payload.sessionId === sessionId && apply(e.payload));
    return () => {
      alive = false;
      off.then((f) => f());
      invoke("transcript_close", { sessionId }).catch(() => {});
    };
  }, [sessionId, cwd]);
  return t;
}

/**
 * The task list to show: the mod's live list when its file is newer than the
 * transcript's last task event (the mod only sees tasks made after it loaded),
 * else the list replayed from the transcript.
 */
export function pickTasks(session: AdmiralSession | undefined, t: Transcript): TranscriptTask[] {
  const live = session?.tasks ?? [];
  if (!t.tasks.length) return live;
  if (live.length && session && (t.tasksAt === undefined || session.updatedAt > t.tasksAt) && live.length >= t.tasks.length) return live;
  return t.tasks;
}
