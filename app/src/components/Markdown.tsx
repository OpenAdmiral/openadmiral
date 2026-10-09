import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useId, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/** claude.ai pages (artifacts, docs) open inside OpenAdmiral; anything else in the default browser. */
export const isClaudeLink = (href: string) => /^https:\/\/claude\.ai\//.test(href);

export function openLink(href: string) {
  if (isClaudeLink(href)) invoke("browser_open", { url: href }).catch(() => openUrl(href));
  else if (/^https?:\/\//.test(href)) openUrl(href).catch(() => {});
}

const dark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
/** Loaded on first use: mermaid is large. */
function loadMermaid() {
  mermaidReady ??= import("mermaid").then((m) => m.default);
  return mermaidReady;
}

/** A mermaid diagram, themed for the current appearance. */
export function Mermaid({ code, className }: { code: string; className?: string }) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scheme, setScheme] = useState(dark());
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setScheme(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    let alive = true;
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: scheme ? "dark" : "default", fontFamily: "Outfit Variable, sans-serif" });
        const out = await mermaid.render(`${id}-${scheme ? "d" : "l"}`, code.trim());
        if (alive) {
          setSvg(out.svg);
          setError(null);
        }
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [code, scheme, id]);
  if (error) return <pre className={cn("whitespace-pre-wrap text-xs text-red-600", className)}>{error}</pre>;
  if (!svg) return <div className={cn("text-xs text-ink-3", className)}>Drawing diagram…</div>;
  return <div className={cn("admiral-mermaid flex justify-center", className)} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Model-written markdown: GFM, highlighted code, mermaid fences, safe links. */
export function Markdown({ children, className, onClaudeLink }: { children: string; className?: string; onClaudeLink?: (href: string) => void }) {
  return (
    <div className={cn("admiral-md", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: ({ href = "", children }) => (
            <>
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  openLink(href);
                }}
              >
                {children}
              </a>
              {isClaudeLink(href) && (
                <button
                  onClick={() => (onClaudeLink ? onClaudeLink(href) : openLink(href))}
                  className="ml-1 inline-flex h-4 items-center rounded bg-brand-500/12 px-1 align-middle text-[10px] font-semibold text-brand-700 no-underline hover:bg-brand-500/20 dark:text-brand-300"
                >
                  Open in OpenAdmiral
                </button>
              )}
            </>
          ),
          code: ({ className: cls, children, ...rest }) => {
            if (/language-mermaid/.test(cls ?? "")) return <Mermaid code={String(children)} className="my-2" />;
            return (
              <code className={cls} {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
