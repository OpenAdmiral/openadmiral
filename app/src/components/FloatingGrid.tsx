import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAdmiral } from "@/lib/admiral";
import { useSeen } from "@/lib/artifacts";
import { devEnv } from "@/lib/dev";
import { parseFocus } from "@/lib/focus";
import { useHandoffs } from "@/lib/handoffs";
import { useLifecycle } from "@/lib/lifecycle";
import { matchShortcut } from "@/lib/shortcuts";
import { gridState, relayout, type SplitState } from "@/lib/split";
import { useUiState } from "@/lib/ui";
import { AgentDetail } from "./AgentDetail";
import { WindowPalette } from "./CommandPalette";
import { ConfirmDialog, Notices } from "./Overlays";
import { PanePicker, SplitPanes, ViewMenu } from "./Split";
import { setTerminalScale } from "./Terminal";
import { TooltipProvider } from "./Tooltip";
import { RestartTrustDialog } from "./TrustPanel";

const EMPTY: SplitState = { layout: "2v", panes: [null, null], active: 0 };


/**
 * A window with a grid of its own (float.rs grid_new): any layout, the agents you put in
 * it, kept across restarts. An agent lives in one window at a time: putting it here takes
 * it out of the window that had it, and that window lets it go here too.
 */
export function FloatingGrid({ id }: { id: string }) {
  const { agents, now, queues, artifacts, requests, loaded, superseded, pluginInstalled } = useAdmiral({ quiet: true });
  const [grid, setGrid] = useState<SplitState | null>(null);
  const [preview, setPreview] = useState(false);
  const life = useLifecycle(agents);
  const ui = useUiState({ readOnly: true });
  const seen = useSeen(artifacts, loaded);
  const handoffs = useHandoffs(() => {});
  const textScale = ui.textScale ?? 1;
  const [dense, setDense] = useState(false);

  useEffect(() => void devEnv.then((d) => setPreview(d.preview)), []);
  useEffect(() => setTerminalScale(textScale), [textScale]);
  useEffect(() => {
    invoke<unknown>("grid_state_load", { id }).then((s) => setGrid(s ? gridState(s) : EMPTY), () => setGrid(EMPTY));
  }, [id]);

  const update = (f: (g: SplitState) => SplitState) =>
    setGrid((g) => {
      if (!g) return g;
      const next = f(g);
      void invoke("grid_state_save", { id, state: next }).catch(() => {});
      return next;
    });

  // Which agents this window shows, for the others (they let them go) and the main window.
  const shown = grid?.panes.filter((p): p is string => !!p) ?? [];
  const key = shown.join(",");
  useEffect(() => {
    if (grid) void invoke("grid_track", { sessions: shown }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, grid !== null]);

  // Another window took one of these agents: its pane empties here.
  useEffect(() => {
    const off = getCurrentWebviewWindow().listen<string>("openadmiral://grid-release", (e) => update((g) => ({ ...g, panes: g.panes.map((p) => (p === e.payload ? null : p)) })));
    return () => void off.then((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After /clear an agent carries a new session id: its pane follows it.
  useEffect(() => {
    if (!grid || !grid.panes.some((p) => p && superseded.get(p))) return;
    update((g) => ({ ...g, panes: g.panes.map((p) => (p && superseded.get(p)) || p) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [superseded, key]);

  // The window's title (Mission Control, the Window menu): the agents it shows.
  const names = shown.map((s) => agents.find((a) => a.id === s)?.name).filter(Boolean);
  useEffect(() => {
    void getCurrentWebviewWindow()
      .setTitle(names.length ? names.join(" · ") : "OpenAdmiral")
      .catch(() => {});
  }, [names.join(" · ")]);

  // An artifact to open, from the main window.
  const [artifactFocus, setArtifactFocus] = useState<{ key: string; at: number; version?: number; sessionId: string } | undefined>();
  const lastFocus = useRef(0);
  useEffect(() => {
    const off = getCurrentWebviewWindow().listen<unknown>("openadmiral://focus", (e) => {
      const f = parseFocus(e.payload, Date.now(), lastFocus.current);
      if (!f) return;
      lastFocus.current = f.at;
      setArtifactFocus({ key: `${f.sessionId}/${f.artifactId}`, at: f.at, version: f.version, sessionId: f.sessionId });
      update((g) => ({ ...g, active: Math.max(0, g.panes.indexOf(f.sessionId)) }));
    });
    return () => void off.then((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = matchShortcut(e);
      const run = k === "close-agent" ? () => invoke("float_close") : k === "text-bigger" ? () => ui.stepText(1) : k === "text-smaller" ? () => ui.stepText(-1) : undefined;
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ui]);

  const others = useMemo(() => agents.filter((a) => !grid?.panes.includes(a.id) && a.status !== "ended" && !a.unplugged), [agents, grid]);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-panel">
        {/* The title bar: traffic lights at its left, the layout at its right. */}
        <div data-tauri-drag-region className="flex h-[38px] shrink-0 items-center justify-end gap-1 px-2">
          {grid && (
            <ViewMenu
              layout={grid.layout}
              onLayout={(l) => update((g) => relayout(g, l, []))}
              scale={textScale}
              onScale={(d) => ui.stepText(d)}
              dense={dense}
              onDense={() => setDense((x) => !x)}
            />
          )}
        </div>
        <div className="min-h-0 flex-1 px-1.5 pb-1.5">
          {grid && (
            <SplitPanes
              layout={grid.layout}
              ratios={grid.ratios}
              onRatios={(ratios) => update((g) => ({ ...g, ratios }))}
              render={(i) => {
                const a = agents.find((x) => x.id === grid.panes[i]);
                const active = i === grid.active;
                if (!a)
                  return (
                    <PanePicker
                      sidebar={false}
                      agents={others}
                      active={active}
                      onFocus={() => update((g) => ({ ...g, active: i }))}
                      onPick={(pick) => update((g) => ({ ...g, panes: g.panes.map((p, j) => (j === i ? pick : p)), active: i }))}
                    />
                  );
                return (
                  <div className="h-full" onPointerDownCapture={() => !active && update((g) => ({ ...g, active: i }))}>
                    <AgentDetail
                      key={a.id}
                      agent={a}
                      now={now}
                      handoff={handoffs.find((h) => h.sessionId === a.id)}
                      request={requests[a.id]}
                      inspectorHidden
                      onToggleInspector={() => {}}
                      layout={ui}
                      actions={life.actions}
                      closing={life.closing.has(a.id)}
                      preview={preview}
                      agents={agents}
                      queue={queues[a.id]}
                      onError={(m) => life.notify(m, "error")}
                      onNotice={(m) => life.notify(m)}
                      onConfirm={life.setConfirm}
                      artifacts={artifacts.filter((x) => x.sessionId === a.id)}
                      artifactFocus={artifactFocus?.sessionId === a.id ? artifactFocus : undefined}
                      seen={seen}
                      onClaudeLink={(href) => invoke("browser_open", { url: href }).catch((e) => life.notify(String(e), "error"))}
                      pluginInstalled={pluginInstalled}
                      pane={{ active, onClose: () => update((g) => ({ ...g, panes: g.panes.map((p, j) => (j === i ? null : p)) })) }}
                      part="main"
                      dense={dense}
                      textScale={textScale}
                      restarting={life.restarting.includes(a.id)}
                    />
                  </div>
                );
              }}
            />
          )}
        </div>
      </div>
      <ConfirmDialog confirm={life.confirm} onClose={() => life.setConfirm(null)} />
      <RestartTrustDialog ask={life.trustAsk} onRetry={life.trustRetry} onCancel={life.trustCancel} />
      <Notices notices={life.notices} />
      <WindowPalette agents={agents} artifacts={artifacts} queues={queues} />
    </TooltipProvider>
  );
}
