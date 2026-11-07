import type { Agent, AgentStatus } from "@/lib/types";

/**
 * The welcome tour (components/Onboarding.tsx): shown once, on a first run. Someone
 * who already has sessions running the plugin is past it: it is marked done quietly.
 */
export function welcomeDecision(o: { uiLoaded: boolean; agentsLoaded: boolean; onboarded: boolean | undefined; agents: Agent[] }): "wait" | "show" | "done" | "none" {
  if (!o.uiLoaded || !o.agentsLoaded) return "wait";
  if (o.onboarded) return "none";
  return o.agents.some(connected) ? "done" : "show";
}

/** A session that runs the OpenAdmiral plugin, and the plugin is alive in it. */
export const connected = (a: Agent) => !!a.session && !a.unplugged && !a.pluginDown;

/**
 * The agent the last step follows: the connected one working now that started most
 * recently, else the most recent connected one.
 */
export function followed(agents: Agent[]): Agent | undefined {
  const mine = agents.filter(connected);
  const recent = (a: Agent) => a.cli?.startedAt ?? a.session?.startedAt ?? 0;
  const by = (xs: Agent[]) => [...xs].sort((a, b) => recent(b) - recent(a))[0];
  return by(mine.filter((a) => a.status === "working" || a.status === "waiting" || a.status === "starting")) ?? by(mine);
}

/** A connected agent finished a turn between two polls. */
export function turnFinished(before: Map<string, AgentStatus>, agents: Agent[]) {
  return agents.some((a) => connected(a) && (before.get(a.id) === "working" || before.get(a.id) === "waiting") && a.status === "idle");
}
