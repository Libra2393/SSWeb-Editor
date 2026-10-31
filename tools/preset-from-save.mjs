#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Part of SSWeb Editor. See LICENSE and CREDITS.md.
//
// Builds a preset from a reference save.
//
//   node tools/preset-from-save.mjs <wiiking2.sav> <slot 1-4 | all> <preset id> "<title>" [--image] [--group "<name>"]
//
// By default the game's flag arrays (story, item, dungeon, scene and chest flags) are copied whole as 16-bit
// words, plus spawn, stats, pouch and storage. The player's name, play time, save time and Hero Mode are left to
// the save the preset is applied to, and so are statistics (enemy kills and hits), map beacons and bytes nobody
// has described yet. Such a preset works on Wii and HD saves alike.
//
// --image copies each slot byte for byte instead (everything before the checksum, name and play time included),
// for states that depend on undescribed bytes, such as speedrun practice files. Raw bytes are in the reference's
// byte order, so the preset is limited to the reference's format.
//
// With "all", every non-empty file of the reference is copied to the same file number, so the preset lays out
// a whole save (for routes that keep helper files beside the main one).
//
// The output is a starting point: add a description and sources by hand.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SaveFile, num } from "../js/codec.js";
import { loadWith, formatFor, applyVariants, leafFields } from "../js/defs.js";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, name === "--image" ? 1 : 2)[1] ?? true; };
const image = !!flag("--image");
const group = flag("--group");
const [path, slotArg, id, title] = args;
if (!path || !slotArg || !id) {
  console.error('usage: preset-from-save.mjs <save> <slot 1-4 | all> <preset id> "<title>" [--image] [--group "<name>"]');
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const all = await loadWith(async (n) => JSON.parse(readFileSync(join(root, "defs", n), "utf8")));
const bytes = readFileSync(path);
const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
const defs = formatFor(all, new Uint8Array(buf));
applyVariants(defs, [defs.format.id]);
const save = new SaveFile(buf, defs);
const isNew = defs.fieldsById.get("general.isNew");

const slotCount = num(defs.layout.scopes.slot.count);
const slots = slotArg === "all" ? [...Array(slotCount).keys()] : [Number(slotArg) - 1];
const tag = (entry, slot) => (slotArg === "all" ? { slot: slot + 1, ...entry } : entry);

const apply = [];
for (const slot of slots) {
  if (slotArg === "all" && save.read(isNew, slot) && !image) {
    apply.push(tag({ field: "general.isNew", value: true }, slot));
    continue;
  }
  apply.push(...(image ? imageEntries(slot) : flagEntries(slot)).map((e) => tag(e, slot)));
}

const preset = { id, title: title || id, description: "", scope: "slot", sources: "" };
if (image) preset.formats = [defs.format.id];
if (group) preset.group = group;
preset.apply = apply;
// One entry per line keeps the file readable and diffs small.
console.log(JSON.stringify(preset, null, 2)
  .replace(/\{\n\s+("field"|"type"|"slot")([^{}]*?)\n\s+\}/g, (m) => m.replace(/\n\s*/g, " "))
  .replace(/"formats": \[\n\s+([^\]]*?)\n\s+\]/, (m, list) => `"formats": [${list.replace(/,\n\s+/g, ", ")}]`));

/** The slot's flag arrays as words, plus the described general, inventory and equipment fields outside them. */
function flagEntries(slot) {
  // The flag arrays, as the tracker names them. All are arrays of u16 in the game.
  const ARRAYS = ["story", "item", "dungeon", "scene", "tbox"];
  const regions = defs.tracker.regions.filter((r) => ARRAYS.includes(r.id)).map((r) => ({ ...r, start: num(r.start), end: num(r.end) }));
  const inArrays = (off) => regions.some((r) => off >= r.start && off < r.end);
  // Kept from the target save, or handled specially below.
  const KEEP = new Set(["general.playerName", "general.isNew", "general.heroMode", "general.playTime", "general.saveTime"]);

  const out = [
    { field: "general.playerName", value: "Link", onlyIfEmpty: true },
    { field: "general.isNew", value: false },
  ];
  for (const f of leafFields(defs)) {
    if (f.scope !== "slot" || KEEP.has(f.key) || f.flagRef) continue;
    if (!/^(general|inventory|equipment)\./.test(f.key) || inArrays(num(f.offset))) continue;
    let value = save.read(f, slot);
    if (typeof value === "number" && !Number.isInteger(value)) value = Math.round(value * 1e4) / 1e4;
    out.push({ field: f.key, value });
  }
  const base = save.scopeBase("slot", slot);
  const little = defs.layout.endian === "little";
  for (const r of regions) {
    const words = [];
    for (let o = r.start; o < r.end; o += 2) {
      const a = save.bytes[base + o], b = save.bytes[base + o + 1];
      words.push((little ? a | (b << 8) : (a << 8) | b).toString(16).padStart(4, "0"));
    }
    out.push({ type: "words", id: r.id, offset: "0x" + r.start.toString(16).toUpperCase().padStart(4, "0"), note: r.label, words: words.join(" ") });
  }
  return out;
}

/** The slot's bytes before the checksum, as runs of non-zero data (short gaps of zeros stay inside a run). */
function imageEntries(slot) {
  const base = save.scopeBase("slot", slot);
  const end = num(defs.layout.checksums.find((c) => c.scope === "slot").store);
  const runs = [];
  let start = -1, last = -1;
  for (let i = 0; i <= end; i++) {
    const nonzero = i < end && save.bytes[base + i] !== 0;
    if (nonzero) { if (start < 0) start = i; last = i; }
    if (start >= 0 && (i === end || (!nonzero && i - last > 8))) {
      const hex = [...save.bytes.subarray(base + start, base + last + 1)].map((x) => x.toString(16).padStart(2, "0")).join("");
      runs.push(["0x" + start.toString(16).toUpperCase().padStart(4, "0"), hex]);
      start = -1;
    }
  }
  return [{ type: "image", runs }];
}
