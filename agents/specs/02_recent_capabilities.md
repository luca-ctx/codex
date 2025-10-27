# Recent Harness Capabilities

- **Keep-going loop**
  - `/continue` toggles an auto-follow-up mode in the TUI. When enabled the widget immediately queues “Please continue…” after every completed assistant turn and reminds the agent to call `permanently_terminate_session` once nothing remains.
  - Automatic prompts are skipped if the human enqueues a message mid-turn, and the mode is force-disabled whenever the session terminates or the agent explicitly ends it.
  - Turn-finished hooks (see below) only run when keep-going is off and the outbound queue is empty so automation does not fire on every loop iteration.

- **Turn-finished hooks**
  - `[hooks.onAgentTurnFinished]` in `config.toml` accepts a shell `command` that runs after any turn that finishes without auto-continue, or immediately after `permanently_terminate_session`.
  - Each hook executes in the chat widget that produced the turn; failures are logged as warnings but do not halt Codex.

- **Session naming**
  - New rollouts adopt the configured name or reuse the latest name when resuming. Names capture both a human-readable title and a slugged identifier (ASCII, ≤64 chars, whitespace collapsed; falls back to `session` if no slug characters).
  - `/rename <title>` updates the active session. Duplicate titles emit a background notice and keep the existing slug.
  - Name updates stream through `SessionRenamed` events so the TUI history, resume picker, and rollout metadata stay in sync.

- **Auto-compaction behaviour**
  - Every model auto-enables compaction at ~95 % of its context window unless `model_auto_compact_token_limit` overrides (or disables) the trigger.
  - Overflow handling now does an inline compact-and-retry once before surfacing an error. The summarisation prompt asks for a detailed memento covering finished work, TODOs with file paths, missing tests, and handoff notes.
  - If the compaction prompt still exceeds the window, Codex trims older history, emits `Auto-compaction prompt still exceeded…` plus `Removed additional history content…` notifications, and records the fallback in the rollout log.
  - `scripts/generate_long_context.py` produces large fixtures (default ≈200 k tokens) for manual verification of the compaction path.

- **Agent-level tools**
  - `permanently_terminate_session` is available in every session. Use it only when no further work remains; it resets keep-going, emits a termination event, and triggers turn-finished hooks.
  - `request_code_review` starts the review-agent pipeline. Optional `plan`, `scope`, and `model` inputs are supported; the command returns immediately while background review events stream through standard review-mode updates.

- **MCP Codex orchestration**
  - `codex`: launches a fresh Codex session from MCP with optional overrides (model, plan tool usage, sandbox mode, approval policy) and returns a `conversation_id`.
  - `codex-reply`: sends additional turns to an existing `conversation_id`; rejects empty prompts client-side.
  - `codex-batch`: accepts multiple session specs in parallel and returns per-session status, labels, conversation IDs, and serialized tool outputs so orchestrators can branch follow-up work.
  - `codex-code-review`: runs the review-agent pipeline on an existing conversation. Requires `conversation_id` and `instructions`, plus optional `model` or `user_facing_hint`. Executes asynchronously with results delivered via review stream events.

- **MCP auth surfacing**
  - Startup now inspects each configured MCP server. If a client fails due to missing OAuth credentials the UI emits: `The <server> MCP server is not logged in. Run 'codex mcp login <server>' to log in.` Other startup failures still surface their full error text.

- **Shell timeout safety**
  - Shell and unified-exec commands default to a 1000 ms timeout (documented in the tool schemas). On timeout or Ctrl+C Codex kills the entire spawned process group before sending `SIGKILL`, preventing orphaned children.

- **Agent support tooling**
  - `tools/ask-human-cli`: pnpm-packaged Slack helper that DM’s the designated human, waits for a threaded response (5 min default), and reacts with ✅ when the reply arrives. Requires `SLACK_BOT_TOKEN` and `SLACK_USER_ID` via Infisical and is invoked with `pnpm --dir icp exec --package @icp/ask-human-cli ask-human-dev …`.
  - `tools/figma-api-cli`: workspace CLI mirroring the MCP Figma surface (context, metadata, variables, screenshots, design-system, automation). Auth via Infisical `FIGMA_PERSONAL_ACCESS_TOKEN`. Automation subcommands run Playwright jobs that use the paired plugin.
  - `tools/figma-automation-plugin`: Profound Automation Runner plugin that consumes jobs stored in editor `localStorage`, executes scripted/declarative actions, and logs prefixed `PH_AUTOMATION_RESULT` records for downstream parsing. Declarative jobs support selectors like `@last` or `#Node Name`.
  - `tools/penpot-dev-env`: docker-compose wrapper (`pnpm penpot-env start/status/stop/down/logs`) provisioning a deterministic Penpot 2.10.1 sandbox with seeded admin creds in `tools/penpot-dev-env/state/`.
  - `agents/skills/playwright`: refreshed Playwright automation playbook emphasising `/tmp` scripts, headful browsing defaults, and reusable patterns for responsive checks, auth, forms, and link validation. Scripts run via `node run.js <script>`.
  - `agents/skills/maestro`: Maestro mobile automation skill exposing helpers for executing flows, capturing screenshots, and collecting logs against cached builds and managed device manifests through `global.__MAESTRO_HELPERS`. Obeys `MAESTRO_SKILL_ROOT`.
