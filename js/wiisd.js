// SPDX-License-Identifier: GPL-3.0-or-later
// Part of SSWeb Editor. See LICENSE and CREDITS.md.

// Import-only reader for Wii SD-card save exports (the data.bin the Wii writes to an SD card).
//
// Deliberate limits — see "Legal (United States)" in the README:
//  * No keys are included. The user enters the SD key and IV themselves; nothing is downloaded.
//  * Decryption only. This module has no encryption, re-signing or export path, and the editor never
//    writes a data.bin. Saving produces the raw, unencrypted wiiking2.sav that Dolphin uses.
//  * Everything runs locally in the browser; the file and keys are never sent anywhere.

const BANNER_SIZE = 0xf0c0; // encrypted header + banner + icons
const BK_SIZE = 0x80; // plaintext "Bk" backup header
const FILE_HEADER_SIZE = 0x80;
const FILE_MAGIC = 0x03adf17e;

/** Cheap structural check, used to offer the import dialog for a file the editor can't otherwise open. */
export function looksLikeSdExport(bytes) {
  if (bytes.length < BANNER_SIZE + BK_SIZE) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return v.getUint32(BANNER_SIZE) === 0x70 && v.getUint16(BANNER_SIZE + 4) === 0x426b; // size, "Bk"
}

/** Parses a hex string (spaces, commas, "0x" allowed) into exactly 16 bytes, or null. */
export function parseKey(text) {
  const hex = String(text).replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 32) return null;
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
}

/**
 * Decrypts the save files inside an SD export.
 * Returns { titleId: "SOUP", files: [{ name, data: Uint8Array }] }. Throws if the keys don't fit.
 */
export async function readSdExport(bytes, keyBytes, ivBytes) {
  if (!looksLikeSdExport(bytes)) throw new Error("This isn't a Wii SD-card save export.");
  if (!globalThis.crypto?.subtle) throw new Error("This browser doesn't allow decryption on this page. Open the editor from its website, or as a file in Chrome, Edge or Firefox.");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt", "decrypt"]);

  // The first 8 bytes of the decrypted header are the title ID (00010000 + game ID). That's enough to tell
  // whether the key and IV are right without decrypting the whole banner.
  const head = await decryptNoPadding(key, ivBytes, bytes.subarray(0, 16));
  const hv = new DataView(head.buffer);
  if (hv.getUint32(0) !== 0x00010000) throw new Error("The key or IV is wrong (the decrypted title ID doesn't make sense).");
  const titleId = String.fromCharCode(...head.subarray(4, 8));

  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint32(BANNER_SIZE + 0x0c);
  const files = [];
  let off = BANNER_SIZE + BK_SIZE;
  for (let i = 0; i < count; i++) {
    if (off + FILE_HEADER_SIZE > bytes.length || v.getUint32(off) !== FILE_MAGIC) throw new Error(`File entry ${i + 1} is damaged.`);
    const size = v.getUint32(off + 4);
    const type = bytes[off + 0x0a];
    const nameBytes = bytes.subarray(off + 0x0b, off + 0x50);
    const name = String.fromCharCode(...nameBytes.subarray(0, Math.max(0, nameBytes.indexOf(0)) || nameBytes.length));
    const fileIv = bytes.slice(off + 0x50, off + 0x60);
    const padded = Math.ceil(size / 0x40) * 0x40;
    off += FILE_HEADER_SIZE;
    if (type === 1) {
      if (off + padded > bytes.length) throw new Error(`${name} runs past the end of the export.`);
      const plain = await decryptNoPadding(key, fileIv, bytes.subarray(off, off + padded));
      files.push({ name, data: plain.slice(0, size) });
    }
    off += type === 1 ? padded : 0;
  }
  return { titleId, files };
}

/**
 * AES-128-CBC decryption of block-aligned data without padding. WebCrypto always expects PKCS#7 padding,
 * so this appends one block that decrypts to a full padding block, then drops it from the result.
 * (Encryption is only used here to build that one throwaway block; nothing is ever encrypted for output.)
 */
async function decryptNoPadding(key, iv, data) {
  if (data.length % 16) throw new Error("Encrypted data isn't block-aligned.");
  const last = data.subarray(data.length - 16);
  const pad = new Uint8Array(16).fill(16);
  const extra = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: last }, key, pad)).subarray(0, 16);
  const joined = new Uint8Array(data.length + 16);
  joined.set(data);
  joined.set(extra, data.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, joined));
}
