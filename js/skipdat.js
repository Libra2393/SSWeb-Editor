// skip.dat: the per-file "cutscenes seen" record the game keeps beside the save. The game reads cutscene marks from
// it, not from the save's own copy, and overwrites the save's copy from it when it saves a file. So the editor
// reads skip.dat into the save's cutscene block (the Cutscenes tab then shows what the game uses) and writes it back
// from that block. Only formats whose layout declares the file as a "sidecar" do this: on HD its layout isn't
// mapped yet, and a file the editor doesn't understand is never written.
import { num } from "./codec.js";

/** The layout's description of skip.dat, or null when this format's skip.dat isn't known. */
export function skipSidecar(defs) {
  return (defs.layout.sidecars || []).find((s) => s.file === "skip.dat") || null;
}

/** The bytes of skip.dat as the open save would write it now. Call after updateChecksums. */
export function skipDatBytes(save) {
  const sc = skipSidecar(save.defs);
  if (!sc) throw new Error(`${save.defs.format.label} skip.dat isn't mapped, so the editor doesn't write it.`);
  return save.bytes.slice(num(sc.start), num(sc.start) + num(sc.length));
}

/** Why these bytes can't be taken as this format's skip.dat; empty when they can. */
export function skipDatProblems(save, bytes) {
  const sc = skipSidecar(save.defs);
  if (!sc) return [`${save.defs.format.label} skip.dat isn't mapped yet, so the editor doesn't read it.`];
  if (bytes.length !== num(sc.length)) return [`That file is ${bytes.length} bytes; a ${save.defs.format.label} skip.dat is ${num(sc.length)}.`];
  const probe = save.defs.layout.checksums.find((c) => c.scope === sc.scope);
  const problems = [];
  if (probe) {
    const copy = new save.constructor(save.bytes.slice().buffer, save.defs);
    copy.bytes.set(bytes, num(sc.start));
    for (let n = 0; n < copy.scopeCount(sc.scope); n++) {
      if (copy.checksumValid(probe, n) === false) problems.push(`The checksum of file ${n + 1}'s cutscene chunk in that skip.dat is wrong. ` +
        "The game would wipe that chunk when it loads, so the file isn't taken as it is.");
    }
  }
  return problems;
}

/**
 * Copies skip.dat into the save's cutscene block. Each file's chunk counts as replaced whole (it is the game's own
 * record, signed), so it is written normally on save and Revert on the file undoes it. Throws on problems.
 */
export function readSkipDat(save, bytes) {
  const problems = skipDatProblems(save, bytes);
  if (problems.length) throw new Error(problems.join("\n"));
  const sc = skipSidecar(save.defs), start = num(sc.start);
  save.bytes.set(bytes, start);
  for (let n = 0; n < save.scopeCount(sc.scope); n++) save.replaced.add(`${sc.scope}:${n}`);
}

/** True when the save's copy of the skip.dat bytes differs from what was loaded. */
export function skipDatChanged(save) {
  const sc = skipSidecar(save.defs);
  if (!sc) return false;
  const a = num(sc.start), b = a + num(sc.length);
  for (let i = a; i < b; i++) if (save.bytes[i] !== save.original[i]) return true;
  return false;
}
