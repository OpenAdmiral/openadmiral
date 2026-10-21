import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, MotionGlobalConfig, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent } from "@/lib/types";
import { AboutSheet } from "@/components/AboutSheet";
import { AgentDetail } from "@/components/AgentDetail";
import { CostsView } from "@/components/CostsView";
import { useCostReport, useCosts, type RangeDays } from "@/lib/costs";
import { DelegationsView } from "@/components/DelegationsView";
import { AgentsMap } from "@/components/AgentsMap";
import { NewAgentSheet } from "@/components/NewAgentSheet";
import { Sidebar, type View } from "@/components/Sidebar";
import { useSidebarOrder } from "@/lib/order";
import { setProjectOrder } from "@/lib/utils";
import { takeAttention } from "@/lib/attention";
import { activeOpenCount, staleReason } from "@/lib/delegations";
import { useUiState } from "@/lib/ui";
import { parseFocus } from "@/lib/focus";
import { listen } from "@tauri-apps/api/event";
import { Rail } from "@/components/Rail";
import { TooltipProvider } from "@/components/Tooltip";
import { useHandoffs } from "@/lib/handoffs";
import { useRename } from "@/lib/rename";
import { keyOf, latest, useSeen } from "@/lib/artifacts";
import { ArtifactsGallery } from "@/components/ArtifactsPane";
import { invoke } from "@tauri-apps/api/core";
import { useRef } from "react";
import { devEnv } from "@/lib/dev";
import { agentMenuEntries, useLifecycle } from "@/lib/lifecycle";
import { enableTrace, fireMenuItem, registerMenu, setMenuErrorHandler, trace } from "@/lib/menu";
import { ConfirmDialog, Notices } from "@/components/Overlays";
import { useAdmiral } from "@/lib/admiral";
import { matchShortcut, type ShortcutId } from "@/lib/shortcuts";
import { ShortcutsSheet } from "@/components/ShortcutsSheet";
import { QueueView } from "@/components/QueueView";
import { pending, useQueueJanitor, type SchedulerEvent } from "@/lib/queue";
import { isTimed } from "@/lib/schedule";
import { UnderwayContext, useUnderway } from "@/lib/underway";
import { pluginBehind, reloadPlugin, usePluginChangedAt } from "@/lib/plugin";
import { recentOrder, useSortMode } from "@/lib/recent";
import { UnderwayPill } from "@/components/UnderwayPill";
import { PluginSetup } from "@/components/PluginSetup";

export default function App() {
  const { agents: rawAgents, delegations, rateLimits, now, cliReady, queues, artifacts, requests, loaded, superseded, pluginInstalled } = useAdmiral();
  const [view, setView] = useState<View | null>(null);
  // A new agent from the + sheet: open it as soon as the CLI lists it (give up after a minute).
  const [openWhenListed, setOpenWhenListed] = useState<{ shortId: string; at: number } | null>(null);
  // After /clear the agent on screen carries a new session id: follow it.
  useEffect(() => {
    if (view?.kind !== "agent") return;
    const next = superseded.get(view.id);
    if (next) setView({ kind: "agent", id: next });
  }, [superseded, view]);
  const [sheet, setSheet] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [about, setAbout] = useState(false);
  const life = useLifecycle(rawAgents);
  const underway = useUnderway();
  // Sessions still on an older plugin than the installed one: offer /reload-plugins.
  const pluginChangedAt = usePluginChangedAt();
  const reloadPlugins = useCallback(
    (ids: string[]) =>
      reloadPlugin(ids).then(
        (n) => life.notify(n === 1 ? "Reloading the plugin: the session does it as soon as it is idle." : `Reloading the plugin in ${n} sessions, each as soon as it is idle.`),
        (e) => life.notify(String(e), "error"),
      ),
    [life.notify],
  );
  // Auto-resume (src-tauri/src/resume.rs): say which agents a dropped connection had stopped.
  useEffect(() => {
    const off = listen<{ sessionId: string; name: string }>("openadmiral://resumed", (e) => life.notify(`Back online: ${e.payload.name || "an agent"} carries on where the connection dropped`));
    return () => void off.then((f) => f());
  }, [life.notify]);
  // Rename shows the new name at once (and moves the sidebar-order entry, keyed by name).
  const renameKey = useRef<(a: Agent, from: string, to: string) => void>(() => {});
  const renameFailed = useCallback((text: string) => life.notify(text, "error"), [life.notify]);
  const rename = useRename(rawAgents, now, (a, from, to) => renameKey.current(a, from, to), renameFailed);
  const agents = rename.agents;
  const behindIds = agents.filter((a) => pluginBehind(a, pluginChangedAt)).map((a) => a.id);
  const order = useSidebarOrder(agents, cliReady);
  // My order (projects, as arranged) or Recent (flat, by last activity): the
  // sidebar, the rail and ⌘1–9 / ⌥↑↓ all follow the one shown.
  const [sortMode, setSortMode] = useSortMode();
  const shown = useMemo(() => (sortMode === "recent" ? recentOrder(order.flat) : order.flat), [sortMode, order.flat]);
  useEffect(() => {
    if (!openWhenListed) return;
    if (Date.now() - openWhenListed.at > 60_000) return setOpenWhenListed(null);
    const a = agents.find((x) => x.cli?.id === openWhenListed.shortId || x.id.startsWith(openWhenListed.shortId));
    if (!a) return;
    setOpenWhenListed(null);
    setView({ kind: "agent", id: a.id });
  }, [agents, openWhenListed]);
  renameKey.current = order.renameKey;
  // Project colors follow the sidebar order, everywhere in the app.
  setProjectOrder(order.groups.map((g) => g.label));
  // Select the resumed session so its terminal opens (its id, or the copy's when claude made one).
  const handoffs = useHandoffs(({ to }) => setView({ kind: "agent", id: to }));
  const ui = useUiState();
  const seen = useSeen(artifacts, loaded);
  // An artifact to show in the agent's Artifacts tab (from a toast or the gallery).
  const [artifactFocus, setArtifactFocus] = useState<{ sessionId: string; key: string; at: number; version?: number } | null>(null);
  // "Open in OpenAdmiral" from a session's transcript (focus.json; the backend already raised the window).
  const lastFocus = useRef(0);
  useEffect(() => {
    const off = listen<unknown>("openadmiral://focus", (e) => {
      const f = parseFocus(e.payload, Date.now(), lastFocus.current);
      if (!f) return;
      lastFocus.current = f.at;
      setView({ kind: "agent", id: f.sessionId });
      setArtifactFocus({ sessionId: f.sessionId, key: `${f.sessionId}/${f.artifactId}`, at: f.at, version: f.version });
    });
    return () => {
      off.then((u) => u());
    };
  }, []);
  // Clicking a "needs you" notification brings OpenAdmiral forward: open that agent (its terminal shows the prompt).
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  useEffect(() => {
    const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      const id = takeAttention((x) => agentsRef.current.some((a) => a.id === x && a.status === "waiting"));
      if (id) setView({ kind: "agent", id });
    });
    return () => {
      off.then((u) => u());
    };
  }, []);
  // Help → Keyboard Shortcuts (its ⌘/ accelerator lands here too, before the webview sees the key).
  useEffect(() => {
    const off = listen("openadmiral://shortcuts", () => setShortcuts(true));
    return () => {
      off.then((u) => u());
    };
  }, []);
  useEffect(() => {
    const off = listen("openadmiral://about", () => setAbout(true));
    return () => {
      off.then((u) => u());
    };
  }, []);
  // A turn to show in the Conversation tab (the preview's OPENADMIRAL_TAB=conversation:<turn>).
  const [turnFocus, setTurnFocus] = useState<{ sessionId: string; index: number; at: number } | null>(null);
  const openClaude = (href: string) => invoke("browser_open", { url: href }).catch((e) => life.notify(String(e), "error"));

  // New artifacts or versions: a toast for the agent on screen; the sidebar badge covers the rest.
  const versionsSeen = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const current = new Map(artifacts.map((a) => [keyOf(a), latest(a).n]));
    const before = versionsSeen.current;
    versionsSeen.current = current;
    if (!before) return;
    for (const a of artifacts) {
      const n = latest(a).n;
      if ((before.get(keyOf(a)) ?? 0) >= n) continue;
      if (view?.kind === "agent" && view.id === a.sessionId) {
        life.notify(n > 1 ? `New version of “${a.title}” (v${n})` : `New artifact: “${a.title}”`, "info", {
          label: "Open",
          run: () => setArtifactFocus({ sessionId: a.sessionId, key: keyOf(a), at: Date.now() }),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifacts, loaded]);
  // Up next: sent one-shots leave their files; queues follow a session's new id.
  useQueueJanitor(queues, superseded);
  const scheduledCount = Object.values(queues).reduce((n, e) => n + pending(e).filter(isTimed).length, 0);
  // A newer version (the updater checks at launch, every 6 h and from Help → Check for Updates…).
  const [update, setUpdate] = useState<{ version: string; installing: boolean } | null>(null);
  useEffect(() => {
    const offs = [
      listen<{ version: string }>("openadmiral://update", (e) => setUpdate({ version: e.payload.version, installing: false })),
      listen<string>("openadmiral://update-none", (e) => life.notify(`You're up to date: OpenAdmiral ${e.payload} is the latest version.`)),
      listen<string>("openadmiral://update-error", (e) => life.notify(`Could not check for updates: ${e.payload}`, "error")),
    ];
    return () => offs.forEach((off) => off.then((u) => u()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const installUpdate = () => {
    setUpdate((u) => (u ? { ...u, installing: true } : u));
    invoke("update_install").catch((err) => {
      setUpdate((u) => (u ? { ...u, installing: false } : u));
      life.notify(`The update failed: ${String(err)}`, "error");
    });
  };

  // A file saved from the webview (an image's Download Image): say where it went.
  useEffect(() => {
    const off = listen<{ success: boolean; path?: string | null }>("openadmiral://download", (e) => {
      const { success, path } = e.payload;
      if (!success) return life.notify("The download failed.", "error");
      const name = path?.split("/").pop();
      life.notify(`Saved ${name ?? "the file"} to Downloads.`, "info", path ? { label: "Show in Finder", run: () => void invoke("reveal_path", { path }) } : undefined);
    });
    return () => {
      off.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The scheduler (Rust) resumed a closed agent for a due item, or could not.
  useEffect(() => {
    const off = listen<SchedulerEvent>("openadmiral://scheduler", (e) => {
      const ev = e.payload;
      const who = ev.name || ev.sessionId.slice(0, 8);
      if (ev.state === "resumed") life.notify(`Resumed ${who} to run its scheduled Up next item.`);
      else if (ev.state === "error") life.notify(`Could not resume ${who} for its scheduled item: ${ev.error ?? "unknown error"}. OpenAdmiral retries in 10 minutes.`, "error");
    });
    return () => {
      off.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const costReport = useCostReport();
  const [costRange, setCostRange] = useState<RangeDays>(30);
  const costs = useCosts(costReport.report, agents, costRange);
  // The menu bar's fleet report shows today's cost (src-tauri/src/tray.rs).
  useEffect(() => {
    invoke("tray_today", { usd: costs?.today ?? null }).catch(() => {});
  }, [costs?.today]);
  // Clicks in the menu bar menu: an agent, a view, a new agent, the Underway panel.
  useEffect(() => {
    const offs = [
      listen<{ kind: string; id?: string }>("openadmiral://navigate", (e) => {
        const { kind, id } = e.payload;
        if (kind === "agent" && id) setView({ kind: "agent", id });
        else if (kind === "agents" || kind === "costs" || kind === "queue" || kind === "delegations" || kind === "artifacts") setView({ kind });
      }),
      listen("openadmiral://new-agent", () => setSheet(true)),
      listen("openadmiral://underway-panel", () => window.dispatchEvent(new CustomEvent("openadmiral:tip", { detail: "underway" }))),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, []);

  const [preview, setPreview] = useState(false);
  const [previewChecks, setPreviewChecks] = useState({ attach: false, probe: false });
  useEffect(() => {
    devEnv.then((d) => {
      setPreview(d.preview);
      setPreviewChecks({ attach: !!d.attach, probe: !!d.probe });
      if (d.select) setView({ kind: "agent", id: d.select });
      if (d.view === "agents" || d.view === "delegations" || d.view === "costs" || d.view === "artifacts" || d.view === "queue") setView({ kind: d.view });
      if (d.view === "about") setAbout(true);
      if (d.sort === "recent" || d.sort === "order") setSortMode(d.sort);
      if (d.rail) ui.toggleLeft();
      if (d.inspectorHidden) ui.toggleRight();
      // A webview snapshot leaves out the window's vibrancy: paint it (index.css).
      // Animations off too: a snapshot must not land mid-transition.
      if (d.shot) {
        document.documentElement.dataset.shot = "";
        MotionGlobalConfig.skipAnimations = true;
      }
      // OPENADMIRAL_TIP=<id>: open that tooltip once things have rendered (preview screenshots).
      if (d.tip) setTimeout(() => window.dispatchEvent(new CustomEvent("openadmiral:tip", { detail: d.tip })), 3500);
      // OPENADMIRAL_TAB=artifacts[:<artifactId>] opens the Artifacts tab, on that artifact if named.
      // OPENADMIRAL_TAB=menu (preview): the session actions popover open at start, for a screenshot.
      if (d.select && d.tab === "menu") setTurnFocus({ sessionId: d.select, index: -2, at: Date.now() });
      if (d.select && d.tab?.startsWith("conversation")) {
        setTurnFocus({ sessionId: d.select, index: Number(d.tab.split(":")[1] ?? -1), at: Date.now() });
      }
      if (d.select && d.tab?.startsWith("artifacts")) {
        const id = d.tab.split(":")[1];
        setArtifactFocus({ sessionId: d.select, key: id ? `${d.select}/${id}` : "", at: Date.now() });
      }
    });
  }, []);

  // Preview check: fire agent menu items by id through the backend's menu handler, as a click would.
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current || !loaded || !cliReady) return;
    devEnv.then(async (d) => {
      if (!d.debugMenu || fired.current) return;
      fired.current = true;
      enableTrace();
      setMenuErrorHandler((m) => trace(`menu error: ${m}`));
      trace(`debug menu: ${agents.length} agents, firing ${d.debugMenu}`);
      for (const id of d.debugMenu.split(",")) {
        // App-menu items (Help → …) need no agent.
        if (id.startsWith("help:")) {
          await fireMenuItem(id).catch((err) => trace(`menu error: ${String(err)}`));
          continue;
        }
        const sessionId = id.split(":").at(-1)!;
        const a = agents.find((x) => x.id === sessionId);
        if (!a) {
          trace(`debug menu: no agent ${sessionId}`);
          continue;
        }
        registerMenu(agentMenuEntries(a, life.actions));
        await fireMenuItem(id).then(() => trace(`fired ${id}`), (e) => trace(`fire failed ${id}: ${e}`));
        await new Promise((r) => setTimeout(r, 1500));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, cliReady, agents.length]);

  // Land on whoever needs attention first, else the first live agent.
  useEffect(() => {
    if (view || !order.ready || !cliReady || order.flat.length === 0) return;
    setView({ kind: "agent", id: order.flat[0].id });
  }, [order.flat, order.ready, cliReady, view]);

  // The agent before/after the selected one, in sidebar order (no wrapping).
  const nextInOrder = (dir: 1 | -1) => {
    const list = shown;
    const i = view?.kind === "agent" ? list.findIndex((a) => a.id === view.id) : -1;
    if (i === -1) return dir === 1 ? list[0] : list.at(-1);
    return list[i + dir];
  };
  // Like Slack's unread jump: agents waiting on you first, then those with unseen
  // artifacts or a delegation of theirs that just finished or got blocked.
  const nextNeedingYou = (dir: 1 | -1) => {
    const recent = Date.now() - 30 * 60_000;
    const flagged = (a: (typeof shown)[number]) =>
      (seen.unseen[a.id] ?? 0) > 0 || delegations.some((d) => d.from.sessionId === a.id && (d.status === "done" || d.status === "blocked") && d.updatedAt > recent);
    const list = [...shown.filter((a) => a.status === "waiting"), ...shown.filter((a) => a.status !== "waiting" && flagged(a))];
    if (!list.length) return undefined;
    const i = view?.kind === "agent" ? list.findIndex((a) => a.id === view.id) : -1;
    if (i === -1) return dir === 1 ? list[0] : list.at(-1);
    return list[i + dir];
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys come from the shortcuts table (lib/shortcuts.ts), which also draws the ⌘/ sheet.
      const id = matchShortcut(e);
      if (!id) return;
      // ⌘⌥↑/⌘⌥↓: previous/next agent in sidebar order; with ⇧, only those that need you.
      // ⌘ chords never reach the terminal, so these work everywhere, the terminal included.
      // Plain ⌥↑/⌥↓ also move between agents (Slack's keys), except in the terminal, where
      // Claude Code uses them, and in text fields, where they move by paragraph.
      if (id === "agent-prev" || id === "agent-next" || id === "needs-prev" || id === "needs-next") {
        if (!e.metaKey) {
          const target = e.target as HTMLElement | null;
          if (target?.closest?.(".xterm, input, textarea, [contenteditable=true]")) return;
        }
        const dir = id.endsWith("next") ? 1 : -1;
        const next = id.startsWith("needs") ? nextNeedingYou(dir) : nextInOrder(dir);
        e.preventDefault();
        e.stopPropagation();
        if (next) setView({ kind: "agent", id: next.id });
        else if (id.startsWith("needs")) life.notify("Nobody needs you right now.");
        return;
      }
      // Panels, Xcode-style: ⌘0 (or ⌘⌃S) the sidebar, ⌘⌥0 the inspector, ⌘⇧F focus mode.
      const run: Partial<Record<ShortcutId, () => void>> = {
        "toggle-inspector": ui.toggleRight,
        "toggle-sidebar": ui.toggleLeft,
        "focus-mode": ui.toggleFocus,
        shortcuts: () => setShortcuts(true),
        "new-agent": () => setSheet(true),
        "view-agents": () => setView({ kind: "agents" }),
        "view-delegations": () => setView({ kind: "delegations" }),
        "view-artifacts": () => setView({ kind: "artifacts" }),
        "view-costs": () => setView({ kind: "costs" }),
        "view-queue": () => setView({ kind: "queue" }),
        // Close the selected agent (the app menu has no Close Window, so ⌘W is ours).
        "close-agent": () => {
          const a = view?.kind === "agent" ? agents.find((x) => x.id === view.id) : undefined;
          if (a?.cli) life.actions.close(a);
        },
      };
      if (id === "agent-n") {
        const a = shown[Number(e.key) - 1];
        if (a) {
          e.preventDefault();
          setView({ kind: "agent", id: a.id });
        }
        return;
      }
      const action = run[id];
      if (!action) return;
      e.preventDefault();
      action();
    };
    // Capture: xterm swallows keys once it has focus.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, view, agents, life.actions, ui, seen.unseen, delegations]);

  const selected = view?.kind === "agent" ? agents.find((a) => a.id === view.id) : undefined;
  // With the sidebar collapsed to a rail, the name is edited in the header: show that agent.
  useEffect(() => {
    if (rename.editing && ui.leftCollapsed) setView({ kind: "agent", id: rename.editing });
  }, [rename.editing, ui.leftCollapsed]);

  return (
    <UnderwayContext.Provider value={underway}>
    <TooltipProvider>
    <div className="flex h-full">
      {/* The sidebar's width animates between full and rail; the views refit once it settles. */}
      <div
        className="h-full shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 ease-out motion-reduce:transition-none"
        style={{ width: ui.leftCollapsed ? 44 : 272 }}
      >
        {ui.leftCollapsed ? (
          <Rail
            onShortcuts={() => setShortcuts(true)}
            groups={sortMode === "recent" ? [{ key: "recent", label: "Recent", agents: shown }] : order.groups}
            view={view}
            onSelect={setView}
            onExpand={ui.toggleLeft}
            openDelegations={activeOpenCount(delegations, agents, now)}
            scheduledCount={scheduledCount}
            actions={life.actions}
            onClearEnded={() => life.clearEnded(agents)}
            onResetOrder={order.reset}
          />
        ) : (
      <Sidebar
        onCollapse={ui.toggleLeft}
        onShortcuts={() => setShortcuts(true)}
        scheduledCount={scheduledCount}
        update={update ? { ...update, install: installUpdate } : undefined}
        pluginBehind={{ count: behindIds.length, reload: () => void reloadPlugins(behindIds) }}
        unplugged={(() => {
          const list = agents.filter((a) => a.unplugged);
          return { installed: pluginInstalled, count: list.length, open: () => list[0] && setView({ kind: "agent", id: list[0].id }) };
        })()}
        groups={order.groups}
        sort={{ mode: sortMode, set: setSortMode, recent: sortMode === "recent" ? shown : [], now }}
        queues={queues}
        unseen={seen.unseen}
        requests={requests}
        artifactCount={artifacts.length}
        delegations={delegations}
        rateLimits={rateLimits}
        view={view}
        onMoveProject={order.moveProject}
        onMoveAgent={order.moveAgent}
        onResetOrder={order.reset}
        actions={life.actions}
        onClearEnded={() => life.clearEnded(agents)}
        todayCost={costs?.today}
        onSelect={setView}
        onNew={() => setSheet(true)}
        renaming={rename.editing ? { id: rename.editing, save: rename.commit, cancel: rename.cancel } : undefined}
      />
        )}
      </div>
      <main
        data-rail={ui.leftCollapsed ? "" : undefined}
        className="relative min-w-0 flex-1 border-l border-line bg-panel shadow-[-1px_0_0_0_var(--color-line)]"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view?.kind === "agent" ? view.id : (view?.kind ?? "empty")}
            className="h-full"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
          >
            {view?.kind === "artifacts" ? (
              <ArtifactsGallery artifacts={artifacts} agents={agents} now={now} isUnseen={seen.isUnseen} markSeen={seen.markSeen} onError={(m) => life.notify(m, "error")} onClaudeLink={openClaude} />
            ) : view?.kind === "costs" ? (
              <CostsView
                costs={costs}
                range={costRange}
                onRange={setCostRange}
                fetchedAt={costReport.report?.fetchedAt}
                loading={costReport.loading}
                error={costReport.error}
                onRefresh={costReport.refresh}
                agents={agents}
                rateLimits={rateLimits}
                now={now}
                onJump={(id) => setView({ kind: "agent", id })}
              />
            ) : view?.kind === "agents" ? (
              <AgentsMap
                groups={order.groups}
                agents={agents}
                // Stale delegations (agents gone, quiet for a day) are not links anymore.
                delegations={delegations.filter((d) => !staleReason(d, agents, now))}
                queues={queues}
                now={now}
                onJump={(id) => setView({ kind: "agent", id })}
                onOpenDelegations={() => setView({ kind: "delegations" })}
              />
            ) : view?.kind === "queue" ? (
              <QueueView queues={queues} agents={agents} delegations={delegations} now={now} onJump={(id) => setView({ kind: "agent", id })} onError={(m) => life.notify(m, "error")} />
            ) : view?.kind === "delegations" ? (
              <DelegationsView delegations={delegations} agents={agents} now={now} onJump={(id) => setView({ kind: "agent", id })} queues={queues} />
            ) : selected ? (
              <AgentDetail
                agent={selected}
                delegations={delegations}
                now={now}
                onOpenDelegations={() => setView({ kind: "delegations" })}
                handoff={handoffs.find((h) => h.sessionId === selected.id)}
                request={requests[selected.id]}
                inspectorHidden={ui.rightCollapsed}
                onToggleInspector={ui.toggleRight}
                layout={ui}
                actions={life.actions}
                closing={life.closing.has(selected.id)}
                preview={preview}
                previewAttach={previewChecks.attach}
                probe={previewChecks.probe}
                agents={agents}
                queue={queues[selected.id]}
                onError={(m) => life.notify(m, "error")}
                onNotice={(m) => life.notify(m)}
                onConfirm={life.setConfirm}
                artifacts={artifacts.filter((a) => a.sessionId === selected.id)}
                artifactFocus={artifactFocus?.sessionId === selected.id ? artifactFocus : undefined}
                turnFocus={turnFocus?.sessionId === selected.id ? turnFocus : undefined}
                seen={seen}
                onClaudeLink={openClaude}
                renaming={ui.leftCollapsed && rename.editing === selected.id ? { save: rename.commit, cancel: rename.cancel } : undefined}
                pluginBehind={behindIds.includes(selected.id) ? { reload: () => void reloadPlugins([selected.id]) } : undefined}
                pluginInstalled={pluginInstalled}
              />
            ) : (
              <Empty onNew={() => setSheet(true)} pluginInstalled={pluginInstalled} />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
      <ConfirmDialog confirm={life.confirm} onClose={() => life.setConfirm(null)} />
      <Notices notices={life.notices} />
      <ShortcutsSheet open={shortcuts} onClose={() => setShortcuts(false)} />
      <AboutSheet open={about} onClose={() => setAbout(false)} />
      <NewAgentSheet open={sheet} onClose={() => setSheet(false)} agents={agents} onCreated={(shortId) => shortId && setOpenWhenListed({ shortId, at: Date.now() })} />
    </div>
    </TooltipProvider>
    </UnderwayContext.Provider>
  );
}

function Empty({ onNew, pluginInstalled }: { onNew: () => void; pluginInstalled: boolean }) {
  return (
    <div data-tauri-drag-region className="relative flex h-full flex-col items-center justify-center text-center">
      <div className="absolute top-3.5 right-5">
        <UnderwayPill />
      </div>
      <img src="/icon.png" alt="" className="mb-4 size-16 opacity-90" />
      <h1 className="text-xl font-semibold text-ink">{pluginInstalled ? "Your fleet is quiet" : "Connect your Claude Code sessions"}</h1>
      <p className="mt-1 max-w-sm text-sm text-ink-3">
        {pluginInstalled
          ? "Agents appear here as soon as a Claude Code session with the OpenAdmiral plugin starts, or when you start one."
          : "OpenAdmiral shows every Claude Code session that runs its plugin. Install it once and your sessions appear here."}
      </p>
      <PluginSetup installed={pluginInstalled} className="mt-5 w-full max-w-md" />
      <button
        onClick={onNew}
        className="mt-5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
      >
        Start an agent
      </button>
    </div>
  );
}
