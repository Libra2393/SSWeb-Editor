// Shared plumbing for the test suite: loads the definitions from disk the way the app loads them over HTTP, and
// builds save files in memory. No real save is read, committed or needed; every byte here is generated.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaveFile, num, fieldSize } from "../js/codec.js";
import { loadWith, applyVariants, writePreset, applyPresetFresh } from "../js/defs.js";

export { SaveFile, num, fieldSize, writePreset, applyPresetFresh };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));

const all = await loadWith(async (name) => readJson(path.join("defs", name)));
for (const d of all) applyVariants(d, [d.format.id]);
export const FORMATS = all.map((d) => d.format.id);
export const defsFor = (id) => all.find((d) => d.format.id === id);

/** File size worked out from the layout's scopes (the furthest byte any scope reaches), not a hardcoded count. */
export function layoutSize(d) {
  return Math.max(...Object.values(d.layout.scopes).map((s) => num(s.base) + (s.stride != null ? num(s.stride) * num(s.count ?? 1) : num(s.size))));
}

/** Deterministic byte stream (a fixed-seed LCG), so "random" fill is the same on every run. */
function lcg(seed) {
  let x = (seed >>> 0) || 1;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x >>> 24; };
}

export const field = (d, key) => {
  const f = d.fieldsById.get(key);
  if (!f || f.invalid) throw new Error(`no usable field "${key}" in ${d.format.id}`);
  return f;
};
export const emptyField = (d) => field(d, d.layout.slotSummary.empty);
export const slotCount = (d) => num(d.layout.scopes.slot.count);
/** The slot scope plus the scopes that travel with it (HD's extra blocks and cutscene bits). */
export const slotScopes = (d) => ["slot", ...(d.layout.scopes.slot.companions || [])];

/** A new SaveFile over a copy of `bytes`, as if the file had just been opened. */
export const open = (d, bytes) => new SaveFile(bytes.slice().buffer, d);

function blank(d) {
  const bytes = new Uint8Array(layoutSize(d));
  const m = d.layout.magic;
  if (m) bytes.set([...Object.keys(m.values)[0]].map((c) => c.charCodeAt(0)), num(m.offset));
  return bytes;
}

/** Signs every checksum. A generated file starts unsigned, which the codec would rightly refuse to re-sign silently. */
function sign(save) {
  save.defs.layout.checksums.forEach((cs, i) => { for (let n = 0; n < save.scopeCount(cs.scope); n++) save.allowResign(i, n); });
  save.updateChecksums({ all: true });
  save.markSaved();
}

/** Every file empty, the way the game leaves an unused file. Returns the signed bytes. */
export function emptyBytes(d) {
  const save = new SaveFile(blank(d).buffer, d);
  for (let n = 0; n < slotCount(d); n++) { save.clearScope("slot", n, { force: true }); save.write(emptyField(d), n, true); }
  sign(save);
  return save.bytes.slice();
}

/**
 * Every file in use: slot bytes filled with a seeded pattern, then a small scenario written through the public
 * API. `name` and `hero` apply to every file; play time and rupees differ per file. Returns the signed bytes.
 */
export function filledBytes(d, { seed = 1, name = "Tester", hero = false } = {}) {
  const bytes = blank(d), next = lcg(seed);
  for (const sc of slotScopes(d)) {
    const s = d.layout.scopes[sc];
    for (let n = 0; n < num(s.count ?? 1); n++) { const b = num(s.base) + n * num(s.stride ?? 0); for (let i = 0; i < num(s.size); i++) bytes[b + i] = next(); }
  }
  const save = new SaveFile(bytes.buffer, d);
  for (let n = 0; n < slotCount(d); n++) {
    save.write(emptyField(d), n, false);
    save.write(field(d, "general.playerName"), n, name);
    save.write(field(d, "general.playTime"), n, 3600 * (n + 1) + seed);
    save.write(field(d, "general.heroMode"), n, hero);
    save.write(field(d, "general.rupees"), n, 100 + n);
  }
  sign(save);
  return save.bytes.slice();
}

/**
 * Filled bytes with one data byte flipped in each listed file: in the slot itself, in HD's first extra block
 * (`inExtra`), or in another per-file scope (`scope`, e.g. the cutscene chunk). Never in a stored checksum.
 */
export function badBytes(d, slots, { inExtra = false, scope = inExtra ? "slotExtra" : "slot", ...opts } = {}) {
  const bytes = filledBytes(d, opts), probe = new SaveFile(bytes.slice().buffer, d);
  const at = scope === "slot" || scope === "slotExtra" ? 0x100 : 0x04;
  for (const n of slots) bytes[probe.scopeBase(scope, n) + at] ^= 0xff;
  return bytes;
}

export const slotChecksum = (d) => { const i = d.layout.checksums.findIndex((c) => c.scope === "slot"); return [d.layout.checksums[i], i]; };
/** The 4 stored checksum bytes of a file, as a comparable string. */
export function stored(save, n) {
  const [cs] = slotChecksum(save.defs), at = save.scopeBase("slot", n) + num(cs.store);
  return [...save.bytes.subarray(at, at + 4)].join(",");
}
/** Bytes of one file: its slot and everything that travels with it. */
export function slotBytes(save, n) {
  return Buffer.concat(slotScopes(save.defs).map((sc) => { const b = save.scopeBase(sc, n); return Buffer.from(save.bytes.subarray(b, b + num(save.scope(sc).size))); }));
}
export const isImage = (preset) => (preset.apply || []).some((e) => e.image);
