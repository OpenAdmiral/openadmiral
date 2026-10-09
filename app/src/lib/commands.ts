import type { AdmiralSession } from "./types";

/**
 * Slash commands the header chips put in a session's prompt box. A session only
 * lists the ones its Claude Code build has; an older mod lists none, so all are offered.
 */
export const offers = (s: AdmiralSession | undefined, command: string) => !s?.commands || s.commands.includes(command);

/** /usage where the build has it, else /cost; undefined when neither. */
export const costCommand = (s: AdmiralSession | undefined) => (offers(s, "usage") ? "/usage" : offers(s, "cost") ? "/cost" : undefined);

/** The Remote Control chip: hidden without the command, then off / on with nobody / N devices. */
export function remoteState(s: AdmiralSession | undefined): { kind: "hidden" | "off" | "on" | "connected"; clients: number } {
  // Unlike the other commands, only a build that says it has /remote-control shows the chip.
  if (!s?.commands?.includes("remote-control")) return { kind: "hidden", clients: 0 };
  const clients = s.remote?.clients ?? 0;
  if (clients > 0) return { kind: "connected", clients };
  return { kind: s.remote?.enabled ? "on" : "off", clients: 0 };
}
