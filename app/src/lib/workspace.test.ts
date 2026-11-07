import { describe, expect, it } from "vitest";
import { previewUrl, previews, shellArgv } from "@/lib/workspace";

describe("previewUrl", () => {
  it("works out Conductor's port arithmetic", () => {
    expect(previewUrl("http://localhost:$((CONDUCTOR_PORT+2))/app", 55100)).toBe("http://localhost:55102/app");
    expect(previewUrl("http://localhost:$CONDUCTOR_PORT", 55110)).toBe("http://localhost:55110");
    expect(previewUrl("http://127.0.0.1:${OPENADMIRAL_PORT}", 55120)).toBe("http://127.0.0.1:55120");
  });
});

describe("previews", () => {
  const scripts = { setup: null, run: [], archive: null, runMode: null, source: null };
  it("falls back to the workspace's first port", () => expect(previews({ scripts: { ...scripts, previewUrls: [] }, port: 55100 })).toEqual([["localhost", "http://localhost:55100"]]));
  it("names each preview URL", () =>
    expect(previews({ scripts: { ...scripts, previewUrls: [["App", "http://localhost:$((CONDUCTOR_PORT+1))"]] }, port: 55100 })).toEqual([["App", "http://localhost:55101"]]));
});

describe("shellArgv", () => {
  it("uses the platform's shell", () => {
    expect(shellArgv("pnpm dev", false)).toEqual(["/bin/sh", "-lc", "pnpm dev"]);
    expect(shellArgv("pnpm dev", true)).toEqual(["cmd", "/C", "pnpm dev"]);
  });
});
