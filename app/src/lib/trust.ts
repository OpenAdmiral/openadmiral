/** A session that could not restart until its folder is trusted. */
export type TrustAsk = { sessionId: string; name: string; folder: string };

/** The folder a "Workspace not trusted" error names; null for any other error. */
export function untrustedFolder(error: string, cwd: string): string | null {
  if (!/workspace not trusted/i.test(error)) return null;
  return /`claude` in (.+?) once\b/.exec(error)?.[1] ?? cwd;
}
