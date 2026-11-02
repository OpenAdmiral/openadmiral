import { ShieldWarningLinearIcon } from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect } from "react";
import type { TrustAsk } from "@/lib/trust";
import { disposeTerminal, AgentTerminal } from "./Terminal";

export const isUntrusted = (error: string | null) => !!error && /workspace not trusted/i.test(error);

/**
 * `claude --bg` refuses a folder whose trust prompt was never accepted. This runs
 * plain `claude` there, inside the app, so the person can accept it and retry.
 */
export function TrustPanel({ cwd, onRetry, onCancel }: { cwd: string; onRetry: () => void; onCancel: () => void }) {
  const key = `trust:${cwd}`;
  useEffect(() => () => disposeTerminal(key), [key]);

  return (
    <div>
      <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
        <ShieldWarningLinearIcon size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-100">
          Claude Code has not been trusted in <span className="font-mono">{cwd}</span> yet. In the prompt below choose “Yes, I trust this folder” (press{" "}
          <span className="font-semibold">↓</span>, then <span className="font-semibold">Enter</span>: “No” comes selected), then retry.
        </p>
      </div>
      <div className="mb-4 h-64 overflow-hidden rounded-xl border border-line bg-term">
        <AgentTerminal agentKey={key} argv={["claude"]} cwd={cwd} className="h-full" />
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="rounded-lg px-3.5 py-2 text-sm text-ink-2 transition-all duration-200 hover:bg-line">
          Cancel
        </button>
        <button
          onClick={() => {
            // The trust is saved the moment it is accepted; this session is not needed.
            disposeTerminal(key);
            onRetry();
          }}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
        >
          I accepted it — retry
        </button>
      </div>
    </div>
  );
}

/** A restart refused for the same reason. The session keeps running on its old version meanwhile. */
export function RestartTrustDialog({ ask, onRetry, onCancel }: { ask: TrustAsk | null; onRetry: () => void; onCancel: () => void }) {
  return (
    <AnimatePresence>
      {ask && (
        <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[12vh] backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="w-[640px] max-w-[calc(100vw-32px)] rounded-2xl border border-line-strong bg-canvas p-5 shadow-xl">
            <h2 className="text-base font-semibold text-ink">{ask.retry ? `${ask.name} can't open here yet` : `${ask.name} can't restart yet`}</h2>
            <p className="mt-1 mb-3 text-sm leading-relaxed text-ink-2">{ask.retry ? "Nothing was lost: its conversation is saved and goes on once the folder is trusted." : "It is still running, nothing was lost. It stays on its current version until the folder is trusted."}</p>
            <TrustPanel key={ask.folder} cwd={ask.folder} onRetry={onRetry} onCancel={onCancel} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ErrorBox({ error }: { error: string }) {
  return <p className="selectable mb-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-red-500/10 px-3 py-2 font-mono text-xs text-red-600 dark:text-red-400">{error}</p>;
}
