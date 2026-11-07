import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/** How long the names stay up if nothing hides them first. */
const MAX_MS = 30_000;
/** Pointer moves this soon after the notice are Mission Control's own animation, not the person. */
const SETTLE_MS = 600;

/**
 * Mission Control or App Exposé just opened (src-tauri/src/mission.rs): each agent's
 * name shows large until the person is back (a pointer move, a key, a focus change).
 * Preview: OPENADMIRAL_TIP=mission shows it.
 */
export function useMissionControl() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let since = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      since = Date.now();
      setOn(true);
      clearTimeout(timer);
      timer = setTimeout(() => setOn(false), MAX_MS);
    };
    const hide = () => {
      if (Date.now() - since < SETTLE_MS) return;
      clearTimeout(timer);
      setOn(false);
    };
    const off = listen("openadmiral://mission-control", show);
    const onTip = (e: Event) => (e as CustomEvent).detail === "mission" && show();
    window.addEventListener("openadmiral:tip", onTip);
    window.addEventListener("pointermove", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("focus", hide);
    window.addEventListener("blur", hide);
    return () => {
      void off.then((f) => f());
      clearTimeout(timer);
      window.removeEventListener("openadmiral:tip", onTip);
      window.removeEventListener("pointermove", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("focus", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);
  return on;
}
