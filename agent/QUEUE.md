# SSWeb-Editor — work queue

Last updated: 2026-11-21 (first sweep, main @ 2b2bcbc)

## 1. Extra Wallets can't be edited (issue #1)
- **Goal:** let users give themselves Extra Wallets (+300 each), so saves like the one in issue #1 can be fixed.
- **Evidence:** issue #1 (Max7512, 2026-11-11, no reply yet). `defs/inventory.json` has Medium/Big/Giant/Tycoon wallets but no Extra Wallet. `defs/tracker.json` lists it as "known" only: "Item 199 (Extra Wallet) in the item flag table; may be a counter."
- **First step:** find out how the game stores it. Mark compares two real saves: one before and one after buying an Extra Wallet. If it is one flag, it's a simple field. If it is a counter (0–3), it needs a number field.
- **Legal-edit check:** only allow counts the real game can reach. Add a risk entry like the other wallets (clearing it may lose the item).
- **Size:** M (most of the work is confirming storage on real saves).

## 2. Tracker "Wallets" group lists only 2 of 4 wallets
- **Goal:** confirm whether this is on purpose.
- **Evidence:** `defs/tracker.json` "Wallets" group has `mediumWallet` and `tycoonWallet`; `bigWallet` and `giantWallet` exist in `defs/inventory.json` but are not listed.
- **First step:** check other tracker groups to see if they list every field or only a sample.
- **Size:** S.

## 3. Branch tidy-up (Mark only)
- 11 branches on GitHub besides `main`. Some may be already merged. The agent never deletes branches; this is a list for Mark to review.
- **Size:** S.
