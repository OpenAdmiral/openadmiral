import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Opening a link from an agent's output: the first time a site comes up, the person is
 * asked (components/LinkGate.tsx): Open, Open and Trust (that site opens without asking
 * from then on), or Don't Open. Trusted sites are kept in this machine's local storage,
 * shared by every window.
 */
const KEY = "openadmiral.trustedLinkHosts";

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

export function trustedHosts(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function trustHost(host: string) {
  const hosts = new Set(trustedHosts());
  hosts.add(host);
  try {
    localStorage.setItem(KEY, JSON.stringify([...hosts].sort()));
  } catch {
    // Without storage it asks again next time; nothing else changes.
  }
}

/** A site and its subdomains: trusting example.com covers docs.example.com. */
export const isTrusted = (host: string, hosts = trustedHosts()) => hosts.some((h) => host === h || host.endsWith(`.${h}`));

/** Opens it without asking: claude.ai pages in the app's own window, the rest in the browser. */
export function openNow(url: string) {
  if (/^https:\/\/claude\.ai\//.test(url)) void invoke("browser_open", { url }).catch(() => openUrl(url));
  else if (/^https?:\/\//.test(url)) void openUrl(url).catch(() => {});
}

/** Opens a link, asking first unless its site is trusted. */
export function requestOpen(url: string) {
  const host = hostOf(url);
  if (!host) return;
  if (isTrusted(host)) return openNow(url);
  window.dispatchEvent(new CustomEvent("openadmiral:open-link", { detail: url }));
}
