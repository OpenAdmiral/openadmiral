import { describe, expect, it } from "vitest";
import { addSpace, flatten, layout, placeFolder, prefixName, removeSpace, spaceKey, suggestSpaces, type Group, type SidebarOrder } from "./order";

const g = (key: string): Group => ({ key, label: key, agents: [] });
const base = (o: Partial<SidebarOrder> = {}): SidebarOrder => ({ projects: [], agents: {}, spaces: [], ...o });

describe("projects in the sidebar", () => {
  const groups = ["applivery-api", "applivery-web", "blog", "docs"].map(g);

  it("draws a project where its key is, with its folders in their order", () => {
    const o = addSpace(base({ projects: ["blog", "docs", "applivery-api", "applivery-web"] }), { id: "x", name: "Applivery", color: "#000" }, ["applivery-web", "applivery-api"], "applivery-api");
    const tree = layout(groups, o);
    expect(tree.map((n) => (n.kind === "group" ? n.group.key : n.space.name))).toEqual(["blog", "docs", "Applivery"]);
    expect(flatten(tree).map((x) => x.key)).toEqual(["blog", "docs", "applivery-web", "applivery-api"]);
  });

  it("shows an empty project, first when made without a place", () => {
    const tree = layout(groups, addSpace(base({ projects: ["blog"] }), { id: "x", name: "New", color: "#000" }));
    expect(tree[0]).toMatchObject({ kind: "space", groups: [] });
  });

  it("moves a folder from one project to another, and out", () => {
    let o = addSpace(base(), { id: "a", name: "A", color: "#000" }, ["blog", "docs"]);
    o = addSpace(o, { id: "b", name: "B", color: "#000" });
    o = placeFolder(o, "docs", "b");
    expect(o.spaces!.map((s) => s.members)).toEqual([["blog"], ["docs"]]);
    o = placeFolder(o, "blog", "b", "docs");
    expect(o.spaces!.map((s) => s.members)).toEqual([[], ["blog", "docs"]]);
    o = placeFolder(o, "blog", null, spaceKey("b"));
    expect(o.spaces![1].members).toEqual(["docs"]);
    expect(o.projects.indexOf("blog")).toBe(o.projects.indexOf(spaceKey("b")) - 1);
  });

  it("gives a removed project's folders back to the top level, in its place", () => {
    const o = removeSpace(addSpace(base({ projects: ["blog", "docs"] }), { id: "a", name: "A", color: "#000" }, ["docs"], "docs"), "a");
    expect(o.projects).toEqual(["blog", "docs"]);
    expect(o.spaces).toEqual([]);
  });

  it("suggests a project for folders that share a prefix, until turned down or made", () => {
    const tree = layout(groups, base());
    expect(suggestSpaces(tree, base())).toEqual([{ name: "Applivery", keys: ["applivery-api", "applivery-web"], labels: ["applivery-api", "applivery-web"] }]);
    expect(suggestSpaces(tree, base({ dismissed: ["applivery"] }))).toEqual([]);
    const made = addSpace(base(), { id: "a", name: "Applivery", color: "#000" });
    expect(suggestSpaces(layout(groups, made), made)).toEqual([]);
    expect(prefixName("tmv")).toBe("Tmv");
  });
});
