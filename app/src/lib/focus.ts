/** docs/CONTRACT.md "focus.json": a session asked OpenAdmiral to show something (the mod's "Open in OpenAdmiral"). */
export type FocusRequest = { kind: "artifact"; sessionId: string; artifactId: string; version?: number; at: number };

const MAX_AGE_MS = 10_000;

/**
 * A focus request worth acting on: well formed, newer than the last one handled,
 * and recent (an old file, say at app start, is ignored).
 */
export function parseFocus(raw: unknown, now: number, lastAt = 0): FocusRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (v.kind !== "artifact") return null;
  if (typeof v.sessionId !== "string" || !v.sessionId || typeof v.artifactId !== "string" || !v.artifactId) return null;
  if (typeof v.at !== "number" || v.at <= lastAt || now - v.at > MAX_AGE_MS) return null;
  const version = typeof v.version === "number" && v.version > 0 ? v.version : undefined;
  return { kind: "artifact", sessionId: v.sessionId, artifactId: v.artifactId, version, at: v.at };
}
