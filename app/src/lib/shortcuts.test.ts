import { describe, expect, it } from "vitest";
import { matchShortcut, SHORTCUTS } from "./shortcuts";

const key = (over: Partial<KeyboardEvent>) => ({ metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, key: "", code: "", ...over }) as KeyboardEvent;

describe("the shortcuts table", () => {
  it("recognises the chords the app handles", () => {
    expect(matchShortcut(key({ metaKey: true, key: "3", code: "Digit3" }))).toBe("agent-n");
    expect(matchShortcut(key({ metaKey: true, altKey: true, code: "ArrowDown" }))).toBe("agent-next");
    expect(matchShortcut(key({ metaKey: true, altKey: true, shiftKey: true, code: "ArrowUp" }))).toBe("needs-prev");
    expect(matchShortcut(key({ metaKey: true, key: "0", code: "Digit0" }))).toBe("toggle-sidebar");
    expect(matchShortcut(key({ metaKey: true, ctrlKey: true, key: "s", code: "KeyS" }))).toBe("toggle-sidebar");
    expect(matchShortcut(key({ metaKey: true, altKey: true, key: "º", code: "Digit0" }))).toBe("toggle-inspector");
    expect(matchShortcut(key({ metaKey: true, shiftKey: true, key: "F", code: "KeyF" }))).toBe("focus-mode");
    expect(matchShortcut(key({ metaKey: true, shiftKey: true, key: "/", code: "Digit7" }))).toBe("shortcuts");
    expect(matchShortcut(key({ ctrlKey: true, key: "2", code: "Digit2" }))).toBe("tab-conversation");
    expect(matchShortcut(key({ metaKey: true, key: "e", code: "KeyE" }))).toBe("view-agents");
  });

  it("leaves ordinary typing alone", () => {
    expect(matchShortcut(key({ key: "a", code: "KeyA" }))).toBeUndefined();
    expect(matchShortcut(key({ metaKey: true, key: "c", code: "KeyC" }))).toBeUndefined();
    expect(matchShortcut(key({ ctrlKey: true, key: "l", code: "KeyL" }))).toBeUndefined();
  });

  it("gives every shortcut keys and a description", () => {
    for (const s of SHORTCUTS.flatMap((g) => g.items)) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(3);
    }
  });
});
