import { invoke } from "@tauri-apps/api/core";

/** A repo's scripts and a workspace's port (src-tauri/src/scripts.rs). */
export type RunAction = { id: string; command: string; default: boolean };
export type Scripts = { setup: string | null; run: RunAction[]; archive: string | null; runMode: string | null; previewUrls: [string, string][]; source: string | null };
export type WorkspaceInfo = { scripts: Scripts; port: number; env: [string, string][]; path: string; root: string; worktree: boolean };

export const workspaceInfo = (cwd: string) => invoke<WorkspaceInfo>("workspace_info", { cwd });

/** Conductor's preview URLs: `$((CONDUCTOR_PORT+N))` and `$CONDUCTOR_PORT` filled in. */
export function previewUrl(url: string, port: number) {
  return url
    .replace(/\$\(\(\s*(?:CONDUCTOR|OPENADMIRAL)_PORT\s*\+\s*(\d+)\s*\)\)/g, (_, n) => String(port + Number(n)))
    .replace(/\$\{?(?:CONDUCTOR|OPENADMIRAL)_PORT\}?/g, String(port));
}

/** The pages a workspace offers: its preview URLs, else its first port on localhost. */
export function previews(info: Pick<WorkspaceInfo, "scripts" | "port">): [string, string][] {
  return info.scripts.previewUrls.length ? info.scripts.previewUrls.map(([n, u]) => [n, previewUrl(u, info.port)]) : [["localhost", `http://localhost:${info.port}`]];
}

/** The pty a run action lives in, one per agent and action. */
export const runKey = (agentId: string, action: string) => `run:${agentId}:${action}`;

/** A script through the platform's shell (as scripts.rs runs setup and archive). */
export function shellArgv(script: string, windows = /Windows/.test(navigator.userAgent)) {
  return windows ? ["cmd", "/C", script] : ["/bin/sh", "-lc", script];
}
