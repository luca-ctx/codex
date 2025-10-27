# ExecPlan: Continuous Context Cleaner
Created: 2025-10-23
Status: Completed
Last Updated: 2025-10-23

## Why It Matters
Large, noisy transcripts (especially redundant command output) currently persist until the auto-compactor runs near the context limit. This wastes tokens, forces emergency trims, and erodes autonomy. A conservative cleaner that continuously removes junk keeps the window focused on actionable information so agents can execute longer missions without human resets.

## Current Context
- Baseline behaviour: auto-compaction triggers ~95 % usage with fallback trimming (`agents/specs/02_recent_capabilities.md`).
- Idea brief captured in `agents/specs/03_random_ideas.md` (“Continuous Context Cleaning”).
- Dedicated Docker dev container `codex-cleaner` running (Ubuntu 22.04) with `/workspace/codex` mounted from the isolated host copy; Node 18, pnpm/corepack, Codex CLI, and Rust toolchains are already installed and verified.
- Host repo contains other in-flight changes; avoid touching unrelated files.
- Work must happen inside the container to isolate dependencies from other agents.

## Success Criteria
- [x] Container environment restored with Node 18+, Rust, and Codex CLI functioning (`codex --version` succeeds inside container).
- [x] Continuous context cleaner implemented behind a config flag (default off) in codex-core and triggered between turns.
- [x] Cleaner selectively patches history without touching human/user instructions or active plan/spec artifacts; includes unit tests covering skip/trim behaviour.
- [x] TUI/CLI messaging updated so agents understand cleaner activity (e.g., transcript notice or event log).
- [x] Documentation updates (AGENTS.md or relevant prompt/spec) describing how to enable/monitor the cleaner.
- [ ] Validation suite: targeted `cargo test` for new module, plus regression tests for compaction path; lint/format via `just fmt` and `just fix -p codex-core`.

## Work Overview
Stand up the Docker dev environment, implement a post-turn cleaner that inspects conversation history, prompts a helper to produce removals, applies the patch safely, and document the workflow. We will gate the feature behind config until confidence improves. All development (builds, tests, docs) happens inside the container; final changes are synced back to the host repo.

## Milestone 1: Container Environment Ready
**Scope:** Ensure `/workspace/codex` inside `codex-cleaner` has working toolchains (Node 18, pnpm, Codex CLI, Rust) so we can run Codex sessions and build Rust code without affecting the host.

**Steps:**
1. `docker exec codex-cleaner bash -lc "cd /workspace/codex && curl -fsSL https://deb.nodesource.com/setup_18.x | bash -"` to install NodeSource repo.
2. `docker exec … apt-get install -y nodejs` to install Node 18 (includes npm).
3. Enable pnpm/necessary globals (`corepack enable`, `npm install -g @openai/codex`).
4. Source Rust toolchain (`. $HOME/.cargo/env`) and confirm `rustc --version`, `cargo --version`.
5. Verify codex CLI (`codex --version`) and ensure `/workspace/codex` builds (`pnpm --version` optional).

**Validation:**
- Commands above succeed without error.
- `docker exec codex-cleaner codex --version` prints version.
- `docker exec codex-cleaner bash -lc "cd /workspace/codex/codex-rs && cargo --version"` prints installed toolchain.

**Rollback/Fallback:** If Node install fails, purge `nodejs` packages (`apt-get remove --purge nodejs npm`) and retry. Container is disposable; worst-case recreate container using previous setup notes.

**Status:** Complete

## Milestone 2: Implement Continuous Cleaner in codex-core
**Scope:** Add a new cleaner module invoked after each agent turn that asks a dedicated Codex sub-run to redact obvious noise (command logs, redundant stdout) via patch operations, respecting conservative safeguards.

**Steps:**
1. Review current compaction flow (`codex-rs/core/src/codex/compact.rs`, `codex.rs` state machine) to identify hook after successful turn completion but before enqueuing next prompt.
2. Design cleaner config struct (`config.toml` flag, e.g., `[context.cleaner] enabled`, thresholds). Add config parsing/defaults.
3. Implement cleaner runner:
   - Collect recent transcript slices (limit tokens).
   - Prompt helper template (new `codex-rs/core/templates/cleaner/prompt.md`) with instructions from spec.
   - Use internal Codex session (similar to compactor) to request `PatchHistory` actions removing ranges.
   - Validate patches (no user/human entries, no code blocks) before applying.
4. Integrate into turn lifecycle: after storing turn result and before auto-continue kicks, run cleaner if enabled and context usage > minimal threshold (e.g., >50%).
5. Emit events/logs for applied removals (for TUI display). Extend protocol if needed for new event type.
6. Guard with telemetry/logging toggles and ensure cleaner aborts gracefully on errors/timeouts.

**Validation:**
- Added `codex-rs/core/src/codex/cleaner.rs` with unit coverage for removable filtering and JSON parsing.
- Config plumbing (`ContextCleanerConfig`, session helpers) compiles; targeted cleaner tests pass in container.
- Cleaner wired post-turn in `codex.rs`, gated by config and emitting background summaries.

**Rollback/Fallback:** Feature is behind config flag; leave disabled if issues occur. Revert module integration by toggling flag or removing invocation.

**Status:** Completed

## Milestone 3: Surface Feedback and Sync Back
**Scope:** Update user-facing messaging, documentation, and ensure changes propagate to host workspace cleanly.

**Steps:**
1. Update TUI/CLI to present cleaner notifications (e.g., summary message in chatwidget). Add tests/snapshots if necessary.
2. Document feature in AGENTS.md and relevant spec references (link to this plan if needed).
3. Run formatting (`just fmt`) and scoped lint (`just fix -p codex-core`, plus other projects touched).
4. Execute targeted tests (`cargo test -p codex-core`, extended suites if shared crates touched).
5. Copy/container `rsync` or `tar` new files from `/workspace/codex` back to host repo `/home/luca/code/codex`.
6. Update this exec plan: mark milestones complete, log progress, set validation checklist.

**Validation:**
- Docs updated, tests pass, lint clean.
- Host repo reflects container changes (confirmed via `git status`).

**Rollback/Fallback:** If TUI snapshots fail, revert TUI changes and leave notifications minimal. If sync conflicts, reapply patches manually from container diff.

**Status:** Complete

## Progress Log
- 2025-10-23 – Plan drafted; awaiting environment setup.
- 2025-10-23 – Reinstalled Node 18, enabled corepack, installed codex CLI, and verified Rust/cargo inside `codex-cleaner`.
- 2025-10-23 – Implemented cleaner core (module, config plumbing, session helpers), added unit coverage, and wired post-turn hook with background summaries.
- 2025-10-23 – Documented cleaner usage in `AGENTS.md`, added keep-going reminder to request code reviews, and ran `just fmt`, `just fix -p codex-core`, `cargo test -p codex-core` (with `CODEX_SANDBOX_NETWORK_DISABLED=1` and `USER=root` to skip network-gated suites), plus `cargo test -p codex-tui`; all targeted tests now pass.

## Decision Log
- 2025-10-23 – Opted for config-flagged cleaner invoked post-turn to allow gradual rollout.

## Validation Summary
- [x] `docker exec codex-cleaner codex --version`
- [x] `docker exec codex-cleaner bash -lc "cd /workspace/codex && corepack enable && pnpm --version"`
- [x] `docker exec codex-cleaner bash -lc ". $HOME/.cargo/env && cd /workspace/codex/codex-rs && just fmt"`
- [x] `docker exec codex-cleaner bash -lc ". $HOME/.cargo/env && cd /workspace/codex/codex-rs && just fix -p codex-core"`
- [x] `docker exec -e CODEX_SANDBOX_NETWORK_DISABLED=1 -e USER=root codex-cleaner bash -lc '. $HOME/.cargo/env && cd /workspace/codex/codex-rs && cargo test -p codex-core'`
- [x] `docker exec codex-cleaner bash -lc '. $HOME/.cargo/env && cd /workspace/codex/codex-rs && cargo test -p codex-tui'`

## Risks & Follow-Ups
- Cleaner prompts may still over-trim valuable context; need careful safeguard heuristics and logs.
- Running extra Codex session per turn could add latency; monitor performance.
- Coordination with auto-compaction to avoid redundant work.

## Handoff Notes
- Start with Milestone 1 inside `codex-cleaner` container; Node toolchain is currently absent.
- Keep plan updated after each milestone; ensure validation checklist reflects actual commands run.

## Upon Completion
- [ ] permanently_terminate_session called: false
