// Moving one file (slot) from one save into another, across the Wii and HD formats. See docs/conversion-plan.md.
//
// A slot is the same structure in both formats; only the byte order of its multi-byte values differs, plus the
// saved-at time, which each format counts from its own epoch at its own rate. So a file is converted by reversing
// each value in the ranges the layout's "units" list, translating the saved-at time, and letting the target's own
// checksum rule sign the result. Nothing outside the target file is touched: the target save keeps its header, its
// region and its other files, and on HD the target file keeps its own playthrough ID.
import { num } from "./codec.js";
import { leafFields } from "./defs.js";

const sameFormat = (a, b) => a.defs.format.id === b.defs.format.id;

/** Reverses every value in the scope's "units" ranges ([start, end, width]); width 1 is copied as it is. */
export function swapUnits(bytes, units) {
  for (const [s, e, w] of units || []) {
    const width = num(w);
    if (width < 2) continue;
    for (let i = num(s); i + width <= num(e); i += width) bytes.subarray(i, i + width).reverse();
  }
  return bytes;
}

/** The slot's date-time fields ("wiitime"), each with its offset, epoch and tick rate in this format. */
function clockFields(defs) {
  return [...leafFields(defs)].filter((f) => f.type === "wiitime" && f.scope === "slot");
}

const U64_MAX = (1n << 64n) - 1n;
const epochSeconds = (epoch = "2000-01-01") => BigInt(Date.parse(epoch + "T00:00:00Z") / 1000);

/**
 * Re-encodes the saved-at time so it shows the same wall-clock second: Wii ticks since 2000 (60,750,000 a second)
 * <-> HD seconds since 1970. Zero stays zero (a file that has never been saved). The sub-second part is dropped.
 */
function translateClock(raw, from, to) {
  if (raw === 0n) return 0n;
  const secs = raw / BigInt(num(from.tickRate)) + epochSeconds(from.epoch) - epochSeconds(to.epoch);
  if (secs <= 0n) return 0n;
  const out = secs * BigInt(num(to.tickRate));
  return out > U64_MAX ? U64_MAX : out;
}

/** Why a file can't be imported, as sentences for the user; empty when it can. */
export function importProblems(source, from) {
  const label = source.defs.layout.scopes.slot.labels?.[from] || `File ${from + 1}`;
  const problems = [];
  const empty = source.defs.fieldsById.get(source.defs.layout.slotSummary?.empty);
  if (empty && !empty.invalid && source.read(empty, from)) problems.push(`${label} of that save is empty.`);
  const scopes = source.withCompanions("slot");
  source.defs.layout.checksums.forEach((cs) => {
    if (!source.checksumParts(cs).some((p) => scopes.includes(p.scope))) return;
    if (source.checksumValid(cs, from) === false) {
      const what = cs.scope === "slot" ? label : (source.scope(cs.scope).label || cs.scope).replace("{n}", from + 1);
      problems.push(`The checksum of ${what} in that save is wrong. Importing would sign it again under this save's rule, ` +
        `so it isn't done. If you know why it is wrong, open that save, use “Re-sign bad checksums anyway”, save it, and import from it then.`);
    }
  });
  return problems;
}

/**
 * The source file's bytes in the target's format: { slot: 0x53BC data bytes, skip: 0x20 cutscene bytes or null }.
 * Checksums are not carried; the target computes its own.
 */
export function convertFile(source, from, targetDefs) {
  const src = source.defs.layout.scopes, dst = targetDefs.layout.scopes;
  const dataLength = (defs) => num(defs.layout.checksums.find((c) => c.scope === "slot").store);
  const length = dataLength(source.defs);
  if (length !== dataLength(targetDefs)) throw new Error("The two formats' files are not the same size.");
  const base = source.scopeBase("slot", from);
  const slot = source.bytes.slice(base, base + length);
  let skip = null;
  if (src.skip && dst.skip) {
    // The part both formats' maps cover: the 16 flag words. (Wii keeps the chunk's CRC after them, HD a spare word.)
    const end = (s) => Math.max(...(s.units || []).map(([, e]) => num(e)));
    const at = source.scopeBase("skip", from);
    skip = source.bytes.slice(at, at + Math.min(end(src.skip), end(dst.skip)));
  }
  const swap = (source.defs.layout.endian || "big") !== (targetDefs.layout.endian || "big");
  if (!swap) return { slot, skip };

  const view = new DataView(slot.buffer);
  const srcLe = source.defs.layout.endian === "little";
  const clocks = clockFields(source.defs).map((f) => [f, view.getBigUint64(num(f.offset), srcLe)]);
  swapUnits(slot, src.slot.units);
  if (skip) swapUnits(skip, src.skip.units.filter(([, e]) => num(e) <= skip.length));
  const tgtClocks = new Map(clockFields(targetDefs).map((f) => [f.id, f]));
  for (const [f, raw] of clocks) {
    const to = tgtClocks.get(f.id);
    if (to && num(to.offset) === num(f.offset)) view.setBigUint64(num(f.offset), translateClock(raw, f, to), targetDefs.layout.endian === "little");
  }
  return { slot, skip };
}

/**
 * Replaces file `to` of `target` with file `from` of `source`. The target file is emptied the way Clear file does
 * (on HD that keeps its playthrough ID), then the converted bytes are written; HD's extra blocks stay zero unless the
 * source is an HD save too, in which case they come across apart from the ID. The file counts as replaced whole, so
 * it is signed normally on save and "Revert changes" undoes the import. Throws when importProblems has any.
 */
export function importFile(target, source, from, to) {
  const problems = importProblems(source, from);
  if (problems.length) throw new Error(problems.join("\n"));
  const { slot, skip } = convertFile(source, from, target.defs);
  target.clearScope("slot", to, { force: true });
  target.bytes.set(slot, target.scopeBase("slot", to));
  if (skip) target.bytes.set(skip, target.scopeBase("skip", to));
  if (sameFormat(source, target)) {
    const keep = target.scope("slot").clear?.keep || [];
    for (const n of target.scope("slot").companions || []) {
      if (n === "skip") continue;
      const size = num(target.scope(n).size), at = target.scopeBase(n, to);
      const kept = keep.filter((k) => k.scope === n).map((k) => [at + num(k.start), target.bytes.slice(at + num(k.start), at + num(k.start) + num(k.length))]);
      target.bytes.set(source.bytes.subarray(source.scopeBase(n, from), source.scopeBase(n, from) + size), at);
      for (const [o, b] of kept) target.bytes.set(b, o);
    }
  }
  target.markReplaced("slot", to);
}

/**
 * True when an HD file going to a Wii save is partway through the Song of the Hero quest (the dragons have been
 * asked about the song, and it isn't complete). The Wii game has a bug in that quest, fixed in HD, that can make it
 * impossible to finish depending on the order of events and reloads.
 */
export function songOfTheHeroRisk(source, from, targetDefs) {
  if (targetDefs.format.id !== "wii" || source.defs.format.id === "wii") return false;
  const asked = source.defs.fieldsById.get("story.f08FB_04"), song = source.defs.fieldsById.get("inventory.songOfTheHero");
  if (!asked || asked.invalid || !song || song.invalid) return false;
  return source.read(asked, from) && !source.read(song, from);
}
