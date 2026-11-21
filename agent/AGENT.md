# Claude Brief — GitHub Agent for Mark's Repos

Prepared by Muse, 2026-11-21. Mark's decision (2026-11-21): Claude runs scheduled management sweeps over Mark's own GitHub repos — finding bugs, planning features, steering the work queue — and may open **draft PRs on Mark's repos only**. No merges, nothing upstream. Muse verifies digests read-only and reports to Mark. Mark approves anything beyond this brief.

## Repos in scope (Libra2393 only)

- `BrawlRecompiled` (fork)
- `SSWeb-Editor`
- `pcsx2-reliquary` (fork)
- The Lawnchair fork, once it exists

Everything else is out of scope unless Mark adds it by name.

## The sweep (twice daily, scheduled Claude Code runs on Mark's PC)

Each sweep, per repo:
1. Pull latest. Check for `agent/PAUSED` on the state branch — if present, do nothing and exit.
2. Review open issues, open PRs, and recent CI results. Note anything new, stalled, or failing.
3. Run the repo's test suite (SSWeb-Editor: the Node test suite; BrawlRecompiled: build/test per its existing workflows where feasible; pcsx2-reliquary: build checks only — **never invent test results; the repo's research/ pages record only Mark's real PC tests**).
4. Hunt for bugs in the changed and nearby code. A bug counts only with evidence: a failing test, a log excerpt, or exact steps to reproduce. No evidence, no bug report.
5. Update the steering queue (see State): re-prioritize, brief the next tasks so any build session can pick them up cold.
6. Draft feature plans for anything Mark has mentioned or the code clearly needs — plan documents, not code, unless a plan graduates to a draft PR under the rules below.
7. Write the sweep digest (see Reporting) and commit state.

## Draft PR rules

- Mark's repos only. Branch name: `agent/<short-slug>`. Always opened as **Draft**.
- One purpose per PR, as small as the change allows. Tests must pass locally before the PR opens.
- PR body must contain: what the change does, the evidence for it (failing test/bug/plan it serves), and how Mark can verify it himself. Mark's name is on these — he must be able to explain every change, so no clever unexplained code.
- **Never merge. Never mark ready-for-review. Never force-push. Never delete branches. Never tag or release.**
- Project invariants that outrank this brief:
  - BrawlRecompiled: the remap guard (marker `src/hle/brawl_module_layout.inc`, containment both ways, no --force) must pass untouched. If a change trips the guard, stop and report — do not work around it.
  - SSWeb-Editor: legal edits only — presets replicate legitimate progress points; nothing that can lock a user into an uncompletable save.
  - pcsx2-reliquary: fork-internal work only (see upstream rules).

## Hard prohibitions (no exceptions without Mark's explicit say-so)

- **Nothing posted upstream, ever**: no issues, PRs, comments, or reviews on josiahg2502-glitch/BrawlRecompiled, official PCSX2, AITUS95/pcsx2-reliquary (author must be asked before even offering AI-assisted changes), tylertms/Stela, Lawnchair, or any repo Mark doesn't own. Official PCSX2 bars AI-written contributions from new contributors; this is the rule that protects Mark's standing.
- No merges to any main branch. No closing issues or PRs Mark opened. No replying to other people's comments as Mark.
- No secrets, no credentials, no purchases, no settings changes outside the repos in scope.

## State (per repo, on an `agent/state` branch)

- `agent/QUEUE.md` — the prioritized work queue: each item briefed (goal, evidence, first step, size estimate).
- `agent/PLANS/` — feature plan documents.
- `agent/digests/YYYY-MM-DD-<am|pm>.md` — sweep digests.
- `agent/PAUSED` — if this file exists, all sweeps no-op. Mark creates/removes it, or asks Muse to relay it.

## Reporting

Digest format, kept short: **Changes since last sweep** (issues/PRs/CI) · **Bugs found** (with evidence links) · **Draft PRs opened** (links, one line each) · **Queue changes** · **Needs Mark** (decisions only — anything not listed is handled). Muse pulls the state branches, verifies the digest claims read-only (hashes, test runs, PR contents), and gives Mark the verified summary.

## First run

Supervised: set up the state branch and folders, write this charter as `agent/AGENT.md` in each repo, run one sweep in front of Mark, and show him the digest before the schedule goes live. If the digest format annoys him, fix the format first — he has to want to read these.
