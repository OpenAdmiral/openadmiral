import { invoke } from "@tauri-apps/api/core";
import {
  BranchingPathsUpLinearIcon,
  ChatLineLinearIcon,
  CheckCircleLinearIcon,
  CloseCircleLinearIcon,
  CpuLinearIcon,
  DollarLinearIcon,
  FolderLinearIcon,
  GalleryLinearIcon,
  CodeSquareLinearIcon,
  PlayLinearIcon,
  ListArrowDownLinearIcon,
  MaximizeSquare3LinearIcon,
  MenuDotsLinearIcon,
  MinimizeSquare3LinearIcon,
  SidebarMinimalisticLinearIcon,
  MonitorLinearIcon,
  RecordCircleLinearIcon,
  RefreshLinearIcon,
  DangerTriangleLinearIcon,
} from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import type { Agent, AdmiralSession } from "@/lib/types";
import { ago, branchTone, cn, compact as shortNumber, contextUsed, fillText, modelLabel, projectColor, usd } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import type { Artifact } from "@/lib/artifacts";
import { ChangesView } from "@/components/ChangesView";
import { RunView } from "@/components/RunView";
import { useMissionControl } from "@/lib/mission";
import { ArtifactsPane } from "./ArtifactsPane";
import { HandoffSheet } from "./HandoffSheet";
import { NameEditor } from "./NameEditor";
import { startHandoff, type Handoff } from "@/lib/handoffs";
import { agentActionItems, closedByHand, type AgentActions } from "@/lib/lifecycle";
import { ActionMenu, type ActionItem } from "./ActionMenu";
import { costCommand, offers, remoteState } from "@/lib/commands";
import { Tip, TipLabel } from "./Tooltip";
import { Info } from "./Info";
import { AgentTerminal, focusTerminal, repaintTerminal, screenOf, typeIntoTerminal } from "./Terminal";
import { ConversationView } from "./ConversationView";

type Tab = "main" | "conversation" | "artifacts" | "changes" | "run";
import { UpNext } from "./UpNext";
import { pending, type QueueEntry } from "@/lib/queue";
import { BlockStack } from "./Blocks";
import type { AdmiralRequest } from "@/lib/admiral";
import { Conversation } from "./Conversation";
import { matchShortcut } from "@/lib/shortcuts";
import { pickTasks, useTranscript, type TranscriptTask } from "@/lib/transcript";
import { Chip, Meter, STATUS_LABEL } from "./primitives";
import { StatusIcon } from "./StatusIcon";
import { hasNow, NowPanel } from "./Progress";
import { UnderwayPill } from "@/components/UnderwayPill";
import { PluginSetup } from "@/components/PluginSetup";
import { inExtension, runsElsewhere, whereLabel } from "@/lib/host";

type Props = {
  agent: Agent;
  now: number;
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
  /** The OpenAdmiral plugin is installed (for a session found running without it). */
  pluginInstalled?: boolean;
  /**
   * One of several panes (the chat area split): only the active one takes the keys and the
   * keyboard focus; the header is tighter; `onClose` empties the pane.
   */
  pane?: { active: boolean; onClose?: () => void };
  /** What to draw: everything, the agent without its inspector (a pane), or only the inspector (beside the panes). */
  part?: "all" | "main" | "inspector";
  /** The layout and text size control, in the header. */
  viewMenu?: React.ReactNode;
  /** Show `viewMenu` even in a pane's compact header (an agent's own window has no bar above it). */
  viewMenuInPane?: boolean;
  /** Text size of the conversation and artifacts (the terminal's is set on the terminals). */
  textScale?: number;
  /** A pane in compact mode: one header line, the tabs as icons, no chips. */
  dense?: boolean;
  /** The header's button: into a floating window, or from one back to the main window. */
  floatAction?: { kind: "float" | "dock"; run: () => void };
  /** The agent is in a floating window: its terminal is there. */
  floating?: { show: () => void; bringBack: () => void };
  /** In a floating window: room for the traffic lights. */
  inset?: boolean;
  /** Waiting for its turn to end, to restart on the installed Claude Code. */
  restarting?: boolean;
};

/** Focus requests already acted on, by agent; outlives the view, which remounts per agent. */
const HANDLED_FOCUS = new Set<string>();

export function AgentDetail({ agent, now, handoff, request, actions, closing, preview, previewAttach, probe, agents, queue, onError, onNotice, onConfirm, artifacts, artifactFocus, turnFocus, seen, onClaudeLink, inspectorHidden, onToggleInspector, layout, renaming, pluginBehind, pluginInstalled = true, pane, part = "all", viewMenu, viewMenuInPane, textScale = 1, dense: denseOption, floatAction, floating, inset, restarting }: Props) {
  const active = pane?.active ?? true;
  const s = agent.session;
  const transcript = useTranscript(agent.id, agent.cwd);
  // Whether it was already closed when opened here (the view mounts anew per agent): only then
  // does it resume by itself. Closed while on screen (Close, Close and Remove, /exit) it stays closed.
  const openedClosed = useRef(!agent.cli);
  const tasks = pickTasks(s, transcript);
  const [tab, setTab] = useState<Tab>("main");
  // Preview: OPENADMIRAL_TIP=changes opens the Changes tab, for a screenshot.
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail; if (d === "changes" || d === "run") setTab(d); };
    window.addEventListener("openadmiral:tip", on);
    return () => window.removeEventListener("openadmiral:tip", on);
  }, []);
  const hasRepo = (!!(agent.session?.repo || agent.session?.branch) || !!agent.codex) && !agent.unplugged;
  // Mission Control: the name large over the whole view, so its thumbnail says who it is.
  const mission = useMissionControl();
  // Index → Conversation: the turn to bring to the top, and the one being read.
  const [jump, setJump] = useState<{ index: number; at: number } | undefined>();
  const [reading, setReading] = useState<number | null>(null);
  const showTurn = (index: number) => {
    setTab("conversation");
    setJump({ index, at: Date.now() });
  };
  const attached = (!preview || !!previewAttach) && agent.attachable && agent.live && !floating;
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
      if (!active) return;
      const id = matchShortcut(e);
      const t = id === "tab-terminal" ? "main" : id === "tab-conversation" ? "conversation" : id === "tab-artifacts" ? "artifacts" : id === "tab-changes" && hasRepo ? "changes" : id === "tab-run" && hasRepo ? "run" : undefined;
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      setTab(t);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [agent.id, attached, active]);
  useEffect(() => {
    if (artifactFocus && freshFocus(`artifact:${artifactFocus.at}`)) setTab("artifacts");
  }, [artifactFocus?.at]);
  // Landing on the Terminal tab (a click, ⌃1, "Reply in terminal", another agent
  // picked) puts the keyboard there, so one click is enough to start typing.
  useEffect(() => {
    if (tab === "main" && attached) {
      // Several panes: only the active one takes the keyboard.
      if (active) focusTerminal(agent.id);
      // Back on screen: the TUI may have been resized while hidden; bring it back in full.
      repaintTerminal(agent.id);
    }
  }, [tab, agent.id, attached, active]);
  const unseenHere = artifacts.filter(seen.isUnseen).length;
  // With the inspector hidden, a dot on its toggle says something there changed:
  // the mod sent a queued prompt.
  const attentionKey = `${queue?.sent?.sent.length ?? 0}`;
  const [baseline, setBaseline] = useState<string | null>(null);
  useEffect(() => {
    setBaseline(inspectorHidden ? attentionKey : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectorHidden, agent.id]);
  const inspectorAttention = inspectorHidden && baseline !== null && baseline !== attentionKey;

  // The header chips: commands go to the session's prompt box through the mod (never submitted).
  const cmd: HeaderCommands = {
    fill: async (text) => {
      // Its plugin is not running (a folder never trusted runs no plugins, for one): nobody
      // would pick the request up. Type it into the attached terminal instead, never submitted.
      const silent = !!agent.cli && (!s || s.status === "ended" || Date.now() - s.updatedAt > PLUGIN_SILENT_MS);
      if (silent && attached && typeIntoTerminal(agent.id, text)) {
        setTab("main");
        return;
      }
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

  const hideInspector = part === "main" || inspectorHidden;
  const inspectorEl = (
    <aside className="h-full w-[340px]">
      <BlockStack
            order={layout.blockOrder}
            collapsed={layout.blockCollapsed}
            onCollapse={layout.setBlockCollapsed}
            onOrder={layout.setBlockOrder}
            onReset={layout.resetLayout}
            blocks={[
              { id: "tasks", title: "Tasks", aside: tasks.length ? `${tasks.filter((t) => t.status === "completed").length}/${tasks.length}` : undefined, body: <Tasks tasks={tasks} session={s} /> },
              {
                id: "upnext",
                title: "Up next",
                tone: "brand",
                icon: <ListArrowDownLinearIcon size={14} className="text-brand-600 dark:text-brand-400" />,
                aside: pending(queue).length ? `${pending(queue).length} pending` : undefined,
                body: agent.unplugged ? (
                  <p className="px-4 py-3 text-xs leading-relaxed text-ink-3">Up next needs the OpenAdmiral plugin in this session: it is the plugin that submits queued prompts.</p>
                ) : (
                  <UpNext agent={agent} entry={queue} agents={agents} onError={onError} />
                ),
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
              { id: "activity", title: "Activity", defaultCollapsed: true, aside: s?.activity?.length || undefined, body: <div className="px-3 pb-3"><Activity session={s} now={now} /></div> },
            ]}
          />
    </aside>
  );
  // The inspector slides shut; its content keeps its width so nothing reflows mid-animation.
  const inspectorSlot = (
    <div
      aria-hidden={hideInspector}
      className="shrink-0 overflow-hidden transition-[width,margin,opacity] duration-200 ease-out motion-reduce:transition-none"
      style={{ width: hideInspector ? 0 : 340, marginLeft: hideInspector ? 0 : 12, opacity: hideInspector ? 0 : 1 }}
    >
      {inspectorEl}
    </div>
  );
  if (part === "inspector") return <div className="flex h-full pr-3 pb-3">{inspectorSlot}</div>;
  const compact = !!pane;
  const dense = compact && !!denseOption;
  // Changes: what the agent changed in its git checkout (components/ChangesView.tsx).
  const tabs = hasRepo ? (["main", "conversation", "artifacts", "changes", "run"] as const) : (["main", "conversation", "artifacts"] as const);
  const TAB_LABEL = { main: attached || (agent.attachable && agent.live) ? "Terminal" : "Session", conversation: "Conversation", artifacts: "Artifacts", changes: "Changes", run: "Run" } as const;
  const tabIcons = (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-line/70 p-0.5">
      {tabs.map((t, i) => {
        const Icon = t === "main" ? MonitorLinearIcon : t === "conversation" ? ChatLineLinearIcon : t === "changes" ? CodeSquareLinearIcon : t === "run" ? PlayLinearIcon : GalleryLinearIcon;
        return (
          <Tip key={t} side="bottom" content={<TipLabel label={`${TAB_LABEL[t]}${t === "artifacts" && artifacts.length ? ` (${artifacts.length})` : ""}`} kbd={`⌃${i + 1}`} />}>
            <button
              onClick={() => setTab(t)}
              aria-label={TAB_LABEL[t]}
              aria-pressed={tab === t}
              className={cn(
                "relative inline-flex size-6 items-center justify-center rounded-md transition-colors @max-[300px]:size-5",
                tab === t ? "bg-canvas text-ink shadow-sm dark:bg-white/10" : "text-ink-3 hover:text-ink",
              )}
            >
              <Icon size={14} />
              {t === "artifacts" && unseenHere > 0 && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-brand-500" />}
            </button>
          </Tip>
        );
      })}
    </div>
  );

  return (
    <div className={cn("relative flex h-full min-w-0 flex-col", mission && "[&>:not([data-name-card])]:opacity-60 [&>:not([data-name-card])]:blur-[3px]")}>
      {mission && <NameCard agent={agent} />}
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
        compact={compact}
        dense={dense}
        tabs={dense ? tabIcons : undefined}
        floatAction={floatAction}
        inset={inset}
        restarting={restarting}
        active={active}
        viewMenu={viewMenu}
        viewMenuInPane={viewMenuInPane}
        onClosePane={pane?.onClose}
      />
      {agent.status === "waiting" && s?.waiting && (
        <div className={cn("mb-3 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm", compact ? "mx-3 gap-2 px-3 py-2 text-xs" : "mx-5")}>
          <StatusIcon status="waiting" size={16} tip={false} />
          <span className={cn("font-semibold whitespace-nowrap text-amber-800 dark:text-amber-200", compact ? "min-w-0 truncate" : "shrink-0")}>
            {s.waiting.reason === "permission" ? "Waiting for a permission" : "Waiting for your answer"}
          </span>
          {s.waiting.detail && <span className={cn("truncate text-amber-800/80 dark:text-amber-200/80", compact && "min-w-0 flex-1")}>{s.waiting.detail}</span>}
          <span className="ml-auto shrink-0 text-xs text-amber-800/70 tabular dark:text-amber-200/70">{ago(s.waiting.since, now)}</span>
        </div>
      )}
      <div className={cn("flex min-h-0 flex-1", compact ? "px-1.5 pb-1.5" : "px-3 pb-3")}>
        <div
          className={cn(
            "relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-canvas shadow-sm transition-[border-color,box-shadow] duration-150",
            compact && active ? "border-brand-500/70 ring-[3px] ring-brand-500/15" : "border-line",
          )}
        >
          <div
            data-tauri-drag-region
            // More tabs than room (a narrow pane): one line that scrolls sideways (trackpad or wheel).
            onWheel={(e) => e.deltaY && !e.deltaX && (e.currentTarget.scrollLeft += e.deltaY)}
            className={cn(
              "@container flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-line px-2 pt-1.5 whitespace-nowrap [scrollbar-width:none] [&>*]:shrink-0",
              dense && "hidden",
            )}
          >
            {tabs.map((t, i) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 pt-1 pb-2 text-xs transition-colors @max-[340px]:px-1.5",
                  tab === t ? "border-brand-500 font-semibold text-ink" : "border-transparent text-ink-3 hover:text-ink",
                )}
              >
                {t === "main" ? (agent.attachable && agent.live ? "Terminal" : "Session") : TAB_LABEL[t]}
                <span className="text-[10px] font-normal text-ink-3 @max-[340px]:hidden">⌃{i + 1}</span>
                {t === "artifacts" && artifacts.length > 0 && (
                  <span className={cn("rounded-full px-1.5 text-[10px] leading-4 tabular", unseenHere ? "bg-brand-600 font-semibold text-white" : "bg-line text-ink-3")}>{artifacts.length}</span>
                )}
              </button>
            ))}
          </div>
          {/* The terminal stays mounted behind the Artifacts tab, so switching keeps its session. */}
          <div className={cn("relative min-h-0 flex-1", tab !== "main" && "hidden", agent.attachable && agent.live && "bg-term")}>
          {floating ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <MaximizeSquare3LinearIcon size={26} className="text-ink-3" />
              <p className="text-sm font-semibold text-ink">{agent.name} is in its own window</p>
              <div className="flex items-center gap-2">
                <button onClick={floating.show} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700">
                  Show the window
                </button>
                <button onClick={floating.bringBack} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-2 ring-1 ring-line-strong transition-colors hover:bg-line">
                  Bring it back
                </button>
              </div>
            </div>
          ) : preview && !previewAttach && agent.attachable ? (
            <div className="flex h-full items-center justify-center text-xs text-ink-3">Terminal not attached in preview mode.</div>
          ) : agent.attachable && agent.live ? (
            <AgentTerminal
              key={agent.id}
              agentKey={agent.id}
              argv={agent.codex ? agent.codex.argv : ["claude", "attach", agent.cli?.id ?? agent.id.slice(0, 8)]}
              onCloseSession={() => actions.close(agent)}
              instance={agent.cli?.startedAt}
              cwd={agent.cwd}
              className="h-full"
            />
          ) : (
            agent.unplugged ? (
              <Unplugged agent={agent} installed={pluginInstalled} />
            ) : (
              <ReadOnly agent={agent} now={now} handoff={handoff} request={request} autoResume={openedClosed.current} onElsewhere={() => actions.resumeElsewhere(agent)} />
            )
          )}
        </div>
          {tab === "conversation" && (
            <div className="min-h-0 flex-1" style={textScale !== 1 ? { zoom: textScale } : undefined}>
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
          {tab === "run" && hasRepo && (
            <div className="min-h-0 flex-1" style={textScale !== 1 ? { zoom: textScale } : undefined}>
              <RunView agent={agent} active={tab === "run"} onError={onError} onNotice={onNotice} onConfirm={onConfirm} onArchived={() => actions.remove(agent)} />
            </div>
          )}
          {tab === "changes" && hasRepo && (
            <div className="min-h-0 flex-1" style={textScale !== 1 ? { zoom: textScale } : undefined}>
              <ChangesView agent={agent} queue={queue} active={tab === "changes"} onError={onError} onNotice={onNotice} />
            </div>
          )}
          {tab === "artifacts" && (
            <div className="min-h-0 flex-1" style={textScale !== 1 ? { zoom: textScale } : undefined}>
              <ArtifactsPane artifacts={artifacts} focus={artifactFocus?.key || undefined} focusVersion={artifactFocus?.version} focusAt={artifactFocus?.at} now={now} isUnseen={seen.isUnseen} markSeen={seen.markSeen} onError={onError} onClaudeLink={onClaudeLink} />
            </div>
          )}
        </div>
        {part === "all" && inspectorSlot}
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
  compact,
  dense,
  tabs,
  floatAction,
  inset,
  restarting,
  active = true,
  viewMenu,
  viewMenuInPane,
  onClosePane,
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
  compact?: boolean;
  dense?: boolean;
  tabs?: React.ReactNode;
  floatAction?: { kind: "float" | "dock"; run: () => void };
  inset?: boolean;
  restarting?: boolean;
  active?: boolean;
  viewMenu?: React.ReactNode;
  viewMenuInPane?: boolean;
  onClosePane?: () => void;
}) {
  const s = agent.session;
  const ctx = s?.context;
  const used = contextUsed(ctx);
  // A plugin that did not load: often a folder Claude Code doesn't trust, which /reload-plugins can't fix.
  const [untrusted, setUntrusted] = useState(false);
  useEffect(() => {
    if (!agent.pluginDown) return setUntrusted(false);
    invoke<boolean | null>("folder_trusted", { cwd: agent.cwd }).then((t) => setUntrusted(t === false), () => {});
  }, [agent.pluginDown, agent.cwd]);
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
    <header data-tauri-drag-region className={cn("flex shrink-0 flex-col", compact && "group/pane @container min-w-0 @max-[300px]:[&_.size-8]:size-6", dense ? "px-2.5 py-1.5 [&_.size-8]:size-7" : compact ? "gap-1.5 px-3 pt-2.5 pb-2" : "gap-2.5 px-5 pt-3.5 pb-3.5", compact && (active ? "relative z-30" : "relative z-20"), inset && "pl-[76px]")}>
      <div data-tauri-drag-region className={cn("flex items-center", compact ? "gap-2" : "gap-3")}>
        <StatusIcon status={agent.status} size={compact ? 15 : 18} />
        {renaming ? (
          <NameEditor value={agent.name} onSave={(name) => renaming.save(agent, name)} onCancel={renaming.cancel} className="max-w-sm text-xl tracking-tight" />
        ) : (
          // The name fills a pane's header: it has to move the window too. "deep": its twin tag as well.
          <h1 data-tauri-drag-region="deep" className={cn("truncate font-semibold tracking-tight", compact ? "text-[15px]" : "text-xl", compact && "min-w-0 flex-1", active ? "text-ink" : "text-ink-2")}>
            {agent.name}
            {agent.twin && <span className="ml-2 font-mono text-sm font-normal text-ink-3">{agent.twin}</span>}
          </h1>
        )}
        {!dense && <span data-tauri-drag-region className={cn("shrink-0 text-ink-3", compact ? "text-xs @max-[420px]:hidden" : "text-sm")}>{STATUS_LABEL[agent.status]}</span>}
        {restarting && (
          <button
            onClick={() => void invoke("agent_restart_cancel", { sessionId: agent.id })}
            title="Cancel the restart"
            className="shrink-0 rounded-full bg-brand-500/15 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-brand-700 hover:bg-brand-500/25 dark:text-brand-300"
          >
            restarts after this turn · cancel
          </button>
        )}
        {closing && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
            {request?.waiting ? `closing when done · waiting: ${request.waiting}` : "closing after this turn…"}
          </span>
        )}
        {agent.status === "working" && s?.turn && !compact && (
          <span className="truncate text-sm text-ink-3">· {ago(s.turn.startedAt, now)} on “{s.turn.prompt.slice(0, 80)}”</span>
        )}
        {!compact && <span className="flex-1" />}
        {dense && used !== undefined && (
          <Tip side="bottom" content={<TipLabel label={`Context: ${Math.round(used)}% used`} />}>
            <span className="flex shrink-0 items-center gap-1.5 @max-[400px]:hidden">
              <Meter value={used} className="w-6 @max-[440px]:hidden" />
              <span className={cn("text-[10.5px] tabular", fillText(used))}>{Math.round(used)}%</span>
            </span>
          </Tip>
        )}
        {tabs}
        {/* Panes share these in the bar above them; a floating window has its own inspector. */}
        {!compact && <UnderwayPill />}
        {(!compact || viewMenuInPane) && viewMenu}
        {(!compact || inset) && (
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
        )}
        <ActionMenu
          items={agentActionItems(agent, actions)}
          defaultOpen={openMenu}
          trigger={(toggle, isOpen) => (
            <Tip side="bottom" content={isOpen ? null : <TipLabel label="Session actions" />}>
              <button
                onClick={toggle}
                aria-label="Session actions"
                className={cn(
                  "relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-all duration-200 hover:bg-line hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand-500",
                  isOpen && "bg-line text-ink",
                )}
              >
                <MenuDotsLinearIcon size={18} />
                {agent.update && <span title={`Claude Code ${agent.update.to} is installed: Restart to Update`} className="absolute top-1 right-1 size-1.5 rounded-full bg-brand-500" />}
              </button>
            </Tip>
          )}
        />
        {floatAction && (
          <Tip side="bottom" content={<TipLabel label={floatAction.kind === "float" ? "Move to its own window" : "Back to the main window"} />}>
            <button
              onClick={floatAction.run}
              aria-label={floatAction.kind === "float" ? "Move to its own window" : "Back to the main window"}
              className={cn(
                "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-all duration-200 hover:bg-line hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand-500",
                compact && "@max-[300px]:hidden @max-[300px]:group-hover/pane:inline-flex",
              )}
            >
              {floatAction.kind === "float" ? <MaximizeSquare3LinearIcon size={17} /> : <MinimizeSquare3LinearIcon size={17} />}
            </button>
          </Tip>
        )}
        {onClosePane && (
          <Tip side="bottom" content={<TipLabel label="Close this pane" />}>
            <button
              onClick={onClosePane}
              aria-label="Close this pane"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-all duration-200 hover:bg-line hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand-500 @max-[300px]:hidden @max-[300px]:group-hover/pane:inline-flex"
            >
              <CloseCircleLinearIcon size={17} />
            </button>
          </Tip>
        )}
      </div>
      <div
        data-tauri-drag-region
        // In a narrow pane the chips stay on one line and scroll sideways (trackpad, or the wheel).
        onWheel={compact ? (e) => e.deltaY && !e.deltaX && (e.currentTarget.scrollLeft += e.deltaY) : undefined}
        className={cn("flex items-center gap-1.5", dense && "hidden", compact ? "flex-nowrap overflow-x-auto overscroll-x-contain whitespace-nowrap [scrollbar-width:none] [&>*]:shrink-0" : "flex-wrap")}
      >
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
                    {shortNumber(ctx.tokens)} / {shortNumber(ctx.window)} tokens
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
                        {ctx?.tokens !== undefined && ` ${shortNumber(ctx.tokens)} of ${shortNumber(ctx.window)} tokens.`}
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
        {/* Only the exception is worth a chip: a session running outside OpenAdmiral
            (an editor, a terminal window); one in OpenAdmiral is the normal case. */}
        {runsElsewhere(agent) && (
          <Chip icon={<MonitorLinearIcon size={13} />}>
            In {whereLabel(agent) ?? "Terminal"}
            <Info
              tip={
                inExtension(agent)
                  ? `Running in the ${whereLabel(agent)} panel. Follow it here; keep working on it in ${whereLabel(agent)}.`
                  : `Running in ${whereLabel(agent) ?? "a terminal window"}. Bring it into OpenAdmiral to work on it here.`
              }
            />
          </Chip>
        )}
        {agent.unplugged && (
          <Tip side="bottom" content={<TipLabel label={`Running in ${agent.unplugged.via} without the OpenAdmiral plugin: its conversation is here, live status and the rest need the plugin.`} />}>
            <Chip icon={<MonitorLinearIcon size={13} />} className="text-brand-700 dark:text-brand-300">
              In {agent.unplugged.via} · not connected
            </Chip>
          </Tip>
        )}
        {agent.pluginDown && untrusted && (
          <Tip
            side="bottom"
            content={
              <TipLabel
                label={`Claude Code doesn't trust ${agent.cwd}, so it runs no plugins there and this session's status is out of date. Click to copy the fix: run it in a terminal, accept the trust prompt (its default is “No, exit”), quit, then restart this agent.`}
              />
            }
          >
            <Chip icon={<DangerTriangleLinearIcon size={13} />} className="text-amber-700 dark:text-amber-300" onClick={() => cmd.copy(`cd ${shellQuote(agent.cwd)} && claude`)}>
              Folder not trusted · Fix
            </Chip>
          </Tip>
        )}
        {agent.pluginDown && !untrusted && (
          <Tip side="bottom" content={<TipLabel label="OpenAdmiral's plugin did not load when this session last started, so its context and status here are out of date. Reload types /reload-plugins in its terminal: press Return to run it." />}>
            <Chip icon={<RefreshLinearIcon size={13} />} className="text-amber-700 dark:text-amber-300" onClick={() => void cmd.fill("/reload-plugins")}>
              Plugin not running · Reload
            </Chip>
          </Tip>
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

function Tasks({ tasks, session }: { tasks: TranscriptTask[]; session: AdmiralSession | undefined }) {
  const done = tasks.filter((t) => t.status === "completed").length;
  const now = hasNow(session);
  return (
    <div className="px-3 pb-3">
      {/* The main work first; the sub-tasks Claude listed apart, below. */}
      {now && (
        <div className="mb-3 border-b border-line pb-3">
          <NowPanel session={session} />
        </div>
      )}
      {now && <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Sub-tasks</div>}
      {tasks.length === 0 ? (
        <p className="px-1 text-xs text-ink-3">No sub-tasks in this session.</p>
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

/** A session found running without the plugin: what OpenAdmiral can and cannot do, and how to connect it. */
function Unplugged({ agent, installed }: { agent: Agent; installed: boolean }) {
  const via = agent.unplugged?.via ?? "Claude Code";
  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="max-w-xl rounded-xl border border-line bg-panel p-5">
        <p className="text-sm font-semibold text-ink">Running in {via}, not connected</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-2">
          OpenAdmiral found this session through its transcript, so you can follow it here and read the whole conversation in the Conversation tab. To see when it
          needs you, get its notifications, queue prompts with Up next, and hand work between agents, connect it with the OpenAdmiral plugin.
        </p>
        <PluginSetup installed={installed} className="mt-4" />
      </div>
    </div>
  );
}

/** Agents this run of the app already resumed on its own: once each, so a failure does not loop. */
const autoResumed = new Set<string>();
/** A live session whose plugin has not written for this long is taken as having none running. */
const PLUGIN_SILENT_MS = 3 * 60_000;
/** Opened, not passed over: ⌥↓ through the list moves on before this. */
const AUTO_RESUME_MS = 1000;

function ReadOnly({ agent, now, handoff: pending, request, autoResume, onElsewhere }: { agent: Agent; now: number; handoff?: Handoff; request?: AdmiralRequest; autoResume: boolean; onElsewhere: () => void }) {
  const s = agent.session;
  const [handoff, setHandoff] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Running in an editor or a terminal window (interactive sessions are not in `claude agents`).
  const inTerminal = runsElsewhere(agent);
  const where = whereLabel(agent) ?? "a terminal window";
  const panel = inExtension(agent);
  // A closed session opened here resumes by itself, as if Resume had been pressed.
  // Not one with no conversation to continue: resuming that would start a new session.
  const stopped = !inTerminal && !panel && !agent.cli && !agent.unplugged && !pending && agent.session?.hasTranscript !== false;
  useEffect(() => {
    if (!autoResume || !stopped || autoResumed.has(agent.id) || closedByHand(agent.id)) return;
    const t = setTimeout(() => {
      autoResumed.add(agent.id);
      startHandoff(agent.id, agent.cli?.name ?? agent.session?.name ?? agent.name, agent.cwd).catch((e) => setStartError(String(e)));
    }, AUTO_RESUME_MS);
    return () => clearTimeout(t);
    // Once per opening: the agent's own updates must not restart the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, stopped]);
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
    <div className="@container flex h-full flex-col overflow-y-auto p-6 @max-[480px]:p-3">
      {/* A narrow pane: the buttons drop below the text instead of squeezing it into a column of words. */}
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-line bg-panel p-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400">
          <RecordCircleLinearIcon size={20} />
        </span>
        <div className="min-w-[min(13rem,100%)] flex-1 basis-[16rem] text-sm text-ink-2">
          {panel ? (
            <>
              <p className="font-semibold text-ink">Running in {where}</p>
              <p className="mt-0.5 text-xs leading-relaxed">
                Follow it here and read its whole conversation; you'll know when it needs you. Keep working on it in {where}: its panel there can't hand it over. Once you
                close its tab, you can resume it in OpenAdmiral.
              </p>
            </>
          ) : inTerminal ? (
            <>
              <p className="font-semibold text-ink">Running in {where}</p>
              <p className="mt-0.5 text-xs leading-relaxed">
                Follow it here and read its whole conversation. Bring it into OpenAdmiral to work on it here: it continues as the same conversation, and keeps running when you
                close OpenAdmiral.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-ink">Not running</p>
              <p className="mt-0.5 text-xs leading-relaxed">Resume this conversation in OpenAdmiral and pick up where it left off.</p>
            </>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {inTerminal && !agent.session?.host && (
            <button
              onClick={() => invoke("open_in_terminal", { cwd: agent.cwd }).catch(() => {})}
              className="rounded-lg px-3 py-2 text-xs font-semibold text-ink-2 transition-all duration-200 hover:bg-line focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              Open folder in Terminal
            </button>
          )}
          {stopped && (
            <button onClick={onElsewhere} className="rounded-lg px-3.5 py-2 text-sm text-ink-2 transition-all duration-200 hover:bg-line">
              Resume in Another Folder…
            </button>
          )}
          {!panel && (
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
          )}
        </div>
      </div>
      <HandoffSheet agent={agent} handoff={pending} waiting={request?.waiting} startError={startError} open={handoff} onClose={() => setHandoff(false)} />

      {s?.turn && agent.status === "working" && (
        <Block label={`Working · ${ago(s.turn.startedAt, now)}`}>
          <p className="selectable text-sm text-ink">{s.turn.prompt}</p>
          <NowPanel session={s} />
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

/** A path for a shell command line, quoted when it needs it. */
function shellQuote(p: string) {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * While Mission Control is open (lib/mission.ts): the view blurred under a small card
 * with the agent's name, its project and what it is doing, so each thumbnail says who
 * it is. Sized to its own pane (container units), one card per pane.
 */
function NameCard({ agent }: { agent: Agent }) {
  const color = projectColor(agent.project);
  const busy = agent.status === "working" || agent.status === "waiting";
  return (
    // Near the top, not the middle: Mission Control puts its own title in the middle on hover.
    <div data-name-card className="pointer-events-none absolute inset-0 z-40 flex items-start justify-center p-3 pt-[12cqh]" style={{ containerType: "size" }}>
      <div
        className="flex max-w-[88cqw] flex-col items-center rounded-2xl border border-line-strong bg-canvas/94 px-[1.2em] py-[0.8em] text-center shadow-2xl"
        style={{ fontSize: "clamp(14px, 4.6cqw, 26px)" }}
      >
        <span className="flex max-w-full items-center gap-[0.45em] text-[0.72em] font-semibold tracking-[0.08em] text-ink-3 uppercase">
          <span className="size-[0.7em] shrink-0 rounded-full" style={{ background: color }} />
          <span className="truncate">{agent.project}</span>
        </span>
        <span className="mt-[0.15em] max-w-full truncate text-[1.6em] leading-tight font-semibold tracking-tight text-ink">{agent.name}</span>
        {busy && (
          <span
            className={cn(
              "mt-[0.45em] flex items-center gap-[0.4em] rounded-full px-[0.65em] py-[0.15em] text-[0.75em] font-semibold",
              agent.status === "waiting" ? "bg-amber-400/15 text-amber-700 dark:text-amber-300" : "bg-brand-500/12 text-brand-700 dark:text-brand-300",
            )}
          >
            <StatusIcon status={agent.status} tip={false} />
            {agent.status === "waiting" ? "Needs you" : "Working"}
          </span>
        )}
      </div>
    </div>
  );
}
