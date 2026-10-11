import {
  ChartSquareLinearIcon,
  CodeLinearIcon,
  DocumentTextLinearIcon,
  FileTextLinearIcon,
  GalleryLinearIcon,
  Routing2LinearIcon,
  WidgetLinearIcon,
} from "@solar-icons/react";
import { useEffect, useMemo, useState } from "react";
import { fileUrl, keyOf, latest, type Artifact, type ArtifactKind } from "@/lib/artifacts";
import type { Agent } from "@/lib/types";
import { ago, cn, projectColor } from "@/lib/utils";
import { ArtifactViewer } from "./ArtifactViewer";
import { UnderwayPill } from "@/components/UnderwayPill";

export const KIND_ICON: Record<ArtifactKind, typeof CodeLinearIcon> = {
  html: CodeLinearIcon,
  markdown: DocumentTextLinearIcon,
  mermaid: Routing2LinearIcon,
  image: GalleryLinearIcon,
  pdf: FileTextLinearIcon,
  diff: ChartSquareLinearIcon,
  text: DocumentTextLinearIcon,
};

const newestFirst = (a: Artifact, b: Artifact) => latest(b).createdAt - latest(a).createdAt;

type Shared = { now: number; isUnseen: (a: Artifact) => boolean; markSeen: (a: Artifact) => void; onError: (m: string) => void; onClaudeLink: (href: string) => void };

/** One agent's artifacts: a list, newest first, and the viewer. */
export function ArtifactsPane({ artifacts, focus, focusVersion, focusAt, ...s }: Shared & { artifacts: Artifact[]; focus?: string; focusVersion?: number; focusAt?: number }) {
  const list = useMemo(() => [...artifacts].sort(newestFirst), [artifacts]);
  const [selected, setSelected] = useState<string | undefined>(focus ?? (list[0] && keyOf(list[0])));
  // Each request counts (by its time), even for the artifact already on screen.
  useEffect(() => {
    if (focus) setSelected(focus);
  }, [focus, focusAt]);
  const current = list.find((a) => keyOf(a) === selected) ?? list[0];
  useEffect(() => {
    if (current) s.markSeen(current);
  }, [current, s]);

  if (!list.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <WidgetLinearIcon size={32} className="mb-3 text-ink-3" />
        <p className="text-sm font-semibold text-ink">No artifacts yet</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-ink-3">
          Reports, plans, diagrams, images and pages this agent publishes with the OpenAdmiral <code className="font-mono">show</code> tool appear here.
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0">
      <ul className="w-56 shrink-0 space-y-0.5 overflow-y-auto border-r border-line p-2">
        {list.map((a) => (
          <Row key={keyOf(a)} a={a} active={current && keyOf(a) === keyOf(current)} unseen={s.isUnseen(a)} now={s.now} onClick={() => setSelected(keyOf(a))} />
        ))}
      </ul>
      <div className="min-w-0 flex-1">
        {current && (
          <ArtifactViewer
            key={keyOf(current)}
            artifact={current}
            version={focus === keyOf(current) ? focusVersion : undefined}
            versionAt={focus === keyOf(current) ? focusAt : undefined}
            now={s.now}
            onError={s.onError}
            onClaudeLink={s.onClaudeLink}
          />
        )}
      </div>
    </div>
  );
}

function Row({ a, active, unseen, now, onClick }: { a: Artifact; active?: boolean; unseen: boolean; now: number; onClick: () => void }) {
  const Icon = KIND_ICON[a.kind] ?? DocumentTextLinearIcon;
  const v = latest(a);
  return (
    <li>
      <button onClick={onClick} className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors", active ? "bg-line-strong" : "hover:bg-line")}>
        <Icon size={15} className="mt-0.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-ink">{a.title}</span>
            {unseen && <span className="size-1.5 shrink-0 rounded-full bg-brand-500" />}
          </span>
          <span className="text-[10.5px] text-ink-3 tabular">
            v{v.n} · {ago(v.createdAt, now)} ago
          </span>
        </span>
      </button>
    </li>
  );
}

/** Every artifact across agents, as a grid, with the viewer beside it. */
export function ArtifactsGallery({ artifacts, agents, ...s }: Shared & { artifacts: Artifact[]; agents: Agent[] }) {
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const projects = [...new Set(artifacts.map((a) => a.project))].sort();
  const kinds = [...new Set(artifacts.map((a) => a.kind))].sort();
  const shown = artifacts
    .filter((a) => (!project || a.project === project) && (!kind || a.kind === kind) && (!q || a.title.toLowerCase().includes(q.toLowerCase())))
    .sort(newestFirst);
  const current = artifacts.find((a) => keyOf(a) === open);
  useEffect(() => {
    if (current) s.markSeen(current);
  }, [current, s]);
  const agentName = (a: Artifact) => agents.find((x) => x.id === a.sessionId)?.name ?? a.sessionId.slice(0, 8);
  const select = "h-7 rounded-md border border-line-strong bg-canvas px-2 text-xs text-ink focus:border-brand-500 focus:outline-none";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header data-tauri-drag-region className="flex shrink-0 flex-wrap items-center gap-3 px-6 pt-3.5 pb-4">
        <WidgetLinearIcon size={20} className="text-brand-600 dark:text-brand-400" />
        <h1 className="text-xl font-semibold tracking-tight text-ink">Artifacts</h1>
        <span className="text-sm text-ink-3 tabular">{artifacts.length}</span>
        <span className="flex-1" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles…" className={cn(select, "w-48")} />
        <select value={project} onChange={(e) => setProject(e.target.value)} className={select}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={select}>
          <option value="">All kinds</option>
          {kinds.map((k) => <option key={k}>{k}</option>)}
        </select>
        <UnderwayPill />
      </header>
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <div className={cn("min-h-0 overflow-y-auto px-3", current ? "w-[420px] shrink-0" : "flex-1")}>
          {shown.length === 0 ? (
            <p className="mt-16 text-center text-sm text-ink-3">{artifacts.length ? "Nothing matches." : "No artifacts yet."}</p>
          ) : (
            <div className={cn("grid gap-3", current ? "grid-cols-2" : "grid-cols-[repeat(auto-fill,minmax(220px,1fr))]")}>
              {shown.map((a) => {
                const v = latest(a);
                const Icon = KIND_ICON[a.kind] ?? DocumentTextLinearIcon;
                const active = open === keyOf(a);
                return (
                  <button
                    key={keyOf(a)}
                    onClick={() => setOpen(active ? null : keyOf(a))}
                    className={cn("group overflow-hidden rounded-xl border bg-canvas text-left shadow-sm transition-all duration-200 hover:shadow-md", active ? "border-brand-500 ring-2 ring-brand-500/25" : "border-line")}
                  >
                    <div className="admiral-checker relative flex h-32 items-center justify-center overflow-hidden border-b border-line">
                      {a.kind === "image" ? (
                        <img src={fileUrl(a, v)} alt="" className="max-h-full max-w-full object-contain" />
                      ) : (
                        <span className="flex size-12 items-center justify-center rounded-xl bg-canvas shadow-sm ring-1 ring-line">
                          <Icon size={22} className="text-brand-600 dark:text-brand-400" />
                        </span>
                      )}
                      {s.isUnseen(a) && <span className="absolute top-2 right-2 rounded-full bg-brand-600 px-1.5 text-[10px] font-semibold leading-4 text-white">new</span>}
                    </div>
                    <div className="px-3 py-2">
                      <div className="truncate text-xs font-semibold text-ink">{a.title}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-3 tabular">
                        <span className="size-1.5 rounded-full" style={{ background: projectColor(a.project) }} />
                        <span className="truncate">{agentName(a)}</span>
                        <span>· v{v.n} · {ago(v.createdAt, s.now)} ago</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {current && (
          <div className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-line bg-canvas shadow-sm">
            <ArtifactViewer key={keyOf(current)} artifact={current} now={s.now} onDeleted={() => setOpen(null)} onError={s.onError} onClaudeLink={s.onClaudeLink} />
          </div>
        )}
      </div>
    </div>
  );
}
