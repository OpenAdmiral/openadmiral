import { hostLabel } from "../../../plugin/hooks/host";
import type { Agent } from "./types";

/**
 * Where a session runs, as the header and sidebar say it: "VS Code", "VS Code
 * terminal", "iTerm"… From the plugin (`host`, ../../../plugin/hooks/host.ts, one
 * source for both sides), or from the process for a session without the plugin.
 */
export function whereLabel(a: Agent): string | undefined {
  if (a.unplugged) return a.unplugged.via;
  if (a.session?.host) return hostLabel(a.session.host);
  if (a.cli?.kind === "interactive") return "Terminal";
  return undefined;
}

/** Running, but somewhere OpenAdmiral cannot attach to (an editor, a terminal window). */
export const runsElsewhere = (a: Agent) => a.live && !a.attachable && !a.unplugged && a.status !== "ended";

/**
 * Running in an editor's Claude Code panel (not its terminal). It cannot be brought into
 * OpenAdmiral: the panel would not close, so it stays where it is and is followed from here.
 */
export const inExtension = (a: Agent) => runsElsewhere(a) && a.session?.host?.kind === "extension";
