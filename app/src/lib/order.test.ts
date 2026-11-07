import { describe, expect, it } from "vitest";
import { addSpace, arrangeSpace, flatten, layout, placeAgents, placeFolder, placeNewcomers, prefixName, removeSpace, spaceKey, suggestSpaces, type Group, type SidebarOrder } from "./order";

const agent = (name: string) => ({ id: name, name, project: "x", cwd: "/x", status: "idle", cli: { name } }) as never;
// A folder's group as the sidebar has it: with an agent (a group never shows empty).
const g = (key: string): Group => ({ key, label: key, agents: [agent(`${key}-1`)] });
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

  it("moves single agents into a project, and back with their group", () => {
    const blog: Group = { key: "blog", label: "blog", agents: [agent("a"), agent("b")] };
    let o = addSpace(base({ projects: ["blog"] }), { id: "s", name: "S", color: "#000" });
    o = placeAgents(o, "blog", ["b"], "s");
    const tree = layout([blog], o);
    expect(tree.map((n) => (n.kind === "group" ? n.group.agents.map((a) => a.id) : n.groups.map((g) => [g.slot, g.agents.map((a) => a.id)])))).toEqual([[["s\u0001blog", ["b"]]], ["a"]]);
    // The whole group follows into the project; b needs no placement of its own any more.
    o = placeFolder(o, "blog", "s", undefined, ["a"]);
    expect(o.placed).toEqual({});
    expect(layout([blog], o)).toMatchObject([{ kind: "space", groups: [{ slot: "s\u0001blog" }] }]);
    // One agent out again: placed at the top level.
    o = placeAgents(o, "blog", ["a"], "");
    expect(flatten(layout([blog], o)).map((g) => g.agents.map((a) => a.id))).toEqual([["b"], ["a"]]);
  });

  it("keeps a project's groups in the order arranged by hand", () => {
    let o = addSpace(base(), { id: "s", name: "S", color: "#000" }, ["blog", "docs"]);
    o = placeAgents(o, "applivery-api", ["applivery-api-1"], "s");
    const space = () => layout(groups, o).find((n) => n.kind === "space");
    // Whole groups first, then the one with only an agent here.
    expect(space()).toMatchObject({ groups: [{ key: "blog" }, { key: "docs" }, { key: "applivery-api" }] });
    o = arrangeSpace(o, "s", ["applivery-api", "blog", "docs"]);
    expect(space()).toMatchObject({ groups: [{ key: "applivery-api" }, { key: "blog" }, { key: "docs" }] });
  });
});

describe("a newcomer to a folder whose agents were placed by hand", () => {
  const space = { id: "vv", name: "VentureVoid", color: "blue", members: [] };
  const base: SidebarOrder = { projects: [], agents: {}, spaces: [space], placed: { "/oa\u0000OpenAdmiral App": "vv" } };
  it("joins its siblings' project", () => expect(placeNewcomers(base, "/oa", ["openadmiral"]).placed).toMatchObject({ "/oa\u0000openadmiral": "vv" }));
  it("stays at the top level when its siblings are split up", () => {
    const split = { ...base, placed: { ...base.placed, "/oa\u0000other": "" } };
    expect(placeNewcomers(split, "/oa", ["openadmiral"])).toBe(split);
  });
  it("ignores a project that no longer exists", () => {
    const gone = { ...base, spaces: [] };
    expect(placeNewcomers(gone, "/oa", ["openadmiral"])).toBe(gone);
  });
  it("leaves a whole folder's project to its group", () => {
    const whole = { ...base, spaces: [{ ...space, members: ["/oa"] }] };
    expect(placeNewcomers(whole, "/oa", ["openadmiral"])).toBe(whole);
  });
});
