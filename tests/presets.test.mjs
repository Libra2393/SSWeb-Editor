// D of the suite: presets. They are listed from the loaded definitions at run time; nothing here counts them.
// Written counts are pinned in golden-counts.json. A changed count is a deliberate, reviewed event:
// regenerate with  UPDATE_GOLDEN=1 node --test  and look at the diff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT, readJson, FORMATS, defsFor, num, fieldSize, field, emptyField, slotCount, slotScopes, open, emptyBytes, filledBytes, slotBytes, writePreset, applyPresetFresh, isImage } from "./helpers.mjs";

const GOLDEN = "tests/golden-counts.json", update = !!process.env.UPDATE_GOLDEN;
const golden = existsSync(path.join(ROOT, GOLDEN)) ? readJson(GOLDEN) : {};
const seen = {};

for (const id of FORMATS) {
  const d = defsFor(id), F = (key) => field(d, key);
  const store = num(d.layout.checksums.find((c) => c.scope === "slot").store);
  seen[id] = {};

  test(`${id} D1: every preset applies to an empty save with nothing skipped, and writes its pinned count`, () => {
    assert.ok(d.presets.length > 0);
    for (const p of d.presets) {
      const s = open(d, emptyBytes(d));
      const r = writePreset(d, s, p, 0);
      assert.deepEqual(r.skipped, [], `${p.id}: skipped`);
      assert.ok(r.written > 0, `${p.id}: wrote nothing`);
      seen[id][p.id] = r.written;
      if (!update) assert.equal(r.written, golden[id]?.[p.id], `${p.id}: written count changed (pinned ${golden[id]?.[p.id]}). If intended, run UPDATE_GOLDEN=1 node --test`);
      s.updateChecksums();
      for (const cs of d.layout.checksums) for (let n = 0; n < s.scopeCount(cs.scope); n++) assert.equal(s.checksumValid(cs, n), true, `${p.id}: file ${n + 1} checksum`);
    }
    if (!update) assert.deepEqual(Object.keys(golden[id] || {}).sort(), d.presets.map((p) => p.id).sort(), "golden-counts.json lists exactly the presets that exist");
  });

  const fieldLists = d.presets.filter((p) => !isImage(p));

  test(`${id} D2: a field-list preset gives the same file whatever it replaces`, () => {
    // Masking: what legitimately carries over (name, Hero Mode, HD's kept ranges) is blanked on both sides, and
    // then every byte of the file must match. The name's whole byte range is zeroed, since writing a shorter name
    // leaves the old one's tail in place past the terminator.
    const name = F("general.playerName");
    const level = (s, n) => {
      s.bytes.fill(0, s.absOffset(name, n), s.absOffset(name, n) + fieldSize(name));
      s.write(F("general.heroMode"), n, false);
      for (const k of d.layout.scopes.slot.clear?.keep || []) { const at = s.scopeBase(k.scope, n) + num(k.start); s.bytes.fill(0, at, at + num(k.length)); }
      s.bytes.fill(0, s.scopeBase("slot", n) + store, s.scopeBase("slot", n) + store + 4); // the checksum follows from the rest
      return slotBytes(s, n);
    };
    for (const p of fieldLists) {
      const a = open(d, filledBytes(d, { seed: 11, name: "Aaa", hero: true })), b = open(d, filledBytes(d, { seed: 22, name: "Bbbbbb", hero: false }));
      assert.notDeepEqual(slotBytes(a, 0), slotBytes(b, 0));
      applyPresetFresh(d, a, p, 0); applyPresetFresh(d, b, p, 0);
      assert.ok(level(a, 0).equals(level(b, 0)), `${p.id}: results differ between two starting files`);
      const fresh = open(d, emptyBytes(d)); applyPresetFresh(d, fresh, p, 0);
      assert.ok(level(fresh, 0).equals(level(a, 0)), `${p.id}: a used file ends differently from an empty one`);
    }
  });

  test(`${id} D3: only the name and Hero Mode carry over; an empty file gets Link and Normal Mode`, () => {
    for (const p of fieldLists) {
      const used = open(d, filledBytes(d, { name: "Test", hero: true }));
      const other = slotBytes(used, 1);
      applyPresetFresh(d, used, p, 0);
      assert.equal(used.read(F("general.playerName"), 0), "Test", p.id);
      assert.equal(used.read(F("general.heroMode"), 0), true, p.id);
      assert.equal(used.read(emptyField(d), 0), false, p.id);
      assert.ok(slotBytes(used, 1).equals(other), `${p.id}: touched another file`);
      const empty = open(d, emptyBytes(d));
      applyPresetFresh(d, empty, p, 0);
      if (p.apply.some((e) => e.field === "general.playerName")) assert.equal(empty.read(F("general.playerName"), 0), "Link", p.id);
      assert.equal(empty.read(F("general.heroMode"), 0), false, p.id);
    }
  });

  const images = d.presets.filter(isImage);
  if (images.length) test(`${id} D4: a full-file preset replaces exactly its files, byte for byte`, () => {
    for (const p of images) {
      const targets = [...new Set(p.apply.filter((e) => e.image).map((e) => (e.slot ? e.slot - 1 : 0)))];
      const onEmpty = open(d, emptyBytes(d)), onUsed = open(d, filledBytes(d, { seed: 33 }));
      const before = onUsed.bytes.slice();
      applyPresetFresh(d, onEmpty, p, 0); applyPresetFresh(d, onUsed, p, 0);
      // A file is its slot plus the scopes that travel with it (the cutscene chunk; HD's extra blocks).
      const inTarget = (i) => targets.some((n) => slotScopes(d).some((sc) => { const b = onUsed.scopeBase(sc, n); return i >= b && i < b + num(onUsed.scope(sc).size); }));
      for (const n of targets) {
        const b = onUsed.scopeBase("slot", n);
        assert.deepEqual(onUsed.bytes.subarray(b, b + store), onEmpty.bytes.subarray(b, b + store), `${p.id}: file ${n + 1}`);
        for (const sc of slotScopes(d).slice(1)) {             // the old file's companion data doesn't survive
          const keep = (d.layout.scopes.slot.clear?.keep || []).filter((k) => k.scope === sc);
          const cb = onUsed.scopeBase(sc, n);
          for (let i = 0; i < num(onUsed.scope(sc).size); i++) {
            if (keep.some((k) => i >= num(k.start) && i < num(k.start) + num(k.length))) continue;
            assert.equal(onUsed.bytes[cb + i], 0, `${p.id}: file ${n + 1} ${sc} byte ${i} kept from the old file`);
          }
        }
      }
      for (let i = 0; i < before.length; i++) if (!inTarget(i) && onUsed.bytes[i] !== before[i]) assert.fail(`${p.id}: byte ${i} outside its files changed`);
    }
  });

  test(`${id} D5: writePreset itself never overwrites a name that is already there`, () => {
    const p = fieldLists.find((x) => x.apply.some((e) => e.field === "general.playerName" && e.onlyIfEmpty));
    assert.ok(p, "a preset with an onlyIfEmpty name");
    const s = open(d, filledBytes(d, { name: "Test" }));
    writePreset(d, s, p, 0);
    assert.equal(s.read(F("general.playerName"), 0), "Test");
  });
}

test("golden counts file is written when asked", { skip: !update }, () => {
  writeFileSync(path.join(ROOT, GOLDEN), JSON.stringify(seen, null, 2) + "\n");
});
