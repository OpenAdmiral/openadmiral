import { describe, expect, it } from "vitest";
import { findLinks } from "@/lib/links";

describe("findLinks", () => {
  it("finds a link on one row and drops a closing parenthesis", () => {
    const [l] = findLinks(["  see (https://example.com/a?b=1)."]);
    expect(l.url).toBe("https://example.com/a?b=1");
    expect(l.pieces).toEqual([{ row: 0, start: 7, end: 32 }]);
  });

  it("joins a URL Claude Code wrapped over indented rows", () => {
    const rows = [
      "1. A Isabelle (abrir (https://mail.google.com/mail/?authuser=",
      "   cesar@applivery.com#all?compose=thread-f:18813267859564977",
      "   90%2Bmsg-a:r6472592142666245874)), en inglés y en un hilo",
    ];
    const [l] = findLinks(rows);
    expect(l.url).toBe("https://mail.google.com/mail/?authuser=cesar@applivery.com#all?compose=thread-f:1881326785956497790%2Bmsg-a:r6472592142666245874");
    expect(l.pieces.map((p) => p.row)).toEqual([0, 1, 2]);
    expect(l.pieces[1]).toEqual({ row: 1, start: 3, end: 61 });
    // The continuation row's prose after the URL is not part of it.
    expect(rows[2].slice(l.pieces[2].start, l.pieces[2].end)).toBe("90%2Bmsg-a:r6472592142666245874");
  });

  it("does not join a sentence that ends a row", () => {
    const links = findLinks(["Read https://example.com/docs.", "Then run the tests."]);
    expect(links.map((l) => l.url)).toEqual(["https://example.com/docs"]);
  });

  it("finds several links and bare claude.ai ones", () => {
    const links = findLinks(["a https://x.dev/one and claude.ai/artifact/abc123 b"]);
    expect(links.map((l) => l.url)).toEqual(["https://x.dev/one", "https://claude.ai/artifact/abc123"]);
  });
});
