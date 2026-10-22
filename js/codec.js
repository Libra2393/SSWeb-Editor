// SPDX-License-Identifier: GPL-3.0-or-later
// Part of SSWeb Editor. See LICENSE and CREDITS.md.

// Reads and writes typed fields in a save buffer, driven entirely by the JSON definitions.

export const num = (v) => (typeof v === "string" ? Number(v.trim().toLowerCase().startsWith("0x") ? parseInt(v, 16) : v) : v);

const INT_TYPES = {
  u8: [1, false], u16: [2, false], u32: [4, false], u64: [8, false],
  s8: [1, true], s16: [2, true], s32: [4, true],
};
const FLOAT_TYPES = { f32: 4, f64: 8 };
export const FIELD_TYPES = [...Object.keys(INT_TYPES), ...Object.keys(FLOAT_TYPES), "flag", "bool", "string", "duration", "wiitime", "row"];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC32. Pass the previous result as `crc` to continue it over another range. */
export function crc32(bytes, start, length, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = start, end = start + length; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CHECKSUMS = { crc32 };

/** Byte size a field occupies, used for bounds checks and the coverage map. */
export function fieldSize(f) {
  const t = storageType(f);
  if (INT_TYPES[t]) return INT_TYPES[t][0];
  if (FLOAT_TYPES[t]) return FLOAT_TYPES[t];
  if (f.type === "string") return num(f.length);
  return 0;
}

function storageType(f) {
  switch (f.type) {
    case "flag": return f.storage || "u8";
    case "bool": return f.storage || "u8";
    case "duration":
    case "wiitime": return f.storage || "u64";
    default: return f.type;
  }
}

export class SaveFile {
  constructor(buffer, defs) {
    this.defs = defs;
    this.bytes = new Uint8Array(buffer.slice(0));
    this.original = new Uint8Array(buffer.slice(0));
    this.view = new DataView(this.bytes.buffer);
    this.origView = new DataView(this.original.buffer);
    this.validOnLoad = new Map(); // "checksumIndex:slot" -> bool
    this.defs.layout.checksums.forEach((cs, i) => {
      for (let n = 0; n < this.scopeCount(cs.scope); n++) this.validOnLoad.set(`${i}:${n}`, this.checksumValid(cs, n));
    });
  }

  scope(name) {
    const s = this.defs.layout.scopes[name];
    if (!s) throw new Error(`Unknown scope "${name}"`);
    return s;
  }
  scopeCount(name) { return num(this.scope(name).count ?? 1); }
  scopeBase(name, index = 0) {
    const s = this.scope(name);
    return num(s.base) + (s.count ? index * num(s.stride) : 0);
  }
  absOffset(f, index) { return this.scopeBase(f.scope, f.scope && this.scope(f.scope).count ? index : 0) + num(f.offset); }

  // --- typed access -------------------------------------------------------

  read(f, index, view = this.view) {
    const off = this.absOffset(f, index);
    const le = (f.endian || this.defs.layout.endian) === "little";
    const t = storageType(f);
    switch (f.type) {
      case "flag": { const m = num(f.mask); return (Number(readInt(view, off, t, le)) & m) === m; }
      case "bool": return Number(readInt(view, off, t, le)) !== 0;
      case "string": return readString(view, off, num(f.length), this.encoding(f));
      case "duration": return Number(readInt(view, off, t, le)) / num(f.tickRate);
      case "wiitime": return wiiTicksToIso(BigInt(readInt(view, off, t, le)), num(f.tickRate), f.epoch);
    }
    if (FLOAT_TYPES[t]) return t === "f32" ? view.getFloat32(off, le) : view.getFloat64(off, le);
    const raw = readInt(view, off, t, le);
    if (f.bits != null) return Number((BigInt(raw) >> BigInt(num(f.shift ?? 0))) & ((1n << BigInt(num(f.bits))) - 1n));
    return Number(raw);
  }

  /** "utf16" follows the layout's byte order; utf16be/utf16le force one. */
  encoding(f) {
    if (f.encoding === "utf16") return this.defs.layout.endian === "little" ? "utf16le" : "utf16be";
    return f.encoding;
  }

  readOriginal(f, index) { return this.read(f, index, this.origView); }

  write(f, index, value) {
    // Unchanged values touch nothing, so unknown bits and padding survive a no-op edit.
    const cur = this.read(f, index);
    if (cur === value || (Number.isNaN(cur) && Number.isNaN(value))) return;
    const off = this.absOffset(f, index);
    const le = (f.endian || this.defs.layout.endian) === "little";
    const t = storageType(f);
    const v = this.view;
    switch (f.type) {
      case "flag": {
        const m = BigInt(num(f.mask)), raw = BigInt(readInt(v, off, t, le));
        return writeInt(v, off, t, le, value ? raw | m : raw & ~m);
      }
      case "bool": return writeInt(v, off, t, le, value ? 1n : 0n);
      case "string": return writeString(this.bytes, off, num(f.length), this.encoding(f), value);
      case "duration": {
        const rate = BigInt(num(f.tickRate)), old = BigInt(readInt(v, off, t, le));
        return writeInt(v, off, t, le, BigInt(Math.max(0, Math.floor(value))) * rate + (old % rate));
      }
      case "wiitime": {
        const rate = BigInt(num(f.tickRate)), old = BigInt(readInt(v, off, t, le));
        return writeInt(v, off, t, le, isoToWiiTicks(value, num(f.tickRate), f.epoch) + (old % rate));
      }
    }
    if (FLOAT_TYPES[t]) return t === "f32" ? v.setFloat32(off, value, le) : v.setFloat64(off, value, le);
    let n = BigInt(Math.trunc(value));
    if (f.bits != null) {
      const shift = BigInt(num(f.shift ?? 0)), mask = (1n << BigInt(num(f.bits))) - 1n;
      const raw = BigInt.asUintN(INT_TYPES[t][0] * 8, BigInt(readInt(v, off, t, le)));
      n = (raw & ~(mask << shift)) | ((n & mask) << shift);
    }
    writeInt(v, off, t, le, n);
  }

  /** Limits implied by the storage type, narrowed by the field's own min/max. */
  range(f) {
    const t = storageType(f);
    let lo = 0, hi;
    if (f.bits != null) hi = 2 ** num(f.bits) - 1;
    else if (INT_TYPES[t]) {
      const [size, signed] = INT_TYPES[t];
      hi = signed ? 2 ** (size * 8 - 1) - 1 : 2 ** (size * 8) - 1;
      if (signed) lo = -(2 ** (size * 8 - 1));
    }
    return { min: f.min != null ? num(f.min) : lo, max: f.max != null ? num(f.max) : hi };
  }

  // --- checksums ----------------------------------------------------------

  /**
   * The ranges a checksum covers, in order. By default one range of its own scope; `parts` lets it run on
   * through other scopes (each taken at the same index), as the HD save's slot checksum does.
   */
  checksumParts(cs) {
    return cs.parts || [{ scope: cs.scope, start: cs.start, length: cs.length }];
  }

  computeChecksum(cs, index) {
    const algo = CHECKSUMS[cs.algorithm];
    if (!algo) return null;
    let sum = 0;
    for (const p of this.checksumParts(cs)) sum = algo(this.bytes, this.scopeBase(p.scope, index) + num(p.start), num(p.length), sum);
    return sum;
  }

  /** true/false, or null when the layout names an algorithm nobody has worked out yet. */
  checksumValid(cs, index) {
    const sum = this.computeChecksum(cs, index);
    if (sum === null) return null;
    return sum === this.view.getUint32(this.scopeBase(cs.scope, index) + num(cs.store), this.defs.layout.endian === "little");
  }

  /** A scope plus the scopes it declares as `companions` (per-slot data stored elsewhere in the file). */
  withCompanions(name) {
    return [name, ...(this.scope(name).companions || [])];
  }

  scopeChanged(name, index, { companions = true } = {}) {
    for (const n of companions ? this.withCompanions(name) : [name]) {
      const base = this.scopeBase(n, index), size = num(this.scope(n).size);
      for (let i = base; i < base + size; i++) if (this.bytes[i] !== this.original[i]) return true;
    }
    return false;
  }

  /** Recomputes checksums for scopes whose bytes changed (or every scope with `all`). Returns what was rewritten. */
  updateChecksums({ all = false } = {}) {
    const fixed = [];
    this.defs.layout.checksums.forEach((cs, i) => {
      for (let n = 0; n < this.scopeCount(cs.scope); n++) {
        if (!CHECKSUMS[cs.algorithm]) continue;
        if (!all && !this.checksumParts(cs).some((p) => this.scopeChanged(p.scope, n))) continue;
        if (cs.onlyIfValidOnLoad && !this.validOnLoad.get(`${i}:${n}`)) continue;
        const sum = this.computeChecksum(cs, n);
        this.view.setUint32(this.scopeBase(cs.scope, n) + num(cs.store), sum, this.defs.layout.endian === "little");
        fixed.push({ scope: cs.scope, index: n });
      }
    });
    return fixed;
  }

  copyScope(name, from, to) {
    for (const n of this.withCompanions(name)) {
      const size = num(this.scope(n).size);
      this.bytes.copyWithin(this.scopeBase(n, to), this.scopeBase(n, from), this.scopeBase(n, from) + size);
    }
  }

  revertScope(name, index) {
    for (const n of this.withCompanions(name)) {
      const base = this.scopeBase(n, index), size = num(this.scope(n).size);
      this.bytes.set(this.original.subarray(base, base + size), base);
    }
  }

  /** Called after a successful in-place save, so "changed" is measured from what is on disk. */
  markSaved() { this.original.set(this.bytes); }
}

function readInt(view, off, t, le) {
  switch (t) {
    case "u8": return view.getUint8(off);
    case "s8": return view.getInt8(off);
    case "u16": return view.getUint16(off, le);
    case "s16": return view.getInt16(off, le);
    case "u32": return view.getUint32(off, le);
    case "s32": return view.getInt32(off, le);
    case "u64": return view.getBigUint64(off, le);
  }
  throw new Error(`Not an integer type: ${t}`);
}

function writeInt(view, off, t, le, n) {
  n = BigInt(n);
  switch (t) {
    case "u8": case "s8": return view.setUint8(off, Number(BigInt.asUintN(8, n)));
    case "u16": case "s16": return view.setUint16(off, Number(BigInt.asUintN(16, n)), le);
    case "u32": case "s32": return view.setUint32(off, Number(BigInt.asUintN(32, n)), le);
    case "u64": return view.setBigUint64(off, BigInt.asUintN(64, n), le);
  }
  throw new Error(`Not an integer type: ${t}`);
}

function readString(view, off, length, encoding = "ascii") {
  let s = "";
  if (encoding === "utf16be" || encoding === "utf16le") {
    const le = encoding === "utf16le";
    for (let i = 0; i + 1 < length; i += 2) {
      const c = view.getUint16(off + i, le);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
  } else {
    for (let i = 0; i < length; i++) {
      const c = view.getUint8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
  }
  return s;
}

function writeString(bytes, off, length, encoding = "ascii", value) {
  // Writes the characters plus one terminator if it fits. Bytes past the terminator are left as they
  // were, because some fields (the hero's name) are followed by unrelated data inside their nominal length.
  if (encoding === "utf16be" || encoding === "utf16le") {
    const max = Math.floor(length / 2), n = Math.min(value.length, max);
    for (let i = 0; i <= n && i < max; i++) {
      const c = i < n ? value.charCodeAt(i) : 0;
      if (encoding === "utf16be") { bytes[off + i * 2] = c >> 8; bytes[off + i * 2 + 1] = c & 0xff; }
      else { bytes[off + i * 2] = c & 0xff; bytes[off + i * 2 + 1] = c >> 8; }
    }
  } else {
    const n = Math.min(value.length, length);
    for (let i = 0; i < n; i++) bytes[off + i] = value.charCodeAt(i) & 0xff;
    if (n < length) bytes[off + n] = 0;
  }
}

// Timestamps count clock ticks from an epoch (the Wii's is 2000-01-01 00:00 local time; HD uses Unix time).
// They're handled as naive date-times (via UTC math) so the browser's timezone never shifts them.
const epochMs = (epoch = "2000-01-01") => Date.parse(epoch + "T00:00:00Z");
function wiiTicksToIso(ticks, rate, epoch) {
  const secs = Number(ticks / BigInt(rate));
  return new Date(epochMs(epoch) + secs * 1000).toISOString().slice(0, 19);
}
function isoToWiiTicks(iso, rate, epoch) {
  const ms = Date.parse(iso.length === 16 ? iso + ":00Z" : iso + "Z");
  if (Number.isNaN(ms)) throw new Error(`Bad date: ${iso}`);
  return BigInt(Math.max(0, Math.round((ms - epochMs(epoch)) / 1000))) * BigInt(rate);
}
