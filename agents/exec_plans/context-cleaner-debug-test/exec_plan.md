# ExecPlan: Context Cleaner Debug Validation
Created: 2025-10-23
Status: Completed
Last Updated: 2025-10-23

## Why It Matters
We recently shipped the continuous context cleaner but have not verified how well it behaves when Codex runs headlessly. A reproducible debug build test will confirm that the cleaner strips noisy shell output during long, non-interactive runs so we can trust it before wider rollout.

## Current Context
- Continuous cleaner design lives in `agents/specs/03_random_ideas.md`; implementation details and history captured in `agents/exec_plans/continuous-context-cleaner/exec_plan.md`.
- Debug binaries already exist under `codex-rs/target/debug/` (`codex`, `codex-exec`, etc.); instructions forbid invoking any release builds.
- `~/.codex/config.toml` has `[context.cleaner] enabled = true` with permissive thresholds (min_usage_percent = 0) so the cleaner should fire even on short runs.
- Codex sessions (transcripts + event logs) are persisted under `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`; these contain cleaner summaries we must inspect.
- The task requires creating a temporary noisy random-number script in `/tmp`, running Codex headlessly (`codex exec …`) with instructions to execute it 10 times, then auditing the resulting logs for cleaner activity.

## Success Criteria
- [ ] Local debug binary `codex-rs/target/debug/codex` is rebuilt and confirmed runnable without touching any release artifacts.
- [ ] `/tmp/noisy_rng.sh` (or equivalent) emits high-volume noise plus a clearly parsed `RESULT: <number>` line per run.
- [ ] Non-interactive Codex run completes, producing an answer with 10 collected random numbers.
- [ ] Associated session log shows context cleaner removal entries for the noisy stdout chunks while preserving the final `RESULT` lines.
- [ ] If cleaner misses noise, configuration and/or implementation is adjusted and retested until logs confirm robust trimming.
- [ ] ExecPlan milestones, progress log, decisions, and validation checklist are updated throughout the effort.

## Work Overview
Rebuild the debug CLI, craft a noisy RNG script, execute Codex in non-interactive mode with a prompt that exercises the cleaner, and audit the session logs. Iterate on configuration or code if the cleaner fails to prune noise, repeating the run until the logs look healthy.

## Milestone 1: Prep Debug Binary and Noisy Script
**Scope:** Ensure the debug CLI is up to date and create a reproducibly noisy RNG helper in `/tmp`.

**Steps:**
1. From `codex-rs/`, run `cargo build -p codex-cli` to refresh the debug binary.
2. Verify the binary with `./target/debug/codex --version`.
3. Author `/tmp/noisy_rng.sh` with executable permissions. Script requirements:
   - Print at least ~100 lines of irrelevant noise (`echo "noise line $i"` loops, timestamps, etc.).
   - Emit exactly one `RESULT: <int>` line at the end.
4. Smoke-test the script once manually (`bash /tmp/noisy_rng.sh`) and capture example output for later comparison.

**Validation:**
- `cargo build -p codex-cli` succeeds without invoking release mode.
- `./target/debug/codex --version` reports the expected CLI version.
- Manual script run outputs noisy chatter followed by a `RESULT: …` line.

**Rollback/Fallback:** If build fails, inspect existing artifacts but do not delete `target/debug`; resolve compilation issues or escalate. Remove `/tmp/noisy_rng.sh` if a cleaner version is needed and recreate it.

**Status:** Complete

## Milestone 2: Run Headless Session
**Scope:** Execute Codex via the debug binary with instructions to run the noisy RNG script 10 times and summarize results.

**Steps:**
1. Compose an instruction prompt (store in `/tmp/cleaner_prompt.txt`) telling Codex to:
   - Use `/tmp/noisy_rng.sh`.
   - Run it 10 times via the shell.
   - Collect all `RESULT` numbers.
   - Report the list and any aggregate stats without replaying raw logs.
2. Launch the run: `codex-rs/target/debug/codex exec --cd /home/luca/code/codex "$(cat /tmp/cleaner_prompt.txt)" | tee /tmp/cleaner_run.out`.
3. Wait for completion and confirm the output includes 10 numeric results.
4. Note the session slug printed in stdout or deduce it from the newest file under `~/.codex/sessions`.

**Validation:**
- Headless run exits successfully (status 0).
- Output file `/tmp/cleaner_run.out` contains Codex's summary with 10 collected numbers.
- Session ID identified for later log inspection.

**Rollback/Fallback:** If the run fails or Codex refuses to execute commands, adjust the prompt for clarity or fix script permissions, then rerun.

**Status:** Complete

## Milestone 3: Inspect Cleaner Behaviour and Iterate
**Scope:** Review session logs for cleaner activity; adjust configuration or code if noise was not trimmed, re-run Milestone 2 as needed.

**Steps:**
1. Locate the newest `rollout-*.jsonl` in the session directory from Milestone 2.
2. Search entries for cleaner events (`Context cleaner removed` or summary notifications).
3. Confirm that removed entries correspond to the noisy stdout chunks while preserving `RESULT` lines.
4. If noise remains:
   - Tweak cleaner configuration (e.g., lower `protected_tail_items`, adjust `max_item_bytes`) in `~/.codex/config.toml` and document the change.
   - If config tweaks fail, inspect `codex-rs/core/src/codex/cleaner.rs` heuristics and consider code adjustments (staying in debug mode).
   - Re-run Milestone 2 after adjustments and repeat log inspection.
5. Once satisfied, restore any temporary config adjustments to desired defaults and document final settings.
6. Update this plan’s Progress Log, Decision Log, and Validation Summary.

**Validation:**
- Session log clearly records cleaner removals of the noisy stdout segments.
- Final configuration documented in plan (and, if changed, left in a sensible default state).
- No regressions observed in subsequent reruns.

**Rollback/Fallback:** Revert config tweaks, or if code changes worsen behaviour, revert the edits and reassess before attempting another fix.

**Status:** Complete

## Progress Log
- 2025-10-23 – Plan drafted; status moved to In Progress in preparation for Milestone 1.
- 2025-10-23 – Completed Milestone 1 (debug CLI rebuilt, noisy RNG script authored and validated).
- 2025-10-23 – Ran headless session via `codex exec` (session `019a10c1-5595-7d60-9584-dc27940bae47`), agent produced 10-run summary; noticed it wrapped execution in Python capturing stdout, so noisy logs were suppressed.
- 2025-10-23 – Inspected debug sessions (`019a10e5-65ee-7401-9a69-32cf3f5f1455`, `019a10ef-25a4-74b1-baf7-822ae3240733`) and found the cleaner failing with HTTP 400 due to schema validation. Updated `build_output_schema` to require `"summary"` alongside `"removals"` and adjusted the cleaner prompt to mandate an empty string when no summary is needed. Rebuilt the debug CLI and reran (`019a10f3-ca48-7df3-b1c3-58c4b3dc0075`), confirming the cleaner removed the noisy shell output entry (#23, ~10.5k chars) while preserving the `RESULT` lines. Left the aggressive config overrides (`max_removals_per_turn = 10`, `protected_tail_items = 1`) in place for continued testing.
- 2025-10-23 – Restored cleaner config defaults (`max_removals_per_turn = 3`, `protected_tail_items = 6`), ran `just fmt`, and executed `cargo test -p codex-core`. Full suite hit the known `suite::tool_parallelism::read_file_tools_run_in_parallel` timeout, but rerunning that test in isolation passed. Milestone 3 validations complete; ready to wrap up.
- 2025-10-23 – Addressed review feedback by allowing optional `reason` in the cleaner schema, reran `just fmt`, reran `cargo test -p codex-core` (same timeout on the parallelism test), and re-confirmed the isolated test passes.

## Decision Log
- Require the cleaner model to always emit a `summary` string (allowing empty values) so the response schema satisfies the OpenAI validator; updated both the JSON schema builder and prompt copy accordingly.

## Validation Summary
- [x] `cargo build -p codex-cli`
- [x] `codex-rs/target/debug/codex --version`
- [x] `bash /tmp/noisy_rng.sh`
- [x] `codex-rs/target/debug/codex exec --cd /home/luca/code/codex "$(cat /tmp/cleaner_prompt.txt)"`
- [x] Session log review confirming cleaner removals
- [x] `cargo test -p codex-core` (full run hit known timeout; targeted rerun of `suite::tool_parallelism::read_file_tools_run_in_parallel` succeeded)

## Risks & Follow-Ups
- Cleaner may over-aggressively trim relevant transcript pieces; monitor logs to ensure summaries remain intact.
- Headless run could reuse cached sessions; ensure we inspect the correct transcript.
- Repeated test runs may clutter `/tmp`; ensure temporary files are cleaned up afterward.

## Handoff Notes
- Begin with Milestone 1. Keep `/tmp/noisy_rng.sh` and `/tmp/cleaner_prompt.txt` consistent between reruns.
- Record any configuration modifications and restore defaults when done to avoid surprising other agents.

## Upon Completion
- [ ] permanently_terminate_session called: false
