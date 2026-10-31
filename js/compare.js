// SPDX-License-Identifier: GPL-3.0-or-later
// Part of SSWeb Editor. See LICENSE and CREDITS.md.

// Compares one slot of two saves of the same format: which known fields changed, and which bits nobody has
// described yet, decoded into story/item/scene/chest flag numbers where the game's flag tables allow.

import { num } from "./codec.js";
import { leafFields, bitCoverage } from "./defs.js";

// Changes that happen on every save and say nothing about game progress.
const NOISE = [
  { start: 0x0000, end: 0x0010, label: "play time and save time" },
  { start: 0x0010, end: 0x0034, label: "spawn positions" },
  { start: 0x530e, end: 0x5314, label: "facing angles" },
  { start: 0x53bc, end: 0x53c0, label: "checksum" },
];
const inNoise = (scope, off) => scope === "slot" && NOISE.some((n) => off >= n.start && off < n.end);

/**
 * diffSlots(defs, a, slotA, b, slotB) — a and b are SaveFile objects built with the same defs.
 * Returns { known, unknown, noiseBytes, location } where
 *   known:   [{ labels, key, field, from, to, region }]
 *   unknown: [{ kind, title, detail, from, to, region, suggestion }]
 */
export function diffSlots(defs, a, slotA, b, slotB, { hideNoise = true } = {}) {
  const regions = regionList(defs);
  const regionOf = (scope, off) => regions.find((r) => r.scope === scope && off >= r.start && off < r.end)?.label || scope;

  // --- known fields (one row per distinct bit range, listing every label that describes it)
  const seen = new Map();
  for (const f of leafFields(defs)) {
    if (!isSlotScope(a, f.scope)) continue;
    if (hideNoise && inNoise(f.scope, num(f.offset))) continue;
    const from = a.read(f, slotA), to = b.read(f, slotB);
    if (same(from, to)) continue;
    const id = `${f.scope}:${num(f.offset)}:${f.type}:${f.mask ?? ""}:${f.shift ?? ""}:${f.bits ?? ""}`;
    if (seen.has(id)) { seen.get(id).labels.push(fieldName(defs, f)); continue; }
    seen.set(id, { labels: [fieldName(defs, f)], key: f.key, field: f, from, to, region: regionOf(f.scope, num(f.offset)) });
  }
  const known = [...seen.values()];

  // --- unknown bits: changed, but outside every field's bits
  const unknown = [];
  let noiseBytes = 0;
  for (const scope of a.withCompanions("slot")) {
    const cov = scope === "slot" ? bitCoverage(defs, scope) : new Uint8Array(num(a.scope(scope).size));
    const baseA = a.scopeBase(scope, slotA), baseB = b.scopeBase(scope, slotB);
    const raw = []; // byte offsets with unknown changes outside the flag arrays
    for (let i = 0; i < cov.length; i++) {
      const x = a.bytes[baseA + i] ^ b.bytes[baseB + i];
      if (!x) continue;
      if (inNoise(scope, i)) { noiseBytes++; if (hideNoise) continue; }
      const u = x & ~cov[i];
      if (!u) continue;
      const flags = scope === "slot" ? decodeFlags(defs, a, b, baseA, baseB, i, u) : null;
      if (flags) unknown.push(...flags.map((r) => ({ ...r, region: regionOf(scope, i) })));
      else raw.push(i);
    }
    // merge neighbouring raw bytes into ranges
    for (let k = 0; k < raw.length; ) {
      let j = k;
      while (j + 1 < raw.length && raw[j + 1] <= raw[j] + 2) j++;
      const start = raw[k], end = raw[j] + 1;
      unknown.push({
        kind: "bytes", title: `${end - start} byte${end - start > 1 ? "s" : ""} at ${hex(start)}`,
        detail: `${scope} + ${hex(start)}–${hex(end - 1)}`,
        from: hexBytes(a.bytes, baseA + start, end - start), to: hexBytes(b.bytes, baseB + start, end - start),
        region: regionOf(scope, start),
        suggestion: { id: `unknown_${start.toString(16)}`, label: "", type: end - start === 1 ? "u8" : end - start === 2 ? "u16" : "u32", offset: hex(start), ...(scope !== "slot" ? { scope } : {}) },
      });
      k = j + 1;
    }
  }

  return { known, unknown, noiseBytes, location: { a: whereIs(defs, a, slotA), b: whereIs(defs, b, slotB) } };
}

/** Decodes changed bits of byte `i` in the story/item/scene/chest flag arrays into flag numbers. */
function decodeFlags(defs, a, b, baseA, baseB, i, changedBits) {
  const t = defs.flagTables || {};
  const arrays = [
    ["story", t.story, 0x100], ["item", t.item, 0x80],
    ["scene", t.scene, t.scene && num(t.scene.wordsPerScene) * 2 * 26],
    ["chest", t.chest, t.chest && num(t.chest.wordsPerScene) * 2 * 26],
  ];
  for (const [kind, table, size] of arrays) {
    if (!table) continue;
    const base = num(table.base);
    if (i < base || i >= base + size) continue;
    const rel = i - base, word = rel >> 1, firstByte = rel % 2 === 0;
    // Which half of the 16-bit word this byte holds depends on the save's byte order.
    const high = (defs.layout.endian === "little") ? !firstByte : firstByte;
    const little = defs.layout.endian === "little";
    const wordAt = (bytes, baseX) => { const o = baseX + base + word * 2; return little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]; };
    const wa = wordAt(a.bytes, baseA), wb = wordAt(b.bytes, baseB);
    const rows = [];
    for (let k = 0; k < 8; k++) {
      if (!(changedBits & (1 << k))) continue;
      const bit = k + (high ? 8 : 0);
      if (kind === "story" || kind === "item") {
        const n = table.flags.findIndex(([w, sh, bits]) => w === word && bit >= sh && bit < sh + bits);
        if (n < 0) { rows.push(flagRow(kind, `unlisted bit ${bit} of word ${word}`, null, wa, wb, bit, 1, null)); continue; }
        if (rows.some((r) => r.n === n)) continue; // a multi-bit counter, already reported
        const [, sh, bits, name] = table.flags[n];
        rows.push(flagRow(kind, `${kind === "story" ? "Story" : "Item"} flag #${n}`, name, wa, wb, sh, bits,
          { id: `${kind}${n}`, type: `${kind}flag`, flag: n }, n));
      } else {
        const perScene = num(table.wordsPerScene);
        const scene = Math.floor(word / perScene), n = (word % perScene) * 16 + bit;
        const sceneName = Object.entries(table.scenes).find(([, v]) => v === scene)?.[0] ?? `scene ${scene}`;
        rows.push(flagRow(kind, `${sceneName} / ${kind} flag ${n}`, null, wa, wb, bit, 1,
          { id: `${kind}_${sceneName.toLowerCase().replace(/\W+/g, "_")}_${n}`, type: `${kind}flag`, scene: sceneName, flag: n }));
      }
    }
    return rows;
  }
  return null;
}

function flagRow(kind, title, name, wa, wb, shift, bits, suggestion, n) {
  const mask = (1 << bits) - 1;
  const from = (wa >> shift) & mask, to = (wb >> shift) & mask;
  return { kind: `${kind} flag`, title, detail: name || "no description yet", from: bits === 1 ? !!from : from, to: bits === 1 ? !!to : to, suggestion, n };
}

function whereIs(defs, s, slot) {
  const get = (k) => { const f = defs.fieldsById.get(k); return f && !f.invalid ? s.read(f, slot) : undefined; };
  return { stage: get("general.stage"), room: get("general.room"), name: get("general.playerName"), playTime: get("general.playTime") };
}

function regionList(defs) {
  const t = defs.tracker;
  if (!t) return [];
  return [...t.regions, ...(defs.format.id === "hd" ? t.hdRegions || [] : [])].map((r) => ({ ...r, start: num(r.start), end: num(r.end) }));
}

const isSlotScope = (s, scope) => s.withCompanions("slot").includes(scope);
const same = (x, y) => x === y || (Number.isNaN(x) && Number.isNaN(y));
const fieldName = (defs, f) => {
  const section = defs.sections.find((s) => f.key?.startsWith(s.id + "."));
  return `${f.label || f.id}${section ? ` (${section.title})` : ""}`;
};
const hex = (n) => "0x" + n.toString(16).toUpperCase().padStart(4, "0");
const hexBytes = (bytes, off, len) => [...bytes.subarray(off, off + len)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
