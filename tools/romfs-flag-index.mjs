// SPDX-License-Identifier: GPL-3.0-or-later
// Part of SSWeb Editor. See LICENSE and CREDITS.md.
//
// Builds an index of where the game uses each story, scene and chest flag, from YOUR OWN game data.
//
//   node tools/romfs-flag-index.mjs <romfs.bin or extracted romfs folder> [--dump objects.json]
//
// It reads every Stage/<stage>/**/<stage>_stg_l<layer>.arc(.LZ) (Skyward Sword HD keeps the Wii formats: LZ11
// compression, big-endian U8 archives, BZS object lists), finds every object in every room and layer, and decodes
// the flags each object type uses. It writes defs/flags/flag-usage.json: flag -> where it is used and by what.
// That file holds facts only (flag numbers, stage/room names, object type names); no game data is copied.
// --dump also writes the full raw object list, for research; keep that one to yourself.
//
// The archive and object-list layouts follow the Skyward Sword Randomizer's sslib (MIT, Skyward Sword Rando Team)
// and mrcheeze's skyward-sword-tools; flag fields follow the zeldaret/ss decompilation (CC0) and the randomizer.

import { readFileSync, writeFileSync, statSync, readdirSync, openSync, readSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- reading the game data

/** Lists files in a Switch RomFS image (or a folder it was extracted to) as { path -> () => bytes }. */
export function openRomfs(src) {
  if (statSync(src).isDirectory()) {
    const out = new Map();
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.set(relative(src, p).split("\\").join("/"), () => readFileSync(p)); } };
    walk(src);
    return out;
  }
  // The image is several GB, so read only the pieces needed, from one open file.
  const fd = openSync(src, "r");
  const read = (off, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b; };
  const hdr = read(0, 0x50);
  const q = (i) => Number(hdr.readBigUInt64LE(i * 8));
  const [, , , dmOff, dmSize, , , fmOff, fmSize, dataOff] = Array.from({ length: 10 }, (_, i) => q(i));
  const dmeta = read(dmOff, dmSize), fmeta = read(fmOff, fmSize);
  const dirPath = (off) => {
    const parts = [];
    while (off !== 0) {
      const parent = dmeta.readUInt32LE(off), nlen = dmeta.readUInt32LE(off + 0x14);
      parts.push(dmeta.toString("utf8", off + 0x18, off + 0x18 + nlen));
      off = parent;
    }
    return parts.reverse().join("/");
  };
  const out = new Map();
  for (let off = 0; off < fmeta.length;) {
    const parent = fmeta.readUInt32LE(off), fo = Number(fmeta.readBigUInt64LE(off + 8)), fs = Number(fmeta.readBigUInt64LE(off + 16));
    const nlen = fmeta.readUInt32LE(off + 0x1c), name = fmeta.toString("utf8", off + 0x20, off + 0x20 + nlen);
    const path = [dirPath(parent), name].filter(Boolean).join("/");
    out.set(path, () => read(dataOff + fo, fs));
    off += 0x20 + ((nlen + 3) & ~3);
  }
  return out;
}

/** Nintendo LZ11 ("0x11") decompression. */
function lz11(src) {
  if (src[0] !== 0x11) throw new Error("not LZ11");
  let size = src[1] | (src[2] << 8) | (src[3] << 16), p = 4;
  if (size === 0) { size = (src[4] | (src[5] << 8) | (src[6] << 16) | (src[7] << 24)) >>> 0; p = 8; }
  const out = new Uint8Array(size); let o = 0;
  while (o < size) {
    let flags = src[p++];
    for (let i = 0; i < 8 && o < size; i++, flags <<= 1) {
      if (!(flags & 0x80)) { out[o++] = src[p++]; continue; }
      const b1 = src[p++], ind = b1 >> 4; let len, disp;
      if (ind === 0) { const b2 = src[p++], b3 = src[p++]; len = (((b1 & 0xf) << 4) | (b2 >> 4)) + 0x11; disp = (((b2 & 0xf) << 8) | b3) + 1; }
      else if (ind === 1) { const b2 = src[p++], b3 = src[p++], b4 = src[p++]; len = (((b1 & 0xf) << 12) | (b2 << 4) | (b3 >> 4)) + 0x111; disp = (((b3 & 0xf) << 8) | b4) + 1; }
      else { const b2 = src[p++]; len = ind + 1; disp = (((b1 & 0xf) << 8) | b2) + 1; }
      for (let k = 0; k < len; k++, o++) out[o] = out[o - disp];
    }
  }
  return out;
}

/** U8 archive -> [{ path, data }]. */
function u8(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint32(0) !== 0x55aa382d) throw new Error("not a U8 archive");
  const root = v.getUint32(4), count = v.getUint32(root + 8), strs = root + count * 12;
  const name = (off) => { let e = strs + off; while (buf[e]) e++; return Buffer.from(buf.subarray(strs + off, e)).toString("latin1"); };
  const files = [], stack = [];
  for (let i = 1; i < count; i++) {
    const n = root + i * 12, isDir = buf[n] === 1, nm = name(v.getUint32(n) & 0xffffff), a = v.getUint32(n + 4), b = v.getUint32(n + 8);
    while (stack.length && i >= stack[stack.length - 1].end) stack.pop();
    if (isDir) stack.push({ name: nm, end: b });
    else files.push({ path: [...stack.map((s) => s.name), nm].join("/"), data: buf.subarray(a, a + b) });
  }
  return files;
}

// BZS record layouts (from the randomizer's sslib/bzs.py): fields, big-endian struct format, size.
const OBJ = ["params1 params2 posx posy posz anglex angley anglez id name", "II3fHHHH8s", 36];
const SOBJ = ["params1 params2 posx posy posz sizex sizey sizez anglex angley anglez id name", "II3f3fHHHH8s", 48];
const STRUCTS = {
  "SCEN": ["name room layer entrance night byte5 flag6 zero saveprompt", "32sbbbbbbbb", 40],
  "AREA": ["posx posy posz sizex sizey sizez angle area_link unk3 dummy", "3f3fHhb3s", 32],
  "EVNT": ["unk1 story_flag1 story_flag2 unk2 exit_id unk3 skipevent unk4 sceneflag1 sceneflag2 skipflag dummy1 item dummy2 name", "2shh3sb3sb1sBBBhhh32s", 56],
  "PLY ": ["storyflag play_cutscene byte4 posx posy posz anglex angley anglez entrance_id", "hbb3f3Hh", 24],
  "OBJS": OBJ, "OBJ ": OBJ, "DOOR": OBJ,
  "SOBS": SOBJ, "SOBJ": SOBJ, "STAS": SOBJ, "STAG": SOBJ, "SNDT": SOBJ,
  "LYSE": ["story_flag night layer", "hbb", 4],
  "STIF": ["wtf1 wtf2 wtf3 byte1 flagindex byte3 byte4 unk1 map_name_id unk2", "3fbbbb2sb1s", 20],
};

function unpack(names, fmt, data) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = {}; const keys = names.split(/\s+/); let o = 0, k = 0;
  for (const [, n, t] of fmt.matchAll(/(\d*)([a-zA-Z])/g)) {
    const count = n ? Number(n) : 1;
    if (t === "s") { out[keys[k++]] = Buffer.from(data.subarray(o, o + count)).toString("latin1").replace(/\0.*$/s, ""); o += count; continue; }
    for (let c = 0; c < count; c++) {
      const val = { b: () => v.getInt8(o), B: () => v.getUint8(o), h: () => v.getInt16(o), H: () => v.getUint16(o), i: () => v.getInt32(o), I: () => v.getUint32(o), f: () => v.getFloat32(o) }[t]();
      o += { b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, f: 4 }[t];
      out[keys[k++]] = val;
    }
  }
  return out;
}

/** BZS object list -> { TYPE: [records] , LAY: { l0: {...}, ... } }. */
function bzs(data) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (o) => String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
  const node = (type, count, base) => {
    if (type === "V001") {
      const out = {};
      for (let i = 0; i < count; i++) {
        const a = base + i * 12;
        out[tag(a)] = node(tag(a), v.getInt16(a + 4), a + v.getInt32(a + 8));
      }
      return out;
    }
    if (type === "LAY ") {
      const out = {};
      for (let i = 0; i < count; i++) {
        const a = base + i * 8, c = v.getInt16(a);
        out[`l${i}`] = c ? node("V001", c, a + v.getInt32(a + 4)) : {};
      }
      return out;
    }
    const s = STRUCTS[type];
    if (!s) return null; // record types the index doesn't need
    const [names, fmt, size] = s;
    return Array.from({ length: count }, (_, i) => unpack(names, fmt, data.subarray(base + i * size, base + (i + 1) * size)));
  };
  if (tag(0) !== "V001") throw new Error("not a BZS file");
  return node("V001", v.getInt16(4), v.getInt32(8));
}

/** MSBF event flow (layout from the randomizer's sslib/msb.py): nodes, branch table and named entry points. */
function msbf(data) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (Buffer.from(data.subarray(0, 8)).toString("latin1") !== "MsgFlwBn") throw new Error("not an MSBF file");
  const out = { nodes: [], branches: [], entries: [] };
  for (let pos = 0x20; pos + 0x10 <= data.length;) {
    const id = Buffer.from(data.subarray(pos, pos + 4)).toString("latin1"), len = v.getInt32(pos + 4);
    const seg = pos + 0x10;
    if (id === "FLW3") {
      const n = v.getInt16(seg), nb = v.getInt16(seg + 2);
      for (let i = 0; i < n; i++) {
        const o = seg + 0x10 + 0x10 * i;
        out.nodes.push({ type: v.getInt8(o), subType: v.getInt8(o + 1), param1: v.getInt16(o + 4), param2: v.getInt16(o + 6),
                         next: v.getInt16(o + 8), param3: v.getInt16(o + 10), param4: v.getInt16(o + 12), param5: v.getInt16(o + 14) });
      }
      for (let i = 0; i < nb; i++) out.branches.push(v.getInt16(seg + 0x10 + 0x10 * n + 2 * i));
    } else if (id === "FEN1") {
      const count = v.getInt32(seg);
      for (let i = 0; i < count; i++) {
        let c = v.getInt32(seg + 4 + 8 * i), ptr = seg + v.getInt32(seg + 8 + 8 * i);
        for (; c > 0; c--) {
          const sl = data[ptr], name = Buffer.from(data.subarray(ptr + 1, ptr + 1 + sl)).toString("latin1");
          out.entries.push({ name, node: v.getInt32(ptr + 1 + sl) });
          ptr += 5 + sl;
        }
      }
    }
    pos = (seg + len + 0xf) & ~0xf; // segments are 16-byte aligned
  }
  return out;
}

/** Every event flow file in one language's message archives: [{ file, flow }]. */
export function eventFlows(romfs, lang = "US/Object/en_US") {
  const out = [];
  for (const path of [...romfs.keys()].filter((p) => p.startsWith(lang + "/") && p.endsWith(".arc")).sort()) {
    for (const f of u8(romfs.get(path)())) {
      if (!f.path.endsWith(".msbf")) continue;
      out.push({ archive: path.split("/").pop().replace(/\.arc$/, ""), file: f.path.split("/").pop().replace(/\.msbf$/, ""), flow: msbf(f.data) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- walking every stage

function* objectsOf(tree, where) {
  for (const [type, list] of Object.entries(tree || {})) {
    if (type === "LAY ") { for (const [l, sub] of Object.entries(list)) yield* objectsOf(sub, { ...where, layer: Number(l.slice(1)) }); continue; }
    if (!Array.isArray(list)) continue;
    for (const rec of list) yield { ...where, list: type.trim(), ...rec };
  }
}

export function indexGame(romfs) {
  const objects = [], stages = new Map(); // stage -> { flagindex }
  const arcs = [...romfs.keys()].filter((p) => /^Stage\/([^/]+)\/(?:[^/]+\/)?\1_stg_l(\d+)\.arc(\.LZ)?$/.test(p)).sort();
  const seen = new Set(); // a room's object list can appear in several layer archives; count it once
  for (const path of arcs) {
    const [, stage] = path.match(/^Stage\/([^/]+)\//);
    let data = romfs.get(path)();
    if (path.endsWith(".LZ")) data = lz11(data);
    for (const f of u8(data)) {
      if (f.path.endsWith("stage.bzs")) {
        const key = `${stage}/stage/${hash(f.data)}`;
        if (seen.has(key)) continue; seen.add(key);
        const tree = bzs(f.data);
        const stif = tree.STIF?.[0];
        if (stif && !stages.has(stage)) stages.set(stage, { flagindex: stif.flagindex });
        for (const o of objectsOf(tree, { stage, room: "stage" })) objects.push(o);
      } else if (f.path.endsWith(".arc")) {
        const room = f.path.match(/_r(\d+)\.arc$/)?.[1];
        for (const g of u8(f.data)) {
          if (!g.path.endsWith("room.bzs")) continue;
          const key = `${stage}/${room}/${hash(g.data)}`;
          if (seen.has(key)) continue; seen.add(key);
          for (const o of objectsOf(bzs(g.data), { stage, room: room == null ? f.path : Number(room) })) objects.push(o);
        }
      }
    }
  }
  return { objects, stages };
}
function hash(d) { let h = 2166136261; for (let i = 0; i < d.length; i += 7) h = Math.imul(h ^ d[i], 16777619); return (h >>> 0).toString(16) + d.length; }

// ---------------------------------------------------------------- what each object does with flags

// Field layouts from the randomizer's gamepatches.py (try_patch_obj and comments) and the decompilation
// (d_a_obj_tbox.cpp, d_a_item.cpp). Each rule: [flag kind, role, value(obj)]. Story flags are 11 bits (0x7FF =
// none), scene flags 8 bits (0xFF = none), chest flags 6 bits (only 0..31 are stored).
const story = (v) => v & 0x7ff, scene = (v) => v & 0xff;
const DECODERS = {
  TBox: [["chest", "opened (chest flag)", (o) => (o.anglez >> 9) & 0x3f],
         ["scene", "set when opened", (o) => scene(o.anglex)],
         ["scene", "makes it appear", (o) => scene(o.params1 >>> 20)]],
  Item: [["scene", "set when collected", (o) => scene(o.params1 >>> 10)]],
  Soil: [["scene", "set when dug up", (o) => scene(o.params1 >>> 4)]],
  EvntTag: [["scene", "triggers the event", (o) => scene(o.params1 >>> 16)], ["scene", "set by the event", (o) => scene(o.params1 >>> 8)]],
  EvfTag: [["story", "triggers the event", (o) => story(o.params1 >>> 19)], ["story", "set by the event", (o) => story(o.params1 >>> 8)]],
  ScChang: [["story", "needed for this exit", (o) => story(o.anglex)], ["story", "blocks this exit", (o) => story(o.anglez)], ["scene", "needed for this exit", (o) => scene(o.params1 >>> 24)]],
  SwAreaT: [["story", "set on entering the area", (o) => story(o.anglex)], ["story", "unset on entering the area", (o) => story(o.anglez)],
            ["scene", "set on entering the area", (o) => scene(o.params1)], ["scene", "unset on entering the area", (o) => scene(o.params1 >>> 8)]],
  NpcTke: [["scene", "makes the NPC appear", (o) => scene(o.anglex)], ["scene", "makes the NPC leave", (o) => scene(o.anglex >> 8)]],
  PushBlk: [["scene", "set when pushed into place", (o) => scene(o.params1 >>> 12)]],
  // Found by matching known collectible flags against the object dump (see the README):
  Chandel: [["scene", "set when the chandelier falls", (o) => scene(o.params1 >>> 24)]],
  chest: [["scene", "set when the closet/wardrobe is opened", (o) => scene(o.params1)]],
};
const NPC = [["story", "makes the NPC appear", (o) => story(o.params1 >>> 10)], ["story", "makes the NPC leave", (o) => story(o.params1 >>> 21)]];
const RECORDS = {
  EVNT: [["story", "event condition or result", (o) => o.story_flag1], ["story", "event condition or result", (o) => o.story_flag2],
         ["scene", "event condition or result", (o) => o.sceneflag1], ["scene", "event condition or result", (o) => o.sceneflag2]],
  LYSE: [["story", "selects the stage layout", (o) => o.story_flag]],
  PLY: [["story", "player start condition", (o) => o.storyflag]],
};

/** Every flag reference in the game: [{ kind, flag, scene, stage, room, layer, object, role }]. */
export function flagUses({ objects, stages }) {
  const uses = [];
  for (const o of objects) {
    const rules = RECORDS[o.list] || DECODERS[o.name] || (o.name?.startsWith("Npc") && o.name !== "NpcTke" ? NPC : null);
    if (!rules) continue;
    const sceneIdx = stages.get ? stages.get(o.stage)?.flagindex : stages[o.stage]?.flagindex;
    for (const [kind, role, get] of rules) {
      const n = get(o);
      const none = kind === "story" ? n <= 0 || n >= 0x7ff : kind === "scene" ? n < 0 || n >= 0xff : n < 0 || n > 31;
      if (none) continue;
      if (kind !== "story" && sceneIdx == null) continue;
      uses.push({ kind, flag: n, scene: kind === "story" ? undefined : sceneIdx, stage: o.stage, room: o.room, layer: o.layer ?? null,
                  object: o.name || o.list, role });
    }
  }
  return uses;
}

// Event flows (MSBF). Node layouts from the randomizer's gamepatches.py (FlagEventTypes / FlagSwitchTypes):
//   event  (type 3): subType 0 + param3 0/1 = set/unset story flag param2;
//                    subType 1 + param3 2/3 = set/unset scene flag param1 in scene group param2 (-1 = current area)
//   branch (type 2): param3 3 = check story flag param2; param3 6 = check scene flag param2 in the current area
// "Current area" scene flags are tied to the scene groups each message archive covers (an assumption, marked so).
const ARCHIVE_SCENES = {
  "1-Town": [0, 21], "2-Forest": [1, 2, 3, 11, 12, 22], "3-Mountain": [4, 5, 14, 15, 23],
  "4-Desert": [7, 8, 9, 17, 18, 24], "5-CenterField": [10, 20, 25],
};

/** Flag uses in the event flows: [{ kind, flag, scene, stage: event file, room: entry point, object: "Event", role }]. */
export function eventUses(flows) {
  const uses = [];
  for (const { archive, file, flow } of flows) {
    // Which named entry point reaches each node, so a use can be labelled with the event it belongs to.
    const reachedBy = new Map();
    for (const e of flow.entries) {
      const todo = [e.node];
      while (todo.length) {
        const i = todo.pop();
        if (i < 0 || i >= flow.nodes.length || reachedBy.has(i)) continue;
        reachedBy.set(i, e.name);
        const n = flow.nodes[i];
        todo.push(n.next);
        if (n.type === 2) for (let b = 0; b < n.param4; b++) todo.push(flow.branches[n.param5 + b]);
      }
    }
    const add = (kind, flag, scene, role, i) => uses.push({ kind, flag, scene, stage: file, room: reachedBy.get(i) ?? null, layer: null, object: "Event", role });
    flow.nodes.forEach((n, i) => {
      if (n.type === 3 && n.subType === 0 && (n.param3 === 0 || n.param3 === 1) && n.param2 > 0 && n.param2 < 0x7ff)
        add("story", n.param2, undefined, n.param3 === 0 ? "set by the event" : "unset by the event", i);
      else if (n.type === 3 && n.subType === 1 && (n.param3 === 2 || n.param3 === 3) && n.param1 >= 0 && n.param1 < 0xff) {
        const role = n.param3 === 2 ? "set by the event" : "unset by the event";
        if (n.param2 >= 0) add("scene", n.param1, n.param2, role, i);
        else for (const sc of ARCHIVE_SCENES[archive] || []) add("scene", n.param1, sc, role + " (if in this area)", i);
      } else if (n.type === 2 && n.param3 === 3 && n.param2 > 0 && n.param2 < 0x7ff) add("story", n.param2, undefined, "checked by the event", i);
      else if (n.type === 2 && n.param3 === 6 && n.param2 >= 0 && n.param2 < 0xff)
        for (const sc of ARCHIVE_SCENES[archive] || []) add("scene", n.param2, sc, "checked by the event (if in this area)", i);
    });
  }
  return uses;
}

/** Groups flag uses into the compact facts-only file the editor loads. */
export function usageFile(uses, sceneNames) {
  const out = { story: {}, scene: {}, chest: {} };
  const seen = new Set();
  for (const u of uses) {
    const key = u.kind === "story" ? String(u.flag) : `${u.scene}/${u.flag}`;
    const row = [u.stage, u.room, u.layer, u.object, u.role];
    const id = u.kind + key + row.join("|");
    if (seen.has(id)) continue; seen.add(id);
    (out[u.kind][key] ||= []).push(row);
  }
  return {
    name: "Flag usage",
    source: "Generated by tools/romfs-flag-index.mjs from the game's own stage files and event flows (Skyward Sword HD v1.0.0; the Wii version uses the same formats). Facts only: which object or event uses each flag, and how. Field layouts from the Skyward Sword Randomizer (MIT) and the zeldaret/ss decompilation (CC0).",
    format: "story: { flag: [[stage, room, layer, object, role], ...] }; scene and chest: { \"sceneIndex/flag\": [...] }. For objects, room is a number or \"stage\" and layer the stage layer (null = all layers). For events, object is \"Event\", stage is the event file and room the named entry point that reaches the flag command.",
    scenes: sceneNames,
    ...out,
  };
}

// ---------------------------------------------------------------- main

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const src = process.argv[2];
  if (!src) { console.error("usage: node tools/romfs-flag-index.mjs <romfs.bin | romfs folder> [--dump objects.json]"); process.exit(1); }
  const t = Date.now();
  const { objects, stages } = indexGame(openRomfs(src));
  console.log(`${objects.length} objects in ${stages.size} stages (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  const di = process.argv.indexOf("--dump");
  if (di > 0) writeFileSync(process.argv[di + 1], JSON.stringify({ stages: Object.fromEntries(stages), objects }));
  const flows = eventFlows(openRomfs(src));
  const evUses = eventUses(flows);
  console.log(`${flows.length} event flow files: ${evUses.length} flag uses`);
  const uses = [...flagUses({ objects, stages }), ...evUses];
  const scenes = JSON.parse(readFileSync(join(ROOT, "defs/flags/sceneflags.json"), "utf8")).scenes;
  const file = usageFile(uses, Object.fromEntries(Object.entries(scenes).map(([k, v]) => [v, k])));
  const out = join(ROOT, "defs/flags/flag-usage.json");
  writeFileSync(out, JSON.stringify(file, null, 0).replace(/\],"/g, '],\n"') + "\n");
  const count = (k) => Object.keys(file[k]).length;
  console.log(`${uses.length} flag uses: ${count("story")} story flags, ${count("scene")} scene flags, ${count("chest")} chest flags -> ${relative(process.cwd(), out)}`);
}
