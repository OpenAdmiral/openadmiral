import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useRef, useState } from "react";
import { useAdmiral } from "@/lib/admiral";
import { useSeen } from "@/lib/artifacts";
import { devEnv } from "@/lib/dev";
import { parseFocus } from "@/lib/focus";
import { useHandoffs } from "@/lib/handoffs";
import { useLifecycle } from "@/lib/lifecycle";
import { matchShortcut } from "@/lib/shortcuts";
import { useUiState } from "@/lib/ui";
import { AgentDetail } from "./AgentDetail";
import { ConfirmDialog, Notices } from "./Overlays";
import { setTerminalScale } from "./Terminal";
import { TooltipProvider } from "./Tooltip";

/** How long an agent may be missing before its window closes (a list can blink while it refreshes). */
const GONE_AFTER_MS = 5000;

/** The whole of a floating window: one agent, with the inspector a shortcut away. */
export function FloatingAgent({ id }: { id: string }) {
  const { agents, now, queues, artifacts, requests, loaded, cliReady, superseded, pluginInstalled } = useAdmiral({ quiet: true });
  const [current, setCurrent] = useState(id);
  const [inspectorHidden, setInspectorHidden] = useState(true);
  const [preview, setPreview] = useState(false);
  const life = useLifecycle(agents);
  const ui = useUiState({ readOnly: true });
  const seen = useSeen(artifacts, loaded);
  const handoffs = useHandoffs(() => {});
  const agent = agents.find((a) => a.id === current);
  // "Open in OpenAdmiral" on an artifact of this agent: the backend raised this window.
  const [artifactFocus, setArtifactFocus] = useState<{ key: string; at: number; version?: number } | undefined>();
  const lastFocus = useRef(0);
  useEffect(() => {
    // This window's own: a plain listen also hears what is sent to the others.
    const off = getCurrentWebviewWindow().listen<unknown>("openadmiral://focus", (e) => {
      const f = parseFocus(e.payload, Date.now(), lastFocus.current);
      if (!f) return;
      lastFocus.current = f.at;
      setArtifactFocus({ key: `${f.sessionId}/${f.artifactId}`, at: f.at, version: f.version });
    });
    return () => void off.then((u) => u());
  }, []);
  const textScale = ui.textScale ?? 1;

  useEffect(() => void devEnv.then((d) => setPreview(d.preview)), []);
  useEffect(() => setTerminalScale(textScale), [textScale]);
  useEffect(() => {
    invoke("frontend_log", { level: "float", message: `floating window showing ${id}` }).catch(() => {});
  }, [id]);
  // After /clear the agent carries a new session id: follow it, and tell the main window.
  useEffect(() => {
    const next = superseded.get(current);
    if (!next) return;
    setCurrent(next);
    invoke("float_track", { sessionId: next }).catch(() => {});
  }, [superseded, current]);
  // Removed: nothing left to show here.
  const gone = loaded && cliReady && !agent;
  useEffect(() => {
    if (!gone || preview) return;
    const t = setTimeout(() => invoke("float_close").catch(() => {}), GONE_AFTER_MS);
    return () => clearTimeout(t);
  }, [gone, preview]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = matchShortcut(e);
      // ⌘W closes this window: the agent goes on, and the main window shows it again.
      const run = key === "close-agent" ? () => invoke("float_close") : key === "toggle-inspector" ? () => setInspectorHidden((h) => !h) : key === "text-bigger" ? () => ui.stepText(1) : key === "text-smaller" ? () => ui.stepText(-1) : undefined;
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ui]);

  return (
    <TooltipProvider>
      <div className="h-full bg-panel">
        {agent ? (
          <AgentDetail
            agent={agent}
            now={now}
            handoff={handoffs.find((h) => h.sessionId === agent.id)}
            request={requests[agent.id]}
            inspectorHidden={inspectorHidden}
            onToggleInspector={() => setInspectorHidden((h) => !h)}
            layout={ui}
            actions={life.actions}
            closing={life.closing.has(agent.id)}
            preview={preview}
            agents={agents}
            queue={queues[agent.id]}
            onError={(m) => life.notify(m, "error")}
            onNotice={(m) => life.notify(m)}
            onConfirm={life.setConfirm}
            artifacts={artifacts.filter((x) => x.sessionId === agent.id)}
            artifactFocus={artifactFocus}
            seen={seen}
            onClaudeLink={(href) => invoke("browser_open", { url: href }).catch((e) => life.notify(String(e), "error"))}
            pluginInstalled={pluginInstalled}
            pane={{ active: true }}
            dense={!!ui.densePanes}
            textScale={textScale}
            inset
            restarting={life.restarting.includes(agent.id)}
            floatAction={{ kind: "dock", run: () => void invoke("float_dock") }}
          />
        ) : (
          <div data-tauri-drag-region className="flex h-full items-center justify-center text-sm text-ink-3">
            {gone ? "This agent is gone." : "Loading…"}
          </div>
        )}
      </div>
      <ConfirmDialog confirm={life.confirm} onClose={() => life.setConfirm(null)} />
      <Notices notices={life.notices} />
    </TooltipProvider>
  );
}
