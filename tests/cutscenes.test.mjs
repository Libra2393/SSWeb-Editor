// The per-file cutscene block: the same 16 words in both formats, a CRC32 per chunk on Wii, and the chunk moving with
// its file under Clear file, Copy to, presets and Revert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FORMATS, defsFor, num, field, emptyField, open, emptyBytes, filledBytes, badBytes } from "./helpers.mjs";

for (const id of FORMATS) {
  const d = defsFor(id), le = d.layout.endian === "little";
  const ci = d.layout.checksums.findIndex((c) => c.scope === "skip");

  test(`${id} cutscene bits sit at the same word and bit, in the format's byte order`, () => {
    // b0cm10 = word 6 bit 4; b03m01 = word 1 bit 8 (ids keep the HD byte/mask they were first found as).
    for (const [key, word, bit] of [["b0cm10", 6, 4], ["b03m01", 1, 8], ["b02m40", 1, 6]]) {
      const s = open(d, emptyBytes(d)), base = s.scopeBase("skip", 1);
      s.write(field(d, `cutscenes.${key}`), 1, true);
      const set = []; for (let i = 0; i < 0x20; i++) if (s.bytes[base + i]) set.push([i, s.bytes[base + i]]);
      const byte = 2 * word + (le ? bit >> 3 : 1 - (bit >> 3));
      assert.deepEqual(set, [[byte, 1 << (bit & 7)]], key);
      assert.equal(new DataView(s.bytes.buffer).getUint16(base + 2 * word, le), 1 << bit, key);
    }
  });

  if (ci < 0) continue; // HD keeps no checksum for the block

  test(`${id} every cutscene chunk carries a CRC32, empty files included`, () => {
    const cs = d.layout.checksums[ci];
    for (const bytes of [emptyBytes(d), filledBytes(d)]) {
      const s = open(d, bytes);
      for (let n = 0; n < s.scopeCount("skip"); n++) assert.equal(s.checksumValid(cs, n), true, `file ${n + 1}`);
    }
    assert.equal(num(cs.length), 0x20);
  });

  test(`${id} a cutscene chunk that was bad on load is held like a bad file, and goes with its file`, () => {
    const cs = d.layout.checksums[ci], slotCs = d.layout.checksums.findIndex((c) => c.scope === "slot");
    const s = open(d, badBytes(d, [1], { scope: "skip" }));
    assert.equal(s.checksumValid(cs, 1), false);
    assert.equal(s.checksumValid(d.layout.checksums[slotCs], 1), true, "the slot itself is fine");
    assert.equal(s.resignWithheld(ci, 1), true);
    s.write(field(d, "cutscenes.b0cm10"), 1, true);
    s.updateChecksums({ all: true });
    assert.equal(s.checksumValid(cs, 1), false, "not re-signed silently");

    const cleared = open(d, badBytes(d, [1], { scope: "skip" }));
    cleared.clearScope("slot", 1, { force: true });
    cleared.write(emptyField(d), 1, true);
    const b = cleared.scopeBase("skip", 1);
    assert.ok(cleared.bytes.subarray(b, b + 0x20).every((x) => x === 0), "Clear file wipes the chunk, as the game does");
    cleared.updateChecksums();
    assert.equal(cleared.checksumValid(cs, 1), true, "and signs it");
    cleared.revertScope("slot", 1);
    assert.equal(cleared.resignWithheld(ci, 1), true, "Revert brings the hold back");

    const copied = open(d, badBytes(d, [1], { scope: "skip" }));
    copied.copyScope("slot", 0, 1);
    copied.updateChecksums();
    assert.equal(copied.checksumValid(cs, 1), true, "Copy to carries a good chunk over");
    assert.deepEqual(copied.bytes.subarray(copied.scopeBase("skip", 1), copied.scopeBase("skip", 1) + 0x24), copied.bytes.subarray(copied.scopeBase("skip", 0), copied.scopeBase("skip", 0) + 0x24));

    const resign = open(d, badBytes(d, [1], { scope: "skip" }));
    resign.allowResign(ci, 1);
    resign.updateChecksums({ only: [[ci, 1, "File 2 cutscenes seen"]] });
    assert.equal(resign.checksumValid(cs, 1), true, "the deliberate re-sign covers the chunk");
  });
}
