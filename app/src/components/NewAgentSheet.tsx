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
  // Its own git worktree, so agents in one repo don't step on each other (a Conductor-style workspace).
  const [repo, setRepo] = useState<string | null>(null);
  const [worktree, setWorktree] = useState(false);
  useEffect(() => {
    setRepo(null);
    if (!cwd) return;
    const t = setTimeout(() => void invoke<string | null>("git_root", { cwd }).then(setRepo, () => setRepo(null)), 250);
    return () => clearTimeout(t);
  }, [cwd]);
  // Another agent already works in this repo: a worktree is the safer default.
  const crowded = !!repo && agents.some((a) => a.live && a.status !== "ended" && (a.session?.repo?.root ?? a.cwd) === repo);
  useEffect(() => setWorktree(crowded), [crowded]);
  const slug = worktreeSlug(name || basename(cwd));
  // Start from a branch, a pull request or an issue: a checkout of its own (src-tauri workspace.rs).
  const [fromKind, setFromKind] = useState<"none" | "branch" | "pr" | "issue">("none");
  const [fromValue, setFromValue] = useState("");
  const from = repo && fromKind !== "none" && fromValue.trim() ? { kind: fromKind, value: fromValue.trim() } : null;

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

  // Esc closes it, before the terminal underneath sees the key.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, busy, onClose]);

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
      const shortId = await invoke<string>("new_agent", { cwd, name, prompt: prompt || null, worktree: repo && worktree && slug && !from ? slug : null, from });
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

            {repo && (
              <div className="mb-3">
                <label className="mb-1.5 block text-xs font-semibold text-ink-2">Start from</label>
                <div className="flex gap-1 rounded-lg bg-line/60 p-0.5 text-xs">
                  {(
                    [
                      ["none", "Current checkout"],
                      ["branch", "Branch"],
                      ["pr", "Pull request"],
                      ["issue", "Issue"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setFromKind(k)}
                      className={cn("flex-1 rounded-md px-2 py-1 transition-colors", fromKind === k ? "bg-canvas font-semibold text-ink shadow-sm" : "text-ink-3 hover:text-ink")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {fromKind !== "none" && (
                  <>
                    <input
                      autoFocus
                      className={cn(input, "mt-2 font-mono text-xs")}
                      value={fromValue}
                      onChange={(e) => setFromValue(e.target.value)}
                      placeholder={fromKind === "branch" ? "feature/checkout-v2" : fromKind === "pr" ? "123 or a pull request link" : "42 or an issue link"}
                    />
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                      {fromKind === "branch"
                        ? "A checkout of its own on that branch (fetched from origin if it is not here yet)."
                        : fromKind === "pr"
                          ? "A checkout of its own on the pull request's branch, with gh. It reads the PR before it starts."
                          : "A checkout of its own on a new branch, with the issue as its first instruction (gh)."}
                    </p>
                  </>
                )}
              </div>
            )}
            {repo && fromKind === "none" && (
              <label className="mb-4 flex cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-2.5">
                <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} className="mt-0.5 accent-brand-600" />
                <span className="min-w-0 text-sm">
                  <span className="font-semibold text-ink">In its own worktree</span>
                  <span className="block text-xs leading-relaxed text-ink-3">
                    {worktree && slug ? (
                      <>
                        A separate checkout on branch <code className="font-mono text-[11px] text-ink-2">worktree-{slug}</code>, so it can't step on other agents in this repo.
                      </>
                    ) : crowded ? (
                      "Another agent already works in this repo: a separate checkout keeps their changes apart."
                    ) : (
                      "A separate checkout on its own branch, so it can't step on other agents in this repo."
                    )}
                  </span>
                </span>
              </label>
            )}

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

/** The worktree name Claude Code will use (src-tauri new_agent does the same). */
export function worktreeSlug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}
