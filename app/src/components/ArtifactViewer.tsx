import {
  CopyLinearIcon,
  FolderOpenLinearIcon,
  ArrowRightUpLinearIcon,
  TrashBinMinimalisticLinearIcon,
} from "@solar-icons/react";
import { useEffect, useMemo, useState } from "react";
import { artifactAction, fileUrl, latest, readText, type Artifact, type ArtifactVersion } from "@/lib/artifacts";
import { ago, cn } from "@/lib/utils";
import { Markdown, Mermaid } from "./Markdown";

/**
 * What the sandboxed frame may load: inline code, scripts from the usual CDNs,
 * images and fonts from data/https. Nothing can reach the app: the frame has an
 * opaque origin (no allow-same-origin) and no network calls of its own.
 */
const FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; img-src data: blob: https:; font-src data: https:; media-src data: blob:; connect-src 'none'";

function withCsp(html: string) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`) : `${meta}${html}`;
}

export function ArtifactViewer({
  artifact: a,
  version,
  versionAt,
  now,
  onDeleted,
  onError,
  onClaudeLink,
}: {
  artifact: Artifact;
  /** A version asked for ("Open in OpenAdmiral" on an older card); else the newest. */
  version?: number;
  versionAt?: number;
  now: number;
  onDeleted?: () => void;
  onError: (m: string) => void;
  onClaudeLink?: (href: string) => void;
}) {
  const versions = useMemo(() => [...a.versions].sort((x, y) => x.n - y.n), [a.versions]);
  const wanted = () => (version && a.versions.some((x) => x.n === version) ? version : latest(a).n);
  const [n, setN] = useState(wanted);
  const [compare, setCompare] = useState(false);
  // A new version arriving moves the viewer to it; a request for a version moves it there.
  useEffect(() => setN(latest(a).n), [a.id, a.versions.length]);
  useEffect(() => {
    if (versionAt) setN(wanted());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionAt]);
  const v = versions.find((x) => x.n === n) ?? latest(a);
  const prev = versions.filter((x) => x.n < v.n).at(-1);

  const act = (action: "open" | "reveal" | "copy" | "delete") =>
    artifactAction(a, action, v)
      .then(() => action === "delete" && onDeleted?.())
      .catch((e) => onError(String(e)));

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="mr-1 min-w-0 truncate text-sm font-semibold text-ink">{a.title}</h2>
        <span className="shrink-0 rounded bg-line px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{a.kind}</span>
        {versions.length > 1 && (
          <div className="flex items-center gap-0.5 rounded-lg bg-line p-0.5">
            {versions.map((x) => (
              <button
                key={x.n}
                onClick={() => setN(x.n)}
                className={cn("rounded-md px-2 py-0.5 text-[11px] tabular transition-all", x.n === v.n ? "bg-canvas font-semibold text-ink shadow-sm" : "text-ink-2 hover:text-ink")}
              >
                v{x.n}
              </button>
            ))}
          </div>
        )}
        {a.kind === "image" && prev && (
          <button
            onClick={() => setCompare(!compare)}
            className={cn("rounded-md px-2 py-1 text-[11px] transition-colors", compare ? "bg-brand-500/12 font-semibold text-brand-700 dark:text-brand-300" : "text-ink-2 hover:bg-line")}
          >
            Compare v{prev.n}
          </button>
        )}
        <span className="flex-1" />
        <span className="shrink-0 text-[11px] text-ink-3 tabular">{ago(v.createdAt, now)} ago</span>
        <IconButton title="Open in default app" onClick={() => act("open")} icon={<ArrowRightUpLinearIcon size={15} />} />
        <IconButton title="Reveal in Finder" onClick={() => act("reveal")} icon={<FolderOpenLinearIcon size={15} />} />
        {a.kind !== "pdf" && <IconButton title={a.kind === "image" ? "Copy image" : "Copy text"} onClick={() => act("copy")} icon={<CopyLinearIcon size={15} />} />}
        <IconButton title="Delete artifact" danger onClick={() => act("delete")} icon={<TrashBinMinimalisticLinearIcon size={15} />} />
      </div>
      {v.note && <div className="border-b border-line bg-panel px-4 py-1.5 text-xs text-ink-2">v{v.n} · {v.note}</div>}
      <div className="relative min-h-0 flex-1">
        {a.kind === "image" ? (
          compare && prev ? (
            <div className="grid h-full grid-cols-2 gap-px bg-line">
              <ImageView a={a} v={prev} label={`v${prev.n}`} />
              <ImageView a={a} v={v} label={`v${v.n}`} />
            </div>
          ) : (
            <ImageView a={a} v={v} />
          )
        ) : a.kind === "pdf" ? (
          <iframe title={a.title} src={fileUrl(a, v)} className="h-full w-full border-0 bg-white" />
        ) : (
          <TextKinds a={a} v={v} onClaudeLink={onClaudeLink} />
        )}
      </div>
    </div>
  );
}

function IconButton({ title, onClick, icon, danger }: { title: string; onClick: () => void; icon: React.ReactNode; danger?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-colors", danger ? "hover:bg-red-500/10 hover:text-red-600" : "hover:bg-line hover:text-ink")}
    >
      {icon}
    </button>
  );
}

/** Fit to the pane; a click shows it at 100 %, scrolled to pan. Transparency on a checkerboard. */
function ImageView({ a, v, label }: { a: Artifact; v: ArtifactVersion; label?: string }) {
  const [actual, setActual] = useState(false);
  return (
    <div
      className={cn("admiral-checker relative h-full w-full", actual ? "overflow-auto cursor-zoom-out" : "flex items-center justify-center overflow-hidden p-4 cursor-zoom-in")}
      onClick={() => setActual(!actual)}
    >
      {label && <span className="absolute top-2 left-2 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">{label}</span>}
      <img src={fileUrl(a, v)} alt={a.title} draggable={false} className={cn(actual ? "max-w-none" : "max-h-full max-w-full object-contain shadow-sm")} />
    </div>
  );
}

function TextKinds({ a, v, onClaudeLink }: { a: Artifact; v: ArtifactVersion; onClaudeLink?: (href: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setText(null);
    setError(null);
    readText(a, v)
      .then((t) => alive && setText(t))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [a.dir, v.file]);
  if (error) return <p className="p-4 text-xs text-red-600">{error}</p>;
  if (text === null) return <p className="p-4 text-xs text-ink-3">Loading…</p>;
  switch (a.kind) {
    case "html":
      // allow-scripts only: an opaque origin, so the page cannot reach the app.
      return <iframe title={a.title} sandbox="allow-scripts" srcDoc={withCsp(text)} className="h-full w-full border-0 bg-white" />;
    case "markdown":
      return (
        <div className="h-full overflow-y-auto px-8 py-6">
          <Markdown className="admiral-doc mx-auto max-w-3xl text-sm leading-relaxed text-ink-2 selectable" onClaudeLink={onClaudeLink}>
            {text}
          </Markdown>
        </div>
      );
    case "mermaid":
      return (
        <div className="h-full overflow-auto p-6">
          <Mermaid code={text} />
        </div>
      );
    case "diff":
      return <DiffView text={text} />;
    default:
      return <pre className="selectable h-full overflow-auto p-4 font-mono text-xs leading-5 text-ink-2">{text}</pre>;
  }
}

function DiffView({ text }: { text: string }) {
  return (
    <div className="selectable h-full overflow-auto py-2 font-mono text-[11.5px] leading-5">
      {text.split("\n").map((line, i) => (
        <div
          key={i}
          className={cn(
            "px-4 whitespace-pre",
            line.startsWith("+++") || line.startsWith("---") ? "font-semibold text-ink" :
            line.startsWith("+") ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" :
            line.startsWith("-") ? "bg-red-500/10 text-red-800 dark:text-red-300" :
            line.startsWith("@@") ? "bg-brand-500/8 text-brand-700 dark:text-brand-300" :
            line.startsWith("diff ") || line.startsWith("index ") ? "text-ink-3" : "text-ink-2",
          )}
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}
