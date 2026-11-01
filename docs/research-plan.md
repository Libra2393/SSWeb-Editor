# Research plan: the save bytes still unexplained

What a flag-copy preset needs is now fully described. These are the bytes that are still unknown or only
partly known, with the cheapest way to settle each. "Offline" means it can be done from game data or saves
already collected; "in game" means a short session in Sky Recomp with the snapshot watcher running
(back up the save, write prepared files, one action per save, diff consecutive snapshots).

| # | Bytes | Known so far | How to settle it | Where |
|---|-------|--------------|------------------|-------|
| 1 | `0x53B5` save-prompt byte | 1 in Wii post-dungeon prompt saves and HD autosaves, 0 in statue saves | Take one real save prompt: the one after the flight tutorial, before the Wing Ceremony, is the earliest. Build an HD file at that point from the prologue preset minus the Wing Ceremony flags, spawn it at the tutorial landing with the entrance load flag, accept the prompt. | In game |
| 2 | Dungeon flag 4 (word 0 bit 3) | Only ever set in Skyview Temple and the Ancient Cistern | Extend `tools/romfs-flag-index.mjs` to record dungeon-flag writes (event-flow flag nodes and object parameters, as for story/scene flags) and see which event or object sets it. | Offline |
| 3 | Dungeon flags 9–11 and 14 (words 2, 4, 5, 6) | Never non-zero in any save | Same index as #2. If nothing in the game data writes them, mark them unused. | Offline |
| 4 | Dungeon flag 2, 12, 16 labels (map, boss key obtained / used) | "Probable", from comparing saves | Same index as #2: the map chest and boss-key chest/door objects should reference them. | Offline |
| 5 | HD extra block 1 (`0x2238` bytes per slot at `0x14FB0`) | Covered by the slot checksum; contents unknown | Diff the block across the 46 Sky Recomp snapshots to separate constant bytes from ones that change with play; then follow the HD save routine near the checksum code (`0xDFA7E4` in v1.0.1) to see what fills it. | Offline |
| 6 | HD extra block 2 (`0x118` bytes per slot at `0x1D9B0`) | `+0x00` and `+0x54`: 16-byte per-file ID, copied into autosaves; `+0x10` changes too | Same as #5. | Offline |
| 7 | Sky Keep room layout (`0x539C`, 9 bytes) | Named in the decompilation; default `00 01 02 03 04 05 06 07 FF` | Convert the All Dungeons "Sky Keep" split to an HD flag preset (`tools/preset-from-save.mjs`, default mode), spawn it inside Sky Keep, slide one room at the control panel, save. | In game |
| 8 | Enemy kill/hit counters 20, 36, 79 | One counter per enemy type; 62 is the Chuchu | Look for the counter index in each enemy actor in the decompilation; otherwise kill one known enemy type and save. | Offline first |
| 9 | Temporary and zone flags (`0x30F4`, `0x30FC`) | Reset when an area loads | Low priority: no effect on reproducing a save. | — |

Order: the offline items (#2–#6, #8) first, since they need no play; then one in-game session covering
#1 and #7.
