/**
 * With `macOptionIsMeta`, xterm turns every ⌥ chord into Meta. On layouts where
 * ⌥ composes symbols (Spanish: ⌥2 "@", ⌥3 "#", ⌥1 "|", ⌥º "\\", ⌥ñ "~", ⌥e "€",
 * brackets and braces) that loses the symbol. This picks the chords whose
 * composed character should be typed as is; everything else (⌥←/→, ⌥Enter,
 * ⌥b/⌥f word moves, dead keys) stays Meta.
 */
type KeyLike = { type?: string; key: string; code: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean };

/** Symbols worth typing even when ⌥ composes them on a letter key (⌥e "€" on Spanish). */
const LETTER_KEY_SYMBOLS = new Set(["@", "#", "€", "$", "[", "]", "{", "}", "|", "\\", "~", "^", "`", "¬", "<", ">"]);

export function optionComposedChar(e: KeyLike): string | null {
  if (e.type && e.type !== "keydown") return null;
  if (!e.altKey || e.metaKey || e.ctrlKey) return null;
  // Dead keys (⌥n, ⌥u…) compose with the next key: the normal path handles them.
  if (e.key === "Dead" || [...e.key].length !== 1 || e.key === " ") return null;
  if (e.code.startsWith("Key")) return LETTER_KEY_SYMBOLS.has(e.key) ? e.key : null;
  // Digits and punctuation keys: a composed letter or digit stays Meta, a symbol is typed.
  return /^[\p{L}\p{N}]$/u.test(e.key) ? null : e.key;
}
