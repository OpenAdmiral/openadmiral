import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

/** Layout choices kept across restarts (the app data dir's ui-state.json). */
export type UiState = {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  /** Set while focus mode hides both panels: how they were before. */
  focusRestore?: { leftCollapsed: boolean; rightCollapsed: boolean };
  /** The inspector's blocks: their order (unknown ids go last) and which are folded. Global, not per agent. */
  blockOrder?: string[];
  blockCollapsed?: Record<string, boolean>;
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
    // Focus mode hides both; leaving it puts each panel back as it was.
    toggleFocus: () =>
      update((s) =>
        s.focusRestore
          ? { ...s.focusRestore, focusRestore: undefined }
          : { leftCollapsed: true, rightCollapsed: true, focusRestore: { leftCollapsed: s.leftCollapsed, rightCollapsed: s.rightCollapsed } },
      ),
  };
}
