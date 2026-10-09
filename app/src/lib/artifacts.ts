import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";

/** docs/CONTRACT.md "artifacts/": what an agent showed the user with the mod's `show` tool. */
export type ArtifactKind = "html" | "markdown" | "mermaid" | "image" | "pdf" | "diff" | "text";
export type ArtifactVersion = { n: number; file: string; createdAt: number; note?: string; sourcePath?: string };
export type Artifact = {
  v: 1;
  id: string;
  sessionId: string;
  project: string;
  title: string;
  kind: ArtifactKind;
  versions: ArtifactVersion[];
  updatedAt: number;
  /** Added by the backend: the folder holding the version files. */
  dir: string;
};

export const keyOf = (a: Pick<Artifact, "sessionId" | "id">) => `${a.sessionId}/${a.id}`;
export const latest = (a: Artifact) => a.versions.reduce((m, v) => (v.n > m.n ? v : m), a.versions[0]);
export const fileUrl = (a: Artifact, v: ArtifactVersion) => convertFileSrc(`${a.dir}/${v.file}`);

export const readText = (a: Artifact, v: ArtifactVersion) => invoke<string>("artifact_text", { sessionId: a.sessionId, id: a.id, file: v.file });
export const artifactAction = (a: Artifact, action: "open" | "reveal" | "copy" | "delete", v?: ArtifactVersion) =>
  invoke("artifact_action", { sessionId: a.sessionId, id: a.id, file: v?.file ?? null, action });

const SEEN = "openadmiral.artifacts.seen";

/**
 * The newest version the user has looked at, per artifact. The first run takes
 * everything that already exists as seen, so only what arrives later is new.
 */
export function useSeen(artifacts: Artifact[], loaded: boolean) {
  const [seen, setSeen] = useState<Record<string, number> | null>(() => {
    try {
      const raw = localStorage.getItem(SEEN);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const persist = (next: Record<string, number>) => {
    setSeen(next);
    try {
      localStorage.setItem(SEEN, JSON.stringify(next));
    } catch {
      // A convenience only.
    }
  };
  useEffect(() => {
    if (seen === null && loaded) persist(Object.fromEntries(artifacts.map((a) => [keyOf(a), latest(a).n])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, seen]);

  const markSeen = useCallback(
    (a: Artifact) => {
      const n = latest(a).n;
      if ((seen?.[keyOf(a)] ?? 0) >= n) return;
      persist({ ...(seen ?? {}), [keyOf(a)]: n });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seen],
  );

  const unseen = useMemo(() => {
    const out: Record<string, number> = {};
    if (!seen) return out;
    for (const a of artifacts) if (latest(a).n > (seen[keyOf(a)] ?? 0)) out[a.sessionId] = (out[a.sessionId] ?? 0) + 1;
    return out;
  }, [artifacts, seen]);

  return { unseen, markSeen, isUnseen: (a: Artifact) => !!seen && latest(a).n > (seen[keyOf(a)] ?? 0) };
}
