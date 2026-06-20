# ExecPlan: Context Cleaner Code Quality
Created: 2026-06-20
Status: Complete
Last Updated: 2026-06-20

## Why It Matters
The continuous context cleaner is a harness-level capability aligned with the project goal of reducing wasted context usage. Its current implementation is concentrated in one large Rust module, which makes behavior changes harder to review and increases the risk of accidental transcript-removal regressions. This plan improves maintainability while preserving behavior and adding focused guardrail tests.

## Current Context
- Canonical project specs live under `agents/specs/` and emphasize harness-level capabilities, context efficiency, and real validation.
- Repo instructions prohibit editing spec files and require `just fmt`, `just fix -p <project>`, and crate-specific tests after Rust changes.
- The cleaner currently lives in `codex-rs/core/src/codex/cleaner.rs` and combines task orchestration, model JSON parsing, history presentation, removal selection, removal application, and tests.
- The current branch is `codex/improve-code-quality`; untracked `.codex/` and `.entire/` directories are outside this PR scope.

## Success Criteria
- [ ] Cleaner orchestration stays in `codex-rs/core/src/codex/cleaner.rs`.
- [ ] History rendering, model response parsing, and removal application are separated into focused submodules.
- [ ] Existing cleaner behavior is preserved, including protected-tail handling and shell-output-only removal.
- [ ] New or moved tests cover module boundaries and the most important safety guardrails.
- [ ] `just fmt`, `just fix -p codex-core`, and `cargo test -p codex-core cleaner` pass.

## Work Overview
Refactor the cleaner module without changing public runtime behavior. Keep the async orchestration in the parent module and move pure helpers into child modules so they can be tested independently. Avoid broad style churn outside the cleaner and avoid unrelated workspace files.

## Milestone 1: Split Cleaner Responsibilities
**Scope:** Create child modules under `codex-rs/core/src/codex/cleaner/` for history presentation, model response parsing, and removal application.

**Steps:**
1. Add `mod history;`, `mod removal;`, and `mod response;` to `codex-rs/core/src/codex/cleaner.rs`.
2. Move `HistoryView`, entry description, shell-call collection, formatting, and associated tests into `codex-rs/core/src/codex/cleaner/history.rs`.
3. Move cleaner response schema, JSON parsing, summary normalization, and response-text extraction into `codex-rs/core/src/codex/cleaner/response.rs`.
4. Move removal selection, history replacement, and removed-summary formatting into `codex-rs/core/src/codex/cleaner/removal.rs`.

**Validation:** Run `cargo test -p codex-core cleaner` and expect all cleaner tests to pass.

**Rollback/Fallback:** If the split causes excessive visibility churn, keep the helpers in the parent module and only extract the lowest-risk pure parsing helpers.

**Status:** Complete

## Milestone 2: Add Guardrail Tests
**Scope:** Add tests that lock down the refactor's safety boundaries without relying on live model calls.

**Steps:**
1. Test that malformed cleaner output returns a parsing error instead of silently removing items.
2. Test that non-shell tool output remains non-removable.
3. Test that protected tail entries still protect messages but do not block shell output cleanup.
4. Prefer equality assertions over field-by-field checks where practical.

**Validation:** Run `cargo test -p codex-core cleaner` and expect all cleaner tests to pass.

**Rollback/Fallback:** If a test is too coupled to internal representation, replace it with a higher-level assertion through `HistoryView::build` or `select_removals`.

**Status:** Complete

## Milestone 3: Format, Lint, and Publish
**Scope:** Finalize Rust formatting/linting, review the diff, commit the intended files only, push, and open a draft PR.

**Steps:**
1. Run `just fmt` from `codex-rs/`.
2. Run `just fix -p codex-core` from `codex-rs/`.
3. Run `cargo test -p codex-core cleaner` from `codex-rs/`.
4. Inspect `git diff` and `git status -sb`; stage only the cleaner refactor and this plan.
5. Commit with a terse quality-improvement message.
6. Push `codex/improve-code-quality` and open a draft PR against the remote default branch.

**Validation:** Formatting, lint fix, and focused tests pass; draft PR URL is available.

**Rollback/Fallback:** If lint reveals unrelated workspace issues, document them and keep the PR scoped to files changed by this plan.

**Status:** Complete

## Progress Log
- 2026-06-20 - Read repo instructions, original AGENTS guidance, specs, and the exec-plan guide; selected the context cleaner as the PR scope.
- 2026-06-20 - Created this ExecPlan and started Milestone 1.
- 2026-06-20 - Completed the cleaner split into `history`, `response`, and `removal` submodules with focused unit tests.
- 2026-06-20 - Ran `cd codex-rs && cargo test -p codex-core cleaner`; 13 cleaner tests passed. The run reported pre-existing `list_dir` dead-code warnings plus one unused import from the refactor, which was removed afterward.
- 2026-06-20 - Installed missing `just` with `cargo install just --locked`; `cd codex-rs && just fmt` completed with rustfmt warnings that `imports_granularity=Item` is nightly-only on this toolchain.
- 2026-06-20 - Ran `cd codex-rs && just fix -p codex-core`; it completed successfully and only reported pre-existing `list_dir` dead-code warnings.
- 2026-06-20 - Ran final `cd codex-rs && cargo test -p codex-core cleaner`; 13 cleaner tests passed with the same pre-existing `list_dir` warnings.
- 2026-06-20 - Ran `cd codex-rs && cargo test --all-features`; workspace validation failed in unrelated `suite::sandbox::python_multiprocessing_lock_works_under_sandbox` from `codex-exec`. Reran `cargo test -p codex-exec --test all python_multiprocessing_lock_works_under_sandbox --all-features`; it failed the same way. The Python multiprocessing snippet succeeds outside the sandbox when run from a file in `/tmp`, so the blocker appears sandbox/Python-runtime specific and outside this cleaner refactor.
- 2026-06-20 - Review agent reported no Rust issues and one stale Handoff Notes issue in this plan; updated the handoff note.
- 2026-06-20 - Committed the cleaner refactor, pushed `codex/improve-code-quality`, and opened draft PR https://github.com/luca-ctx/codex/pull/1.
- 2026-06-20 - Inspected failed GitHub checks on the draft PR. `Check for spelling errors` reports existing repo-wide typos, including `agents/specs/` files that are out of scope to edit. `build-test` fails in `scripts/stage_npm_packages.py` because it cannot find a `rust-release` workflow for version `0.40.0`. `cla` fails because `cla-signatures` is missing and the committer needs CLA state. None of these failures are caused by the cleaner refactor.

## Decision Log
- 2026-06-20 - Chose a behavior-preserving modularization over opportunistic broad cleanup; this improves reviewability and reduces risk around transcript mutation.
- 2026-06-20 - Kept the plan under `agents/exec_plans/` because that is the actual repository path and guide location.

## Validation Summary
- [x] `cd codex-rs && just fmt`
- [x] `cd codex-rs && just fix -p codex-core`
- [x] `cd codex-rs && cargo test -p codex-core cleaner` (initial focused run)
- [x] `cd codex-rs && cargo test -p codex-core cleaner` (final post-format/lint run)
- [ ] `cd codex-rs && cargo test --all-features` (blocked by unrelated `codex-exec` sandbox/Python multiprocessing failure)

## Risks & Follow-Ups
- The cleaner helpers are internal and test-heavy; visibility should remain `pub(super)` or narrower where possible.
- A broader future improvement could add integration coverage for the full cleaner task stream, but this PR should avoid live model dependencies.
- `codex-exec`'s `python_multiprocessing_lock_works_under_sandbox` currently fails reproducibly in this environment under Python 3.14-style multiprocessing/resource-tracker behavior; it should be handled in a dedicated sandbox compatibility task.
- Draft PR CI has unrelated repository/workflow failures in Codespell, `build-test`, and CLA as recorded in the progress log.

## Handoff Notes
Work is complete and published in draft PR https://github.com/luca-ctx/codex/pull/1. The only remaining follow-up is the unrelated `codex-exec` sandbox/Python multiprocessing validation failure noted above; do not touch `agents/specs/`, `.codex/`, or `.entire/`.

## Upon Completion
- Once all milestones and tasks have been completed, call `permanently_terminate_session`.
- permanently_terminate_session called: false
