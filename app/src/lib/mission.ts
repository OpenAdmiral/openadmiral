import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/** A safety net, should the end of Mission Control ever go unseen. */
const MAX_MS = 5 * 60_000;
/** Events this soon after Mission Control opens are its own (the window losing focus, the pointer). */
const SETTLE_MS = 350;

/**
 * Mission Control or App Exposé is open (src-tauri/src/mission.rs tells when it comes
 * and goes): each agent view shows its name large for exactly that long.
 * Preview: OPENADMIRAL_TIP=mission shows it.
 */
export function useMissionControl() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const set = (v: boolean) => {
      clearTimeout(timer);
      setOn(v);
      if (v) timer = setTimeout(() => setOn(false), MAX_MS);
    };
    let since = 0;
    const off = listen<boolean>("openadmiral://mission-control", (e) => {
      if (e.payload !== false) since = Date.now();
      set(e.payload !== false);
    });
    const onTip = (e: Event) => {
      if ((e as CustomEvent).detail !== "mission") return;
      since = Date.now() + MAX_MS;
      set(true);
    };
    // Picking a window ends Mission Control with an animation the Dock's window outlives:
    // the first sign of the person back here (focus, a click, a key) hides it at once.
    const back = () => Date.now() - since > SETTLE_MS && set(false);
    const events = ["focus", "pointerdown", "keydown"] as const;
    window.addEventListener("openadmiral:tip", onTip);
    for (const e of events) window.addEventListener(e, back, true);
    return () => {
      void off.then((f) => f());
      clearTimeout(timer);
      window.removeEventListener("openadmiral:tip", onTip);
      for (const e of events) window.removeEventListener(e, back, true);
    };
  }, []);
  return on;
}
