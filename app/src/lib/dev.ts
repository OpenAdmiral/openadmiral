import { invoke } from "@tauri-apps/api/core";

/** Set when the app runs as a preview instance (OPENADMIRAL_PREVIEW=1): read-only, for screenshots. */
export type DevEnv = { preview: boolean; select?: string; tab?: string; debugMenu?: string; view?: string; rail?: boolean; inspectorHidden?: boolean; attach?: boolean; probe?: boolean; tip?: string; shot?: boolean; sort?: string };

export const devEnv: Promise<DevEnv> = invoke<DevEnv>("dev_env").catch(() => ({ preview: false }));
