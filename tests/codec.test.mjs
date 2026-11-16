// A–C of the suite: loading, field I/O, and the checksum-safety rules v0.4 shipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FORMATS, defsFor, layoutSize, num, fieldSize, field, emptyField, slotCount, open, emptyBytes, filledBytes, badBytes, slotChecksum, stored, writePreset, isImage } from "./helpers.mjs";

const everyValid = (save) => save.defs.layout.checksums.every((cs) => [...Array(save.scopeCount(cs.scope)).keys()].every((n) => save.checksumValid(cs, n) === true));

for (const id of FORMATS) {
  const d = defsFor(id), [cs, ci] = slotChecksum(d);
  const F = (key) => field(d, key);

  test(`${id} A1: generated saves have the layout's size and every checksum valid`, () => {
    assert.equal(layoutSize(d), num(d.layout.fileSize));
    assert.ok(everyValid(open(d, emptyBytes(d))), "empty");
    assert.ok(everyValid(open(d, filledBytes(d))), "filled");
    const empty = open(d, emptyBytes(d));
    for (let n = 0; n < slotCount(d); n++) assert.equal(empty.read(emptyField(d), n), true);
  });

  test(`${id} A2: untouched fields still read their loaded value after edits elsewhere`, () => {
    const s = open(d, filledBytes(d));
    s.write(F("general.rupees"), 0, 4321);
    for (const key of ["general.playerName", "general.playTime", "general.heroMode"]) assert.deepEqual(s.read(F(key), 0), s.readOriginal(F(key), 0), key);
    for (const key of ["general.rupees", "general.playerName", "general.playTime"]) assert.deepEqual(s.read(F(key), 1), s.readOriginal(F(key), 1), `file 2 ${key}`);
    assert.notEqual(s.read(F("general.rupees"), 0), s.readOriginal(F("general.rupees"), 0));
  });

  // A flag and its neighbour in the same 16-bit word, found in the table rather than hardcoded.
  const flags = [...d.fieldsById.values()].filter((f) => f.key?.startsWith("storytable.") && f.type === "flag" && !f.invalid);
  const flagA = flags.find((f) => flags.some((g) => g !== f && num(g.offset) === num(f.offset)));
  const flagB = flags.find((g) => g !== flagA && num(g.offset) === num(flagA.offset));
  const samples = [
    ["general.rupees", 777], ["general.playerName", "Zelda"], ["general.playTime", 7384], ["general.gratitudeCrystals", 37], [flagA.key, null],
  ];

  test(`${id} B1–B3: writes read back, stay inside the field, and a no-op write changes nothing`, () => {
    for (const [key, value] of samples) {
      const s = open(d, filledBytes(d)), f = F(key), n = 1;
      const v = value ?? !s.read(f, n);
      const before = s.bytes.slice();
      s.write(f, n, s.read(f, n));
      assert.deepEqual(s.bytes, before, `${key}: no-op write`);
      s.write(f, n, v);
      // A play time keeps the sub-second ticks the file already had, so only whole seconds are compared.
      assert.deepEqual(f.type === "duration" ? Math.floor(s.read(f, n)) : s.read(f, n), v, `${key}: reads back`);
      const at = s.absOffset(f, n), size = fieldSize(f);
      for (let i = 0; i < s.bytes.length; i++) if ((i < at || i >= at + size) && s.bytes[i] !== before[i]) assert.fail(`${key}: byte ${i} outside the field changed`);
      assert.notDeepEqual(s.bytes.subarray(at, at + size), before.subarray(at, at + size), `${key}: the field itself changed`);
    }
  });

  test(`${id} B4: setting one flag leaves its neighbour in the same word alone`, () => {
    const s = open(d, filledBytes(d)), at = s.absOffset(flagA, 0);
    const word = () => [...s.bytes.subarray(at, at + 2)].join(","), start = word();
    const a = s.read(flagA, 0), b = s.read(flagB, 0);
    s.write(flagA, 0, !a);
    assert.equal(s.read(flagB, 0), b);
    assert.notEqual(word(), start);
    s.write(flagA, 0, a);
    assert.equal(word(), start);
  });

  test(`${id} C1–C3: a file that was bad on load is never re-signed silently`, () => {
    const s = open(d, badBytes(d, [1]));
    assert.equal(s.checksumValid(cs, 1), false);
    assert.equal(s.checksumValid(cs, 0), true);
    assert.equal(s.resignWithheld(ci, 1), true);
    const was = stored(s, 1);
    s.updateChecksums();                                  // C3: untouched
    assert.equal(stored(s, 1), was);
    s.write(F("general.rupees"), 1, 5);
    s.updateChecksums();                                  // C1: edited, saved
    assert.equal(stored(s, 1), was);
    s.updateChecksums({ all: true });                     // C2: "Recompute all"
    assert.equal(stored(s, 1), was);
    assert.equal(s.checksumValid(cs, 1), false);
    s.write(F("general.rupees"), 0, 6);                   // the healthy file beside it is signed as usual
    s.updateChecksums();
    assert.equal(s.checksumValid(cs, 0), true);
  });

  test(`${id} C4: the deliberate re-sign recomputes exactly the files it is given`, () => {
    const s = open(d, badBytes(d, [0, 1]));
    const held = [[ci, 1, "File 2"]];                      // the shape app.js's re-sign handler passes
    for (const [i, n] of held) s.allowResign(i, n);
    const fixed = s.updateChecksums({ only: held });
    assert.equal(fixed.length, 1);
    assert.equal(s.checksumValid(cs, 1), true);
    assert.equal(s.resignWithheld(ci, 1), false);
    assert.equal(s.checksumValid(cs, 0), false);
    assert.equal(s.resignWithheld(ci, 0), true);
    s.write(F("general.rupees"), 1, 9);                    // from then on it is signed like any other
    s.updateChecksums();
    assert.equal(s.checksumValid(cs, 1), true);
  });

  test(`${id} C5–C6: a file replaced whole is signed normally; reverting restores the hold`, () => {
    const cleared = open(d, badBytes(d, [1]));
    cleared.clearScope("slot", 1, { force: true });
    cleared.write(emptyField(d), 1, true);
    assert.equal(cleared.resignWithheld(ci, 1), false);
    cleared.updateChecksums();
    assert.equal(cleared.checksumValid(cs, 1), true, "clearScope");
    cleared.revertScope("slot", 1);                        // C6
    assert.equal(cleared.resignWithheld(ci, 1), true);
    assert.equal(cleared.checksumValid(cs, 1), false);

    const copied = open(d, badBytes(d, [1]));
    copied.copyScope("slot", 0, 1);
    assert.equal(copied.resignWithheld(ci, 1), false);
    copied.updateChecksums();
    assert.equal(copied.checksumValid(cs, 1), true, "copyScope");

    const image = d.presets.find(isImage);
    if (image) {
      const s = open(d, badBytes(d, [1]));
      writePreset(d, s, image, 0);
      assert.equal(s.resignWithheld(ci, 1), false);
      s.updateChecksums();
      assert.equal(s.checksumValid(cs, 1), true, "image preset");
    }
  });

  if (d.layout.scopes.slotExtra) test(`${id} C7: a flipped byte in the extra block is caught by the chained checksum`, () => {
    const s = open(d, badBytes(d, [2], { inExtra: true }));
    assert.equal(s.checksumValid(cs, 2), false);
    assert.equal(s.checksumValid(cs, 1), true);
    const was = stored(s, 2);
    s.write(F("general.rupees"), 2, 5);
    s.updateChecksums();
    assert.equal(stored(s, 2), was);
    s.allowResign(ci, 2);
    s.updateChecksums({ only: [[ci, 2, "File 3"]] });
    assert.equal(s.checksumValid(cs, 2), true);
  });
}
