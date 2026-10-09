/** What the native pasteboard holds (src-tauri/src/clipboard.js). */
export type ClipboardKind = { kind: "files"; paths: string[] } | { kind: "image" } | { kind: "text" } | { kind: "empty" };

/**
 * A path as Terminal.app types it when a file is pasted or dropped: shell
 * metacharacters and spaces escaped with a backslash. Claude Code recognises
 * these and attaches images ("[Image: source: …]").
 */
export const shellEscape = (path: string) => path.replace(/([\s!"#$&'()*,;<>?[\\\]^`{|}~])/g, "\\$1");

/** Paths pasted or dropped: escaped, space-separated, with a trailing space to keep typing. */
export const pathsText = (paths: string[]) => (paths.length ? `${paths.map(shellEscape).join(" ")} ` : "");

/** Ctrl+V: Claude Code then reads an image from the clipboard itself, as in other terminals. */
export const CTRL_V = "\x16";

/** What a paste into an agent terminal sends to its pty, given the pasteboard. */
export function pasteAction(clip: ClipboardKind, text: string): { type: "text"; data: string } | { type: "raw"; data: string } | null {
  switch (clip.kind) {
    case "files":
      return { type: "text", data: pathsText(clip.paths) };
    case "image":
      return { type: "raw", data: CTRL_V };
    case "text":
      return text ? { type: "text", data: text } : null;
    default:
      return null;
  }
}
