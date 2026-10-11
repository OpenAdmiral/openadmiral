import {
  AlarmLinearIcon,
  ArrowRightUpLinearIcon,
  CheckCircleLinearIcon,
  DangerTriangleLinearIcon,
  HourglassLinearIcon,
  LinkLinearIcon,
  PauseLinearIcon,
  Pen2LinearIcon,
  PlayLinearIcon,
  PlaylistMinimalisticLinearIcon,
  RepeatLinearIcon,
  TrashBinMinimalisticLinearIcon,
} from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import { conditionLabel, conditionUnmet, emptyQueue, pending, saveQueue, sentList, type QueueEntry, type QueueItem } from "@/lib/queue";
import { centralGroup, isLate, isTimed, recentSent, runNowPending, scheduledSortKey, whenLabel, type CentralGroup, type QueueCommand } from "@/lib/schedule";
import type { Agent, AdmiralDelegation } from "@/lib/types";
import { ago, cn, projectColor, projectLabel } from "@/lib/utils";
import { Info } from "./Info";
import { QueueInput, QueueText, queueTextProblem } from "./QueueBits";
import { StatusIcon } from "./StatusIcon";
import { UnderwayPill } from "@/components/UnderwayPill";

type Props = {
  queues: Record<string, QueueEntry>;
  agents: Agent[];
  delegations: AdmiralDelegation[];
  now: number;
  onJump: (agentId: string) => void;
  onError: (msg: string) => void;
};

type Row = { sessionId: string; agent?: Agent; item: QueueItem; entry: QueueEntry; group: CentralGroup; sortKey: number };

const SECTIONS: { id: CentralGroup; title: string; icon: typeof AlarmLinearIcon; help: string }[] = [
  { id: "scheduled", title: "Scheduled", icon: AlarmLinearIcon, help: "Runs at a time, once or repeating, soonest first. If the agent is closed then, OpenAdmiral resumes it to run the item." },
  { id: "waiting", title: "Waiting on a condition", icon: HourglassLinearIcon, help: "Held until a delegation reaches a status or another agent finishes its turn." },
  { id: "ready", title: "Ready", icon: PlayLinearIcon, help: "Goes in order as soon as its agent is idle (one per idle turn)." },
];

/** Every Up next item of every session in one place: what runs when, and where. */
export function QueueView({ queues, agents, delegations, now, onJump, onError }: Props) {
  const [filter, setFilter] = useState<string>("");
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const [sessionId, entry] of Object.entries(queues)) {
      const sent = sentList(entry);
      const agent = byId.get(sessionId);
      pending(entry).forEach((item, i) => {
        const met = conditionUnmet(item.after, agents, delegations) === null;
        const group = centralGroup(item, met);
        out.push({ sessionId, agent, item, entry, group, sortKey: group === "scheduled" ? scheduledSortKey(item, sent) : i });
      });
    }
    return out;
  }, [queues, byId, agents, delegations]);

  // Filter by an agent ("a:<id>") or a project ("p:<name>").
  const projects = useMemo(() => [...new Set(rows.map((r) => r.agent?.project ?? "Removed"))].sort(), [rows]);
  const agentOptions = useMemo(() => {
    const ids = [...new Set(rows.map((r) => r.sessionId))];
    return ids.map((id) => ({ id, name: byId.get(id)?.name ?? id.slice(0, 8) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, byId]);
  const keep = (sessionId: string, agent?: Agent) =>
    !filter || (filter.startsWith("a:") ? sessionId === filter.slice(2) : (agent?.project ?? "Removed") === filter.slice(2));
  const shown = rows.filter((r) => keep(r.sessionId, r.agent));
  const recent = recentSent(queues, now).filter((s) => keep(s.sessionId, byId.get(s.sessionId)));
  const scheduledCount = rows.filter((r) => r.group === "scheduled").length;

  const write = (sessionId: string, entry: QueueEntry, map: (items: QueueItem[]) => QueueItem[]) => {
    const q = entry.queue ?? emptyQueue();
    saveQueue(sessionId, { ...q, items: map(q.items) }).catch((e) => onError(String(e)));
  };
  const patch = (r: Row, p: Partial<QueueItem>) => write(r.sessionId, r.entry, (items) => items.map((i) => (i.id === r.item.id ? { ...i, ...p } : i)));
  const remove = (r: Row) => write(r.sessionId, r.entry, (items) => items.filter((i) => i.id !== r.item.id));

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header data-tauri-drag-region className="flex shrink-0 items-center gap-3 px-6 pt-3.5 pb-4">
        <PlaylistMinimalisticLinearIcon size={20} className="text-brand-600 dark:text-brand-400" />
        <h1 className="text-xl font-semibold tracking-tight text-ink">Up next</h1>
        <Info tip="Everything queued for every agent: prompts and slash commands, scheduled or waiting on a condition. Add items from an agent's Up next block." align="left" />
        <span className="text-sm text-ink-3 tabular">
          {rows.length} queued{scheduledCount > 0 && ` · ${scheduledCount} scheduled`}
        </span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter by agent or project"
          className="ml-auto max-w-56 rounded-lg border border-line-strong bg-canvas px-2.5 py-1 text-xs text-ink focus:border-brand-500 focus:outline-none"
        >
          <option value="">All agents</option>
          {projects.length > 0 && (
            <optgroup label="Project">
              {projects.map((p) => (
                <option key={p} value={`p:${p}`}>
                  {p}
                </option>
              ))}
            </optgroup>
          )}
          {agentOptions.length > 0 && (
            <optgroup label="Agent">
              {agentOptions.map((a) => (
                <option key={a.id} value={`a:${a.id}`}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <UnderwayPill />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {rows.length === 0 && recent.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <PlaylistMinimalisticLinearIcon size={32} className="mb-3 text-ink-3" />
            <p className="text-sm font-semibold text-ink">Nothing queued</p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-ink-3">
              Queue prompts or slash commands in an agent's <span className="font-semibold text-ink-2">Up next</span> block: run them after a condition, at a time, or every
              weekday. They all show up here.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-4xl space-y-6">
            {SECTIONS.map((sec) => {
              const list = shown.filter((r) => r.group === sec.id).sort((a, b) => (sec.id === "scheduled" ? a.sortKey - b.sortKey : 0));
              if (!list.length) return null;
              return (
                <section key={sec.id}>
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <sec.icon size={14} className="text-ink-3" />
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{sec.title}</h3>
                    <span className="text-[11px] text-ink-3 tabular">{list.length}</span>
                    <Info tip={sec.help} align="left" />
                  </div>
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-canvas shadow-sm">
                    <AnimatePresence initial={false}>
                      {list.map((r) => (
                        <QueueRow
                          key={`${r.sessionId}/${r.item.id}`}
                          row={r}
                          now={now}
                          agents={agents}
                          delegations={delegations}
                          onJump={onJump}
                          onSave={(text) => patch(r, { text })}
                          onTogglePause={() => patch(r, { paused: !r.item.paused })}
                          onRunNow={() => patch(r, { runNowAt: Date.now(), paused: false })}
                          onDelete={() => remove(r)}
                        />
                      ))}
                    </AnimatePresence>
                  </ul>
                </section>
              );
            })}

            {recent.length > 0 && (
              <section>
                <div className="mb-2 flex items-center gap-2 px-1">
                  <CheckCircleLinearIcon size={14} className="text-ink-3" />
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Recently sent</h3>
                  <span className="text-[11px] text-ink-3 tabular">{recent.length}</span>
                  <Info tip="What Up next sent in the last 24 hours, to whom and when. A late run is a catch-up for a time missed while the agent or OpenAdmiral was closed." align="left" />
                </div>
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                  {recent.map((s) => {
                    const a = byId.get(s.sessionId);
                    return (
                      <li key={`${s.sessionId}/${s.id}/${s.at}`} className="flex items-center gap-3 px-3.5 py-2">
                        <AgentBadge agent={a} sessionId={s.sessionId} onJump={onJump} />
                        <div className="min-w-0 flex-1">
                          <QueueText text={s.label} clamp={2} className={cn(s.error && "text-ink-3 line-through")} />
                          {s.error && (
                            <p className="mt-0.5 flex items-center gap-1 text-[10.5px] text-red-600 dark:text-red-400">
                              <DangerTriangleLinearIcon size={11} /> {s.error}
                            </p>
                          )}
                        </div>
                        {isLate(s) && (
                          <span title={`Due ${whenLabel(s.due!, now)}`} className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold leading-4 text-amber-700 dark:text-amber-300">
                            catch-up for {whenLabel(s.due!, now)}
                          </span>
                        )}
                        <span title={new Date(s.at).toLocaleString()} className="w-16 shrink-0 text-right text-[11px] text-ink-3 tabular">
                          {ago(s.at, now)} ago
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentBadge({ agent, sessionId, onJump }: { agent?: Agent; sessionId: string; onJump: (id: string) => void }) {
  if (!agent)
    return (
      <span title="This agent was removed from OpenAdmiral; its queue stays until you delete it." className="flex w-44 shrink-0 items-center gap-2 text-xs text-ink-3">
        <span className="size-1.5 shrink-0 rounded-full bg-line-strong" />
        <span className="truncate font-mono">{sessionId.slice(0, 8)}</span>
      </span>
    );
  return (
    <button onClick={() => onJump(agent.id)} title={`Open ${agent.name}`} className="group/agent flex w-44 shrink-0 items-center gap-2 text-left">
      <StatusIcon status={agent.status} />
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: projectColor(agent.project) }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-ink group-hover/agent:text-brand-600 dark:group-hover/agent:text-brand-400">{agent.name}</span>
        <span className="block truncate text-[10.5px] text-ink-3">{projectLabel(agent.project)}</span>
      </span>
    </button>
  );
}

function QueueRow({
  row,
  now,
  agents,
  delegations,
  onJump,
  onSave,
  onTogglePause,
  onRunNow,
  onDelete,
}: {
  row: Row;
  now: number;
  agents: Agent[];
  delegations: AdmiralDelegation[];
  onJump: (id: string) => void;
  onSave: (text: string) => void;
  onTogglePause: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}) {
  const { item, agent, entry } = row;
  const sent = sentList(entry);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const commands: readonly QueueCommand[] | undefined = agent?.session?.queueCommands;
  const forced = runNowPending(item, sent);
  const queuePaused = !!entry.queue?.paused;
  const condition = item.after ? conditionLabel(item.after, agents, delegations, item, sent, now) : undefined;
  const save = () => {
    if (draft.trim() && draft.trim() !== item.text && !queueTextProblem(draft, commands)) onSave(draft.trim());
    setEditing(false);
  };
  const icon = item.after?.kind === "schedule" ? RepeatLinearIcon : item.after?.kind === "time" ? AlarmLinearIcon : LinkLinearIcon;
  const Icon = icon;
  const btn = "rounded-md p-1 text-ink-3 transition-colors hover:bg-line hover:text-ink";
  return (
    <motion.li
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.3 } }}
      className={cn("group flex items-start gap-3 px-3.5 py-2.5", (item.paused || queuePaused) && "bg-amber-500/[0.04]")}
    >
      <AgentBadge agent={agent} sessionId={row.sessionId} onJump={onJump} />
      <div className={cn("min-w-0 flex-1", (item.paused || queuePaused) && "opacity-60")}>
        {editing ? (
          <div onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && save()}>
            <QueueInput
              autoFocus
              value={draft}
              onChange={setDraft}
              commands={commands}
              rows={2}
              onSubmit={save}
              onCancel={() => {
                setDraft(item.text);
                setEditing(false);
              }}
            />
          </div>
        ) : (
          <div onDoubleClick={() => setEditing(true)}>
            <QueueText text={item.text} clamp={2} />
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px]">
          {condition && (
            <span className={cn("inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5", isTimed(item) ? "bg-brand-500/10 text-brand-700 dark:text-brand-300" : "bg-line text-ink-2")}>
              <Icon size={11} className="shrink-0" />
              <span className="truncate">{condition}</span>
            </span>
          )}
          {forced && <span className="font-semibold text-brand-600 dark:text-brand-400">runs as soon as the agent is idle</span>}
          {item.paused && <span className="font-semibold text-amber-700 dark:text-amber-300">paused</span>}
          {!item.paused && queuePaused && <span className="font-semibold text-amber-700 dark:text-amber-300">queue paused</span>}
          {agent?.status === "ended" && isTimed(item) && !item.paused && <span className="text-ink-3">agent closed · OpenAdmiral resumes it when due</span>}
          {!agent && <span className="text-ink-3">agent removed</span>}
        </div>
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button onClick={() => setEditing(true)} title="Edit" className={btn}>
            <Pen2LinearIcon size={14} />
          </button>
          <button onClick={onTogglePause} title={item.paused ? "Resume this item" : "Pause this item"} className={cn(btn, item.paused && "text-amber-600 dark:text-amber-400")}>
            <PauseLinearIcon size={14} />
          </button>
          <button onClick={onRunNow} disabled={forced || !agent} title="Run now (as soon as the agent is idle; OpenAdmiral resumes it if closed)" className={cn(btn, "disabled:opacity-30")}>
            <PlayLinearIcon size={14} />
          </button>
          <button onClick={onDelete} title="Delete" className="rounded-md p-1 text-ink-3 transition-colors hover:bg-red-500/10 hover:text-red-600">
            <TrashBinMinimalisticLinearIcon size={14} />
          </button>
          {agent && (
            <button onClick={() => onJump(agent.id)} title={`Open ${agent.name}`} className={btn}>
              <ArrowRightUpLinearIcon size={14} />
            </button>
          )}
        </div>
      )}
    </motion.li>
  );
}
