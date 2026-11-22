// Extra Wallets (issue #1): a 0-3 counter plus an obtained flag; rupee capacity = largest wallet + 300 per Extra Wallet
// (the decompilation's RupeeCounter::getMax and ExtraWalletCounter). Every preset must fit its own capacity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FORMATS, defsFor, num, field, open, emptyBytes, filledBytes, applyPresetFresh } from "./helpers.mjs";

const WALLETS = [["tycoonWallet", 9000], ["giantWallet", 5000], ["bigWallet", 1000], ["mediumWallet", 500]];
function capacity(s, d, n) {
  const base = WALLETS.find(([k]) => s.read(field(d, `inventory.${k}`), n))?.[1] ?? 300;
  return base + 300 * s.read(field(d, "inventory.extraWallets"), n);
}

for (const id of FORMATS) {
  const d = defsFor(id);

  test(`${id} Extra Wallets: the game's counter 508, 0-3, set and read back in every file`, () => {
    const f = field(d, "inventory.extraWallets"), c = field(d, "itemflags.f508");
    assert.equal(num(f.offset), num(c.offset)); assert.equal(num(f.shift), num(c.shift)); assert.equal(num(f.bits), num(c.bits));
    const flag = field(d, "inventory.extraWalletObtained"), f199 = field(d, "itemflags.f199");
    assert.equal(num(flag.offset), num(f199.offset)); assert.equal(num(flag.mask), num(f199.mask));
    for (const bytes of [emptyBytes(d), filledBytes(d)]) {
      for (let n = 0; n < open(d, bytes).scopeCount("slot"); n++) for (const v of [0, 1, 2, 3, 0]) {
        const s = open(d, bytes.slice()), before = s.bytes.slice(), at = s.absOffset(f, n);
        s.write(f, n, v);
        assert.equal(s.read(f, n), v);
        assert.equal(s.read(c, n), v, "the item-flag view agrees");
        for (let i = 0; i < before.length; i++) if (i < at || i >= at + 2) assert.equal(s.bytes[i], before[i], `byte 0x${i.toString(16)} changed`);
        const le = d.layout.endian === "little", w = (x) => new DataView(x.buffer).getUint16(at, le);
        assert.equal(w(s.bytes) & 0x3fff, w(before) & 0x3fff, "the other 14 bits of the word are kept");
      }
    }
  });

  test(`${id} Extra Wallets: values the game can't hold are refused`, () => {
    const s = open(d, emptyBytes(d)), f = field(d, "inventory.extraWallets");
    assert.deepEqual(s.range(f), { min: 0, max: 3 });
  });

  test(`${id} every preset's rupees fit its wallets, and Extra Wallets come with their obtained flag`, () => {
    for (const p of d.presets) {
      const s = open(d, emptyBytes(d));
      applyPresetFresh(d, s, p, 0);
      const x = s.read(field(d, "inventory.extraWallets"), 0), got = s.read(field(d, "inventory.extraWalletObtained"), 0);
      assert.equal(got, x > 0, `${p.id}: obtained flag and count agree`);
      assert.ok(s.read(field(d, "general.rupees"), 0) <= capacity(s, d, 0), `${p.id}: rupees within capacity ${capacity(s, d, 0)}`);
    }
  });
}
