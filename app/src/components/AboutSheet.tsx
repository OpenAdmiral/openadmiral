import { CloseCircleLinearIcon } from "@solar-icons/react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimatePresence, motion } from "framer-motion";
import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";

const SITE = "https://openadmiral.com";

/** The open source OpenAdmiral is built on, thanked in About. */
const THANKS: [string, string][] = [
  ["Tauri", "https://tauri.app"],
  ["React", "https://react.dev"],
  ["Tailwind CSS", "https://tailwindcss.com"],
  ["xterm.js", "https://xtermjs.org"],
  ["Motion", "https://motion.dev"],
  ["dnd kit", "https://dndkit.com"],
  ["TanStack Virtual", "https://tanstack.com/virtual"],
  ["Mermaid", "https://mermaid.js.org"],
  ["react-markdown", "https://github.com/remarkjs/react-markdown"],
  ["highlight.js", "https://highlightjs.org"],
  ["Solar Icons", "https://www.npmjs.com/package/@solar-icons/react"],
  ["Outfit", "https://fonts.google.com/specimen/Outfit"],
  ["JetBrains Mono", "https://www.jetbrains.com/lp/mono/"],
  ["portable-pty", "https://github.com/wezterm/wezterm/tree/main/pty"],
  ["notify", "https://github.com/notify-rs/notify"],
  ["ccusage", "https://github.com/ryoppippi/ccusage"],
  ["Vite", "https://vite.dev"],
];

/** OpenAdmiral → About OpenAdmiral: what it is, where to learn more, and thanks. */
export function AboutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);
  useEffect(() => {
    if (!open) return;
    // Capture, so Esc closes the sheet before the terminal sees it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  const link = (url: string) => () => void openUrl(url);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh] backdrop-blur-[2px]"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            role="dialog"
            aria-label="About OpenAdmiral"
            className="relative w-[440px] rounded-2xl border border-line-strong bg-canvas px-7 pt-8 pb-6 text-center shadow-xl"
          >
            <button onClick={onClose} aria-label="Close" className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink">
              <CloseCircleLinearIcon size={20} />
            </button>
            <img src="/icon.png" alt="" className="mx-auto size-20 drop-shadow-md" />
            <h2 className="mt-4 text-xl font-semibold text-ink">OpenAdmiral</h2>
            {version && <p className="mt-0.5 text-xs text-ink-3 tabular">Version {version}</p>}
            <p className="mx-auto mt-4 max-w-[340px] text-sm leading-relaxed text-ink-2">
              Mission control for your Claude Code sessions: every agent in one window, a nudge when one needs you, and agents that hand work to each
              other.
            </p>
            <div className="mt-5 flex items-center justify-center gap-2">
              <button onClick={link(SITE)} className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700">
                openadmiral.com
              </button>
              <button
                onClick={() => void invoke("update_check").catch(() => {})}
                className="rounded-lg border border-line-strong px-3.5 py-1.5 text-sm font-semibold text-ink-2 transition-colors hover:bg-line hover:text-ink"
              >
                Check for Updates
              </button>
            </div>
            <div className="mt-6 border-t border-line pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Thank you, open source</p>
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
                {THANKS.map(([name, url], i) => (
                  <Fragment key={name}>
                    {i > 0 && " · "}
                    <button onClick={link(url)} className="transition-colors hover:text-ink hover:underline">
                      {name}
                    </button>
                  </Fragment>
                ))}
              </p>
            </div>
            <p className="mt-5 text-[11px] leading-relaxed text-ink-3">
              © César Trigo · MIT License · Free and open source
              <br />
              Not affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
