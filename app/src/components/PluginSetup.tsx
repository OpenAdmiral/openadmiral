import { CopyLinearIcon } from "@solar-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
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

/** Whether OpenAdmiral can run Claude Code here (the CLI, or the copy an editor extension bundles). */
export function useClaudeAvailable() {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    void invoke<boolean>("claude_available").then(setOk, () => setOk(null));
  }, []);
  return ok;
}

/** Installs the plugin from the app, with whichever `claude` there is. */
function InstallButton() {
  const [state, setState] = useState<"idle" | "busy" | "done" | string>("idle");
  const busy = state === "busy";
  return (
    <div className="space-y-1.5">
      <button
        disabled={busy || state === "done"}
        onClick={() => {
          setState("busy");
          invoke("install_plugin").then(
            () => setState("done"),
            (e) => setState(String(e)),
          );
        }}
        className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-60"
      >
        {busy ? "Installing…" : state === "done" ? "Installed" : "Install the plugin"}
      </button>
      {state !== "idle" && state !== "busy" && state !== "done" && <p className="text-[11px] leading-relaxed text-red-600 dark:text-red-400">{state}</p>}
    </div>
  );
}

/**
 * How to connect Claude Code sessions to OpenAdmiral: install the plugin (from here,
 * or with its two commands; the VS Code extension has no /plugin, so its install
 * link), then /reload-plugins in sessions that were already open.
 */
export function PluginSetup({ installed, className }: { installed: boolean; className?: string }) {
  const claude = useClaudeAvailable();
  return (
    <div className={cn("space-y-2 text-left", className)}>
      {!installed && (
        <>
          {claude && <InstallButton />}
          <p className="text-xs leading-relaxed text-ink-2">{claude ? "Or run these" : "Run these"} in any Claude Code session in a terminal:</p>
          {PLUGIN_COMMANDS.map((c) => (
            <Command key={c} text={c} />
          ))}
          <p className="text-xs leading-relaxed text-ink-2">
            In the VS Code extension, /plugin isn't available: type /plugins and add OpenAdmiral/openadmiral in Marketplaces, or{" "}
            <button onClick={() => void invoke("open_vscode_plugin_install").catch(() => {})} className="font-semibold text-brand-600 hover:underline dark:text-brand-400">
              open it in VS Code
            </button>
            .
          </p>
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
