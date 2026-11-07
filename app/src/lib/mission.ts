import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/** A safety net, should the end of Mission Control ever go unseen. */
const MAX_MS = 5 * 60_000;

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
    const off = listen<boolean>("openadmiral://mission-control", (e) => set(e.payload !== false));
    const onTip = (e: Event) => (e as CustomEvent).detail === "mission" && set(true);
    window.addEventListener("openadmiral:tip", onTip);
    return () => {
      void off.then((f) => f());
      clearTimeout(timer);
      window.removeEventListener("openadmiral:tip", onTip);
    };
  }, []);
  return on;
}
