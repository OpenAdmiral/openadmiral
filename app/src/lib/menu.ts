import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Native context menus. The menu is built and shown by the backend; a click comes
 * back as `openadmiral://menu` with the item's id. Actions are held here, strongly,
 * until the next menu opens, so a click delivered after `popup` returned still
 * finds its action.
 */
export type MenuEntry = { id: string; text: string; enabled?: boolean; accelerator?: string; action: () => unknown } | { separator: true };

const actions = new Map<string, () => unknown>();
let onError: (message: string) => void = (m) => console.error(m);
/** Set by the preview's menu check, to trace each step on stderr. */
export let debugTrace = false;
export const enableTrace = () => {
  debugTrace = true;
};

export function setMenuErrorHandler(fn: (message: string) => void) {
  onError = fn;
}

export const trace = (message: string) => invoke("frontend_log", { level: "trace", message }).catch(() => {});

listen<string>("openadmiral://menu", async (e) => {
  const action = actions.get(e.payload);
  if (debugTrace) trace(`menu event ${e.payload} → ${action ? "action" : "no action"}`);
  if (!action) return onError(`Menu item “${e.payload}” has no action.`);
  try {
    await action();
  } catch (err) {
    console.error(err);
    onError(`That action failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

/** Makes these entries the live ones (also used to fire an item without showing the menu). */
export function registerMenu(entries: MenuEntry[]) {
  actions.clear();
  for (const e of entries) if (!("separator" in e)) actions.set(e.id, e.action);
}

export async function popupMenu(entries: MenuEntry[]) {
  registerMenu(entries);
  const items = entries.map((e) => ("separator" in e ? { separator: true } : { id: e.id, text: e.text, enabled: e.enabled ?? true, accelerator: e.accelerator }));
  await invoke("popup_menu", { items }).catch((err) => onError(`Could not open the menu: ${String(err)}`));
}

/** Debug builds and previews: fires an item through the same handler a click reaches. */
export const fireMenuItem = (id: string) => invoke("debug_menu_event", { id });
