import { BellLinearIcon, CheckCircleBoldIcon, CompassLinearIcon, KeyboardLinearIcon, MoonLinearIcon, RocketLinearIcon, StarBoldIcon } from "@solar-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { PLUGIN_COMMANDS, useClaudeAvailable } from "@/components/PluginSetup";
import { connected, followed, turnFinished } from "@/lib/onboarding";
import { starNow, type StarPrompt } from "@/lib/star";
import type { Agent, AgentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STEPS = ["Welcome", "Connect Claude Code", "First agent", "You're set"];

type Props = {
  /** The step to open on (Help → Welcome Tour opens on the first). */
  step: number;
  agents: Agent[];
  pluginInstalled: boolean;
  onNewAgent: () => void;
  /** Done or skipped; `agentId`: open that agent; `underway`: open the Underway panel. */
  onClose: (o: { agentId?: string; underway?: boolean }) => void;
};

/** The welcome tour: what OpenAdmiral is, connect Claude Code, a first agent, and done. */
export function Onboarding({ step: initial, agents, pluginInstalled, onNewAgent, onClose }: Props) {
  const [step, setStep] = useState(initial);
  const [notify, setNotify] = useState(true);
  const [underway, setUnderway] = useState(false);
  const go = (n: number) => setStep(Math.max(0, Math.min(3, n)));
  const finish = (agentId?: string) => onClose({ agentId, underway });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[45] grid grid-cols-[232px_1fr] bg-canvas"
      role="dialog"
      aria-label="Welcome to OpenAdmiral"
    >
      <aside data-tauri-drag-region className="flex flex-col border-r border-line bg-panel px-4 pt-14 pb-5">
        <ol className="space-y-1">
          {STEPS.map((t, i) => (
            <li key={t}>
              <button
                onClick={() => i < step && go(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition-colors",
                  i === step ? "bg-canvas text-ink shadow-sm" : i < step ? "text-ink-2 hover:text-ink" : "cursor-default text-ink-3",
                )}
              >
                <span
                  className={cn(
                    "flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-[11.5px] font-semibold",
                    i === step ? "border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-400" : i < step ? "border-green-600 bg-green-600 text-white" : "border-line-strong",
                  )}
                >
                  {i < step ? "✓" : i + 1}
                </span>
                {t}
              </button>
            </li>
          ))}
        </ol>
        <p className="mt-auto text-[11.5px] leading-relaxed text-ink-3">You can come back to this from Help → Welcome Tour.</p>
      </aside>
      <section data-tauri-drag-region className="relative flex min-h-0 flex-col overflow-y-auto px-14 pt-14 pb-7">
        {step < 3 && (
          <button onClick={() => finish()} className="absolute top-4 right-5 text-[12.5px] text-ink-3 transition-colors hover:text-ink">
            Skip setup
          </button>
        )}
        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }} className="flex flex-1 flex-col">
            {step === 0 && <Welcome next={() => go(1)} />}
            {step === 1 && <Connect installed={pluginInstalled} agents={agents} back={() => go(0)} next={() => go(2)} />}
            {step === 2 && (
              <FirstAgent
                notify={notify}
                setNotify={setNotify}
                underway={underway}
                setUnderway={setUnderway}
                back={() => go(1)}
                next={(launch) => {
                  if (notify) void askNotifications();
                  if (launch) onNewAgent();
                  go(3);
                }}
              />
            )}
            {step === 3 && <Done agents={agents} back={() => go(2)} finish={finish} />}
          </motion.div>
        </AnimatePresence>
      </section>
    </motion.div>
  );
}

async function askNotifications() {
  try {
    if (!(await isPermissionGranted())) await requestPermission();
  } catch {
    // A refusal changes nothing else.
  }
}

function Title({ children, lead }: { children: React.ReactNode; lead: React.ReactNode }) {
  return (
    <>
      <h2 className="text-[26px] font-semibold tracking-tight text-ink">{children}</h2>
      <p className="mt-2 max-w-[540px] text-[15px] leading-relaxed text-ink-2">{lead}</p>
    </>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto flex items-center gap-2.5 pt-8">{children}</div>;
}

const primary = "rounded-xl bg-brand-600 px-4.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-45";
const secondary = "rounded-xl border border-line-strong px-4 py-2 text-sm font-semibold text-ink-2 transition-colors hover:bg-line hover:text-ink";

function Welcome({ next }: { next: () => void }) {
  const ships = [
    { name: "orders-api", line: "Adding idempotency keys", need: false, fill: "70%" },
    { name: "docs-refresh", line: "Needs you · permission", need: true, fill: "55%" },
    { name: "ios-release", line: "Running the tests · 2 min left", need: false, fill: "40%" },
  ];
  return (
    <>
      <img src="/icon.png" alt="" className="mb-4 size-14" />
      <Title lead="OpenAdmiral is the bridge for your Claude Code sessions. You keep the real Claude Code; you stop babysitting terminals.">Welcome aboard, Admiral.</Title>
      <div className="mt-7 grid max-w-[580px] grid-cols-3 gap-2.5">
        {ships.map((s, i) => (
          <motion.div
            key={s.name}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.18 }}
            className={cn("rounded-xl border bg-canvas px-3 py-2.5 text-[13px]", s.need ? "border-amber-400/60 ring-3 ring-amber-400/15" : "border-line-strong")}
          >
            <b className="block font-semibold text-ink">{s.name}</b>
            <span className={cn("text-[12px]", s.need ? "text-amber-700 dark:text-amber-300" : "text-ink-3")}>{s.line}</span>
            <div className="mt-2 h-1 overflow-hidden rounded bg-line">
              <motion.i
                className="block h-full bg-brand-500"
                initial={{ width: "15%" }}
                animate={s.need ? { width: s.fill } : { width: ["20%", s.fill, "85%"] }}
                transition={s.need ? { duration: 0.6 } : { duration: 3, repeat: Infinity, repeatType: "reverse", ease: "easeInOut" }}
              />
            </div>
          </motion.div>
        ))}
      </div>
      <ul className="mt-6 max-w-[540px] space-y-2.5 text-[14px] text-ink-2">
        <li className="flex gap-2.5"><CompassLinearIcon size={18} className="mt-0.5 shrink-0 text-ink-3" />Every session from every project in one window.</li>
        <li className="flex gap-2.5"><BellLinearIcon size={18} className="mt-0.5 shrink-0 text-ink-3" />A nudge the moment an agent needs you.</li>
        <li className="flex gap-2.5"><MoonLinearIcon size={18} className="mt-0.5 shrink-0 text-ink-3" />Queues, hand-offs and the lid closed: work keeps moving without you.</li>
      </ul>
      <Actions>
        <button autoFocus onClick={next} className={primary}>Get started</button>
        <span className="flex-1" />
        <span className="text-[12.5px] text-ink-3">Takes about a minute</span>
      </Actions>
    </>
  );
}

function Connect({ installed, agents, back, next }: { installed: boolean; agents: Agent[]; back: () => void; next: () => void }) {
  const claude = useClaudeAvailable();
  const [state, setState] = useState<"idle" | "busy" | string>("idle");
  const unplugged = agents.filter((a) => a.unplugged);
  const live = agents.filter(connected).length;
  const install = () => {
    setState("busy");
    invoke("install_plugin").then(
      () => setState("idle"),
      (e) => setState(String(e)),
    );
  };
  return (
    <>
      <Title lead="OpenAdmiral sees your sessions through a small Claude Code plugin. It uses Claude Code's own extension system: nothing is patched, and removing it leaves everything as it was.">
        Connect Claude Code
      </Title>
      <div className="mt-6 max-w-[600px] rounded-xl border border-line-strong p-4">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <b className="font-semibold text-ink">OpenAdmiral plugin</b>
            <p className="text-[13px] text-ink-3">For Claude Code on this Mac</p>
          </div>
          {installed ? (
            <Pill tone="ok">✓ Connected</Pill>
          ) : state === "busy" ? (
            <Pill tone="mut">Installing…</Pill>
          ) : (
            <Pill tone="wait">Not installed</Pill>
          )}
        </div>
        {!installed && (
          <div className="mt-3 space-y-2">
            {claude === false ? (
              <p className="text-[13px] text-ink-2">Claude Code isn't installed on this Mac yet. Install it, then come back to this step.</p>
            ) : (
              <button onClick={install} disabled={state === "busy"} className={primary}>
                {state === "busy" ? "Installing…" : "Install plugin"}
              </button>
            )}
            <p className="text-[12.5px] text-ink-3">
              Or in any Claude Code session: <code className="font-mono text-[11.5px]">{PLUGIN_COMMANDS[1]}</code>
            </p>
            {state !== "idle" && state !== "busy" && <p className="text-[12px] text-red-600 dark:text-red-400">{state}</p>}
          </div>
        )}
        {installed && <p className="mt-2 text-[13px] text-ink-2">Installed for your user. New Claude Code sessions connect on their own.</p>}
      </div>
      {unplugged.length > 0 && (
        <div className="mt-2.5 max-w-[600px] rounded-xl border border-line-strong p-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <b className="font-semibold text-ink">Sessions already open</b>
              <p className="text-[13px] text-ink-3">
                {unplugged.length === 1 ? "1 Claude Code session is" : `${unplugged.length} Claude Code sessions are`} running without the plugin (
                {[...new Set(unplugged.map((a) => a.unplugged!.via))].join(", ")}).
              </p>
            </div>
            <Pill tone={live ? "ok" : "mut"}>{live ? `${live} connected` : "not connected"}</Pill>
          </div>
          <p className="mt-2 text-[13px] text-ink-2">
            Type <code className="font-mono text-[11.5px]">/reload-plugins</code> in each one to bring it aboard; in VS Code or Cursor, reloading the window works too.
          </p>
        </div>
      )}
      <p className="mt-3 text-[12.5px] text-ink-3">
        Using only the VS Code extension?{" "}
        <button onClick={() => void invoke("open_vscode_plugin_install").catch(() => {})} className="font-semibold text-brand-600 hover:underline dark:text-brand-400">
          Install in VS Code
        </button>
      </p>
      <Actions>
        <button onClick={back} className={secondary}>Back</button>
        <span className="flex-1" />
        <button autoFocus onClick={next} disabled={!installed} className={primary}>Continue</button>
      </Actions>
    </>
  );
}

function FirstAgent(p: { notify: boolean; setNotify: (v: boolean) => void; underway: boolean; setUnderway: (v: boolean) => void; back: () => void; next: (launch: boolean) => void }) {
  const [launch, setLaunch] = useState(true);
  const choice = (on: boolean, icon: React.ReactNode, title: string, body: string, value: boolean) => (
    <button
      onClick={() => setLaunch(value)}
      className={cn("flex w-full items-start gap-3.5 rounded-xl border p-4 text-left transition-shadow", on ? "border-brand-600 ring-3 ring-brand-600/12" : "border-line-strong hover:border-ink-3")}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-line text-ink-2">{icon}</span>
      <span>
        <b className="block font-semibold text-ink">{title}</b>
        <span className="text-[13px] text-ink-3">{body}</span>
      </span>
    </button>
  );
  return (
    <>
      <Title lead="Start a new Claude Code session from here, or keep working in your own terminal: either way it shows up on the bridge.">Launch your first agent</Title>
      <div className="mt-6 grid max-w-[600px] gap-2.5">
        {choice(launch, <RocketLinearIcon size={18} />, "Start an agent here", "Pick a project folder and what it should do first. Something read-only is a good start, like “Explain how this project is organised”.", true)}
        {choice(!launch, <KeyboardLinearIcon size={18} />, "I'll use my own terminal", "Run claude anywhere. We'll wait for it here and move on when its first reply lands.", false)}
      </div>
      <div className="mt-4 max-w-[600px] divide-y divide-line rounded-xl border border-line-strong px-4">
        <Option title="Notifications" body="So you hear when an agent needs you, even with the window hidden." on={p.notify} set={p.setNotify} />
        <Option
          title="Underway"
          badge="optional"
          body="Keep agents working with the lid closed. It needs a one-time approval of its helper; you can also set it up later from the pill at the top right."
          on={p.underway}
          set={p.setUnderway}
        />
      </div>
      <Actions>
        <button onClick={p.back} className={secondary}>Back</button>
        <span className="flex-1" />
        <button autoFocus onClick={() => p.next(launch)} className={primary}>{launch ? "Launch agent" : "Wait for my session"}</button>
      </Actions>
    </>
  );
}

function Option({ title, badge, body, on, set }: { title: string; badge?: string; body: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 py-3">
      <span className="flex-1">
        <b className="font-semibold text-ink">{title}</b>
        {badge && <span className="ml-1.5 rounded-full bg-line px-2 py-0.5 text-[11px] font-semibold text-ink-3">{badge}</span>}
        <span className="block text-[12.5px] text-ink-3">{body}</span>
      </span>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} className="peer sr-only" />
      <span className={cn("relative h-5 w-[34px] shrink-0 rounded-full transition-colors", on ? "bg-brand-600" : "bg-line-strong")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", on ? "left-4" : "left-0.5")} />
      </span>
    </label>
  );
}

function Done({ agents, back, finish }: { agents: Agent[]; back: () => void; finish: (agentId?: string) => void }) {
  const [done, setDone] = useState(false);
  const before = useRef<Map<string, AgentStatus> | null>(null);
  useEffect(() => {
    const prev = before.current;
    before.current = new Map(agents.map((a) => [a.id, a.status]));
    if (prev && turnFinished(prev, agents)) setDone(true);
  }, [agents]);
  // Preview: OPENADMIRAL_TIP=welcome:4 opens on the finished step.
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent).detail === "welcome:done" && setDone(true);
    window.addEventListener("openadmiral:tip", on);
    return () => window.removeEventListener("openadmiral:tip", on);
  }, []);
  const agent = followed(agents);
  const step = agent?.session?.turn?.progress?.at(-1);

  if (!done)
    return (
      <div className="m-auto flex max-w-[520px] flex-col items-center text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-brand-600/10">
          <span className="size-7 animate-spin rounded-full border-[3px] border-brand-600 border-r-transparent" />
        </span>
        <h2 className="mt-5 text-[24px] font-semibold text-ink">{agent && agent.status !== "idle" ? `${agent.name} is working` : "Waiting for your agent"}</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          {agent && agent.status !== "idle"
            ? "This is how the bridge shows an agent at work. We'll finish as soon as its first reply lands."
            : "Start a Claude Code session, or send a prompt to one. We'll finish as soon as its first reply lands."}
        </p>
        {agent && agent.status !== "idle" && (
          <div className="mt-5 w-full rounded-xl border border-line-strong p-3.5 text-left">
            <div className="flex items-center gap-3">
              <span className="size-3 animate-spin rounded-full border-2 border-brand-500 border-r-transparent" />
              <div className="min-w-0 flex-1">
                <b className="block truncate font-semibold text-ink">{agent.name}</b>
                <span className="block truncate text-[12.5px] text-ink-3">{step?.step ?? agent.session?.turn?.prompt ?? "Working…"}</span>
              </div>
              <span className="rounded-full bg-line px-2 py-0.5 text-[11.5px] font-semibold text-ink-3">{agent.status === "waiting" ? "needs you" : "working"}</span>
            </div>
            {step && (
              <div className="mt-2.5 h-1 overflow-hidden rounded bg-line">
                <i className="block h-full bg-brand-500 transition-all" style={{ width: `${step.percent}%` }} />
              </div>
            )}
          </div>
        )}
        <div className="mt-8 flex gap-2.5">
          <button onClick={back} className={secondary}>Back</button>
          <button onClick={() => finish(agent?.id)} className="rounded-xl px-4 py-2 text-sm text-ink-3 hover:text-ink">Finish without waiting</button>
        </div>
      </div>
    );

  return (
    <div className="m-auto flex w-full max-w-[540px] flex-col items-center text-center">
      <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-green-600">
        <CheckCircleBoldIcon size={64} />
      </motion.span>
      <h2 className="mt-4 text-[24px] font-semibold text-ink">Your first agent is on the bridge</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-2">You're all set. When an agent needs you, it rises to the top and you get a nudge.</p>
      <div className="mt-5 grid w-full grid-cols-3 gap-2 text-left text-[12.5px] text-ink-2">
        <Tip k="⌘K">Jump to any agent, prompt or artifact</Tip>
        <Tip k="⌥↑↓">Move to the next agent</Tip>
        <Tip k="Up next">Queue what an agent does when it's free</Tip>
      </div>
      <StarAsk />
      <button autoFocus onClick={() => finish(agent?.id)} className={cn(primary, "mt-7")}>
        Open the bridge
      </button>
    </div>
  );
}

function Tip({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line px-3 py-2.5">
      <kbd className="mr-1 rounded border border-line-strong px-1 font-mono text-[11px] text-ink">{k}</kbd> {children}
    </div>
  );
}

/** The star card, built into the last step: the backend still decides (already starred, asked before). */
function StarAsk() {
  const [prompt, setPrompt] = useState<StarPrompt | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "starred" | "opened">("idle");
  useEffect(() => {
    invoke<StarPrompt | null>("star_event", { event: { kind: "turn" } }).then(setPrompt, () => {});
    const on = (e: Event) => (e as CustomEvent).detail === "welcome:done" && setPrompt({ reason: "turn", minutes: null, mode: "gh", login: "octocat" });
    window.addEventListener("openadmiral:tip", on);
    return () => window.removeEventListener("openadmiral:tip", on);
  }, []);
  if (!prompt) return null;
  return (
    <div className="mt-5 w-full rounded-xl border border-amber-400/45 bg-amber-400/[0.07] p-4 text-left">
      <div className="flex gap-3">
        <StarBoldIcon size={20} className="mt-0.5 shrink-0 text-amber-500" />
        <div>
          <b className="font-semibold text-ink">Enjoying it so far?</b>
          <p className="text-[13.5px] text-ink-2">OpenAdmiral is free and built by one person. A GitHub star helps other Claude Code users find it.</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          disabled={state !== "idle"}
          onClick={() => {
            setState("busy");
            starNow().then(setState, () => setState("idle"));
          }}
          className="flex items-center gap-1.5 rounded-lg border border-amber-400/60 bg-amber-400/15 px-3.5 py-1.5 text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-400/25 disabled:opacity-80 dark:text-amber-100"
        >
          <StarBoldIcon size={14} />
          {state === "starred" ? "Starred, thank you!" : state === "opened" ? "GitHub opened" : state === "busy" ? "Starring…" : "Star on GitHub"}
        </button>
        <span className="text-[12px] text-ink-3">
          {prompt.mode === "gh" ? `Stars with your GitHub CLI account${prompt.login ? ` (@${prompt.login})` : ""}.` : "Opens GitHub in your browser."}
        </span>
      </div>
    </div>
  );
}

function Pill({ tone, children }: { tone: "ok" | "wait" | "mut"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap",
        tone === "ok" && "bg-green-600/12 text-green-700 dark:text-green-400",
        tone === "wait" && "bg-amber-400/18 text-amber-700 dark:text-amber-300",
        tone === "mut" && "bg-line text-ink-3",
      )}
    >
      {children}
    </span>
  );
}
