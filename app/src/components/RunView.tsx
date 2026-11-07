import { ArchiveLinearIcon, PlayLinearIcon, RefreshLinearIcon, SquareShareLineLinearIcon, StopLinearIcon } from "@solar-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { previews, runKey, shellArgv, workspaceInfo, type WorkspaceInfo } from "@/lib/workspace";
import { AgentTerminal } from "./Terminal";

type Props = {
  agent: Agent;
  active: boolean;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
  onConfirm: (c: { title: string; body: string; action: string; run: () => Promise<void> }) => void;
  /** After archiving: the agent leaves the list. */
  onArchived: () => void;
};

/** Run actions started in this window, per agent, so switching tabs keeps them. */
const started = new Map<string, Set<string>>();

/**
 * The Run tab: the repo's run scripts (Conductor's `.conductor/settings.toml` or
 * `conductor.json`, else OpenAdmiral's own), each in a terminal of its own with the
 * workspace's variables and ports; the preview to open; setup again; and archiving.
 */
export function RunView({ agent, active, onError, onNotice, onConfirm, onArchived }: Props) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(() => started.get(agent.id) ?? new Set());
  const [shown, setShown] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => workspaceInfo(agent.cwd).then(setInfo, (e) => setError(String(e))), [agent.cwd]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  const set = (next: Set<string>) => {
    started.set(agent.id, next);
    setRunning(next);
  };
  useEffect(() => {
    if (!shown && info?.scripts.run.length) setShown((info.scripts.run.find((a) => a.default) ?? info.scripts.run[0]).id);
  }, [info, shown]);

  if (error) return <p className="p-6 text-center text-sm text-ink-3">{error}</p>;
  if (!info) return <p className="p-6 text-center text-sm text-ink-3">Reading the worktree…</p>;
  const { scripts } = info;
  const conductor = scripts.source !== "OpenAdmiral";

  const start = (id: string) => {
    // One at a time when the repo asks for it (Conductor's nonconcurrent mode).
    const next = new Set(scripts.runMode === "nonconcurrent" ? [] : running);
    if (scripts.runMode === "nonconcurrent") for (const r of running) void invoke("pty_kill", { key: runKey(agent.id, r) });
    next.add(id);
    set(next);
    setShown(id);
  };
  const stop = (id: string) => {
    void invoke("pty_kill", { key: runKey(agent.id, id) });
    const next = new Set(running);
    next.delete(id);
    set(next);
  };

  const archive = () =>
    onConfirm({
      title: `Archive ${agent.name}'s worktree?`,
      body: `Runs the archive script if there is one, keeps any uncommitted changes in a git ref, and removes the worktree at ${info.path}. Its branch stays. The agent leaves the list.`,
      action: "Archive",
      run: async () => {
        for (const r of running) await invoke("pty_kill", { key: runKey(agent.id, r) }).catch(() => {});
        try {
          onNotice(await invoke<string>("workspace_archive", { cwd: agent.cwd }));
          onArchived();
        } catch (e) {
          onError(String(e));
        }
      },
    });

  const action = scripts.run.find((a) => a.id === shown);
  const live = (agent.codex ? agent.codex.running : !!agent.cli) && agent.status !== "ended";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px]">
        {scripts.run.map((a) => {
          const on = running.has(a.id);
          return (
            <span key={a.id} className={cn("flex items-center overflow-hidden rounded-lg border", shown === a.id ? "border-brand-500/60" : "border-line-strong")}>
              <button onClick={() => setShown(a.id)} className="px-2.5 py-1 font-semibold text-ink" title={a.command}>
                {a.id}
              </button>
              <button
                onClick={() => (on ? stop(a.id) : start(a.id))}
                aria-label={on ? `Stop ${a.id}` : `Run ${a.id}`}
                className={cn("border-l px-2 py-1", on ? "border-line text-red-600 hover:bg-red-500/10" : "border-line text-green-600 hover:bg-green-500/10")}
              >
                {on ? <StopLinearIcon size={14} /> : <PlayLinearIcon size={14} />}
              </button>
            </span>
          );
        })}
        {scripts.run.length === 0 && <span className="text-ink-3">No run script for this repo yet.</span>}
        <span className="flex-1" />
        {previews(info).map(([name, url]) => (
          <button key={url} onClick={() => void openUrl(url).catch((e) => onError(String(e)))} title={url} className="flex items-center gap-1 rounded-md px-2 py-1 text-ink-2 hover:bg-line hover:text-ink">
            <SquareShareLineLinearIcon size={14} /> {name}
          </button>
        ))}
        {scripts.setup && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              invoke("workspace_setup", { cwd: agent.cwd }).then(
                () => onNotice("Setup finished."),
                (e) => onError(String(e)),
              ).finally(() => setBusy(false));
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-ink-2 hover:bg-line hover:text-ink disabled:opacity-50"
          >
            <RefreshLinearIcon size={14} className={cn(busy && "animate-spin")} /> Run setup
          </button>
        )}
        {!conductor && (
          <button onClick={() => setEditing((x) => !x)} className="rounded-md px-2 py-1 text-ink-2 hover:bg-line hover:text-ink">
            Scripts…
          </button>
        )}
        {info.worktree && (
          <button
            onClick={archive}
            disabled={live}
            title={live ? "Close the agent first" : "Archive this worktree"}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-ink-2 hover:bg-line hover:text-ink disabled:opacity-40"
          >
            <ArchiveLinearIcon size={14} /> Archive
          </button>
        )}
      </div>
      <p className="shrink-0 border-b border-line px-4 py-1.5 text-[11px] text-ink-3">
        {conductor ? `Scripts from ${scripts.source}.` : "Scripts kept by OpenAdmiral for this repo."} Ports {info.port}–{info.port + 9} ($CONDUCTOR_PORT).
      </p>
      {editing && !conductor && <ScriptsEditor cwd={agent.cwd} scripts={scripts} onSaved={() => (setEditing(false), void load())} onError={onError} />}
      <div className="relative min-h-0 flex-1 bg-term">
        {scripts.run.map((a) =>
          running.has(a.id) ? (
            <div key={a.id} className={cn("absolute inset-0", a.id !== shown && "invisible")}>
              <AgentTerminal agentKey={runKey(agent.id, a.id)} argv={shellArgv(a.command)} cwd={info.path} env={info.env} className="h-full" />
            </div>
          ) : null,
        )}
        {(!action || !running.has(action.id)) && (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-3">
            {action ? (
              <span>
                <code className="font-mono text-ink-2">{action.command}</code>
                <br />
                Press ▶ to run it here.
              </span>
            ) : (
              "Add a run script to start this worktree's app with a click."
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ScriptsEditor({ cwd, scripts, onSaved, onError }: { cwd: string; scripts: WorkspaceInfo["scripts"]; onSaved: () => void; onError: (m: string) => void }) {
  const [setup, setSetup] = useState(scripts.setup ?? "");
  const [run, setRun] = useState(scripts.run[0]?.command ?? "");
  const [archive, setArchive] = useState(scripts.archive ?? "");
  const field = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <label className="block">
      <span className="text-[11px] font-semibold text-ink-2">{label}</span>
      <input value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} className="mt-0.5 w-full rounded-md border border-line-strong bg-canvas px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-3" />
    </label>
  );
  return (
    <div className="shrink-0 space-y-2 border-b border-line bg-panel px-4 py-3">
      {field("Setup (when a worktree is made)", setup, setSetup, "pnpm install && cp $CONDUCTOR_ROOT_PATH/.env .")}
      {field("Run", run, setRun, "pnpm dev --port $CONDUCTOR_PORT")}
      {field("Archive (before a worktree is archived)", archive, setArchive, "docker compose down")}
      <div className="flex justify-end">
        <button
          onClick={() => invoke("workspace_scripts_save", { cwd, setup, run, archive }).then(onSaved, (e) => onError(String(e)))}
          className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white hover:bg-brand-700"
        >
          Save
        </button>
      </div>
    </div>
  );
}
