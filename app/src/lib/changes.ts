import { invoke } from "@tauri-apps/api/core";

/** An agent's changes (src-tauri/src/changes.rs). */
export type FileChange = { path: string; from: string | null; status: "added" | "deleted" | "renamed" | "modified"; additions: number; deletions: number; binary: boolean; hunks: string; truncated: boolean };
export type Changes = { root: string; branch: string | null; base: string; defaultBranch: string | null; commits: number; files: FileChange[]; truncated: boolean };

export const loadChanges = (cwd: string) => invoke<Changes>("agent_changes", { cwd });

/** One line of a diff as drawn: its kind and its numbers on each side. */
export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "add" | "del" | "ctx"; text: string; old: number | null; new: number | null }
  | { kind: "note"; text: string };

/** A file's hunks as rows with line numbers ("\ No newline at end of file" becomes a note). */
export function diffRows(hunks: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldN = 0;
  let newN = 0;
  for (const line of hunks.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), old: null, new: newN++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), old: oldN++, new: null });
    else if (line.startsWith("\\")) rows.push({ kind: "note", text: line.slice(2) });
    else if (line.length || rows.length) rows.push({ kind: "ctx", text: line.slice(1), old: oldN++, new: newN++ });
  }
  return rows;
}

/** A note left on one line of the diff, for the agent. */
export type LineComment = { id: string; path: string; line: number; side: "new" | "old"; code: string; text: string };

/** The prompt that carries the review back to the agent. */
export function reviewPrompt(comments: LineComment[]) {
  const byFile = new Map<string, LineComment[]>();
  for (const c of comments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  const parts = [...byFile].map(([path, cs]) =>
    [
      `${path}:`,
      ...cs
        .sort((a, b) => a.line - b.line)
        .map((c) => `- Line ${c.line}${c.side === "old" ? " (removed line)" : ""}: ${c.text.trim()}\n  > ${c.code.trim().slice(0, 200)}`),
    ].join("\n"),
  );
  return `Review notes on your changes. Address each one, then summarise what you changed:\n\n${parts.join("\n\n")}`;
}

/** The prompt that asks the agent to open a pull request for its branch. */
export function prPrompt(c: Pick<Changes, "branch" | "base">) {
  const base = c.base.replace(/^origin\//, "");
  return `Commit any pending changes on ${c.branch ?? "this branch"} with a clear message, push the branch and open a pull request against ${base} with gh: a concise title and a description of what changed and why. Reply with the PR link.`;
}
