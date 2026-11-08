/**
 * Links in a terminal, including the long ones Claude Code wraps over several lines:
 * it breaks them with a real line break and indents the rest, so the terminal sees each
 * piece as text of its own. `findLinks` joins the pieces back.
 */

/** Characters a URL can hold (RFC 3986 and the % escapes), minus what closes markdown. */
const URL_CHAR = /[A-Za-z0-9\-._~:/?#\[\]@!$&'*+,;=%]/;
const START = /https?:\/\/|claude\.ai\/|www\./g;

/** A link and where it sits: each piece is a row and a column span (end exclusive). */
export type FoundLink = { url: string; pieces: { row: number; start: number; end: number }[] };

/**
 * The links in `rows` (the visible text, one string per row). A URL that runs to the end
 * of its row's text continues on the next row when that row, after its indentation,
 * starts with URL characters and no space: how Claude Code wraps them.
 */
export function findLinks(rows: string[]): FoundLink[] {
  const out: FoundLink[] = [];
  // Rows already used as a continuation are not scanned again from their start.
  const consumed = new Map<number, number>();
  for (let r = 0; r < rows.length; r++) {
    const line = rows[r];
    START.lastIndex = consumed.get(r) ?? 0;
    let m: RegExpExecArray | null;
    while ((m = START.exec(line))) {
      const start = m.index;
      let end = start;
      while (end < line.length && URL_CHAR.test(line[end])) end++;
      const pieces = [{ row: r, start, end }];
      let url = line.slice(start, end);
      // Runs to the end of the row's text: look for the rest on the next rows.
      let row = r;
      while (end === line.trimEnd().length && row + 1 < rows.length) {
        const next = rows[row + 1];
        const indent = next.length - next.trimStart().length;
        let e = indent;
        while (e < next.length && URL_CHAR.test(next[e])) e++;
        if (e === indent) break;
        // A continuation is URL-ish all the way to its first space, and the URL so far
        // does not already end like a sentence.
        if (/[.,;:!?]$/.test(url) && !/[?&=/#%-]$/.test(url)) break;
        url += next.slice(indent, e);
        pieces.push({ row: row + 1, start: indent, end: e });
        consumed.set(row + 1, e);
        row++;
        if (e !== next.trimEnd().length) break;
      }
      url = tidy(url);
      if (url.length > 10) out.push({ url: url.startsWith("http") ? url : `https://${url}`, pieces: trimPieces(pieces, url) });
      START.lastIndex = row === r ? end : line.length;
    }
  }
  return out;
}

/** Drops what trails a URL in prose or markdown: a closing ) or ], a full stop, a comma. */
function tidy(url: string) {
  let u = url;
  for (;;) {
    const opens = (c: string) => u.split(c).length - 1;
    if (/[.,;:!?'*]$/.test(u)) u = u.slice(0, -1);
    else if (u.endsWith(")") && opens("(") < opens(")")) u = u.slice(0, -1);
    else if (u.endsWith("]") && opens("[") < opens("]")) u = u.slice(0, -1);
    else return u;
  }
}

/** The last piece loses what `tidy` dropped. */
function trimPieces(pieces: FoundLink["pieces"], url: string) {
  let extra = pieces.reduce((n, p) => n + (p.end - p.start), 0) - url.length;
  const out = pieces.map((p) => ({ ...p }));
  for (let i = out.length - 1; i >= 0 && extra > 0; i--) {
    const cut = Math.min(extra, out[i].end - out[i].start);
    out[i].end -= cut;
    extra -= cut;
  }
  return out.filter((p) => p.end > p.start);
}
