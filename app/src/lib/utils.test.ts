import { describe, expect, it } from "vitest";
import { projectLabel, setProjectOrder, sharedPrefix } from "./utils";

describe("sharedPrefix", () => {
  it("finds the org- prefix every project shares", () => {
    expect(sharedPrefix(["acme-api", "acme-web", "acme-auth"])).toBe("acme-");
  });
  it("is empty when one project differs, there is only one, or a name is just the prefix", () => {
    expect(sharedPrefix(["acme-api", "tooling"])).toBe("");
    expect(sharedPrefix(["acme-api"])).toBe("");
    expect(sharedPrefix(["acme-api", "acme-"])).toBe("");
  });
});

describe("projectLabel", () => {
  it("drops the shared prefix once the sidebar order is known", () => {
    setProjectOrder(["acme-api", "acme-web"]);
    expect(projectLabel("acme-api")).toBe("api");
    expect(projectLabel("other")).toBe("other");
    setProjectOrder(["acme-api", "tooling"]);
    expect(projectLabel("acme-api")).toBe("acme-api");
  });
});
