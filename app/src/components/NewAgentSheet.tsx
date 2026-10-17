import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { CloseCircleLinearIcon, FolderOpenLinearIcon, Rocket2LinearIcon } from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { Agent } from "@/lib/types";
import { basename, cn } from "@/lib/utils";
import { ErrorBox, isUntrusted, TrustPanel } from "./TrustPanel";

type Props = { open: boolean; /** The folder to start on (a project's +). */ initialCwd?: string; onClose: () => void; agents: Agent[]; onCreated: (shortId: string) => void };

const input =
  "w-full rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-3 transition-all duration-200 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30";

export function NewAgentSheet({ open: isOpen, initialCwd, onClose, agents, onCreated }: Props) {
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState(false);

  // Folders already in the fleet are one click away.
  const recent = [...new Map(agents.map((a) => [a.cwd, a])).values()].slice(0, 6);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setBusy(false);
      setTrust(false);
      // Opened from a project's +: its folder and name, ready to go.
      if (initialCwd) {
        setCwd(initialCwd);
        setName(basename(initialCwd));
      }
    }
  }, [isOpen, initialCwd]);

  const pick = async () => {
    const dir = await open({ directory: true, defaultPath: cwd || undefined });
    if (typeof dir === "string") choose(dir);
  };

  const choose = (dir: string) => {
    setCwd(dir);
    if (!name) setName(basename(dir));
  };

  const submit = async () => {
    if (!cwd) return;
    setBusy(true);
    setError(null);
    try {
      const shortId = await invoke<string>("new_agent", { cwd, name, prompt: prompt || null });
      onCreated(shortId);
      onClose();
      setPrompt("");
      setName("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[12vh] backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className="w-[520px] rounded-2xl border border-line-strong bg-canvas p-5 shadow-xl"
            onKeyDown={(e) => {
              // Keys typed into the trust prompt's terminal belong to it.
              if (trust) return;
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-white">
                  <Rocket2LinearIcon size={16} />
                </span>
                <div>
                  <h2 className="text-base font-semibold text-ink">New agent</h2>
                  <p className="text-xs text-ink-3">A Claude Code session that lives in OpenAdmiral and keeps running when you close it.</p>
                </div>
              </div>
              <button onClick={onClose} className="text-ink-3 transition-colors hover:text-ink">
                <CloseCircleLinearIcon size={20} />
              </button>
            </div>

            {trust ? (
              <TrustPanel
                cwd={cwd}
                onCancel={() => setTrust(false)}
                onRetry={() => {
                  setTrust(false);
                  submit();
                }}
              />
            ) : (
              <>
            <label className="mb-1.5 block text-xs font-semibold text-ink-2">Folder</label>
            <div className="mb-2 flex gap-2">
              <input className={cn(input, "font-mono text-xs")} value={cwd} placeholder="/Users/you/dev/project" onChange={(e) => setCwd(e.target.value)} />
              <button
                onClick={pick}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-sm text-ink-2 transition-all duration-200 hover:bg-line focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <FolderOpenLinearIcon size={16} />
                Choose…
              </button>
            </div>
            {recent.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1.5">
                {recent.map((a) => (
                  <button
                    key={a.cwd}
                    onClick={() => choose(a.cwd)}
                    className={cn(
                      "rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-2 transition-all duration-200 hover:border-brand-300 hover:text-brand-700 dark:hover:text-brand-300",
                      cwd === a.cwd && "border-brand-500 bg-brand-500/10 text-brand-700 dark:text-brand-300",
                    )}
                  >
                    {a.project}
                  </button>
                ))}
              </div>
            )}

            <label className="mb-1.5 block text-xs font-semibold text-ink-2">Name</label>
            <input className={cn(input, "mb-4")} value={name} placeholder="mcp-auth-scopes" onChange={(e) => setName(e.target.value)} />

            <label className="mb-1.5 block text-xs font-semibold text-ink-2">
              First instruction <span className="font-normal text-ink-3">(optional)</span>
            </label>
            <textarea
              className={cn(input, "mb-4 h-24 resize-none leading-relaxed")}
              value={prompt}
              placeholder="Add the devices:read scope and expose it in the token introspection…"
              onChange={(e) => setPrompt(e.target.value)}
            />

            {error && <ErrorBox error={error} />}

            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-[11px] text-ink-3">⌘↵ to start</span>
              <button onClick={onClose} className="rounded-lg px-3.5 py-2 text-sm text-ink-2 transition-all duration-200 hover:bg-line">
                Cancel
              </button>
              {isUntrusted(error) && (
                <button
                  onClick={() => setTrust(true)}
                  className="rounded-lg border border-line-strong px-3.5 py-2 text-sm font-semibold text-ink transition-all duration-200 hover:bg-line"
                >
                  Trust this folder…
                </button>
              )}
              <button
                disabled={!cwd || busy}
                onClick={submit}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:opacity-50"
              >
                {busy ? "Starting…" : "Start agent"}
              </button>
            </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
