# Credits

This editor stands on years of research by the Skyward Sword modding, speedrunning and randomizer communities.
Each source below is listed with what was taken from it and under which license.

## Research and data

### WiiKing2 Editor — Antidote (antidote.crk), 2012
<https://github.com/Antidote/skyward-sword-save-editor> · GPL-3.0-or-later (per its source headers)

The original Skyward Sword save editor. Its research notes (`Skyward Sword Save Format.txt`,
`Skyward Sword Flags.txt`, `Skyward Sword Amounts.txt`, `SkipData.txt`, the 010 Editor template) and its source
gave the first map of `wiiking2.sav`: the slot layout and CRC32, the item, sword, wallet, bug and treasure
offsets, packed counters, and the labels in the **Story flags** tab. This project is licensed GPL-3.0-or-later in
keeping with it.

### The Legend of Zelda: Skyward Sword decompilation — zeldaret
<https://github.com/zeldaret/ss> · CC0-1.0

The save-file struct (field names and offsets, including the corrected heart fields and the spawn t1/t2/t3
fields), the flag managers' formats (story, item, scene and chest flags), and the story flag names used in
`defs/flags/storyflags.json`. The decompilation's flag notes credit lepelog's skywardsword-tools and the community
story-flag spreadsheet.

### Skyward Sword Randomizer — Skyward Sword Rando Team
<https://github.com/ssrando/ssrando> · MIT

Location names, original items and chest IDs (`checks.yaml`) behind the **Collectibles** tab, and the start-of-game
story and scene flags (`patches.yaml`) that the prologue preset was built from.

> Copyright 2020 Skyward Sword Rando Team
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
> to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions
> of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
> THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
> IN THE SOFTWARE.

The **object field layouts** used by `tools/romfs-flag-index.mjs` (which bits of an object's parameters hold its
flags, for chests, items, dig spots, area triggers, exits, event triggers, NPCs and push blocks) and its readers
for U8 archives, BZS object lists and MSBF event flows (including which event nodes set and check flags) follow the
randomizer's `gamepatches.py` and `sslib` (`u8file.py`, `bzs.py` (itself based on mrcheeze's skyward-sword-tools)
and `msb.py`).

### Skyward Sword Archipelago world — Battlecats59 and contributors
<https://github.com/Battlecats59/SS_APWorld> · no license file

The story and scene flag positions for each location in the **Collectibles** tab, and the scene index list in
`defs/flags/sceneflags.json`. Only the bit positions (facts about the game) were used, and every one was
re-checked against real save files. With thanks.

### Skyward Sword HD Randomizer — mint-choc-chip-skyblade and contributors
<https://github.com/mint-choc-chip-skyblade/sshd-rando> · AGPL-3.0

Its save-file struct for the Switch version confirmed that Skyward Sword HD keeps the Wii layout. No code or
data was copied.

### libAthena — the libAthena developers
<https://github.com/libAthena/athena> · MIT

The reference for the Wii SD-export format (Bk header, file entries). No code is included, and neither are its
keys; the editor asks the user for them.

### lepelog — skywardsword-tools
<https://github.com/lepelog/skywardsword-tools>

The story-flag research the decompilation's flag notes are based on.

## Own research

The Skyward Sword HD save layout (little-endian slots, the 4th autosave slot and the two per-slot data blocks),
the HD checksum (CRC32 over each slot plus its two blocks, found in the game's save code), and the story and item
flag tables were worked out for this project. The flag tables contain only flag positions (word, bit and width
per flag number), read from the game and cross-checked against the decompilation; no game code or assets are
included.

Testing used saves shared by players, Dolphin and Eden.

## Artwork

The icon, banner and social preview in `assets/` are original artwork drawn for this project as SVG (a gold
feather over a sky of clouds and floating islands). They use no Nintendo art and are licensed with the rest of the
project under GPL-3.0-or-later. `tools/render_art.sh` exports the PNG versions.

## Trademarks

The Legend of Zelda and Skyward Sword are trademarks of Nintendo. This is an unofficial fan project; it is not
affiliated with, endorsed or sponsored by Nintendo. No Nintendo code, assets or keys are included.
