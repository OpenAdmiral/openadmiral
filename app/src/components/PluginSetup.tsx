import { CopyLinearIcon } from "@solar-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { cn } from "@/lib/utils";

export const PLUGIN_COMMANDS = ["/plugin marketplace add OpenAdmiral/openadmiral", "/plugin install openadmiral@openadmiral"];

/** A command to paste into Claude Code, with a copy button. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-1.5 text-left">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{text}</code>
      <button
        onClick={() =>
          void invoke("copy_text", { text }).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
        aria-label={`Copy ${text}`}
        className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-ink-3 transition-colors hover:text-ink"
      >
        <CopyLinearIcon size={13} />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * How to connect Claude Code sessions to OpenAdmiral: the plugin's two commands,
 * and, for sessions already open, /reload-plugins (or reloading the editor window).
 */
export function PluginSetup({ installed, className }: { installed: boolean; className?: string }) {
  return (
    <div className={cn("space-y-2 text-left", className)}>
      {!installed && (
        <>
          <p className="text-xs leading-relaxed text-ink-2">Run these in any Claude Code session (terminal, VS Code or Cursor):</p>
          {PLUGIN_COMMANDS.map((c) => (
            <Command key={c} text={c} />
          ))}
        </>
      )}
      <p className="text-xs leading-relaxed text-ink-2">
        {installed ? "The plugin is installed. Sessions that were already open load it with" : "Then, in sessions that were already open, run"}
      </p>
      <Command text="/reload-plugins" />
      <p className="text-[11px] leading-relaxed text-ink-3">In VS Code or Cursor, reloading the window works too.</p>
    </div>
  );
}
