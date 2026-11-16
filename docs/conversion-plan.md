# Wii ↔ HD conversion — plan (v0.5)

Written 16 November 2026 against `main` at `fe590f7`. Status: steps 0–3 below are built (step 3, the import, on
branch `import-file`); step 4 waits for the in-game checks. What was checked and how is said next to each claim. Things that are inferred or unknown are in
[Open questions](#open-questions) and are not built on silently.

## Summary

A file (slot) is the same 0x53BC-byte structure in both formats. Only the byte order of its multi-byte values
differs, plus **one** field whose meaning differs (the saved-at time). So conversion is a byte-order pass driven by a
four-row type map, one value translation, and rules for the few things that live outside the slot.

The plan is to ship it as **importing a file from a save of the other format into the save that is open**. The open
save was written by the target game, so its header, its HD-only blocks and its playthrough IDs are real and stay as
they are. Nothing has to be invented. Converting a whole save with no target to import into is a second, smaller
step that waits for in-game results.

## Evidence so far

Checked on the 100% NTSC Wii reference save (three files in use) and the HD save used for the v0.4 checks, with a
throwaway prototype of the type map below:

| Check | Result |
|---|---|
| Every usable slot field in the editor's definitions, both formats, sits inside the type map with a matching width | 0 disagreements |
| Each Wii file converted to HD byte order, then every field read with the HD definitions and compared with the Wii definitions reading the original | 12,744 reads, 0 differences (saved-at time excluded, see below) |
| Wii → HD → Wii | byte-identical, all three files |
| Fields usable in one format's slot but not the other's | none |
| The Wii save's own cutscene block (see below) | CRC32 matches in all three chunks; identical to that save's `skip.dat` |

What this does **not** show: that either game accepts a converted file. The HD file used here had its slots written
by the editor, not by the game, so the HD side of the type map rests on the definitions (which have been exercised
in Sky Recomp and Eden) rather than on a fresh game-written sample. See
[In-game acceptance](#in-game-acceptance-marks-step).

## 1. Field-by-field correspondence

### The slot (0x0000–0x53BB): same offsets, different byte order

Source for the widths: the `SaveFile` struct in the zeldaret/ss decompilation (`include/toBeSorted/save_file.h`),
cross-checked against every field definition in `defs/`.

| Range | Unit | What is there |
|---|---|---|
| 0x0000–0x000F | 8 bytes | play time, saved-at time |
| 0x0010–0x08D3 | 4 bytes | spawn positions, beacon positions (floats), Beedle's path, areas visited, pouch (8) and item check (60), file area index |
| 0x08D4–0x531B | 2 bytes | hero's name (UTF-16), story / item / dungeon / scene / chest flags, kill and hit counters, temporary / zone / enemy flags, potion timers, hearts, rooms, angles |
| 0x531C–0x53BB | 1 byte | area names (ASCII), beacon bits, Sky Keep layout, layers, entrances, the new-file flag, B item, pouch slots, night flags |

Converting a slot reverses the bytes of every unit in the first three rows and copies the fourth. It is its own
inverse, so the same pass serves both directions. Because it carries whole words, it also carries bytes the editor
has no field for (temporary, zone and enemy flags, unnamed scene flags), which a field-by-field copy would drop.

Regions whose width the decompilation does not name were looked at in every file available. 0x2E64–0x2F63 (after the
chest flags) and 0x53B5–0x53BB are zero in the three game-written Wii files (and in the editor-built HD ones), so
their unit cannot matter yet; they are treated as 2-byte and 1-byte like their neighbours and listed under open
questions.

### The one field that changes meaning: saved-at time (0x0008)

| | Wii | HD |
|---|---|---|
| Stored as | ticks since 2000-01-01 at 60,750,000 per second, console local time | seconds since 1970-01-01, UTC |

The value is translated, not byte-swapped: the wall-clock date and time are kept. The Wii value carries no time zone,
so the result can be off by the player's UTC offset; it only affects the date shown on the file-select screen. HD → Wii
loses nothing; Wii → HD drops the sub-second part.

Play time (0x0000) uses the same tick rate on both (checked in Sky Recomp, per `defs/general.json`) and is only
byte-swapped.

### Outside the slot

| Thing | Wii | HD | Conversion rule |
|---|---|---|---|
| Game ID, `general.region` (file 0x00, 4 chars) | `SOUE` / `SOUP` / `SOUJ` / `SOUK` | `PROJ` | Belongs to the file, not to a slot. Import never touches the target's. Dropped on Wii → HD. For a whole-file HD → Wii conversion the user must pick the region of their disc; there is no default. |
| Header word at 0x1C | `0x1D` | `0x2B` | On Wii the game rejects the whole save unless it is `0x1D` (`checkFileStatus` in the decompilation), and checks the region too. HD meaning unknown (one sample). Import leaves the target's; whole-file HD → Wii must write `0x1D`. |
| Number of files | 3 | 4 (the 4th is the game's autosave) | Import is one file at a time into the file the user selected. The HD autosave can be a source like any other. Nothing is ever written to HD file 4 unless the user selects it. |
| Cutscenes-seen block | 0xFB60, 3 × 0x24: 16 words + CRC32 of them | 0x14F20, 4 × 0x24: 16 words + 4 bytes always zero | See below. |
| `skip.dat` (separate file) | 0x80 bytes, same three chunks | 0xA0 bytes | Not written by import. HD rebuilds it from the save's copy (observed). Whole-file HD → Wii can offer a matching `skip.dat` download. |
| HD extra block (0x2238 per file) | — | zero in every file seen | See section 2. |
| HD second block (0x118 per file) | — | playthrough ID twice | See section 2. |
| HD shared block (0x1D890, 0x120) | — | 3 non-zero bytes, meaning unknown | Not a per-file thing. Import leaves it. |

**Finding on the way: the Wii save has the cutscene block too.** The decompilation's `SavedSaveFiles` puts
`SkipData skipData[3]` right after the third slot, and the reference save confirms it: three 0x24-byte chunks at
0xFB60, each 0x20 bytes of flags followed by their CRC32 (big-endian), identical to the chunks in that save's
`skip.dat`. The game signs every chunk, used or not (`initSkipData`, `clearFileA`), and on load wipes a chunk whose
CRC is wrong and re-signs it (`checkFileStatus`) — so a bad chunk costs the player their skips, not their save. The
editor's Wii layout had a wrongly placed "Trailer" scope there and no checksum for it; step 0 (branch
`wii-cutscene-block`) fixes that.

**Cutscene bits.** The numbering agrees where it can be compared: the seven bits named from HD play (opening,
first trip to the Sealed Grounds) are all set in the Wii 100% save at the same word and bit. Counting 16-bit words,
the Wii 100% save uses words 0–4 and 6–8 in all three files; every HD bit seen so far is inside that range. (An
earlier draft said HD used a word the Wii never sets; that came from counting bytes in one format and words in the
other.) These bits record cutscenes watched, not progress; on Wii they are what allows skipping.

- Wii → HD: copy the 16 words (byte-swapped); the 4 trailing bytes stay zero.
- HD → Wii: copy the 16 words (byte-swapped), write the chunk's CRC32. Nothing is dropped.

## 2. The scopes that travel together (HD)

Stated source for each, for a file imported into an HD save:

| Block | Source in the converted file | Why |
|---|---|---|
| Extra block, 0x2238 | all zero | It is zero in every HD file seen, including long game-written ones. A file with it zero is a state the game produces. |
| Second block, playthrough ID (0x00–0x0F and 0x54–0x63) | **the target file's existing ID, kept** | Every HD file, even an empty one, already has an ID (that is what Clear file preserves). Keeping it means no ID is invented. This is the same rule presets use. |
| Second block, everything else | zero | Zero in the files seen. One earlier observation says byte 0x10 was 1 on files the game had saved; files without it loaded and played in Sky Recomp. Open question. |
| Cutscene chunk | converted from the source's chunk | Section 1. |

For a file imported into a Wii save none of these exist; the HD blocks are simply not carried.

The only case that needs made-up values is a whole-file Wii → HD conversion with no HD save to import into: four new
random IDs (as a new game gets), the header word and the three shared-block bytes copied from the one sample seen.
That is why whole-file conversion is a later step, behind a real test.

## 3. Checksums

- The slot checksum is **never carried**. After the byte-order pass the target's own rule computes it from the
  converted data: CRC32 of the slot on Wii; CRC32 of slot + extra block + second block on HD.
- Import goes through the "replaced whole" path v0.4 added (`markReplaced`), the same one Clear file, Copy to and
  presets use. So the file is signed normally even if the target file was bad on load, and it is never seen as
  "bad on load" itself. "Revert changes" undoes the import until it is saved.
- **A source file whose checksum is bad cannot be imported.** Converting would re-sign it under another format's
  rule, which is laundering by another route. The message says to open that save and use "Re-sign bad checksums
  anyway" first if the user knows why it is bad.
- The Wii cutscene chunk gets its CRC32 written; the HD one stays without.
- A whole-file conversion produces a new, fully signed file that opens as an unsaved document with no link to the
  source file on disk, so it can only be downloaded, never written over the original.

## 4. What a converted save may claim

The converted file holds exactly the source file's state: same story point, same inventory, same counters, same
spawn. The complete list of bytes that do not come from the source file:

1. Saved-at time: same wall-clock moment, different encoding.
2. The slot checksum and, on Wii, the cutscene chunk's checksum: computed.
3. HD playthrough ID: the target file's own, unchanged.
4. HD extra block: zero.

Nothing is set that the source did not have, and the hero's name and Hero Mode come from the **source** (unlike a
preset, this is the player's own file moving across).

Two things conversion cannot make safe, and will say so:

- **Song of the Hero on Wii.** The Wii game has a known bug that can make the Song of the Hero quest impossible to
  finish depending on the order of events and reloads; HD fixed it. A file that is fine in HD can be exposed to that
  bug once it is a Wii file. HD → Wii warns when the source is inside that quest (Levias done, song not complete),
  naming the bug. It does not try to judge whether the file is already stuck.
- **A file that is already stuck stays stuck.** Conversion does not repair anything.

## How it is built

0. **Wii layout fix** (separate small change): replace the "Trailer" scope with a `skip` scope (0xFB60, 0x24 × 3,
   companion of the slot) and its CRC32; let the Cutscenes tab show on Wii.
1. **Type map in the definitions**, on the slot scope of both layouts (`"units": [[start, end, bytes], …]`), with a
   test that every field agrees with it. The map is data, like everything else in `defs/`.
2. **`convertSlot` in `js/codec.js`** (or a small `js/convert.js`): source SaveFile + file index → bytes in the
   target's byte order, plus the saved-at translation and the cutscene chunk. No DOM.
3. **"Import a file from another save…"** next to "Copy to" in `js/app.js`: pick a `wiiking2.sav` (either format;
   a same-format file works too, with no byte-order pass), choose which of its files, confirm. The confirm names the
   occupied target file and its play time, as presets do, and carries the Song of the Hero warning when it applies.
4. **Whole-save conversion**, only after step 3 has passed in both games.

## Tests (generated saves, added to the suite)

- Every field in both formats agrees with the type map (width and alignment).
- A filled Wii file imported into an HD save: every shared field reads the same through the HD definitions; the
  saved-at time is the same wall-clock second; checksums valid; the other files and the shared block are untouched;
  the target's playthrough ID is unchanged; the extra block is zero.
- The same in the other direction; the cutscene words carried over and the chunk CRC valid.
- Wii → HD → Wii and HD → Wii → HD: slot and cutscene bytes identical, apart from the sub-second part of a Wii
  saved-at time (HD stores whole seconds) and the checksum over it. On the 100% Wii save, file 2 there and back
  differs in exactly bytes 0x0C–0x0F and the stored CRC; the generated test saves use whole seconds.
- A bad-checksum source is refused and the target is not changed.
- Import onto a bad-on-load target ends valid; revert restores the hold.
- Same-format import equals Copy to.

## In-game acceptance (Mark's step)

No test above can show that the games accept the result. When step 3 exists:

| # | From | To | Look for |
|---|---|---|---|
| 1 | Wii 100% save, file 2 | an HD save, in Sky Recomp | file-select shows the right name, hearts and time; loads at the statue; inventory and map intact; can save |
| 2 | An early Wii file (before the first dungeon) | HD | same, plus the next cutscene and story step trigger normally |
| 3 | A Sky Recomp file | a Wii save, in Dolphin | same checks; cutscenes already seen can be skipped |
| 4 | Each file after the game has saved it again | back into the editor | checksum valid; Compare against the converted file shows what the game itself rewrote |

Step 4 is the important one for the open questions: whatever the game changes on its first save is something the
conversion got differently from the game.

## Open questions

1. **HD second block, byte 0x10** — set by the game on files it has saved? Needs one game-written HD save (the
   device with the live Sky Recomp save was offline when this was written).
2. **Header word 0x1C on HD** (`0x2B`) and the **HD shared block** — meaning unknown. (On Wii, 0x1C must be `0x1D`:
   settled by the decompilation.) Import avoids both; whole-file conversion cannot.
3. **Cutscene words 9–15** — unused in both formats, or used and never set in the saves seen? Copied as they are either way.
4. **Widths of 0x2E64–0x2F63 and 0x53B5–0x53BB** — zero everywhere so far.
5. **Saved-at time zone** — is the HD value really UTC, and does anything but the file-select screen read it?
6. **HD-only state inside the slot** — none is known, and no field differs between the definitions, but a
   game-written HD file compared after acceptance test 4 is the real check.
7. **PAL / Japanese / Korean Wii saves** — the definitions have no region-specific fields today; untested.
