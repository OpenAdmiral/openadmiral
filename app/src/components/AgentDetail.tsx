import { invoke } from "@tauri-apps/api/core";
import {
  BranchingPathsUpLinearIcon,
  CheckCircleLinearIcon,
  CpuLinearIcon,
  DollarLinearIcon,
  FolderLinearIcon,
  ListArrowDownLinearIcon,
  MenuDotsLinearIcon,
  SidebarMinimalisticLinearIcon,
  MonitorLinearIcon,
  RecordCircleLinearIcon,
  RoutingLinearIcon,
  RefreshLinearIcon,
} from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import type { Agent, AdmiralDelegation, AdmiralSession } from "@/lib/types";
import { ago, branchTone, cn, compact, contextUsed, fillText, modelLabel, usd } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import type { Artifact } from "@/lib/artifacts";
import { ArtifactsPane } from "./ArtifactsPane";
import { HandoffSheet } from "./HandoffSheet";
import { NameEditor } from "./NameEditor";
import { startHandoff, type Handoff } from "@/lib/handoffs";
import { agentActionItems, type AgentActions } from "@/lib/lifecycle";
import { ActionMenu, type ActionItem } from "./ActionMenu";
import { costCommand, offers, remoteState } from "@/lib/commands";
import { Tip, TipLabel } from "./Tooltip";
import { Info } from "./Info";
import { AgentTerminal, focusTerminal, repaintTerminal, screenOf } from "./Terminal";
import { ConversationView } from "./ConversationView";

type Tab = "main" | "conversation" | "artifacts";
import { UpNext } from "./UpNext";
import { pending, type QueueEntry } from "@/lib/queue";
import { BlockStack } from "./Blocks";
import type { AdmiralRequest } from "@/lib/admiral";
import { Conversation } from "./Conversation";
import { matchShortcut } from "@/lib/shortcuts";
import { pickTasks, useTranscript, type TranscriptTask } from "@/lib/transcript";
import { Chip, DelegationPill, KIND, Meter, STATUS_LABEL } from "./primitives";
import { StatusIcon } from "./StatusIcon";
import { UnderwayPill } from "@/components/UnderwayPill";

type Props = {
  agent: Agent;
  delegations: AdmiralDelegation[];
  now: number;
  onOpenDelegations: () => void;
  handoff?: Handoff;
  request?: AdmiralRequest;
  actions: AgentActions;
  closing: boolean;
  preview?: boolean;
  /** Preview checks only: attach terminals (OPENADMIRAL_PREVIEW_ATTACH) / run the repaint probe (OPENADMIRAL_TERM_PROBE). */
  previewAttach?: boolean;
  probe?: boolean;
  agents: Agent[];
  queue?: QueueEntry;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
  onConfirm: (c: { title: string; body: string; action: string; run: () => Promise<void> }) => void;
  artifacts: Artifact[];
  artifactFocus?: { key: string; at: number; version?: number };
  turnFocus?: { index: number; at: number };
  seen: { isUnseen: (a: Artifact) => boolean; markSeen: (a: Artifact) => void };
  onClaudeLink: (href: string) => void;
  inspectorHidden: boolean;
  onToggleInspector: () => void;
  /** The inspector's block layout, kept in ui-state.json. */
  layout: {
    blockOrder?: string[];
    blockCollapsed?: Record<string, boolean>;
    setBlockCollapsed: (id: string, collapsed: boolean) => void;
    setBlockOrder: (order: string[]) => void;
    resetLayout: () => void;
  };
  /** Set while the header edits this agent's name (renaming with the sidebar collapsed to a rail). */
  renaming?: { save: (a: Agent, name: string) => void; cancel: () => void };
  /** This session runs an older OpenAdmiral plugin than the one installed: offer /reload-plugins. */
  pluginBehind?: { reload: () => void };
};

/** Focus requests already acted on, by agent; outlives the view, which remounts per agent. */
const HANDLED_FOCUS = new Set<string>();

export function AgentDetail({ agent, delegations, now, onOpenDelegations, handoff, request, actions, closing, preview, previewAttach, probe, agents, queue, onError, onNotice, onConfirm, artifacts, artifactFocus, turnFocus, seen, onClaudeLink, inspectorHidden, onToggleInspector, layout, renaming, pluginBehind }: Props) {
  const s = agent.session;
  const transcript = useTranscript(agent.id, agent.cwd);
  const tasks = pickTasks(s, transcript);
  const [tab, setTab] = useState<Tab>("main");
  // Index → Conversation: the turn to bring to the top, and the one being read.
  const [jump, setJump] = useState<{ index: number; at: number } | undefined>();
  const [reading, setReading] = useState<number | null>(null);
  const showTurn = (index: number) => {
    setTab("conversation");
    setJump({ index, at: Date.now() });
  };
  const attached = (!preview || !!previewAttach) && agent.attachable && agent.live;
  // Preview check (OPENADMIRAL_TERM_PROBE): read the screen, hide it behind another tab and the
  // inspector toggle, then read it again; both readings go to stderr.
  useEffect(() => {
    if (!preview || !probe || !attached) return;
    const log = (m: string) => invoke("frontend_log", { level: "probe", message: m }).catch(() => {});
    const steps: [number, () => void][] = [
      [7000, () => log(`before ${JSON.stringify(screenOf(agent.id))}`)],
      [7500, () => setTab("conversation")],
      [8500, () => setTab("main")],
      [9000, () => onToggleInspector()],
      [10000, () => onToggleInspector()],
      [12000, () => log(`after ${JSON.stringify(screenOf(agent.id))}`)],
    ];
    const timers = steps.map(([ms, f]) => setTimeout(f, ms));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, probe, attached, agent.id]);
  // A focus request is one-shot, but coming back to this agent hands the same request in
  // again, and the view is mounted anew for every agent (App keys it by agent): remember the
  // handled ones outside the component and skip them.
  const freshFocus = (id: string) => !HANDLED_FOCUS.has(`${agent.id}:${id}`) && !!HANDLED_FOCUS.add(`${agent.id}:${id}`);
  useEffect(() => {
    if (!turnFocus || !freshFocus(`turn:${turnFocus.at}`)) return;
    if (turnFocus.index >= 0) showTurn(turnFocus.index);
    else if (turnFocus.index === -1) setTab("conversation");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnFocus?.at]);
  // ⌃1 / ⌃2 / ⌃3 switch tabs (⌘1–9 already switch agents in the sidebar).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = matchShortcut(e);
      const t = id === "tab-terminal" ? "main" : id === "tab-conversation" ? "conversation" : id === "tab-artifacts" ? "artifacts" : undefined;
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      setTab(t);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [agent.id, attached]);
  useEffect(() => {
    if (artifactFocus && freshFocus(`artifact:${artifactFocus.at}`)) setTab("artifacts");
  }, [artifactFocus?.at]);
  // Landing on the Terminal tab (a click, ⌃1, "Reply in terminal", another agent
  // picked) puts the keyboard there, so one click is enough to start typing.
  useEffect(() => {
    if (tab === "main" && attached) {
      focusTerminal(agent.id);
      // Back on screen: the TUI may have been resized while hidden; bring it back in full.
      repaintTerminal(agent.id);
    }
  }, [tab, agent.id, attached]);
  const unseenHere = artifacts.filter(seen.isUnseen).length;
  const mine = delegations.filter(
    (d) => d.from.sessionId === agent.id || d.to.sessionId === agent.id || (!d.to.sessionId && d.to.address === agent.name),
  );
  // With the inspector hidden, a dot on its toggle says something there changed:
  // the mod sent a queued prompt, or one of this agent's delegations moved.
  const attentionKey = `${queue?.sent?.sent.length ?? 0}|${Math.max(0, ...mine.map((d) => d.updatedAt))}`;
  const [baseline, setBaseline] = useState<string | null>(null);
  useEffect(() => {
    setBaseline(inspectorHidden ? attentionKey : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectorHidden, agent.id]);
  const inspectorAttention = inspectorHidden && baseline !== null && baseline !== attentionKey;

  // The header chips: commands go to the session's prompt box through the mod (never submitted).
  const cmd: HeaderCommands = {
    fill: async (text) => {
      try {
        await invoke("fill_session", { sessionId: agent.id, text });
      } catch (e) {
        return onError(`Could not type ${text.trim()}: ${String(e)}`);
      }
      if (attached) {
        setTab("main");
        focusTerminal(agent.id);
      } else onNotice(`Typed ${text.trim()} in its terminal window.`);
    },
    copy: (text) => invoke("copy_text", { text }).then(() => onNotice(`Copied ${text}`), (e) => onError(String(e))),
    reveal: (path) => invoke("reveal_path", { path }).catch((e) => onError(String(e))),
    confirm: onConfirm,
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <Header
        agent={agent}
        now={now}
        actions={actions}
        closing={closing}
        request={request}
        openMenu={!!preview && turnFocus?.index === -2}
        inspector={{ hidden: inspectorHidden, attention: inspectorAttention, toggle: onToggleInspector }}
        cmd={cmd}
        renaming={renaming}
        pluginBehind={pluginBehind}
      />
      {agent.status === "waiting" && s?.waiting && (
        <div className="mx-5 mb-3 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm">
          <StatusIcon status="waiting" size={16} tip={false} />
          <span className="font-semibold text-amber-800 dark:text-amber-200">
            {s.waiting.reason === "permission" ? "Waiting for a permission" : "Waiting for your answer"}
          </span>
          {s.waiting.detail && <span className="truncate text-amber-800/80 dark:text-amber-200/80">{s.waiting.detail}</span>}
          <span className="ml-auto text-xs text-amber-800/70 tabular dark:text-amber-200/70">{ago(s.waiting.since, now)}</span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 px-3 pb-3">
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-canvas shadow-sm">
          <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 pt-1.5">
            {(["main", "conversation", "artifacts"] as const).map((t, i) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 pt-1 pb-2 text-xs transition-colors",
                  tab === t ? "border-brand-500 font-semibold text-ink" : "border-transparent text-ink-3 hover:text-ink",
                )}
              >
                {t === "main" ? (agent.attachable && agent.live ? "Terminal" : "Session") : t === "conversation" ? "Conversation" : "Artifacts"}
                <span className="text-[10px] font-normal text-ink-3">⌃{i + 1}</span>
                {t === "artifacts" && artifacts.length > 0 && (
                  <span className={cn("rounded-full px-1.5 text-[10px] leading-4 tabular", unseenHere ? "bg-brand-600 font-semibold text-white" : "bg-line text-ink-3")}>{artifacts.length}</span>
                )}
              </button>
            ))}
          </div>
          {/* The terminal stays mounted behind the Artifacts tab, so switching keeps its session. */}
          <div className={cn("relative min-h-0 flex-1", tab !== "main" && "hidden", agent.attachable && agent.live && "bg-term")}>
          {preview && !previewAttach && agent.attachable ? (
            <div className="flex h-full items-center justify-center text-xs text-ink-3">Terminal not attached in preview mode.</div>
          ) : agent.attachable && agent.live ? (
            <AgentTerminal
              key={agent.id}
              agentKey={agent.id}
              argv={["claude", "attach", agent.cli?.id ?? agent.id.slice(0, 8)]}
              onCloseSession={() => actions.close(agent)}
              cwd={agent.cwd}
              className="h-full"
            />
          ) : (
            <ReadOnly agent={agent} now={now} handoff={handoff} request={request} />
          )}
        </div>
          {tab === "conversation" && (
            <div className="min-h-0 flex-1">
              <ConversationView
                transcript={transcript}
                running={agent.status === "working"}
                now={now}
                jump={jump}
                onActive={setReading}
                onReply={
                  attached
                    ? () => {
                        setTab("main");
                        focusTerminal(agent.id);
                      }
                    : undefined
                }
                onClaudeLink={onClaudeLink}
              />
            </div>
          )}
          {tab === "artifacts" && (
            <div className="min-h-0 flex-1">
              <ArtifactsPane artifacts={artifacts} focus={artifactFocus?.key || undefined} focusVersion={artifactFocus?.version} focusAt={artifactFocus?.at} now={now} isUnseen={seen.isUnseen} markSeen={seen.markSeen} onError={onError} onClaudeLink={onClaudeLink} />
            </div>
          )}
        </div>
        {/* The inspector slides shut; its content keeps its width so nothing reflows mid-animation. */}
        <div
          aria-hidden={inspectorHidden}
          className="shrink-0 overflow-hidden transition-[width,margin,opacity] duration-200 ease-out motion-reduce:transition-none"
          style={{ width: inspectorHidden ? 0 : 340, marginLeft: inspectorHidden ? 0 : 12, opacity: inspectorHidden ? 0 : 1 }}
        >
        <aside className="h-full w-[340px]">
          <BlockStack
            order={layout.blockOrder}
            collapsed={layout.blockCollapsed}
            onCollapse={layout.setBlockCollapsed}
            onOrder={layout.setBlockOrder}
            onReset={layout.resetLayout}
            blocks={[
              { id: "tasks", title: "Tasks", aside: tasks.length ? `${tasks.filter((t) => t.status === "completed").length}/${tasks.length}` : undefined, body: <Tasks tasks={tasks} /> },
              {
                id: "upnext",
                title: "Up next",
                tone: "brand",
                icon: <ListArrowDownLinearIcon size={14} className="text-brand-600 dark:text-brand-400" />,
                aside: pending(queue).length ? `${pending(queue).length} pending` : undefined,
                body: <UpNext agent={agent} entry={queue} agents={agents} delegations={delegations} onError={onError} />,
              },
              {
                id: "prompts",
                title: "Prompts",
                grow: true,
                aside: transcript.turns.length || undefined,
                body: <Conversation transcript={transcript} running={agent.status === "working"} now={now} active={tab === "conversation" ? reading : null} onJump={showTurn} />,
              },
              ...(s?.subagents?.length
                ? [{ id: "subagents", title: "Subagents", aside: `${s.subagents.filter((a) => a.status === "running").length} running`, body: <div className="px-3 pb-3"><Subagents session={s} now={now} /></div> }]
                : []),
              ...(mine.length
                ? [{ id: "delegations", title: "Delegations", aside: mine.length, body: (
            <div className="px-3 pb-3">
              <ul className="space-y-1.5">
                {mine.slice(0, 8).map((d) => {
                  const outgoing = d.from.sessionId === agent.id;
                  return (
                    <li key={d.id} className="rounded-lg py-1">
                      <div className="flex items-center gap-2">
                        <RoutingLinearIcon size={14} className={cn("shrink-0", outgoing ? "text-brand-500" : "rotate-180 text-emerald-500")} />
                        <span className="flex-1 truncate text-xs font-semibold text-ink">{d.title}</span>
                        <DelegationPill status={d.status} />
                      </div>
                      <div className="mt-0.5 pl-[22px] text-[11px] text-ink-3">
                        {outgoing ? `to ${d.to.project ?? d.to.address}` : `from ${d.from.project}`} · {ago(d.updatedAt, now)}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <button onClick={onOpenDelegations} className="mt-1 text-[11px] text-ink-3 hover:text-brand-600">View all</button>
            </div>
                  ) }]
                : []),
              { id: "activity", title: "Activity", defaultCollapsed: true, aside: s?.activity?.length || undefined, body: <div className="px-3 pb-3"><Activity session={s} now={now} /></div> },
            ]}
          />
        </aside>
        </div>
      </div>
    </div>
  );
}

type HeaderCommands = {
  fill: (text: string) => void;
  copy: (text: string) => void;
  reveal: (path: string) => void;
  confirm: (c: { title: string; body: string; action: string; run: () => Promise<void> }) => void;
};

function Header({
  agent,
  now,
  actions,
  closing,
  request,
  openMenu,
  inspector,
  cmd,
  renaming,
  pluginBehind,
}: {
  agent: Agent;
  now: number;
  actions: AgentActions;
  closing: boolean;
  request?: AdmiralRequest;
  openMenu?: boolean;
  inspector: { hidden: boolean; attention: boolean; toggle: () => void };
  cmd: HeaderCommands;
  renaming?: { save: (a: Agent, name: string) => void; cancel: () => void };
  pluginBehind?: { reload: () => void };
}) {
  const s = agent.session;
  const ctx = s?.context;
  const used = contextUsed(ctx);
  const costCmd = costCommand(s);
  const remote = remoteState(s);
  const contextItems: ActionItem[] = [
    offers(s, "compact") && { id: "compact", label: "Compact now", description: "Summarize the conversation to free space; Claude keeps going.", run: () => cmd.fill("/compact") },
    offers(s, "compact") && { id: "compact-focus", label: "Compact with focus…", description: "Type what the summary should keep, then press Enter.", run: () => cmd.fill("/compact ") },
    offers(s, "context") && { id: "context", label: "What's filling it?", description: "A breakdown of what takes up the context: system, tools, files, messages.", run: () => cmd.fill("/context") },
    offers(s, "clear") && {
      id: "clear",
      label: "Start fresh",
      description: "Clear this conversation; it stays resumable with claude --resume.",
      danger: true,
      run: () =>
        cmd.confirm({
          title: `Start ${agent.name} fresh?`,
          body: `Clears this conversation; it stays resumable with claude --resume ${agent.id.slice(0, 8)}. This types /clear in its prompt box; press Enter there to do it.`,
          action: "Type /clear",
          run: async () => cmd.fill("/clear"),
        }),
    },
  ].filter((x): x is ActionItem => !!x);
  return (
    <header data-tauri-drag-region className="flex shrink-0 flex-col gap-2.5 px-5 pt-3.5 pb-3.5">
      <div data-tauri-drag-region className="flex items-center gap-3">
        <StatusIcon status={agent.status} size={18} />
        {renaming ? (
          <NameEditor value={agent.name} onSave={(name) => renaming.save(agent, name)} onCancel={renaming.cancel} className="max-w-sm text-xl tracking-tight" />
        ) : (
          <h1 className="truncate text-xl font-semibold tracking-tight text-ink">{agent.name}</h1>
        )}
        <span className="text-sm text-ink-3">{STATUS_LABEL[agent.status]}</span>
        {closing && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
            {request?.waiting ? `closing when done · waiting: ${request.waiting}` : "closing after this turn…"}
          </span>
        )}
        {agent.status === "working" && s?.turn && (
          <span className="truncate text-sm text-ink-3">· {ago(s.turn.startedAt, now)} on “{s.turn.prompt.slice(0, 80)}”</span>
        )}
        <span className="flex-1" />
        <UnderwayPill />
        <Tip side="bottom" content={<TipLabel label={inspector.hidden ? "Show the inspector" : "Hide the inspector"} kbd="⌘⌥0" />}>
          <button
            onClick={inspector.toggle}
            aria-label={inspector.hidden ? "Show the inspector" : "Hide the inspector"}
            className={cn(
              "relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-all duration-200 hover:bg-line hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand-500",
              !inspector.hidden && "text-ink",
            )}
          >
            <SidebarMinimalisticLinearIcon size={18} className="-scale-x-100" />
            {inspector.attention && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-brand-500 ring-2 ring-canvas" />}
          </button>
        </Tip>
        <ActionMenu
          items={agentActionItems(agent, actions)}
          defaultOpen={openMenu}
          trigger={(toggle, isOpen) => (
            <Tip side="bottom" content={isOpen ? null : <TipLabel label="Session actions" />}>
              <button
                onClick={toggle}
                aria-label="Session actions"
                className={cn(
                  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-all duration-200 hover:bg-line hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand-500",
                  isOpen && "bg-line text-ink",
                )}
              >
                <MenuDotsLinearIcon size={18} />
              </button>
            </Tip>
          )}
        />
      </div>
      <div data-tauri-drag-region className="flex flex-wrap items-center gap-1.5">
        <Tip side="bottom" content={<TipLabel label="Reveal in Finder" />}>
          <Chip icon={<FolderLinearIcon size={13} />} onClick={() => cmd.reveal(agent.cwd)}>
            {agent.project}
          </Chip>
        </Tip>
        {s?.branch && (
          <Tip side="bottom" content={<TipLabel label="Copy the branch name" />}>
            <Chip icon={<BranchingPathsUpLinearIcon size={13} />} className="font-mono" onClick={() => cmd.copy(s.branch!)}>
              <span className={branchTone(s.branch)}>{s.branch}</span>
              {s.worktree && <span className="font-sans text-brand-600 dark:text-brand-400">worktree</span>}
              {!!s.dirty && <span className="font-sans text-amber-600 dark:text-amber-400">±{s.dirty}</span>}
            </Chip>
          </Tip>
        )}
        {s?.model &&
          (offers(s, "model") ? (
            <Tip side="bottom" content={<TipLabel label="Change the model: types /model" />}>
              <Chip icon={<CpuLinearIcon size={13} />} onClick={() => cmd.fill("/model")}>
                {modelLabel(s.model)}
              </Chip>
            </Tip>
          ) : (
            <Chip icon={<CpuLinearIcon size={13} />}>{modelLabel(s.model)}</Chip>
          ))}
        {/* Right after /compact the engine has no token count until the next reply: keep the chip, show a dash. */}
        {ctx && (
          <ActionMenu
            align="left"
            items={contextItems}
            header={
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-semibold text-ink">
                  Context{" "}
                  {used !== undefined ? (
                    <>
                      <span className={fillText(used)}>{Math.round(used)}%</span> <span className="font-normal text-ink-3">of usable</span>
                    </>
                  ) : (
                    <span className="font-normal text-ink-3">updates after the next reply</span>
                  )}
                </span>
                {ctx?.tokens !== undefined && (
                  <span className="text-xs text-ink-3 tabular">
                    {compact(ctx.tokens)} / {compact(ctx.window)} tokens
                  </span>
                )}
              </div>
            }
            trigger={(toggle, isOpen) => (
              <Tip
                side="bottom"
                content={
                  isOpen ? null : (
                    <span className="block max-w-72 whitespace-normal">
                      <span className="font-semibold">Context: compact, inspect or clear</span>
                      <span className="mt-0.5 block text-ink-3">
                        {used !== undefined
                          ? `${Math.round(used)}% of the usable context; Claude auto-compacts at 100%.`
                          : "Just compacted: the size shows again after the next reply."}
                        {ctx?.tokens !== undefined && ` ${compact(ctx.tokens)} of ${compact(ctx.window)} tokens.`}
                      </span>
                    </span>
                  )
                }
              >
                <Chip onClick={contextItems.length ? toggle : undefined} active={isOpen}>
                  <span>Context</span>
                  <Meter value={used ?? 0} className="w-12" />
                  <span className={cn("font-semibold", used !== undefined ? fillText(used) : "text-ink-3")}>{used !== undefined ? `${Math.round(used)}%` : "—"}</span>
                </Chip>
              </Tip>
            )}
          />
        )}
        {s?.costUsd !== undefined &&
          (costCmd ? (
            <Tip side="bottom" content={<TipLabel label={`Usage and limits: types ${costCmd}`} />}>
              <Chip icon={<DollarLinearIcon size={13} />} onClick={() => cmd.fill(costCmd)}>
                {usd(s.costUsd).replace("$", "")}
              </Chip>
            </Tip>
          ) : (
            <Chip icon={<DollarLinearIcon size={13} />}>{usd(s.costUsd).replace("$", "")}</Chip>
          ))}
        {/* Only the exception is worth a chip: a session in a Terminal window (one in
            OpenAdmiral is the normal case). */}
        {agent.cli && !agent.attachable && (
          <Chip icon={<MonitorLinearIcon size={13} />}>
            {KIND.terminal.label}
            <Info tip={KIND.terminal.hint + "."} />
          </Chip>
        )}
        {pluginBehind && (
          <Tip side="bottom" content={<TipLabel label="This session runs an older OpenAdmiral plugin. Reload runs /reload-plugins in it as soon as it is idle." />}>
            <Chip icon={<RefreshLinearIcon size={13} />} className="text-amber-700 dark:text-amber-300" onClick={pluginBehind.reload}>
              Plugin outdated · Reload
            </Chip>
          </Tip>
        )}
        {remote.kind !== "hidden" && (
          <Tip
            side="bottom"
            content={
              <span className="block max-w-72 whitespace-normal">
                <span className="font-semibold">
                  {remote.kind === "connected" ? `Remote Control on — ${remote.clients} device${remote.clients > 1 ? "s" : ""} connected` : remote.kind === "on" ? "Remote Control on — no device connected" : "Remote Control off"}
                </span>
                <span className="mt-0.5 block text-ink-3">Click to type /remote-control: continue this session from your phone or claude.ai.</span>
              </span>
            }
          >
            <Chip
              onClick={() => cmd.fill("/remote-control")}
              className={cn(
                "font-semibold tracking-wide",
                remote.kind === "on" && "border-brand-500/60 bg-brand-500/10 text-brand-700 hover:border-brand-500 hover:bg-brand-500/15 hover:text-brand-700 dark:text-brand-300 dark:hover:text-brand-200",
                remote.kind === "connected" && "border-brand-600 bg-brand-600 text-white hover:border-brand-700 hover:bg-brand-700 hover:text-white",
              )}
            >
              {remote.kind === "connected" ? `RC · ${remote.clients}` : "RC"}
            </Chip>
          </Tip>
        )}
      </div>
    </header>
  );
}

function Tasks({ tasks }: { tasks: TranscriptTask[] }) {
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <div className="px-3 pb-3">
      {tasks.length === 0 ? (
        <p className="px-1 text-xs text-ink-3">No task list in this session.</p>
      ) : (
        <>
          <Meter value={(done / tasks.length) * 100} tone="brand" className="mx-1 mb-2.5" />
          <ul className="max-h-44 space-y-1 overflow-y-auto">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-start gap-2 px-1 text-xs leading-5">
                {t.status === "completed" ? (
                  <CheckCircleLinearIcon size={15} className="mt-[3px] shrink-0 text-emerald-500" />
                ) : t.status === "in_progress" ? (
                  <span className="mt-[5px] flex size-[11px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-brand-500">
                    <span className="size-[5px] animate-breathe rounded-full bg-brand-500" />
                  </span>
                ) : (
                  <span className="mt-[5px] size-[11px] shrink-0 rounded-full border-[1.5px] border-line-strong" />
                )}
                <span className={cn("text-ink-2", t.status === "completed" && "text-ink-3 line-through", t.status === "in_progress" && "font-semibold text-ink")}>
                  {t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Running subagents first (blue pulse, time so far); finished ones below, muted,
 * labelled done/failed. Never a green dot: green means an idle session elsewhere.
 */
function Subagents({ session, now }: { session: AdmiralSession; now: number }) {
  const list = session.subagents ?? [];
  const running = list.filter((a) => a.status === "running");
  const finished = list.filter((a) => a.status !== "running").sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const [showAll, setShowAll] = useState(false);
  const fold = finished.length > 3 && !showAll;
  return (
    <ul className="space-y-1">
      {running.map((a) => (
        <li key={a.id} className="flex items-center gap-2 px-1 text-xs leading-5">
          <StatusIcon status="working" size={12} tip={false} />
          <span className="truncate font-semibold text-ink">{a.description ?? a.type ?? a.id}</span>
          <span className="ml-auto shrink-0 text-[11px] text-ink-3 tabular" title="Running for">{ago(a.startedAt, now)}</span>
        </li>
      ))}
      {fold ? (
        <li>
          <button onClick={() => setShowAll(true)} className="px-1 text-[11px] text-ink-3 hover:text-ink">
            {finished.length} finished
          </button>
        </li>
      ) : (
        finished.map((a) => (
          <li key={a.id} className="flex items-center gap-2 px-1 text-xs leading-5 text-ink-3">
            <span className="size-2 shrink-0 rounded-full border-[1.5px] border-ink-3/60" />
            <span className="truncate">{a.description ?? a.type ?? a.id}</span>
            <span className={cn("ml-auto shrink-0 text-[10.5px] font-semibold", a.status === "failed" && "text-red-600 dark:text-red-400")}>{a.status}</span>
            <span className="shrink-0 text-[11px] tabular">{a.endedAt ? `${ago(a.endedAt, now)} ago` : `started ${ago(a.startedAt, now)} ago`}</span>
          </li>
        ))
      )}
    </ul>
  );
}

const KIND_DOT: Record<string, string> = {
  prompt: "bg-brand-500",
  tool: "bg-gray-400",
  reply: "bg-emerald-500",
  sent: "bg-violet-500",
  received: "bg-sky-500",
  permission: "bg-amber-500",
};

function Activity({ session, now }: { session?: AdmiralSession; now: number }) {
  const items = [...(session?.activity ?? [])].reverse().slice(0, 25);
  return (
    <>
      {items.length === 0 ? (
        <p className="px-1 text-xs text-ink-3">Nothing yet.</p>
      ) : (
        <ol className="relative ml-[5px] border-l border-line">
          <AnimatePresence initial={false}>
            {items.map((it) => (
              <motion.li
                key={`${it.at}-${it.text}`}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="relative pb-2 pl-3.5 text-xs leading-5"
              >
                <span className={cn("absolute top-[7px] -left-[3.5px] size-[6px] rounded-full ring-2 ring-canvas", KIND_DOT[it.kind] ?? "bg-gray-400")} />
                <div className="flex gap-2">
                  <span className={cn("line-clamp-2 flex-1 text-ink-2", it.kind === "tool" && "font-mono text-[11px]")}>{it.text}</span>
                  <span className="shrink-0 text-[11px] text-ink-3 tabular">{ago(it.at, now)}</span>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}
    </>
  );
}

function ReadOnly({ agent, now, handoff: pending, request }: { agent: Agent; now: number; handoff?: Handoff; request?: AdmiralRequest }) {
  const s = agent.session;
  const [handoff, setHandoff] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const inTerminal = agent.cli?.kind === "interactive";
  // The job finished (or was cancelled): close the sheet instead of leaving its last step spinning.
  const hadJob = useRef(false);
  useEffect(() => {
    if (pending) hadJob.current = true;
    else if (hadJob.current) {
      hadJob.current = false;
      setHandoff(false);
    }
  }, [pending]);
  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-5 flex items-center gap-4 rounded-xl border border-line bg-panel p-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400">
          <RecordCircleLinearIcon size={20} />
        </span>
        <div className="flex-1 text-sm text-ink-2">
          {inTerminal ? (
            <>
              <p className="font-semibold text-ink" title={KIND.terminal.hint}>{KIND.terminal.label}</p>
              <p className="mt-0.5 text-xs leading-relaxed">{KIND.terminal.hint}. It continues as the same conversation, and keeps running when you close OpenAdmiral.</p>
            </>
          ) : (
            <>
              <p className="font-semibold text-ink">Not running</p>
              <p className="mt-0.5 text-xs leading-relaxed">Resume this conversation in OpenAdmiral and pick up where it left off.</p>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {inTerminal && (
            <button
              onClick={() => invoke("open_in_terminal", { cwd: agent.cwd }).catch(() => {})}
              className="rounded-lg px-3 py-2 text-xs font-semibold text-ink-2 transition-all duration-200 hover:bg-line focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              Open folder in Terminal
            </button>
          )}
          <button
            onClick={async () => {
              // The backend carries it from here; the sheet only shows how it goes.
              setStartError(null);
              if (!pending || pending.state === "error" || pending.state === "expired")
                await startHandoff(agent.id, agent.cli?.name ?? agent.session?.name ?? agent.name, agent.cwd).catch((e) => setStartError(String(e)));
              setHandoff(true);
            }}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
          >
            {pending && pending.state !== "error" && pending.state !== "expired" ? "Moving into OpenAdmiral…" : inTerminal ? "Bring into OpenAdmiral" : "Resume in OpenAdmiral"}
          </button>
        </div>
      </div>
      <HandoffSheet agent={agent} handoff={pending} waiting={request?.waiting} startError={startError} open={handoff} onClose={() => setHandoff(false)} />

      {s?.turn && agent.status === "working" && (
        <Block label={`Working · ${ago(s.turn.startedAt, now)}`}>
          <p className="selectable text-sm text-ink">{s.turn.prompt}</p>
          {s.lastTool && (
            <p className="mt-2 font-mono text-xs text-ink-3">
              {s.lastTool.name} · {s.lastTool.summary}
            </p>
          )}
        </Block>
      )}
      {s?.lastReply && (
        <Block label="Last reply">
          <p className="selectable whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{s.lastReply}</p>
        </Block>
      )}
      {!s && (
        <p className="text-sm text-ink-3">
          No OpenAdmiral data for this session yet. It appears once the OpenAdmiral plugin runs in it.
        </p>
      )}
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</div>
      {children}
    </div>
  );
}
