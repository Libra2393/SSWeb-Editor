#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Part of SSWeb Editor. See LICENSE and CREDITS.md.
//
// Builds a preset from one slot of a reference save: the game's flag arrays (story, item, dungeon, scene and
// chest flags) are copied whole as 16-bit words, plus spawn, stats, pouch and storage. The player's name,
// play time, save time and Hero Mode are left to the save the preset is applied to, and so are statistics
// (enemy kills and hits), map beacons and bytes nobody has described yet.
//
//   node tools/preset-from-save.mjs <wiiking2.sav> <slot 1-4> <preset id> "<title>" > defs/presets/<id>.json
//
// The output is a starting point: add a description and sources by hand.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SaveFile, num } from "../js/codec.js";
import { loadWith, formatFor, applyVariants, leafFields } from "../js/defs.js";

const [path, slotArg, id, title] = process.argv.slice(2);
if (!path || !slotArg || !id) {
  console.error('usage: preset-from-save.mjs <save> <slot 1-4> <preset id> "<title>"');
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const all = await loadWith(async (n) => JSON.parse(readFileSync(join(root, "defs", n), "utf8")));
const bytes = readFileSync(path);
const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
const defs = formatFor(all, new Uint8Array(buf));
applyVariants(defs, [defs.format.id]);
const save = new SaveFile(buf, defs);
const slot = Number(slotArg) - 1;

// The flag arrays, as the tracker names them. All are arrays of u16 in the game.
const ARRAYS = ["story", "item", "dungeon", "scene", "tbox"];
const regions = defs.tracker.regions.filter((r) => ARRAYS.includes(r.id)).map((r) => ({ ...r, start: num(r.start), end: num(r.end) }));
const inArrays = (off) => regions.some((r) => off >= r.start && off < r.end);

// Kept from the target save, or handled specially below.
const KEEP = new Set(["general.playerName", "general.isNew", "general.heroMode", "general.playTime", "general.saveTime"]);

const apply = [
  { field: "general.playerName", value: "Link", onlyIfEmpty: true },
  { field: "general.isNew", value: false },
];
for (const f of leafFields(defs)) {
  if (f.scope !== "slot" || KEEP.has(f.key) || f.flagRef) continue;
  if (!/^(general|inventory|equipment)\./.test(f.key) || inArrays(num(f.offset))) continue;
  let value = save.read(f, slot);
  if (typeof value === "number" && !Number.isInteger(value)) value = Math.round(value * 1e4) / 1e4;
  apply.push({ field: f.key, value });
}

const base = save.scopeBase("slot", slot);
const little = defs.layout.endian === "little";
for (const r of regions) {
  const words = [];
  for (let o = r.start; o < r.end; o += 2) {
    const a = save.bytes[base + o], b = save.bytes[base + o + 1];
    words.push((little ? a | (b << 8) : (a << 8) | b).toString(16).padStart(4, "0"));
  }
  apply.push({ type: "words", id: r.id, offset: "0x" + r.start.toString(16).toUpperCase().padStart(4, "0"), note: r.label, words: words.join(" ") });
}

const preset = { id, title: title || id, description: "", scope: "slot", sources: "", apply };
// One entry per line keeps the file readable and diffs small.
console.log(JSON.stringify(preset, null, 2).replace(/\{\n\s+("field"|"type")([^{}]*?)\n\s+\}/g, (m) => m.replace(/\n\s*/g, " ")));
