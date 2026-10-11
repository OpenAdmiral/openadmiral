// Writes out/latest.json (Tauri updater manifest) and out/releases.json (the
// downloads page's history) for one published release; see publish.yml.
//   node manifests.mjs <dir> <version> <site>
import fs from "node:fs";
import path from "node:path";

const [dir, version, site] = process.argv.slice(2);
const files = fs.readdirSync(dir);
const one = (suffix) => files.find((f) => f.endsWith(suffix));
const dmg = one(".dmg");
const update = one(".app.tar.gz");
const sig = one(".app.tar.gz.sig");
if (!dmg || !update || !sig) throw new Error(`missing files in ${dir}: ${files.join(", ")}`);

const release = JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8"));
// The release template opens with an HTML comment reminding to write the changelog.
const notes = (release.body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
const date = release.publishedAt ?? new Date().toISOString();
const url = (f) => `${site}/downloads/${version}/${f}`;

// One universal build serves both architectures.
const platform = { signature: fs.readFileSync(path.join(dir, sig), "utf8").trim(), url: url(update) };
const latest = { version, notes, pub_date: date, platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform } };
fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(latest, null, 2));

const previous = JSON.parse(fs.readFileSync(path.join(dir, "previous.json"), "utf8"));
const entry = {
  version,
  date,
  notes,
  files: { dmg: url(dmg), update: url(update) },
  size: { dmg: fs.statSync(path.join(dir, dmg)).size },
};
const releases = [entry, ...(previous.releases ?? []).filter((r) => r.version !== version)];
const semver = (v) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
releases.sort((a, b) => {
  const [x, y] = [semver(a.version), semver(b.version)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return (y[i] ?? 0) > (x[i] ?? 0) ? 1 : -1;
  return 0;
});
fs.writeFileSync(path.join(dir, "releases.json"), JSON.stringify({ releases }, null, 2));
console.log(`latest.json → ${version}; releases.json → ${releases.length} versions`);
