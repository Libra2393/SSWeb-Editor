// E–G of the suite: risk markings, definition integrity, and a smoke test of the offline build.
// baseline.json pins today's load warnings and unusable fields; the suite fails on any NEW one.
// Regenerate with  UPDATE_GOLDEN=1 node --test  after a deliberate change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ROOT, readJson, FORMATS, defsFor, num } from "./helpers.mjs";

const BASELINE = "tests/baseline.json", update = !!process.env.UPDATE_GOLDEN;
const baseline = existsSync(path.join(ROOT, BASELINE)) ? readJson(BASELINE) : {};
const seen = {};
const risks = readJson("defs/risks.json");
const leaves = (d) => [...d.fieldsById.values()].filter((f) => f.type !== "row");

test("E3: every risk entry states a level and a direction", () => {
  const all = [...risks.flags, ...Object.values(risks.fields)];
  assert.ok(risks.flags.length > 0 && Object.keys(risks.fields).length > 0);
  for (const r of all) {
    assert.ok(["lock", "loss"].includes(r.risk), JSON.stringify(r));
    assert.ok(["set", "clear", "both"].includes(r.riskWhen), JSON.stringify(r));
    assert.ok(typeof r.why === "string" && r.why.length > 0, JSON.stringify(r));
  }
});

for (const id of FORMATS) {
  const d = defsFor(id);
  seen[id] = { warnings: [...d.warnings].sort(), invalid: leaves(d).filter((f) => f.invalid).map((f) => f.key).sort() };

  test(`${id} E1: the risk table loads without a warning`, () => {
    assert.deepEqual(d.warnings.filter((w) => /risk/i.test(w)), []);
    for (const key of Object.keys(risks.fields)) assert.ok(d.fieldsById.get(key)?.risk, `${key} is marked`);
  });

  test(`${id} E2: every tab that edits a marked bit carries the same marking`, () => {
    const byBit = new Map();
    for (const f of leaves(d)) {
      if (f.invalid || f.type !== "flag" || f.scope !== "slot") continue;
      const k = `${num(f.offset)}:${num(f.mask)}`;
      if (!byBit.has(k)) byBit.set(k, []);
      byBit.get(k).push(f);
    }
    let shared = 0;
    for (const group of byBit.values()) {
      if (!group.some((f) => f.risk)) continue;
      const [first] = group;
      for (const f of group) assert.deepEqual([f.risk, f.riskWhen], [first.risk, first.riskWhen], `${f.key} disagrees with ${first.key}`);
      if (new Set(group.map((f) => f.key.split(".")[0])).size > 1) shared++;
    }
    assert.ok(shared > 0, "at least one marked bit is shown in more than one tab");
    assert.equal(d.fieldsById.get("general.gratitudeCrystals").risk, "loss");
  });

  test(`${id} F1: loading the definitions raises no new warning`, () => {
    if (update) return;
    assert.deepEqual(seen[id].warnings.filter((w) => !(baseline[id]?.warnings || []).includes(w)), []);
  });

  test(`${id} F2: no field became unusable`, () => {
    assert.ok(leaves(d).length > 1000);
    if (update) return;
    assert.deepEqual(seen[id].invalid.filter((k) => !(baseline[id]?.invalid || []).includes(k)), []);
  });
}

test("baseline file is written when asked", { skip: !update }, () => {
  writeFileSync(path.join(ROOT, BASELINE), JSON.stringify(seen, null, 2) + "\n");
});

const python = spawnSync("python3", ["--version"]).status === 0;
test("G1: the offline build runs and embeds the definitions", { skip: !python && "python3 not available" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ssweb-build-")), out = path.join(dir, "SSWeb-Editor.html");
  try {
    const r = spawnSync("python3", [path.join(ROOT, "tools/build_standalone.py"), "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(out, "utf8");
    assert.ok(html.length > 500_000, "the build is far smaller than expected");
    for (const needle of ["defs/manifest.json", "risks.json", "class SaveFile", "Skyward Sword"]) assert.ok(html.includes(needle), `build lacks ${needle}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
