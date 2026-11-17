// skip.dat: on Wii it is the save's cutscene block plus trailer, byte for byte; the editor reads it in and writes it
// back. HD's skip.dat isn't mapped, so the editor neither reads nor writes it there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defsFor, num, field, open, emptyBytes, filledBytes, badBytes } from "./helpers.mjs";
import { skipSidecar, skipDatBytes, skipDatProblems, readSkipDat, skipDatChanged } from "../js/skipdat.js";

const wii = defsFor("wii"), hd = defsFor("hd");

test("wii skip.dat is the cutscene block and trailer: 0xFB60-0xFBE0, three signed chunks", () => {
  const sc = skipSidecar(wii);
  assert.equal(num(sc.start), num(wii.layout.scopes.skip.base));
  assert.equal(num(sc.length), 3 * 0x24 + 0x14);
  assert.equal(num(sc.start) + num(sc.length), num(wii.layout.fileSize), "it runs to the end of the save");
  const s = open(wii, filledBytes(wii)), out = skipDatBytes(s);
  assert.deepEqual(out, s.bytes.subarray(0xFB60, 0xFBE0));
  assert.deepEqual(skipDatProblems(open(wii, emptyBytes(wii)), out), []);
});

test("hd skip.dat isn't mapped: never read, never written", () => {
  assert.equal(skipSidecar(hd), null);
  const s = open(hd, filledBytes(hd));
  assert.throws(() => skipDatBytes(s));
  assert.equal(skipDatProblems(s, new Uint8Array(160)).length, 1);
  assert.throws(() => readSkipDat(s, new Uint8Array(160)));
  assert.equal(skipDatChanged(s), false);
});

test("wii: a skip.dat of the wrong size, or with a bad chunk checksum, is refused and the save untouched", () => {
  const good = skipDatBytes(open(wii, filledBytes(wii, { seed: 3 })));
  const bad = good.slice(); bad[0x24 + 0x05] ^= 0xff; // file 2's flags, not its CRC
  for (const bytes of [good.subarray(0, 0x7f), new Uint8Array(160), bad]) {
    const s = open(wii, filledBytes(wii)), before = s.bytes.slice();
    assert.ok(skipDatProblems(s, bytes).length > 0);
    assert.throws(() => readSkipDat(s, bytes));
    assert.deepEqual(s.bytes, before);
  }
  assert.match(skipDatProblems(open(wii, emptyBytes(wii)), bad)[0], /file 2/);
});

test("wii: reading skip.dat shows the game's marks, and the save writes them back unchanged", () => {
  const game = open(wii, filledBytes(wii, { seed: 5 }));
  game.write(field(wii, "cutscenes.b0cm10"), 1, true); game.updateChecksums();
  const skip = skipDatBytes(game);
  const s = open(wii, filledBytes(wii));
  assert.equal(skipDatChanged(s), false);
  readSkipDat(s, skip);
  assert.equal(s.read(field(wii, "cutscenes.b0cm10"), 1), true);
  assert.equal(skipDatChanged(s), true);
  s.updateChecksums();
  assert.deepEqual(skipDatBytes(s), skip, "nothing re-signed differently");
  s.write(field(wii, "cutscenes.b03m01"), 0, true); s.updateChecksums();
  const out = skipDatBytes(s), cs = wii.layout.checksums.find((c) => c.scope === "skip");
  assert.deepEqual(skipDatProblems(open(wii, emptyBytes(wii)), out), [], "an edited chunk is written signed");
  const back = open(wii, emptyBytes(wii)); readSkipDat(back, out);
  assert.equal(back.read(field(wii, "cutscenes.b03m01"), 0), true);
  assert.equal(back.checksumValid(cs, 0), true);
});

test("wii: a save whose cutscene chunk was bad on load takes the game's good chunk and signs it", () => {
  const cs = wii.layout.checksums.findIndex((c) => c.scope === "skip");
  const s = open(wii, badBytes(wii, [1], { scope: "skip" }));
  assert.equal(s.resignWithheld(cs, 1), true);
  readSkipDat(s, skipDatBytes(open(wii, filledBytes(wii, { seed: 8 }))));
  assert.equal(s.resignWithheld(cs, 1), false, "the chunk is the game's own record now");
  s.updateChecksums();
  assert.equal(s.checksumValid(wii.layout.checksums[cs], 1), true);
});
