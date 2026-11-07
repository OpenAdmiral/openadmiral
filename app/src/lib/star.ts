import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import type { Agent, AgentStatus } from "@/lib/types";
import type { UnderwayState } from "@/lib/underway";

/**
 * Asking for a GitHub star at a good moment (src-tauri/src/star.rs decides, this
 * notices the moments): a connected agent finished a turn, the person answered an
 * agent that was waiting on them, or the lid opened after Underway kept agents working.
 */
export type StarEvent = { kind: "turn" } | { kind: "answered" } | { kind: "underway"; minutes: number };
export type StarPrompt = { reason: "turn" | "answered" | "underway"; minutes: number | null; mode: "gh" | "web"; login: string | null };

/** Turns finished and waits answered between two polls, for agents running the plugin. */
export function statusEvents(before: Map<string, AgentStatus>, agents: Agent[]): StarEvent[] {
  const out: StarEvent[] = [];
  for (const a of agents) {
    if (a.unplugged) continue;
    const was = before.get(a.id);
    if (was === "working" && a.status === "idle") out.push({ kind: "turn" });
    if (was === "waiting" && a.status === "working") out.push({ kind: "answered" });
  }
  return out;
}

/** Minutes Underway kept agents working with the lid closed, once the lid opens. */
export function lidMinutes(closedAt: number | null, u: Pick<UnderwayState, "lidClosed" | "mode" | "working">, now: number): { closedAt: number | null; minutes?: number } {
  if (u.lidClosed) return { closedAt: closedAt ?? (u.mode === "underway" && u.working > 0 ? now : null) };
  if (closedAt === null) return { closedAt: null };
  return { closedAt: null, minutes: Math.floor((now - closedAt) / 60_000) };
}

const QUIET_MS = 5_000;

/**
 * The card to show, if any. A prompt the backend grants waits until nobody is waiting
 * on the person, they are not typing and the window is in front.
 */
export function useStarPrompt(agents: Agent[], underway: UnderwayState | null, preview: boolean) {
  const [pending, setPending] = useState<StarPrompt | null>(null);
  const [shown, setShown] = useState<StarPrompt | null>(null);
  const statuses = useRef<Map<string, AgentStatus> | null>(null);
  const closedAt = useRef<number | null>(null);
  const lastKey = useRef(0);

  const send = (event: StarEvent) => {
    if (preview) return;
    void invoke<StarPrompt | null>("star_event", { event }).then((p) => p && setPending((cur) => cur ?? p), () => {});
  };

  useEffect(() => {
    const before = statuses.current;
    statuses.current = new Map(agents.map((a) => [a.id, a.status]));
    if (before) statusEvents(before, agents).forEach(send);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  useEffect(() => {
    if (!underway) return;
    const r = lidMinutes(closedAt.current, underway, Date.now());
    closedAt.current = r.closedAt;
    if (r.minutes !== undefined) send({ kind: "underway", minutes: r.minutes });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underway?.lidClosed, underway?.mode, underway?.working]);

  useEffect(() => {
    const onKey = () => (lastKey.current = Date.now());
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const waiting = agents.some((a) => a.status === "waiting");
  useEffect(() => {
    if (!pending || shown) return;
    const t = setInterval(() => {
      if (waiting || !document.hasFocus() || Date.now() - lastKey.current < QUIET_MS) return;
      setShown(pending);
      setPending(null);
    }, 1_500);
    return () => clearInterval(t);
  }, [pending, shown, waiting]);

  // Preview: OPENADMIRAL_TIP=star[:underway|:answered] shows the card for a screenshot.
  useEffect(() => {
    const onTip = (e: Event) => {
      const d = String((e as CustomEvent).detail ?? "");
      if (!d.startsWith("star")) return;
      const reason = (d.split(":")[1] || "turn") as StarPrompt["reason"];
      setShown({ reason, minutes: reason === "underway" ? 47 : null, mode: "gh", login: "octocat" });
    };
    window.addEventListener("openadmiral:tip", onTip);
    return () => window.removeEventListener("openadmiral:tip", onTip);
  }, []);

  return { prompt: shown, close: () => setShown(null) };
}

/** Whether the person starred: the footer's star link goes away then. */
export function useStarred() {
  const [done, setDone] = useState(true);
  useEffect(() => {
    void invoke<boolean>("star_done").then(setDone, () => {});
    const off = listen("openadmiral://starred", () => setDone(true));
    return () => void off.then((f) => f());
  }, []);
  return { done, markDone: () => setDone(true) };
}

/** Stars through the GitHub CLI when it can, else opens the repo: "starred" or "opened". */
export const starNow = () => invoke<"starred" | "opened">("star_now");
export const starDismiss = () => invoke("star_dismiss");

export function starTitle(p: StarPrompt) {
  if (p.reason === "underway") return `Your agents worked ${p.minutes! >= 90 ? `${Math.round(p.minutes! / 60)} h` : `${p.minutes} min`} with the lid closed`;
  if (p.reason === "answered") return "No agent left waiting";
  return "Your first agent is on the bridge";
}

export function starBody(p: StarPrompt) {
  const lead =
    p.reason === "turn"
      ? "You're all set: OpenAdmiral will nudge you whenever an agent needs you. "
      : p.reason === "answered"
        ? "You've been answering your agents the moment they need you. "
        : "";
  return `${lead}OpenAdmiral is free and built by one person. If it's useful, a GitHub star helps other Claude Code users find it.`;
}
