import { SquareShareLineLinearIcon } from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { hostOf, openNow, trustHost } from "@/lib/linkGate";

/**
 * Asks before opening a link from a site not trusted yet (lib/linkGate.ts): Open,
 * Open and Trust <site>, or Don't Open. One per window.
 */
export function LinkGate() {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setUrl(String((e as CustomEvent).detail));
    window.addEventListener("openadmiral:open-link", on);
    return () => window.removeEventListener("openadmiral:open-link", on);
  }, []);
  useEffect(() => {
    if (!url) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setUrl(null);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [url]);
  const host = url ? hostOf(url) : "";
  const close = () => setUrl(null);
  return (
    <AnimatePresence>
      {url && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[60] flex items-start justify-center bg-black/25 pt-[18vh] backdrop-blur-[2px]"
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 480, damping: 34 }}
            role="dialog"
            aria-label="Open this link?"
            className="w-[460px] max-w-[calc(100vw-32px)] rounded-2xl border border-line-strong bg-canvas p-5 shadow-xl"
          >
            <div className="flex gap-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400">
                <SquareShareLineLinearIcon size={20} />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-ink">Open a link to {host}?</h2>
                <p className="mt-1 line-clamp-3 font-mono text-[11.5px] break-all text-ink-3" title={url}>
                  {url}
                </p>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button onClick={close} className="rounded-lg px-3.5 py-2 text-sm text-ink-2 transition-colors hover:bg-line">
                Don't Open
              </button>
              <button
                onClick={() => {
                  trustHost(host);
                  openNow(url);
                  close();
                }}
                className="rounded-lg border border-line-strong px-3.5 py-2 text-sm font-semibold text-ink transition-colors hover:bg-line"
                title={`Links to ${host} and its subdomains open without asking from now on`}
              >
                Open and Trust {host}
              </button>
              <button
                autoFocus
                onClick={() => {
                  openNow(url);
                  close();
                }}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
              >
                Open
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
