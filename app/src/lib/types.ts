// Mirrors ../../../docs/CONTRACT.md (v1).

export type SessionStatus = "starting" | "idle" | "working" | "waiting" | "ended";

export type AdmiralSession = {
  v: 1;
  sessionId: string;
  name?: string;
  cwd: string;
  project: string;
  repo?: { root: string; remote: string | null };
  branch?: string;
  worktree?: boolean;
  dirty?: number;
  model?: string;
  status: SessionStatus;
  waiting?: { reason: "permission" | "question" | "idle_prompt"; detail?: string; since: number };
  turn?: { startedAt: number; prompt: string };
  lastTool?: { name: string; summary: string; at: number };
  lastReply?: string;
  context?: { tokens?: number; window: number; percent?: number; usablePercent?: number };
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[];
  costUsd?: number;
  /** Remote Control: switched on, and remote clients (phone, claude.ai) attached. */
  remote?: { enabled?: boolean; clients: number };
  /** The id this session continues under after a /clear (this file is then ended). */
  supersededBy?: string;
  /** Slash commands this Claude Code build has (of those the header offers); absent from older mods. */
  commands?: string[];
  /** Slash commands Up next may queue in this session, and how they run (docs/CONTRACT.md); absent from older mods. */
  queueCommands?: { name: string; kind: "command" | "skill"; description?: string }[];
  /** When this session loaded its OpenAdmiral plugin (docs/CONTRACT.md); absent from older mods. */
  plugin?: { loadedAt: number };
  tasks?: { id: string; subject: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }[];
  subagents?: { id: string; type?: string; description?: string; status: "running" | "done" | "failed"; startedAt: number; endedAt?: number }[];
  activity?: { at: number; kind: "prompt" | "tool" | "reply" | "sent" | "received" | "permission"; text: string }[];
  startedAt: number;
  updatedAt: number;
  /** Added by the app: whether Claude Code saved a transcript for it. */
  hasTranscript?: boolean;
};

/** `draft`: recorded but not delivered yet (the send is still waiting on auto mode's classifier). */
export type DelegationStatus = "draft" | "sent" | "accepted" | "in_progress" | "blocked" | "done" | "cancelled";

export type AdmiralDelegation = {
  v: 1;
  id: string;
  title: string;
  detail: string;
  from: { sessionId: string; project: string; name?: string };
  to: { address: string; sessionId?: string; project?: string };
  status: DelegationStatus;
  dependsOn?: string[];
  notes: { at: number; by: string; status?: DelegationStatus; text: string }[];
  result?: string;
  createdAt: number;
  updatedAt: number;
};

/** One row of `claude agents --json`. */
export type CliAgent = {
  pid: number;
  cwd: string;
  kind: string; // "interactive" | "background"
  startedAt: number;
  sessionId: string;
  /** The job's short id (`claude attach <id>`): the first session id's prefix, kept across /clear. */
  id?: string;
  name?: string;
  status?: string; // "idle" | "busy" | …
};

export type AgentStatus = "working" | "waiting" | "idle" | "starting" | "ended";

/** A session file and its CLI row joined by sessionId: what the UI draws. */
export type Agent = {
  id: string;
  name: string;
  project: string;
  cwd: string;
  attachable: boolean;
  live: boolean;
  status: AgentStatus;
  session?: AdmiralSession;
  cli?: CliAgent;
  /** Found running without the OpenAdmiral plugin (src-tauri/src/discover.rs): read-only, from its transcript. */
  unplugged?: { via: string };
};

/** A Claude Code session running without the plugin, as discover_sessions finds it. */
export type DiscoveredSession = {
  sessionId: string;
  cwd: string;
  project: string;
  branch: string | null;
  status: "working" | "idle";
  lastPrompt: string | null;
  lastReply: string | null;
  updatedAt: number;
  via: string;
};
