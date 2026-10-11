import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createContext, useContext, useEffect, useState } from "react";

/** Underway: agents keep working with the lid closed (see src-tauri/src/underway.rs). */
export type UnderwaySettings = {
  enabled: boolean;
  onlyWhileWork: boolean;
  batteryFloor: number;
  /** 0: no limit. */
  maxHours: number;
  autoResume: boolean;
  backupSsid: string | null;
  acknowledged: boolean;
  enabledAt: number | null;
};

export type UnderwayCheck = { id: "sleep" | "helper" | "power" | "thermal" | "network" | "backup" | "resume"; level: "ok" | "warn" | "bad"; label: string };

export type UnderwayState = {
  mode: "docked" | "underway" | "standby" | "blocked";
  tone: "ok" | "warn" | "bad" | "neutral";
  pill: string;
  title: string;
  detail: string;
  safe: boolean;
  hold: boolean;
  checks: UnderwayCheck[];
  settings: UnderwaySettings;
  helper: "missing" | "approval" | "ready" | "unavailable" | null;
  helperError: string | null;
  /** The backup network's password is saved in the Keychain (it never reaches the UI). */
  backupPassword: boolean;
  battery: { ac: boolean; percent: number | null; charging: boolean; remainingMin: number | null };
  lidClosed: boolean;
  lowPower: boolean;
  net: { online: boolean; via: string | null; hotspot: boolean; iphoneUsb: boolean; offlineForMs: number | null; backupAttempt: string | null };
  working: number;
  until: number | null;
};

export type UnderwayPatch = Partial<Pick<UnderwaySettings, "enabled" | "onlyWhileWork" | "batteryFloor" | "maxHours" | "autoResume" | "acknowledged">>;

/** The latest state; the backend sends one every few seconds. */
export function useUnderway() {
  const [state, setState] = useState<UnderwayState | null>(null);
  useEffect(() => {
    invoke<UnderwayState | null>("underway_state").then((s) => s && setState(s)).catch(() => {});
    const off = listen<UnderwayState>("openadmiral://underway", (e) => setState(e.payload));
    return () => void off.then((f) => f());
  }, []);
  // Commands answer with the new state at once, ahead of the next tick.
  const apply = (p: Promise<UnderwayState | null>) =>
    p.then((s) => {
      if (s) setState(s);
      return s;
    });
  return {
    state,
    set: (patch: UnderwayPatch) => apply(invoke<UnderwayState | null>("underway_settings", { patch })),
    helper: (action: "install" | "uninstall" | "settings") => apply(invoke<UnderwayState | null>("underway_helper", { action })),
    backup: (ssid: string, password?: string) => apply(invoke<UnderwayState | null>("underway_backup", { ssid, password: password || null })),
    join: () => apply(invoke<UnderwayState | null>("underway_join")),
  };
}

export type Underway = ReturnType<typeof useUnderway>;

export const UnderwayContext = createContext<Underway | null>(null);
export const useUnderwayContext = () => useContext(UnderwayContext);

/** "about 5 h", "about 40 min". */
export function aboutTime(min: number) {
  return min >= 90 ? `about ${Math.round(min / 60)} h` : `about ${min} min`;
}
