import { CloseCircleLinearIcon, MonitorLinearIcon } from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cancelHandoff, startHandoff, type Handoff } from "@/lib/handoffs";
import type { Agent } from "@/lib/types";
import { ErrorBox, isUntrusted, TrustPanel } from "./TrustPanel";

/** After this long still running, the session is probably mid-turn. */
const SLOW_MS = 30_000;

/**
 * Shows a hand-off the backend runs: the OpenAdmiral plugin exits the session when it is
 * idle, then the app resumes it in the background under the same id and name.
 * A session that is not running is just resumed (one step). Closing the sheet
 * does not stop it; the backend gives up after ~30 s without the session showing up.
 */
export function HandoffSheet({ agent, handoff, waiting, startError, open, onClose }: { agent: Agent; handoff?: Handoff; waiting?: string; startError?: string | null; open: boolean; onClose: () => void }) {
  const [trust, setTrust] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retried, setRetried] = useState(false);
  const [now, setNow] = useState(Date.now());
  const listed = agent.cli?.kind === "interactive";
  const name = handoff?.name ?? agent.cli?.name ?? agent.session?.name ?? agent.name;

  useEffect(() => {
    if (!open) return;
    setTrust(false);
    setRetryError(null);
    setRetried(false);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  const state = handoff?.state;
  const error = retryError ?? (retried ? null : startError) ?? (state === "error" ? (handoff?.error ?? "Could not resume it.") : null);
  // Resuming a session that is not running: no exit to wait for.
  const ended = handoff ? handoff.from === "ended" : !listed;
  // While the mod reports what it waits for, that says it all: no "has not answered" hint.
  const slow = !waiting && state === "requested" && listed && now - (handoff?.requestedAt ?? now) > SLOW_MS;

  // Start over through the backend: it resumes at once a session that is no longer running.
  const retry = async () => {
    setRetryError(null);
    setRetried(true);
    try {
      await startHandoff(agent.id, name, agent.cwd);
    } catch (e) {
      setRetryError(String(e));
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
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
            className="w-[540px] rounded-2xl border border-line-strong bg-canvas p-5 shadow-xl"
            onKeyDown={(e) => !trust && e.key === "Escape" && onClose()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-white">
                  <MonitorLinearIcon size={16} />
                </span>
                <div>
                  <h2 className="text-base font-semibold text-ink">{ended ? `Resuming ${name} in OpenAdmiral` : `Bringing ${name} into OpenAdmiral`}</h2>
                  <p className="text-xs text-ink-3">{ended ? "Same conversation: it picks up where it left off." : "Same conversation, same id: it moves from your terminal into OpenAdmiral."}</p>
                </div>
              </div>
              <button onClick={onClose} title="Hide (it keeps going)" className="text-ink-3 transition-colors hover:text-ink">
                <CloseCircleLinearIcon size={20} />
              </button>
            </div>

            {trust ? (
              <TrustPanel cwd={agent.cwd} onCancel={() => setTrust(false)} onRetry={() => { setTrust(false); retry(); }} />
            ) : (
              <>
                <ol className="mb-4 space-y-3">
                  {!ended && (
                  <>
                  <Step done={state !== "requested" || !listed} active={state === "requested" && listed}>
                    Asking <span className="font-semibold text-ink">{name}</span> to hand over. It exits by itself as soon as it is idle.
                    {waiting && listed && (
                      <span className="mt-1 block rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-200">
                        Waiting: {waiting} — it hands over when they finish.
                      </span>
                    )}
                  </Step>
                  <Step done={!listed && state !== "requested"} active={state === "served" && listed}>
                    The session closes in its terminal window.
                  </Step>
                  </>
                  )}
                  <Step done={false} active={state === "resuming" && !error}>
                    OpenAdmiral resumes it here and opens its terminal. It keeps running when you close OpenAdmiral.
                  </Step>
                </ol>

                {slow && (
                  <p className="mb-4 rounded-xl border border-line bg-panel px-4 py-3 text-xs leading-relaxed text-ink-2">
                    {agent.status === "working" ? "It is in the middle of a turn: it hands over when that turn ends." : "It has not answered yet."} If it does not, type{" "}
                    <code className="rounded bg-line px-1.5 py-0.5 font-mono text-ink">/exit</code> in its terminal window and OpenAdmiral takes it from there.
                  </p>
                )}
                {state === "expired" && (
                  <p className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-200">
                    Nothing happened in 10 minutes, so the request was dropped.
                  </p>
                )}
                {error && <ErrorBox error={error} />}

                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => cancelHandoff(agent.id).then(onClose)}
                    className="mr-auto rounded-lg px-3 py-2 text-sm text-ink-3 transition-all duration-200 hover:bg-line hover:text-ink"
                  >
                    {ended ? "Cancel" : "Cancel hand-off"}
                  </button>
                  {error && isUntrusted(error) ? (
                    <button onClick={() => setTrust(true)} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-brand-700">
                      Trust this folder…
                    </button>
                  ) : error ? (
                    <button onClick={retry} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-brand-700">
                      Retry
                    </button>
                  ) : state === "expired" ? (
                    <button
                      onClick={() => startHandoff(agent.id, name, agent.cwd)}
                      className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-brand-700"
                    >
                      Ask again
                    </button>
                  ) : (
                    <button onClick={onClose} className="rounded-lg border border-line-strong px-4 py-2 text-sm font-semibold text-ink-2 transition-all duration-200 hover:bg-line">
                      Hide
                    </button>
                  )}
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function Step({ done, active, children }: { done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="relative mt-0.5 flex size-5 shrink-0 items-center justify-center">
        {done ? (
          <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500 text-[11px] font-semibold text-white">✓</span>
        ) : active ? (
          <>
            <span className="absolute inset-0 animate-ring rounded-full bg-brand-500" />
            <span className="size-2.5 rounded-full bg-brand-500" />
          </>
        ) : (
          <span className="size-2.5 rounded-full border-[1.5px] border-line-strong" />
        )}
      </span>
      <p className="text-sm leading-relaxed text-ink-2">{children}</p>
    </li>
  );
}
