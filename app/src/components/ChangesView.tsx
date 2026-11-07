import { AddCircleLinearIcon, AltArrowDownLinearIcon, ChatSquareLinearIcon, RefreshLinearIcon, SquareShareLineLinearIcon, TrashBinMinimalisticLinearIcon } from "@solar-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffRows, loadChanges, prPrompt, reviewPrompt, type Changes, type DiffRow, type FileChange, type LineComment } from "@/lib/changes";
import { emptyQueue, newItemId, saveQueue, type QueueEntry } from "@/lib/queue";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Review notes not sent yet, per agent: they survive switching tabs. */
const drafts = new Map<string, LineComment[]>();

const BIG_FILE_ROWS = 400;

type Props = { agent: Agent; queue?: QueueEntry; active: boolean; onError: (m: string) => void; onNotice: (m: string) => void };

/**
 * The Changes tab: what the agent changed since its branch started, file by file, with
 * notes on any line that go back to the agent as one prompt, and a pull request in a click.
 */
export function ChangesView({ agent, queue, active, onError, onNotice }: Props) {
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [comments, setCommentsState] = useState<LineComment[]>(() => drafts.get(agent.id) ?? []);
  const setComments = (f: (c: LineComment[]) => LineComment[]) =>
    setCommentsState((c) => {
      const next = f(c);
      drafts.set(agent.id, next);
      return next;
    });

  const load = useCallback(() => {
    setLoading(true);
    loadChanges(agent.cwd).then(
      (c) => {
        setChanges(c);
        setError(null);
        setLoading(false);
      },
      (e) => {
        setError(String(e));
        setLoading(false);
      },
    );
  }, [agent.cwd]);

  // On opening the tab, and whenever the agent finishes a turn while it is open.
  const status = useRef(agent.status);
  useEffect(() => {
    if (active) load();
  }, [active, load]);
  useEffect(() => {
    if (active && status.current !== agent.status && agent.status !== "working") load();
    status.current = agent.status;
  }, [agent.status, active, load]);

  const send = async (text: string, what: string) => {
    const q = queue?.queue ?? emptyQueue();
    try {
      await saveQueue(agent.id, { ...q, items: [...q.items, { id: newItemId(), text, createdAt: Date.now() }] });
      onNotice(agent.status === "idle" ? `${what} sent to ${agent.name}.` : `${what} queued for ${agent.name}: it runs when this turn ends.`);
      return true;
    } catch (e) {
      onError(`Could not send it: ${String(e)}`);
      return false;
    }
  };

  if (error)
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-3">
        <div>
          <p>{error}</p>
          <button onClick={load} className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-line">
            Try again
          </button>
        </div>
      </div>
    );
  if (!changes) return <div className="flex h-full items-center justify-center text-sm text-ink-3">Reading the changes…</div>;

  const add = changes.files.reduce((n, f) => n + f.additions, 0);
  const del = changes.files.reduce((n, f) => n + f.deletions, 0);
  const onBranch = changes.base !== "HEAD" && !!changes.branch;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 text-[12.5px]">
        <span className="min-w-0 truncate text-ink-2">
          {onBranch ? (
            <>
              <code className="font-mono text-ink">{changes.branch}</code> since <code className="font-mono text-ink">{changes.base}</code>
              {changes.commits > 0 && <span className="text-ink-3"> · {changes.commits === 1 ? "1 commit" : `${changes.commits} commits`}</span>}
            </>
          ) : (
            <>Uncommitted changes{changes.branch && <> on <code className="font-mono text-ink">{changes.branch}</code></>}</>
          )}
        </span>
        <span className="tabular text-ink-3">
          {changes.files.length === 1 ? "1 file" : `${changes.files.length} files`} · <span className="text-green-600 dark:text-green-400">+{add}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{del}</span>
        </span>
        <span className="flex-1" />
        <button onClick={load} disabled={loading} title="Read the changes again" className="flex items-center gap-1 rounded-md px-2 py-1 text-ink-3 transition-colors hover:bg-line hover:text-ink disabled:opacity-50">
          <RefreshLinearIcon size={14} className={cn(loading && "animate-spin")} /> Refresh
        </button>
        {onBranch && (
          <button
            onClick={() => void send(prPrompt(changes), "A pull request request")}
            title="Ask the agent to commit, push and open a pull request with gh"
            className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1 font-semibold text-white transition-colors hover:bg-brand-700"
          >
            <SquareShareLineLinearIcon size={14} /> Create PR
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {changes.files.length === 0 && (
          <p className="pt-10 text-center text-sm text-ink-3">{onBranch ? "No changes on this branch yet." : "Nothing changed since the last commit."}</p>
        )}
        {changes.files.map((f) => (
          <FileDiff
            key={`${f.from ?? ""}>${f.path}`}
            file={f}
            comments={comments.filter((c) => c.path === f.path)}
            onComment={(c) => setComments((cs) => [...cs, c])}
            onRemove={(id) => setComments((cs) => cs.filter((c) => c.id !== id))}
          />
        ))}
        {changes.truncated && <p className="text-center text-xs text-ink-3">The diff is too large to show in full: some files are cut.</p>}
      </div>
      {comments.length > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-t border-line bg-panel px-4 py-2.5 text-sm">
          <ChatSquareLinearIcon size={16} className="text-brand-600 dark:text-brand-400" />
          <span className="text-ink-2">{comments.length === 1 ? "1 review note" : `${comments.length} review notes`}</span>
          <span className="flex-1" />
          <button onClick={() => setComments(() => [])} className="rounded-lg px-3 py-1.5 text-ink-3 transition-colors hover:bg-line hover:text-ink">
            Discard
          </button>
          <button
            onClick={async () => {
              if (await send(reviewPrompt(comments), comments.length === 1 ? "Your review note" : "Your review notes")) setComments(() => []);
            }}
            className="rounded-lg bg-brand-600 px-3.5 py-1.5 font-semibold text-white transition-colors hover:bg-brand-700"
          >
            Send to {agent.name}
          </button>
        </div>
      )}
    </div>
  );
}

const STATUS: Record<FileChange["status"], { letter: string; tone: string }> = {
  added: { letter: "A", tone: "text-green-600 dark:text-green-400" },
  deleted: { letter: "D", tone: "text-red-600 dark:text-red-400" },
  renamed: { letter: "R", tone: "text-brand-600 dark:text-brand-400" },
  modified: { letter: "M", tone: "text-amber-600 dark:text-amber-400" },
};

function FileDiff({ file, comments, onComment, onRemove }: { file: FileChange; comments: LineComment[]; onComment: (c: LineComment) => void; onRemove: (id: string) => void }) {
  const rows = useMemo(() => diffRows(file.hunks), [file.hunks]);
  const [open, setOpen] = useState(rows.length <= BIG_FILE_ROWS);
  const [writing, setWriting] = useState<number | null>(null);
  const s = STATUS[file.status];
  return (
    <section className="overflow-hidden rounded-xl border border-line-strong">
      <button onClick={() => setOpen(!open)} className="sticky top-0 z-[1] flex w-full items-center gap-2.5 border-b border-line bg-panel px-3 py-2 text-left text-[12.5px]">
        <AltArrowDownLinearIcon size={14} className={cn("shrink-0 text-ink-3 transition-transform", !open && "-rotate-90")} />
        <span className={cn("w-3 shrink-0 font-mono font-semibold", s.tone)}>{s.letter}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-ink">
          {file.from && <span className="text-ink-3">{file.from} → </span>}
          {file.path}
        </span>
        {comments.length > 0 && <span className="rounded-full bg-brand-500/15 px-1.5 text-[11px] font-semibold text-brand-700 dark:text-brand-300">{comments.length}</span>}
        <span className="shrink-0 tabular">
          <span className="text-green-600 dark:text-green-400">+{file.additions}</span> <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
        </span>
      </button>
      {open &&
        (file.binary ? (
          <p className="px-3 py-2 text-xs text-ink-3">Binary file</p>
        ) : !file.hunks ? (
          <p className="px-3 py-2 text-xs text-ink-3">{file.truncated ? "Too large to show." : "No content changes."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
              <tbody>
                {rows.map((r, i) => (
                  <Row
                    key={i}
                    row={r}
                    comments={comments.filter((c) => r.kind !== "hunk" && r.kind !== "note" && c.line === (c.side === "old" ? r.old : r.new) && sideOf(r) === c.side)}
                    writing={writing === i}
                    onWrite={() => setWriting(i)}
                    onCancel={() => setWriting(null)}
                    onSave={(text) => {
                      if (r.kind === "hunk" || r.kind === "note") return;
                      const side = sideOf(r);
                      onComment({ id: newItemId(), path: file.path, line: (side === "old" ? r.old : r.new)!, side, code: r.text, text });
                      setWriting(null);
                    }}
                    onRemove={onRemove}
                  />
                ))}
              </tbody>
            </table>
            {file.truncated && <p className="px-3 py-2 text-xs text-ink-3">The rest of this file's diff is cut.</p>}
          </div>
        ))}
    </section>
  );
}

const sideOf = (r: DiffRow): "old" | "new" => (r.kind === "del" ? "old" : "new");

function Row({
  row,
  comments,
  writing,
  onWrite,
  onCancel,
  onSave,
  onRemove,
}: {
  row: DiffRow;
  comments: LineComment[];
  writing: boolean;
  onWrite: () => void;
  onCancel: () => void;
  onSave: (text: string) => void;
  onRemove: (id: string) => void;
}) {
  if (row.kind === "hunk")
    return (
      <tr>
        <td colSpan={3} className="bg-brand-500/[0.06] px-3 py-0.5 text-ink-3">
          {row.text}
        </td>
      </tr>
    );
  if (row.kind === "note")
    return (
      <tr>
        <td colSpan={3} className="px-3 text-ink-3 italic">
          {row.text}
        </td>
      </tr>
    );
  const tone = row.kind === "add" ? "bg-green-500/[0.09]" : row.kind === "del" ? "bg-red-500/[0.09]" : "";
  return (
    <>
      <tr className={cn("group", tone)}>
        <td className="w-[1%] border-r border-line px-2 text-right whitespace-nowrap text-ink-3 select-none tabular">
          <span className="inline-block min-w-[2.2em]">{row.old ?? ""}</span>
          <span className="inline-block min-w-[2.6em]">{row.new ?? ""}</span>
        </td>
        <td className="relative w-[1%] px-1 select-none">
          <button
            onClick={onWrite}
            aria-label="Add a review note on this line"
            title="Add a review note for the agent"
            className="flex size-4 items-center justify-center rounded text-brand-600 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 dark:text-brand-400"
          >
            <AddCircleLinearIcon size={14} />
          </button>
        </td>
        <td className={cn("pr-4 whitespace-pre", row.kind === "add" ? "text-green-800 dark:text-green-200" : row.kind === "del" ? "text-red-800 dark:text-red-200" : "text-ink-2")}>
          <span className="select-none text-ink-3">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
          {row.text}
        </td>
      </tr>
      {comments.map((c) => (
        <tr key={c.id}>
          <td colSpan={3} className="px-3 py-1.5">
            <div className="flex max-w-[640px] items-start gap-2 rounded-lg border border-brand-500/30 bg-brand-500/[0.06] px-3 py-2 font-sans text-[13px] text-ink">
              <ChatSquareLinearIcon size={14} className="mt-0.5 shrink-0 text-brand-600 dark:text-brand-400" />
              <span className="flex-1 whitespace-pre-wrap">{c.text}</span>
              <button onClick={() => onRemove(c.id)} aria-label="Remove this note" className="shrink-0 text-ink-3 hover:text-red-600">
                <TrashBinMinimalisticLinearIcon size={14} />
              </button>
            </div>
          </td>
        </tr>
      ))}
      {writing && (
        <tr>
          <td colSpan={3} className="px-3 py-1.5">
            <NoteEditor onCancel={onCancel} onSave={onSave} />
          </td>
        </tr>
      )}
    </>
  );
}

function NoteEditor({ onCancel, onSave }: { onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="max-w-[640px] rounded-lg border border-line-strong bg-canvas p-2 font-sans">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) onSave(text);
        }}
        placeholder="What should the agent change here?"
        className="h-16 w-full resize-none bg-transparent text-[13px] text-ink placeholder:text-ink-3 focus:outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-ink-3">⌘↵ to add · sent with the others</span>
        <button onClick={onCancel} className="rounded-md px-2.5 py-1 text-xs text-ink-2 hover:bg-line">
          Cancel
        </button>
        <button disabled={!text.trim()} onClick={() => onSave(text)} className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          Add note
        </button>
      </div>
    </div>
  );
}
