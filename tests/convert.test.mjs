// Importing a file from another save, across the Wii and HD formats (docs/conversion-plan.md, "Tests").
import { test } from "node:test";
import assert from "node:assert/strict";
import { defsFor, num, field, fieldSize, open, filledBytes, emptyBytes, badBytes } from "./helpers.mjs";
import { leafFields } from "../js/defs.js";
import { importFile, importProblems, songOfTheHeroRisk } from "../js/convert.js";

const wii = defsFor("wii"), hd = defsFor("hd");
const WHEN = "2024-05-06T07:08:09";

/** A filled save whose files have a realistic saved-at time (the seeded fill makes it nonsense otherwise). */
function source(d, opts) {
  const s = open(d, filledBytes(d, opts));
  for (let n = 0; n < s.scopeCount("slot"); n++) {
    const f = field(d, "general.saveTime"), at = s.absOffset(f, n);
    s.bytes.fill(0, at, at + 8);
    s.write(f, n, WHEN);
  }
  s.updateChecksums();
  return open(d, s.bytes);
}

/** Byte ranges [start, end) of file n: its slot and its companion scopes. */
const fileRanges = (s, n) => s.withCompanions("slot").map((sc) => [s.scopeBase(sc, n), s.scopeBase(sc, n) + num(s.scope(sc).size)]);
const inRanges = (i, ranges) => ranges.some(([a, b]) => i >= a && i < b);

/** Fields both formats can use in the slot and the cutscene chunk, keyed by their full id. */
function sharedFields() {
  const out = [];
  for (const [key, f] of wii.fieldsById) {
    const g = hd.fieldsById.get(key);
    if (!f.invalid && g && !g.invalid && f.type !== "row" && (f.scope === "slot" || f.scope === "skip")) out.push([key, f, g]);
  }
  return out;
}

for (const d of [wii, hd]) {
  test(`${d.format.id} every slot and cutscene field agrees with the type map`, () => {
    const bad = [];
    for (const f of leafFields(d)) {
      const units = d.layout.scopes[f.scope]?.units;
      if (f.scope !== "slot" && f.scope !== "skip") continue;
      assert.ok(units, `${f.scope} has a type map`);
      const off = num(f.offset), size = fieldSize(f);
      const unit = units.find(([s, e]) => off >= num(s) && off < num(e));
      if (!unit) { bad.push(`${f.id}: outside the map`); continue; }
      const [s, e, w] = unit.map(num);
      const want = f.type === "string" ? (f.encoding?.startsWith("utf16") ? 2 : 1) : size; // a string is a run of characters
      if (off + size > e) bad.push(`${f.id}: runs past ${e.toString(16)}`);
      else if (want !== w) bad.push(`${f.id}: ${want}-byte value in a ${w}-byte range`);
      else if ((off - s) % w) bad.push(`${f.id}: not aligned to ${w}`);
    }
    assert.deepEqual(bad, []);
  });
}

for (const [from, to] of [[wii, hd], [hd, wii]]) {
  const name = `${from.format.id} → ${to.format.id}`;

  test(`${name}: an imported file reads the same, and nothing else changes`, () => {
    const src = source(from), target = open(to, filledBytes(to, { seed: 7 })), before = target.bytes.slice();
    importFile(target, src, 1, 2);
    for (const [key, f, g] of sharedFields()) {
      if (key === "general.saveTime") continue;
      const a = src.read(f, 1), b = target.read(g, 2);
      assert.ok(Object.is(a, b) || a === b, `${key}: ${a} became ${b}`);
    }
    assert.equal(target.read(field(to, "general.saveTime"), 2), WHEN, "same wall-clock second");
    const mine = fileRanges(target, 2);
    for (let i = 0; i < before.length; i++) if (!inRanges(i, mine)) assert.equal(target.bytes[i], before[i], `byte 0x${i.toString(16)} outside the file changed`);
    if (to === hd) {
      const x = target.scopeBase("slotExtra", 2), y = target.scopeBase("slotExtra2", 2);
      assert.ok(target.bytes.subarray(x, x + 0x2238).every((v) => v === 0), "extra block zero");
      for (let i = 0; i < 0x118; i++) {
        const kept = i < 0x10 || (i >= 0x54 && i < 0x64);
        assert.equal(target.bytes[y + i], kept ? before[y + i] : 0, `second block byte 0x${i.toString(16)}: ${kept ? "the target's ID is kept" : "zero"}`);
      }
    }
    target.updateChecksums();
    target.defs.layout.checksums.forEach((cs) => {
      for (let n = 0; n < target.scopeCount(cs.scope); n++) assert.equal(target.checksumValid(cs, n), true, `${cs.scope} ${n + 1}`);
    });
  });

  test(`${name} → back: slot and cutscene bytes come back identical`, () => {
    const src = source(from);
    const mid = open(to, emptyBytes(to));
    importFile(mid, src, 0, 1); mid.updateChecksums();
    const back = open(from, emptyBytes(from));
    importFile(back, open(to, mid.bytes), 1, 2);
    for (const sc of ["slot", "skip"]) {
      const len = sc === "slot" ? 0x53BC : 0x20, a = src.scopeBase(sc, 0), b = back.scopeBase(sc, 2);
      assert.deepEqual(back.bytes.subarray(b, b + len), src.bytes.subarray(a, a + len), sc);
    }
  });
}

for (const d of [wii, hd]) {
  const other = d === wii ? hd : wii;

  test(`${d.format.id}: a source file with a bad checksum, or an empty one, is refused and the target is untouched`, () => {
    const cases = [[open(d, badBytes(d, [1])), 1], [open(d, emptyBytes(d)), 0]];
    if (d === wii) cases.push([open(d, badBytes(d, [1], { scope: "skip" })), 1]);
    if (d === hd) cases.push([open(d, badBytes(d, [1], { inExtra: true })), 1]);
    for (const [src, n] of cases) {
      assert.ok(importProblems(src, n).length > 0);
      for (const t of [d, other]) {
        const target = open(t, filledBytes(t)), before = target.bytes.slice();
        assert.throws(() => importFile(target, src, n, 0));
        assert.deepEqual(target.bytes, before);
      }
    }
  });

  test(`${d.format.id}: import onto a file that was bad on load ends signed; Revert brings the hold back`, () => {
    for (const s of [d, other]) {
      const target = open(d, badBytes(d, [1])), ci = d.layout.checksums.findIndex((c) => c.scope === "slot");
      assert.equal(target.resignWithheld(ci, 1), true);
      importFile(target, source(s), 0, 1);
      target.updateChecksums();
      assert.equal(target.checksumValid(d.layout.checksums[ci], 1), true);
      target.revertScope("slot", 1);
      assert.equal(target.resignWithheld(ci, 1), true);
    }
  });

  test(`${d.format.id}: same-format import equals Copy to, except that an HD file keeps its own playthrough ID`, () => {
    const src = source(d), target = open(d, filledBytes(d, { seed: 9 })), before = target.bytes.slice();
    const copied = open(d, src.bytes); copied.copyScope("slot", 1, 0);
    importFile(target, src, 1, 0);
    target.updateChecksums(); copied.updateChecksums();
    const keep = (d.layout.scopes.slot.clear?.keep || []).map((k) => [target.scopeBase(k.scope, 0) + num(k.start), num(k.length)]);
    // Stored checksums are compared by validity: on HD the slot's covers the kept ID, so its value differs.
    const sums = d.layout.checksums.map((cs) => [target.scopeBase(cs.scope, 0) + num(cs.store), 4]);
    for (const [a, b] of fileRanges(target, 0)) for (let i = a; i < b; i++) {
      if (sums.some(([at, len]) => i >= at && i < at + len)) continue;
      const kept = keep.some(([at, len]) => i >= at && i < at + len);
      assert.equal(target.bytes[i], kept ? before[i] : copied.bytes[i], `byte 0x${i.toString(16)}`);
    }
    for (const cs of d.layout.checksums) assert.equal(target.checksumValid(cs, 0), true, cs.scope);
  });
}

test("HD → Wii warns about the Song of the Hero only while that quest is open", () => {
  const src = source(hd), asked = field(hd, "story.f08FB_04"), song = field(hd, "inventory.songOfTheHero");
  src.write(asked, 0, true); src.write(song, 0, false);
  assert.equal(songOfTheHeroRisk(src, 0, wii), true);
  assert.equal(songOfTheHeroRisk(src, 0, hd), false, "HD fixed the bug");
  src.write(song, 0, true);
  assert.equal(songOfTheHeroRisk(src, 0, wii), false, "song complete");
  src.write(asked, 0, false); src.write(song, 0, false);
  assert.equal(songOfTheHeroRisk(src, 0, wii), false, "quest not started");
  const w = source(wii); w.write(field(wii, "story.f08FB_04"), 0, true); w.write(field(wii, "inventory.songOfTheHero"), 0, false);
  assert.equal(songOfTheHeroRisk(w, 0, wii), false, "a Wii file was already on Wii");
});
