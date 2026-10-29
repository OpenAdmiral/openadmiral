import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { clampScale, type SplitState } from "./split";

/** Layout choices kept across restarts (the app data dir's ui-state.json). */
export type UiState = {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  /** Set while focus mode hides both panels: how they were before. */
  focusRestore?: { leftCollapsed: boolean; rightCollapsed: boolean };
  /** The inspector's blocks: their order (unknown ids go last) and which are folded. Global, not per agent. */
  blockOrder?: string[];
  blockCollapsed?: Record<string, boolean>;
  /** The chat area split into panes, each showing an agent (see lib/split.ts). */
  split?: SplitState;
  /** Text size of the terminal, conversation and artifacts: 1 is the default. */
  textScale?: number;
  /** Split panes in compact mode: one header line each, tabs as icons. */
  densePanes?: boolean;
};

const DEFAULTS: UiState = { leftCollapsed: false, rightCollapsed: false };

export function useUiState() {
  const [state, setState] = useState<UiState>(DEFAULTS);
  // A change made before the saved state arrives wins over it.
  const touched = useRef(false);

  useEffect(() => {
    invoke<Partial<UiState> | null>("ui_state_load")
      .then((s) => !touched.current && setState({ ...DEFAULTS, ...(s ?? {}) }))
      .catch(() => {});
  }, []);

  const update = useCallback((patch: (s: UiState) => Partial<UiState>) => {
    touched.current = true;
    setState((s) => {
      const next = { ...s, ...patch(s) };
      invoke("ui_state_save", { state: next }).catch(() => {});
      return next;
    });
  }, []);

  return {
    ...state,
    focused: !!state.focusRestore,
    toggleLeft: () => update((s) => ({ leftCollapsed: !s.leftCollapsed, focusRestore: undefined })),
    toggleRight: () => update((s) => ({ rightCollapsed: !s.rightCollapsed, focusRestore: undefined })),
    setBlockCollapsed: (id: string, collapsed: boolean) => update((s) => ({ blockCollapsed: { ...s.blockCollapsed, [id]: collapsed } })),
    setBlockOrder: (blockOrder: string[]) => update(() => ({ blockOrder })),
    resetLayout: () => update(() => ({ blockOrder: undefined, blockCollapsed: undefined })),
    toggleDensePanes: () => update((s) => ({ densePanes: !s.densePanes })),
    setSplit: (f: (s: SplitState | undefined) => SplitState) => update((s) => ({ split: f(s.split) })),
    /** A step bigger (1), smaller (-1), or back to the default (0). */
    stepText: (dir: 1 | -1 | 0) => update((s) => ({ textScale: dir === 0 ? 1 : clampScale((s.textScale ?? 1) + dir * 0.1) })),
    // Focus mode hides both; leaving it puts each panel back as it was.
    toggleFocus: () =>
      update((s) =>
        s.focusRestore
          ? { ...s.focusRestore, focusRestore: undefined }
          : { leftCollapsed: true, rightCollapsed: true, focusRestore: { leftCollapsed: s.leftCollapsed, rightCollapsed: s.rightCollapsed } },
      ),
  };
}
