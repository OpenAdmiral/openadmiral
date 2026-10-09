import { closestCenter, DndContext, KeyboardCode, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlarmLinearIcon, CloseCircleLinearIcon, HourglassLinearIcon, LinkLinearIcon, PauseLinearIcon, Pen2LinearIcon, PlayLinearIcon, RepeatLinearIcon, TrashBinMinimalisticLinearIcon } from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import {
  conditionLabel,
  emptyQueue,
  finished,
  itemStates,
  newItemId,
  pending,
  saveQueue,
  sentList,
  type ItemState,
  type QueueCondition,
  type QueueEntry,
  type QueueItem,
} from "@/lib/queue";
import { isTimed, runNowPending, type QueueCommand } from "@/lib/schedule";
import { typeIntoTerminal } from "./Terminal";
import { QueueInput, QueueText, SchedulePicker, queueTextProblem, useNow } from "./QueueBits";
import type { Agent, AdmiralDelegation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Info } from "./Info";

type Props = { agent: Agent; entry?: QueueEntry; agents: Agent[]; delegations: AdmiralDelegation[]; onError: (msg: string) => void };

/** The user's queue for this agent: prompts submitted one per idle turn, in order. */
export function UpNext({ agent, entry, agents, delegations, onError }: Props) {
  const queue = entry?.queue ?? emptyQueue();
  const items = pending(entry);
  const sent = sentList(entry);
  const now = useNow();
  const states = itemStates(items, queue.paused, agent, agents, delegations, sent, now);
  const commands = agent.session?.queueCommands;

  const write = (next: Partial<typeof queue>) => saveQueue(agent.id, { ...queue, ...next }).catch((e) => onError(String(e)));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: [KeyboardCode.Space], cancel: [KeyboardCode.Esc], end: [KeyboardCode.Space] } }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((i) => i.id === e.active.id), to = items.findIndex((i) => i.id === e.over!.id);
    if (from === -1 || to === -1) return;
    const moved = arrayMove(items, from, to);
    // Keep any already-sent items (about to be pruned) where they are, after the pending ones.
    write({ items: [...moved, ...finished(entry)] });
  };

  const update = (id: string, patch: Partial<QueueItem>) => write({ items: queue.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  const remove = (id: string) => write({ items: queue.items.filter((i) => i.id !== id) });
  const add = (text: string, after?: QueueCondition) =>
    write({ items: [...queue.items, { id: newItemId(), text, createdAt: Date.now(), ...(after ? { after } : {}), ...(after?.kind === "schedule" ? { armedAt: Date.now() } : {}) }] });

  // The body of the inspector's "Up next" block; its header (title, count) is the block's.
  return (
    <div>
      {items.length > 0 && (
        <div className="flex items-center gap-2 px-3 pb-1.5">
          <span className="text-[10px] text-ink-3">One prompt per idle turn; commands too</span>
          <button
            onClick={() => write({ paused: !queue.paused })}
            title={queue.paused ? "Resume the queue" : "Pause the queue"}
            className={cn(
              "ml-auto inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] transition-all duration-200",
              queue.paused ? "bg-amber-500/15 font-semibold text-amber-700 dark:text-amber-300" : "text-ink-3 hover:bg-line hover:text-ink",
            )}
          >
            {queue.paused ? <PlayLinearIcon size={12} /> : <PauseLinearIcon size={12} />}
            {queue.paused ? "Paused" : "Pause"}
          </button>
        </div>
      )}

      {items.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis, restrictToParentElement]} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ol className="max-h-56 space-y-1 overflow-y-auto px-2 pb-1">
              <AnimatePresence initial={false}>
                {items.map((item, i) => (
                  <Item
                    key={item.id}
                    item={item}
                    n={i + 1}
                    state={states.get(item.id)}
                    condition={item.after ? conditionLabel(item.after, agents, delegations, item, sent, now) : undefined}
                    commands={commands}
                    forced={runNowPending(item, sent)}
                    onSave={(text) => update(item.id, { text })}
                    onClearCondition={() => update(item.id, { after: undefined })}
                    onTogglePause={() => update(item.id, { paused: !item.paused })}
                    onRunNow={() => update(item.id, { runNowAt: Date.now(), paused: false })}
                    onDelete={() => remove(item.id)}
                  />
                ))}
              </AnimatePresence>
            </ol>
          </SortableContext>
        </DndContext>
      )}

      <Composer agent={agent} agents={agents} delegations={delegations} commands={commands} onAdd={add} />
    </div>
  );
}

function Item({
  item,
  n,
  state,
  condition,
  commands,
  forced,
  onSave,
  onClearCondition,
  onTogglePause,
  onRunNow,
  onDelete,
}: {
  item: QueueItem;
  n: number;
  state?: ItemState;
  condition?: string;
  commands: readonly QueueCommand[] | undefined;
  forced: boolean;
  onSave: (t: string) => void;
  onClearCondition: () => void;
  onTogglePause: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: item.id });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  useEffect(() => setDraft(item.text), [item.text]);
  const save = () => {
    if (draft.trim() && draft.trim() !== item.text && !queueTextProblem(draft, commands)) onSave(draft.trim());
    setEditing(false);
  };
  const timeIcon = item.after?.kind === "schedule" ? <RepeatLinearIcon size={11} className="shrink-0" /> : item.after?.kind === "time" ? <AlarmLinearIcon size={11} className="shrink-0" /> : <LinkLinearIcon size={11} className="shrink-0" />;
  return (
    <motion.li
      ref={setNodeRef}
      layout={!isDragging}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: item.paused ? 0.6 : 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.35 } }}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group relative rounded-lg border bg-canvas px-2.5 py-2",
        state?.kind === "next" ? "border-brand-500/40" : "border-line",
        isDragging && "z-10 shadow-lg ring-1 ring-brand-500/40",
      )}
    >
      <div className="flex items-start gap-2" {...(editing ? {} : { ...attributes, ...listeners })}>
        <span className="mt-0.5 w-3 shrink-0 text-right text-[10px] font-semibold text-ink-3 tabular">{n}</span>
        {editing ? (
          <div className="flex-1" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && save()}>
            <QueueInput
              autoFocus
              value={draft}
              onChange={setDraft}
              commands={commands}
              rows={3}
              onSubmit={save}
              onCancel={() => {
                setDraft(item.text);
                setEditing(false);
              }}
              className="border-brand-500"
            />
          </div>
        ) : (
          <div onDoubleClick={() => setEditing(true)} className="min-w-0 flex-1 cursor-grab active:cursor-grabbing">
            <QueueText text={item.text} />
          </div>
        )}
        {!editing && (
          <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {!forced && (
              <button onClick={onRunNow} title="Run now (as soon as the agent is idle)" className="rounded p-0.5 text-ink-3 hover:bg-line hover:text-ink">
                <PlayLinearIcon size={13} />
              </button>
            )}
            <button onClick={onTogglePause} title={item.paused ? "Resume this item" : "Pause this item"} className={cn("rounded p-0.5 hover:bg-line", item.paused ? "text-amber-600 dark:text-amber-400" : "text-ink-3 hover:text-ink")}>
              <PauseLinearIcon size={13} />
            </button>
            <button onClick={() => setEditing(true)} title="Edit" className="rounded p-0.5 text-ink-3 hover:bg-line hover:text-ink">
              <Pen2LinearIcon size={13} />
            </button>
            <button onClick={onDelete} title="Delete" className="rounded p-0.5 text-ink-3 hover:bg-red-500/10 hover:text-red-600">
              <TrashBinMinimalisticLinearIcon size={13} />
            </button>
          </span>
        )}
      </div>
      {(condition || state?.label) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-5">
          {condition && (
            <span className={cn("inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px]", isTimed(item) ? "bg-brand-500/10 text-brand-700 dark:text-brand-300" : "bg-line text-ink-2")}>
              {timeIcon}
              <span className="truncate">{condition}</span>
              <button onClick={onClearCondition} title={isTimed(item) ? "Remove the schedule" : "Remove condition"} className="shrink-0 opacity-70 hover:opacity-100">
                <CloseCircleLinearIcon size={11} />
              </button>
            </span>
          )}
          {state?.label && (
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[10.5px]",
                state.kind === "next" ? "font-semibold text-brand-600 dark:text-brand-400" : state.label === "paused" ? "text-amber-700 dark:text-amber-300" : "text-ink-3",
              )}
            >
              {state.kind === "waiting" && <HourglassLinearIcon size={11} />}
              {state.kind === "next" && <span className="size-1.5 animate-breathe rounded-full bg-brand-500" />}
              {state.label}
            </span>
          )}
        </div>
      )}
    </motion.li>
  );
}

function Composer({ agent, agents, delegations, commands, onAdd }: { agent: Agent; agents: Agent[]; delegations: AdmiralDelegation[]; commands: readonly QueueCommand[] | undefined; onAdd: (text: string, after?: QueueCondition) => void }) {
  const [text, setText] = useState("");
  const [after, setAfter] = useState<QueueCondition | undefined>();
  const [picking, setPicking] = useState<"after" | "schedule" | null>(null);
  const openDelegations = useMemo(() => delegations.filter((d) => d.status !== "done" && d.status !== "cancelled"), [delegations]);
  const others = agents.filter((a) => a.id !== agent.id && a.status !== "ended");
  const timed = after?.kind === "time" || after?.kind === "schedule";
  const problem = text.trim() ? queueTextProblem(text, commands) : undefined;
  const pastTime = after?.kind === "time" && after.at <= Date.now();

  const submit = () => {
    if (!text.trim() || problem || pastTime) return;
    onAdd(text.trim(), after);
    setText("");
    setAfter(undefined);
    setPicking(null);
  };
  const toggle = (which: "after" | "schedule") => {
    if (picking === which) return setPicking(null);
    setPicking(which);
    // One condition per item: switching kind starts that kind afresh.
    if (which === "schedule" && !timed) {
      const d = new Date();
      d.setHours(d.getHours() + 1, 0, 0, 0);
      setAfter({ kind: "time", at: d.getTime() });
    }
    if (which === "after" && timed) setAfter(undefined);
  };

  return (
    <div className="border-t border-brand-500/15 px-2 pt-2 pb-2">
      <QueueInput
        value={text}
        onChange={setText}
        onSubmit={submit}
        commands={commands}
        placeholder={`Queue a prompt or /command for ${agent.name}…`}
        onReloadPlugins={agent.attachable ? () => typeIntoTerminal(agent.id, "/reload-plugins") : undefined}
        whereElse={(name) => others.filter((a) => a.session?.queueCommands?.some((c) => c.name === name)).map((a) => a.name)}
      />
      {picking === "after" && (
        <div className="mt-1.5 space-y-1.5 rounded-lg border border-line bg-canvas p-2 text-xs">
          <label className="block text-[10.5px] font-semibold text-ink-3">Run after…</label>
          <select
            value={after && !timed ? `${after.kind}:${after.kind === "delegation" ? after.id : after.kind === "session-idle" ? after.sessionId : ""}` : ""}
            onChange={(e) => {
              const [kind, id] = e.target.value.split(/:(.*)/s);
              setAfter(!kind ? undefined : kind === "delegation" ? { kind, id, status: ["done"] } : { kind: "session-idle", sessionId: id });
            }}
            className="w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-ink focus:border-brand-500 focus:outline-none"
          >
            <option value="">No condition</option>
            {openDelegations.length > 0 && (
              <optgroup label="A delegation reaches a status">
                {openDelegations.map((d) => (
                  <option key={d.id} value={`delegation:${d.id}`}>
                    {d.title} ({d.from.project} → {d.to.project ?? d.to.address})
                  </option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Another agent finishes its turn">
                {others.map((a) => (
                  <option key={a.id} value={`session-idle:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {after?.kind === "delegation" && (
            <select
              value={after.status[0]}
              onChange={(e) => setAfter({ ...after, status: [e.target.value as "done"] })}
              className="w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-ink focus:border-brand-500 focus:outline-none"
            >
              {(["done", "blocked", "in_progress", "accepted", "cancelled"] as const).map((s) => (
                <option key={s} value={s}>
                  is {s.replace("_", " ")}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {picking === "schedule" && (
        <div className="mt-1.5 rounded-lg border border-line bg-canvas p-2">
          <SchedulePicker value={after} onChange={setAfter} />
          {pastTime && <p className="mt-1 text-[10.5px] text-red-600 dark:text-red-400">That time has passed.</p>}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1">
        <button
          onClick={() => toggle("after")}
          className={cn("inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-3 transition-colors hover:bg-line hover:text-ink", after && !timed && "font-semibold text-brand-600 dark:text-brand-400")}
        >
          <LinkLinearIcon size={12} className="shrink-0" />
          <span className="truncate">{after && !timed ? conditionLabel(after, agents, delegations) : "Run after…"}</span>
        </button>
        <button
          onClick={() => toggle("schedule")}
          className={cn("inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-ink-3 transition-colors hover:bg-line hover:text-ink", timed && "font-semibold text-brand-600 dark:text-brand-400")}
        >
          {after?.kind === "schedule" ? <RepeatLinearIcon size={12} className="shrink-0" /> : <AlarmLinearIcon size={12} className="shrink-0" />}
          <span className="truncate">{timed ? conditionLabel(after, agents, delegations) : "Schedule…"}</span>
        </button>
        <Info tip="Run after holds a prompt until another agent finishes its turn or a delegation reaches a status. Schedule runs it at a time, once or repeating; if the agent is closed then, OpenAdmiral resumes it. Slash commands work too: type / to pick one." align="left" />
        <span className="ml-auto text-[10px] text-ink-3">⌘↵</span>
        <button
          disabled={!text.trim() || !!problem || pastTime}
          onClick={submit}
          className="rounded-md bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm transition-all duration-200 hover:bg-brand-700 disabled:bg-line-strong disabled:text-ink-3 disabled:shadow-none"
        >
          Add
        </button>
      </div>
    </div>
  );
}
