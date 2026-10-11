import { CheckCircleLinearIcon, CloseCircleLinearIcon, DangerTriangleLinearIcon } from "@solar-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useUnderwayContext, type UnderwayCheck, type UnderwayState } from "@/lib/underway";
import { cn } from "@/lib/utils";

const TONE: Record<UnderwayState["tone"], string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/45 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  bad: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  neutral: "border-line-strong bg-canvas/60 text-ink-2",
};

const FLOORS = [10, 15, 20, 25, 30, 40];
const LIMITS = [2, 4, 8, 12, 24, 0];

/**
 * Top right of every view: can I close the lid and go? One pill (Docked, Underway,
 * Standing by, Not safe) and, on click, the checks behind the answer and the switches.
 */
export function UnderwayPill() {
  const u = useUnderwayContext();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Preview screenshots open it with OPENADMIRAL_TIP=underway.
  useEffect(() => {
    const onTip = (e: Event) => (e as CustomEvent).detail === "underway" && setOpen(true);
    window.addEventListener("openadmiral:tip", onTip);
    return () => window.removeEventListener("openadmiral:tip", onTip);
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    // Capture, so Esc closes the panel before the terminal sees it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  if (!u?.state) return null;
  const s = u.state;
  return (
    <div ref={root} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${s.pill}: ${s.title}`}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500",
          TONE[s.tone],
        )}
      >
        <span className={cn("size-1.5 rounded-full bg-current", s.hold && "animate-pulse")} />
        {s.pill}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Underway"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="absolute top-full right-0 z-50 mt-1.5 max-h-[calc(100vh-80px)] w-[360px] overflow-y-auto rounded-xl border border-line-strong bg-canvas shadow-xl"
          >
            <Panel />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Panel() {
  const u = useUnderwayContext()!;
  const s = u.state!;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingBackup, setEditingBackup] = useState(false);
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    setError(null);
    p.catch((e) => setError(String(e))).finally(() => setBusy(false));
  };
  const turn = (on: boolean) => {
    if (on && !s.settings.acknowledged) return setConfirming(true);
    run(u.set({ enabled: on }));
  };
  const until = s.until ? new Date(s.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const action = (c: UnderwayCheck): ReactNode => {
    if (c.id === "helper" && s.helper === "missing") return <SmallButton onClick={() => run(u.helper("install"))}>Install</SmallButton>;
    if (c.id === "helper" && s.helper === "approval") return <SmallButton onClick={() => run(u.helper("settings"))}>Open Settings</SmallButton>;
    if (c.id === "backup" && c.level !== "ok") return <SmallButton onClick={() => setEditingBackup(true)}>Set up</SmallButton>;
    if (c.id === "backup" && s.settings.backupSsid && !s.net.hotspot) return <SmallButton onClick={() => run(u.join())}>Join now</SmallButton>;
    if (c.id === "resume" && c.level !== "ok") return <SmallButton onClick={() => run(u.set({ autoResume: true }))}>Turn on</SmallButton>;
    return null;
  };

  return (
    <div className={cn("text-left", busy && "cursor-progress")}>
      <div className="border-b border-line px-4 pt-3.5 pb-3">
        <h2 className="text-[15px] font-semibold text-ink">{s.title}</h2>
        {s.detail && <p className="mt-0.5 text-xs leading-snug text-ink-3">{s.detail}</p>}
      </div>

      <div className="px-4 pt-3">
        <Row
          label="Underway"
          hint={s.settings.enabled ? (until ? `On until ${until}` : "On") : "Keep agents working with the lid closed"}
        >
          <Switch on={s.settings.enabled} onChange={turn} label="Underway" />
        </Row>
        {confirming && (
          <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-ink-2">
            <p className="font-semibold text-ink">Before you close the lid</p>
            <p className="mt-1">
              The Mac keeps working inside your bag, so it warms up and uses battery. Keep it where air can reach it. Underway stops on its own at {s.settings.batteryFloor}% battery, if
              it runs too hot{s.settings.maxHours > 0 && `, after ${s.settings.maxHours} h`}
              {s.settings.onlyWhileWork && ", and lets the Mac sleep once your agents are done"}.
            </p>
            <div className="mt-2.5 flex gap-2">
              <button
                onClick={() => {
                  setConfirming(false);
                  run(u.set({ enabled: true, acknowledged: true }));
                }}
                className="rounded-md bg-brand-600 px-2.5 py-1 font-semibold text-white hover:bg-brand-700"
              >
                Turn on Underway
              </button>
              <button onClick={() => setConfirming(false)} className="rounded-md px-2.5 py-1 font-semibold text-ink-2 hover:bg-line">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <ul className="space-y-1 px-4 pt-3">
        {s.checks.map((c) => (
          <li key={c.id} className="flex min-h-6 items-center gap-2 text-[12.5px] text-ink-2">
            <CheckIcon level={c.level} />
            <span className="min-w-0 flex-1 leading-snug">{c.label}</span>
            {action(c)}
          </li>
        ))}
      </ul>
      {s.net.backupAttempt && s.net.backupAttempt !== "joined" && (
        <p className="mx-4 mt-2 rounded-md bg-line px-2.5 py-1.5 text-[11.5px] leading-snug text-ink-3">
          {s.net.backupAttempt === "joining" ? `Joining ${s.settings.backupSsid ?? "the backup network"}…` : s.net.backupAttempt}
        </p>
      )}
      {error && <p className="mx-4 mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11.5px] leading-snug text-red-700 dark:text-red-300">{error}</p>}

      <div className="mt-3 space-y-2.5 border-t border-line px-4 pt-3 pb-3.5">
        <Row label="Only while agents have work" hint="Then the Mac sleeps as usual">
          <Switch on={s.settings.onlyWhileWork} onChange={(v) => run(u.set({ onlyWhileWork: v }))} label="Only while agents have work" />
        </Row>
        <Row label="Resume after a network drop" hint="Agents a lost connection stopped carry on">
          <Switch on={s.settings.autoResume} onChange={(v) => run(u.set({ autoResume: v }))} label="Resume after a network drop" />
        </Row>
        <Row label="On battery, stop at">
          <Select value={s.settings.batteryFloor} options={FLOORS.map((f) => [f, `${f}%`])} onChange={(v) => run(u.set({ batteryFloor: v }))} label="Battery floor" />
        </Row>
        <Row label="Stop after">
          <Select value={s.settings.maxHours} options={LIMITS.map((h) => [h, h ? `${h} h` : "No limit"])} onChange={(v) => run(u.set({ maxHours: v }))} label="Time limit" />
        </Row>
        <BackupNetwork editing={editingBackup} setEditing={setEditingBackup} run={run} />
        {s.helper === "ready" && (
          <button onClick={() => run(u.helper("uninstall"))} className="text-[11.5px] text-ink-3 hover:text-ink hover:underline">
            Remove the helper
          </button>
        )}
      </div>
    </div>
  );
}

function BackupNetwork({ editing, setEditing, run }: { editing: boolean; setEditing: (v: boolean) => void; run: (p: Promise<unknown>) => void }) {
  const u = useUnderwayContext()!;
  const s = u.state!;
  const [ssid, setSsid] = useState(s.settings.backupSsid ?? "");
  const [password, setPassword] = useState("");
  // Networks this Mac has joined: picking one avoids typing "César’s iPhone" by hand.
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => {
    if (editing) invoke<string[]>("underway_networks").then(setKnown, () => {});
  }, [editing]);
  // A new network always needs its password; the saved one stays when only re-saving.
  const needsPassword = !s.backupPassword || ssid.trim() !== s.settings.backupSsid;
  if (!editing) {
    return (
      <Row label="Backup network" hint={s.settings.backupSsid ?? (s.net.iphoneUsb ? "iPhone by cable" : "None")}>
        <SmallButton onClick={() => setEditing(true)}>{s.settings.backupSsid ? "Change" : "Set up"}</SmallButton>
      </Row>
    );
  }
  return (
    <form
      className="rounded-lg border border-line bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(u.backup(ssid, password));
        setEditing(false);
      }}
    >
      <p className="text-[12.5px] font-semibold text-ink">Backup network</p>
      <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
        Joined when the connection is gone for 20 seconds. Use your iPhone&apos;s hotspot with Personal Hotspot → Allow Others to Join on; its password is on that same screen.
        Plugging the iPhone in with a cable needs no setup at all.
      </p>
      <input
        value={ssid}
        onChange={(e) => setSsid(e.target.value)}
        placeholder="Network name, e.g. Alex’s iPhone"
        aria-label="Network name"
        autoFocus
        className="mt-2 w-full rounded-md border border-line-strong bg-canvas px-2.5 py-1.5 text-xs text-ink focus:border-brand-500 focus:outline-none"
      />
      {known.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {/* An iPhone's hotspot is the likely backup: those first. */}
          {[...known.filter((n) => /iphone/i.test(n)), ...known.filter((n) => !/iphone/i.test(n))].slice(0, 6).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setSsid(n)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                ssid === n ? "border-brand-500 bg-brand-500/10 text-ink" : "border-line-strong text-ink-2 hover:bg-line hover:text-ink",
              )}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        placeholder={needsPassword ? "Password" : "Password (leave empty to keep the saved one)"}
        required={needsPassword}
        aria-label="Password"
        className="mt-1.5 w-full rounded-md border border-line-strong bg-canvas px-2.5 py-1.5 text-xs text-ink focus:border-brand-500 focus:outline-none"
      />
      <p className="mt-1 text-[11px] text-ink-3">The password is kept in your Keychain.</p>
      <div className="mt-2 flex gap-2">
        <button
          type="submit"
          disabled={!ssid.trim() || (needsPassword && !password)}
          className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700 disabled:cursor-default disabled:opacity-50"
        >
          Save
        </button>
        {s.settings.backupSsid && (
          <button
            type="button"
            onClick={() => {
              run(u.backup(""));
              setEditing(false);
            }}
            className="rounded-md px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-500/10 dark:text-red-400"
          >
            Remove
          </button>
        )}
        <button type="button" onClick={() => setEditing(false)} className="ml-auto rounded-md px-2.5 py-1 text-xs font-semibold text-ink-2 hover:bg-line">
          Cancel
        </button>
      </div>
    </form>
  );
}

function CheckIcon({ level }: { level: UnderwayCheck["level"] }) {
  if (level === "ok") return <CheckCircleLinearIcon size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />;
  if (level === "warn") return <DangerTriangleLinearIcon size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />;
  return <CloseCircleLinearIcon size={15} className="shrink-0 text-red-600 dark:text-red-400" />;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink">{label}</p>
        {hint && <p className="truncate text-[11.5px] text-ink-3">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-[18px] w-8 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500",
        on ? "bg-brand-600" : "bg-line-strong",
      )}
    >
      <span className={cn("absolute top-[2px] size-[14px] rounded-full bg-white shadow-sm transition-[left] duration-150", on ? "left-[16px]" : "left-[2px]")} />
    </button>
  );
}

function Select({ value, options, onChange, label }: { value: number; options: [number, string][]; onChange: (v: number) => void; label: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={label}
      className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-ink focus:border-brand-500 focus:outline-none"
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function SmallButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="shrink-0 rounded-md border border-line-strong px-2 py-0.5 text-[11.5px] font-semibold text-ink-2 transition-colors hover:bg-line hover:text-ink">
      {children}
    </button>
  );
}
