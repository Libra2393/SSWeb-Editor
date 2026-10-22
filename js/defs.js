// SPDX-License-Identifier: GPL-3.0-or-later
// Part of SSWeb Editor. See LICENSE and CREDITS.md.

// Loads the JSON definition files and resolves them into the structures the editor renders from.
// The manifest can list several file formats (e.g. the Wii and HD saves). Each gets its own copy of the
// shared sections, validated against its own layout; per-format differences live in field "variants".

import { FIELD_TYPES, fieldSize, num } from "./codec.js";

/** Fetches defs/manifest.json and everything it lists; returns one defs object per format. Fails on file:// pages (use loadFromFiles). */
export async function loadFromServer(base = "defs/") {
  const get = async (name) => {
    const r = await fetch(base + name, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  };
  return loadWith(get);
}

/** Same as loadFromServer, from a FileList (a picked defs folder). */
export async function loadFromFiles(files) {
  const byName = new Map([...files].map((f) => [f.name, f]));
  const get = async (name) => {
    const f = byName.get(name.split("/").pop());
    if (!f) throw new Error(`${name} is missing from the picked folder`);
    try { return JSON.parse(await f.text()); } catch (e) { throw new Error(`${name}: ${e.message}`); }
  };
  return loadWith(get);
}

/** Loads the manifest and everything it lists through `get(fileName) -> parsed JSON`. */
export async function loadWith(get) {
  const manifest = await get("manifest.json");
  const formats = manifest.formats || [{ id: "default", label: "Default", layout: manifest.layout }];
  const layouts = await Promise.all(formats.map((f) => get(f.layout)));
  const enums = {};
  for (const name of manifest.enums || []) Object.assign(enums, await get(name));
  // Flag tables turn game flag numbers (story flag 3, item 177, scene flag Skyloft/8) into save bits.
  const flagTables = {};
  for (const [kind, name] of Object.entries(manifest.flagTables || {})) flagTables[kind] = await get(name);
  const tracker = manifest.tracker ? await get(manifest.tracker).catch(() => null) : null;
  const presets = [];
  for (const name of manifest.presets || []) {
    try { presets.push([await get(name), name]); }
    catch (e) { loadErrors.push(`${name}: ${e.message}`); }
  }
  const sections = [];
  const loadErrors = [];
  for (const name of manifest.sections) {
    try { sections.push([await get(name), name]); }
    catch (e) { loadErrors.push(`${name}: ${e.message}`); }
  }
  // Variants may be keyed by a format id ("hd") or by any game ID a layout accepts ("SOUJ").
  const variantKeys = new Set(formats.map((f) => f.id));
  for (const l of layouts) for (const id of Object.keys(l.magic?.values || {})) variantKeys.add(id);

  return formats.map((format, i) => {
    const defs = { format, layout: layouts[i], enums, flagTables, tracker, sections: [], fieldsById: new Map(), warnings: [...loadErrors], variantKeys };
    for (const [json, name] of sections) {
      try { addSection(defs, structuredClone(json), name); }
      catch (e) { defs.warnings.push(`${name}: ${e.message}`); }
    }
    defs.presets = expandPresetExtends(presets, defs.warnings).map(([json, name]) => resolvePreset(defs, structuredClone(json), name));
    return defs;
  });
}

/** Picks the format whose layout matches the file: by size first, then by its magic game ID. */
export function formatFor(allDefs, bytes) {
  const bySize = allDefs.filter((d) => num(d.layout.fileSize) === bytes.length);
  if (bySize.length <= 1) return bySize[0] || null;
  return bySize.find((d) => {
    const m = d.layout.magic;
    return m && m.values[String.fromCharCode(...bytes.subarray(num(m.offset), num(m.offset) + m.length))];
  }) || bySize[0];
}

/** Adds one section file. Also used for definition files the user drops in at runtime. */
export function addSection(defs, section, source = section.id) {
  if (!section.id || !Array.isArray(section.groups)) throw new Error("a section needs an \"id\" and a \"groups\" array");
  const existing = defs.sections.findIndex((s) => s.id === section.id);
  if (existing >= 0) {
    // Replacing a section: forget its old field ids first.
    for (const id of [...defs.fieldsById.keys()]) if (id.startsWith(section.id + ".")) defs.fieldsById.delete(id);
    defs.sections.splice(existing, 1);
  }
  section.source = source;
  for (const g of section.groups) {
    g.scope = g.scope || section.scope || "slot";
    for (const f of g.fields || []) resolveField(defs, section, f, g.scope);
  }
  if (existing >= 0) defs.sections.splice(existing, 0, section);
  else defs.sections.push(section);
  return section;
}

/**
 * "extends": "<preset id>" starts a preset from another preset's entries; its own "apply" entries come after,
 * so they win when both set the same thing. Chains are followed; cycles and unknown ids are reported.
 */
function expandPresetExtends(presets, warnings) {
  const byId = new Map(presets.map(([json]) => [json.id, json]));
  const flat = (json, seen = []) => {
    if (!json.extends) return json.apply || [];
    const base = byId.get(json.extends);
    if (!base || seen.includes(base.id)) {
      warnings.push(`preset "${json.id}": ${base ? "circular" : "unknown"} "extends": "${json.extends}"`);
      return json.apply || [];
    }
    return [...flat(base, [...seen, json.id]), ...(json.apply || [])];
  };
  return presets.map(([json, name]) => [{ ...json, apply: flat(json) }, name]);
}

/**
 * A preset is a list of values to write into one slot:
 *   { "id", "title", "description", "scope": "slot",
 *     "apply": [ { "field": "general.rupees", "value": 0 },          an existing field by key
 *                { "type": "storyflag", "flag": 3, "value": true } ] } or an inline field
 * An entry with "onlyIfEmpty": true is skipped when the field already holds a value (e.g. keep a name).
 * See expandPresetExtends for building one preset on another.
 * Inline entries are resolved like section fields but not listed in the editor.
 */
function resolvePreset(defs, preset, source) {
  preset.source = source;
  preset.scope = preset.scope || "slot";
  const section = { id: `preset:${preset.id}`, source };
  (preset.apply || []).forEach((entry, i) => {
    const where = `${source} → apply[${i}]`;
    if (!("value" in entry)) defs.warnings.push(`${where}: missing "value"`);
    if (entry.field) {
      if (!defs.fieldsById.has(entry.field)) defs.warnings.push(`${where}: unknown field "${entry.field}"`);
      return;
    }
    const { value, ...field } = entry;
    field.id = field.id || `apply${i}`;
    resolveField(defs, section, field, preset.scope, { register: false });
    entry.resolved = field;
  });
  return preset;
}

function resolveField(defs, section, f, scope, { register = true } = {}) {
  f.scope = f.scope || scope;
  f.key = `${section.id}.${f.id}`;
  const where = `${section.source || section.id} → ${f.id || "(no id)"}`;
  const warn = (msg) => defs.warnings.push(`${where}: ${msg}`);

  if (!f.id) warn("field has no \"id\"");
  if (register) {
    if (defs.fieldsById.has(f.key)) warn(`duplicate id "${f.key}"`);
    defs.fieldsById.set(f.key, f);
  }

  if (FLAG_REF_TYPES.includes(f.type)) {
    const err = expandFlagRef(defs, f);
    if (err) { warn(err); f.invalid = f.baseInvalid = true; return; }
  }
  if (!FIELD_TYPES.includes(f.type)) { warn(`unknown type "${f.type}"`); f.invalid = f.baseInvalid = true; return; }
  if (f.type === "row") { for (const c of f.fields || []) resolveField(defs, section, c, f.scope); return; }

  // "regions" is the older name for "variants".
  if (f.regions) { f.variants = { ...f.regions, ...f.variants }; delete f.regions; }
  if (f.variants) {
    for (const [id, o] of Object.entries(f.variants)) {
      if (defs.variantKeys && !defs.variantKeys.has(id)) warn(`"variants" names unknown format or game ID "${id}"`);
      if (o !== null && typeof o !== "object") warn(`"variants.${id}" must be an object of overrides or null`);
    }
  }
  // Keep the definition as written so variants can be applied and undone (see applyVariants).
  const { variants, key, ...base } = f;
  f.base = base;
  f.invalid = f.baseInvalid = !validateField(defs, f, warn);
}

const FLAG_REF_TYPES = ["storyflag", "itemflag", "sceneflag", "chestflag"];

/**
 * Rewrites a field that names a game flag by number into a concrete field on the 16-bit flag words:
 *   { "type": "storyflag", "flag": 3 }            story flag 3
 *   { "type": "itemflag", "flag": 177 }           item flag of item 177
 *   { "type": "sceneflag", "scene": "Skyloft", "flag": 8 }
 *   { "type": "chestflag", "scene": "Sky", "flag": 6 }      opened-chest flag (the game's per-scene chest array)
 * One-bit flags become checkboxes; wider ones (counters) become numbers. Returns an error message or null.
 */
function expandFlagRef(defs, f) {
  const kind = f.type.replace("flag", "");
  const table = defs.flagTables?.[kind];
  if (!table) return `no "${kind}" flag table in the manifest's "flagTables"`;
  const n = num(f.flag);
  let word, shift, bits, name;
  if (kind === "scene" || kind === "chest") {
    const scene = typeof f.scene === "string" ? table.scenes[f.scene] : num(f.scene);
    if (scene == null) return `unknown scene "${f.scene}"`;
    if (!(n >= 0 && n < num(table.wordsPerScene) * 16)) return `${kind} flag ${f.flag} out of range`;
    [word, shift, bits] = [scene * num(table.wordsPerScene) + (n >> 4), n & 15, 1];
  } else {
    const entry = table.flags[n];
    if (!entry) return `${kind} flag ${f.flag} is not in the table`;
    [word, shift, bits, name] = entry;
    if (word === 255) return `${kind} flag ${f.flag} is unused by the game`;
  }
  const offset = "0x" + (num(table.base) + word * 2).toString(16).toUpperCase().padStart(4, "0");
  f.flagRef = kind === "scene" || kind === "chest" ? `${kind} flag ${f.scene}/${n}` : `${kind} flag #${n}`;
  if (!f.label) f.label = name || f.flagRef;
  if (!f.description && name && f.label !== name) f.description = name;
  if (bits === 1) Object.assign(f, { type: "flag", storage: "u16", offset, mask: "0x" + (1 << shift).toString(16).toUpperCase().padStart(4, "0") });
  else Object.assign(f, { type: "u16", offset, shift, bits });
  return null;
}

/** Checks a leaf field's own keys; returns false if it can't be read safely. */
function validateField(defs, f, warn) {
  const s = defs.layout.scopes[f.scope];
  if (!s) return warn(`unknown scope "${f.scope}"`), false;
  if (f.offset == null || Number.isNaN(num(f.offset))) return warn("missing or bad \"offset\""), false;
  if (f.type === "flag" && f.mask == null) return warn("flag needs a \"mask\""), false;
  if (f.type === "string" && !num(f.length)) return warn("string needs a \"length\" in bytes"), false;
  if ((f.type === "duration" || f.type === "wiitime") && !num(f.tickRate)) return warn(`${f.type} needs a "tickRate"`), false;
  if (num(f.offset) + fieldSize(f) > num(s.size)) return warn(`runs past the end of scope "${f.scope}" (size ${s.size})`), false;
  if (f.enum && !defs.enums[f.enum]) warn(`enum "${f.enum}" is not defined`);
  return true;
}

/**
 * Applies the "variants" overrides matching `keys` (the format id, then the file's game ID) to every
 * field, undoing earlier ones first. Later keys win; an override of null hides the field.
 * Returns the warnings it raised.
 */
export function applyVariants(defs, keys) {
  const warnings = [];
  keys = keys.filter(Boolean);
  defs.variantState = keys.join("/");
  const walk = (fields) => {
    for (const f of fields || []) {
      if (f.type === "row") { walk(f.fields); continue; }
      if (!f.base) continue; // failed basic checks when loaded
      for (const k of Object.keys(f)) if (!["base", "variants", "key", "invalid", "baseInvalid", "absent"].includes(k)) delete f[k];
      Object.assign(f, f.base);
      const hits = keys.filter((k) => f.variants && k in f.variants);
      f.absent = hits.some((k) => f.variants[k] === null);
      for (const k of hits) if (f.variants[k]) Object.assign(f, f.variants[k]);
      const label = hits.join("+");
      const ok = f.absent || !hits.length || validateField(defs, f, (m) => warnings.push(`${f.key} (${label}): ${m}`));
      f.invalid = f.baseInvalid || f.absent || !ok;
    }
  };
  for (const s of defs.sections) for (const g of s.groups) walk(g.fields);
  return warnings;
}

/** Every leaf field, flattened out of groups and rows. */
export function* leafFields(defs) {
  const walk = function* (fields) {
    for (const f of fields || []) {
      if (f.type === "row") yield* walk(f.fields);
      else if (!f.invalid) yield f;
    }
  };
  for (const s of defs.sections) for (const g of s.groups) yield* walk(g.fields);
}

/** For the raw view: which byte offsets of a scope some definition covers, and by what. */
export function coverage(defs, scopeName) {
  const map = new Map();
  for (const f of leafFields(defs)) {
    if (f.scope !== scopeName) continue;
    const start = num(f.offset), size = fieldSize(f);
    for (let i = start; i < start + size; i++) {
      if (!map.has(i)) map.set(i, []);
      map.get(i).push(f.label || f.id);
    }
  }
  for (const cs of defs.layout.checksums) {
    if (cs.scope !== scopeName) continue;
    for (let i = num(cs.store); i < num(cs.store) + 4; i++) map.set(i, [`${cs.algorithm} checksum`]);
  }
  return map;
}

/**
 * For the coverage tracker: which bits of a scope the editor's fields describe, as one mask per byte.
 * Flags and bitfields count only their own bits (so a flag array is measured flag by flag); other fields
 * count all their bytes. Checksum storage counts as covered.
 */
export function bitCoverage(defs, scopeName) {
  const scope = defs.layout.scopes[scopeName];
  const masks = new Uint8Array(num(scope.size));
  const little = defs.layout.endian === "little";
  for (const f of leafFields(defs)) {
    if (f.scope !== scopeName) continue;
    const start = num(f.offset), size = fieldSize(f);
    let valueMask = null; // bits of the stored integer that the field uses
    if (f.type === "flag") valueMask = BigInt(num(f.mask));
    else if (f.bits != null) valueMask = ((1n << BigInt(num(f.bits))) - 1n) << BigInt(num(f.shift ?? 0));
    for (let i = 0; i < size && start + i < masks.length; i++) {
      if (valueMask === null) { masks[start + i] = 0xff; continue; }
      const shiftBytes = little ? i : size - 1 - i; // which byte of the integer this address holds
      masks[start + i] |= Number((valueMask >> BigInt(8 * shiftBytes)) & 0xffn);
    }
  }
  for (const cs of defs.layout.checksums) {
    if (cs.scope !== scopeName) continue;
    for (let i = num(cs.store); i < num(cs.store) + 4; i++) masks[i] = 0xff;
  }
  return masks;
}

/** Enum entries as [number, label] pairs; keys may be decimal or "0x" hex strings. */
export function enumEntries(defs, name) {
  return Object.entries(defs.enums[name] || {}).map(([k, v]) => [num(k), v]).sort((a, b) => a[0] - b[0]);
}
