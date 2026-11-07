import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

/** A safety net, should the end of Mission Control ever go unseen. */
const MAX_MS = 5 * 60_000;
/** Events this soon after Mission Control opens are its own (the window losing focus, the pointer). */
const SETTLE_MS = 350;

/**
 * Mission Control or App Exposé is open (src-tauri/src/mission.rs tells when it comes and
 * goes): each agent view shows its card for exactly that long. One listener per window,
 * shared by its views. Picking one of our windows (focus, a click, a key) tells the backend,
 * which takes the cards down in every window at once.
 * Preview: OPENADMIRAL_TIP=mission shows it.
 */
let on = false;
let since = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const subscribers = new Set<(v: boolean) => void>();
let started = false;

function set(v: boolean) {
  clearTimeout(timer);
  on = v;
  if (v) timer = setTimeout(() => set(false), MAX_MS);
  for (const s of subscribers) s(v);
}

function start() {
  if (started) return;
  started = true;
  let label = "?";
  try {
    label = getCurrentWindow().label;
  } catch {
    // Outside Tauri (tests): no label.
  }
  void listen<boolean>("openadmiral://mission-control", (e) => {
    const v = e.payload !== false;
    if (v) since = Date.now();
    set(v);
    // Which windows heard it, and whether WebKit counted them hidden (mission.log).
    void invoke("mission_log", { message: `${label} heard ${v} (hidden ${document.hidden}, views ${subscribers.size})` }).catch(() => {});
  });
  window.addEventListener("openadmiral:tip", (e) => {
    if ((e as CustomEvent).detail !== "mission") return;
    since = Date.now() + MAX_MS;
    set(true);
  });
  const back = () => {
    if (!on || Date.now() - since < SETTLE_MS) return;
    set(false);
    void invoke("mission_dismiss").catch(() => {});
  };
  for (const e of ["focus", "pointerdown", "keydown"]) window.addEventListener(e, back, true);
}

export function useMissionControl() {
  const [value, setValue] = useState(on);
  useEffect(() => {
    start();
    subscribers.add(setValue);
    setValue(on);
    return () => void subscribers.delete(setValue);
  }, []);
  return value;
}
