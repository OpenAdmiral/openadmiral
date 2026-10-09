import { ShieldWarningLinearIcon } from "@solar-icons/react";
import { useEffect } from "react";
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
          Claude Code has not been trusted in <span className="font-mono">{cwd}</span> yet. Accept the trust prompt below (press{" "}
          <span className="font-semibold">Enter</span> on “Yes, I trust this folder”), then retry.
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

export function ErrorBox({ error }: { error: string }) {
  return <p className="selectable mb-3 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-red-500/10 px-3 py-2 font-mono text-xs text-red-600 dark:text-red-400">{error}</p>;
}
