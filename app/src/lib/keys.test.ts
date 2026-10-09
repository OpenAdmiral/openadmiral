import { describe, expect, it } from "vitest";
import { optionComposedChar } from "./keys";

const opt = (key: string, code: string, extra: Partial<{ type: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
  optionComposedChar({ type: "keydown", key, code, altKey: true, metaKey: false, ctrlKey: false, ...extra });

describe("⌥ on a Spanish Mac keyboard", () => {
  it("types the symbols ⌥ composes", () => {
    expect(opt("@", "Digit2")).toBe("@");
    expect(opt("#", "Digit3")).toBe("#");
    expect(opt("|", "Digit1")).toBe("|");
    expect(opt("\\", "Backquote")).toBe("\\");
    expect(opt("~", "Semicolon")).toBe("~");
    expect(opt("[", "BracketLeft")).toBe("[");
    expect(opt("]", "BracketRight")).toBe("]");
    expect(opt("{", "Quote")).toBe("{");
    expect(opt("}", "Backslash")).toBe("}");
    expect(opt("€", "KeyE")).toBe("€");
  });

  it("keeps Meta for word moves, arrows, Enter and dead keys", () => {
    expect(opt("∫", "KeyB")).toBeNull(); // ⌥b: word back
    expect(opt("ƒ", "KeyF")).toBeNull(); // ⌥f: word forward
    expect(opt("ß", "KeyS")).toBeNull();
    expect(opt("ArrowLeft", "ArrowLeft")).toBeNull();
    expect(opt("Enter", "Enter")).toBeNull();
    expect(opt("Dead", "KeyN")).toBeNull();
    expect(opt("Dead", "KeyU")).toBeNull();
  });

  it("leaves other chords and events alone", () => {
    expect(opt("@", "Digit2", { altKey: false })).toBeNull();
    expect(opt("@", "Digit2", { metaKey: true })).toBeNull();
    expect(opt("@", "Digit2", { ctrlKey: true })).toBeNull();
    expect(opt("@", "Digit2", { type: "keyup" })).toBeNull();
    expect(opt(" ", "Space")).toBeNull();
  });
});
