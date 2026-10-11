import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { Agent } from "@/lib/types";

/** When the OpenAdmiral plugin's files last changed (src-tauri/src/plugin_files.rs), checked every 30 s. */
export function usePluginChangedAt() {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    const check = () => invoke<number | null>("plugin_changed_at").then(setAt, () => {});
    check();
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, []);
  return at;
}

/**
 * A running session whose plugin is older than the plugin's files: it loaded before
 * the last update (or edit) and needs /reload-plugins. A mod too old to say when it
 * loaded counts as behind.
 */
export function pluginBehind(a: Agent, changedAt: number | null) {
  if (!changedAt || !a.cli || !a.session || a.session.status === "ended") return false;
  const loaded = a.session.plugin?.loadedAt;
  return loaded === undefined || loaded < changedAt - 2_000;
}

/** Queues /reload-plugins as Run now in each session; each runs it once idle. */
export const reloadPlugin = (sessionIds: string[]) => invoke<number>("plugin_reload", { sessionIds });
