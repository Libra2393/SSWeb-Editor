# SSWeb-Editor — work queue

Last updated: 2026-11-26 am sweep (main @ ed964d7)

## 1. Extra Wallets can't be edited (issue #1)
- **Status:** fixed — merged to main at ed964d7 on 2026-11-25 (Extra Wallets 0-3 + obtained flag; verified by Muse; tested in Sky Recomp). Mark replied on issue #1 on 2026-11-26 00:22 UTC. Issue is still open; closing it is Mark's call (wait for the reporter, or close). Sweeps: nothing to do here.
- **Goal:** let users give themselves Extra Wallets (+300 each), so saves like the one in issue #1 can be fixed.
- **Evidence:** issue #1 (Max7512, 2026-11-11, no reply yet). `defs/inventory.json` has Medium/Big/Giant/Tycoon wallets but no Extra Wallet. `defs/tracker.json` lists it as "known" only: "Item 199 (Extra Wallet) in the item flag table; may be a counter."
- **First step:** find out how the game stores it. Mark compares two real saves: one before and one after buying an Extra Wallet. If it is one flag, it's a simple field. If it is a counter (0–3), it needs a number field.
- **Legal-edit check:** only allow counts the real game can reach. Add a risk entry like the other wallets (clearing it may lose the item).
- **Progress (2026-11-22 pm sweep):** branch `extra-wallets` @ `4947896` adds the count (0-3, counter 508) and the obtained flag (item flag 199), risk entries and tests. CI passed; local `npm test` 64 pass, 0 fail, 2 skipped.
- **Next:** Mark reviews the branch and opens the PR himself.
- **Size:** M (most of the work is confirming storage on real saves).

## 2. Branch tidy-up (Mark only)
- 12 branches on GitHub besides `main` (11 plus `agent/state`). `extra-wallets` is now fully merged (same commit as main, ed964d7). Others may be merged too. The agent never deletes branches; this is a list for Mark to review.
- **Size:** S.

## Done
- **Tracker "Wallets" group (was item 2) — on purpose, not a bug.** Other wishlist groups also list only some fields (Swords: 3, Songs and Triforce pieces: 3, Bugs: 3, Cutscenes: 7). README "Coverage tracker" says an item is *in editor* once the listed fields exist, so a sample is enough. All 4 wallets are editable in `defs/inventory.json`. Closed 2026-11-21 pm.
