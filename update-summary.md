**Automation & Recovery**
- *Progress mode*: Introduced automatic “keep-going” flows with manager/worker tooling. The TUI can auto-queue follow-up prompts, and the core adds delegate-worker, session termination, and review-agent handlers so orchestrators can spin off targeted sub-tasks or shut runs down cleanly (`0579ad90`).
- *Continue mode UI*: The chat widget now toggles a keep-going mode via slash command, automatically submits continuation prompts, and communicates state shifts through history/messages (`8044e912`).

**Autocompaction Enhancements**
- Added incremental compaction checkpoints and support scripts/documentation so large transcripts can be resumed without replaying the full history (`4b06d4b8`).
- Autocompaction now triggers when 95 % of the context window is used and safely truncates compacted logs, keeping sessions within model limits (`77f0c2cd`, `f9f6bab7`).
- Oversize turns are trimmed iteratively during compaction so runaway transcripts stay within limits without losing recent context (`687a13bb`).

**Execution Safety**
- Shell tool timeouts now terminate the entire spawned process group, preventing background children from lingering after a kill; protocol types and TUI notifications were updated accordingly (`1ccd40c0`).
- Reverted the earlier “subagents” experiment, restoring the delegate worker implementation and ensuring review-agent tooling remains available (`cc1f2fd3`, `ff822aaf`).

**Housekeeping**
- Added an `.sgpt` entry to `.gitignore` and documented the ongoing progress work in `update-summary.md` (`6dd4619e`, `ceb3f1e7`).

**Configurability & Telemetry**
- *Feature toggles*: Introduced a first-class feature-flag registry and agent override file so operators can enable experimental capabilities or swap agents without forking configs (`f7b4e296`, `897d4d5f`).
- *Instrumented headers*: Responses now ship task-kind headers, notifier payloads include thread/user identifiers, and token counts rely on native numbers for downstream analytics (`268a10f9`, `13035561`, `c146585c`, `b09f62a1`).

**Approvals & Guardrails**
- *Auto update consent*: The CLI/TUI share a reusable approval modal so users can review release notes before trusting auto updates (`272e13dd`).
- *Exec transparency*: Command approvals respect auto-approve policies, emit the parsed command list, and warn when high-effort reasoning might exhaust rate limits (`774892c6`, `995f5c36`, `18d00e36`).
- *Recovery polish*: Stream resumption now posts inline notifications, Ctrl-C resets composer history, and stray slash-prefixed prompts are discarded before execution (`f98fa85b`, `0016346d`, `5346cc42`).

**CLI & Tooling**
- *Filesystem introspection*: Added `list_dir`, `grep_files`, and indentation-aware `read_file` handlers to let agents explore repositories in parallel without mutating state (`226215f3`, `f52320be`, `0026b126`).
- *Release automation*: Rust release workflows can run manually or as dry runs, now notarize macOS builds, and ship signed mac binaries (`5fa7844a`, `84c9b574`, `7b4a4c22`).
- *Operators & SDKs*: Exposed non-interactive `codex cloud exec`, improved update banners (including Bun guidance), reminded users about `codex resume`, dropped stale “experimental” labels, and tagged TypeScript SDK sessions with originator metadata (`8662162f`, `d6c5df9a`, `5833508a`, `abd51709`, `60f9e85c`).

**TUI Experience**
- *Composer ergonomics*: Added kill-buffer yank support, caps-lock tolerant shortcuts, right-margin spacing, image-aware placeholders, and a `/name` command for labeling chats (`17550fee`, `961ed319`, `9be704a9`, `90af046c`, `ec238a2c`).
- *Diff & log readability*: Diff viewers wrap long lines, size gutters to content, and align transcripts closer to display mode with tree-sitter Bash highlighting (`56296cad`, `75176dae`, `0e5d72cc`, `b8b04514`).
- *Visual polish*: The TUI hardcodes an xterm palette, animates true-color breathing spinners, and trims unused footer padding for a cleaner layout (`e896db11`, `a0d56541`, `12fd2b41`).

**MCP & Integrations**
- *Code review tooling*: The MCP server exposes a `codex-code-review` tool so external orchestrators can trigger review flows on existing sessions, complete with schema validation and docs (`0962c805`).
- *Streamable HTTP Servers*: `codex mcp add` now handles streamable HTTP endpoints end-to-end, prompting OAuth flows automatically when available (`a43ae86b`, `8a281cd1`).
- *Credential governance*: Configs can choose explicit credential stores, toggle servers on/off, and surface auth status inside both CLI and TUI (`496cb801`, `d3820f47`, `3c5e12e2`).
- *Docs & polish*: Updated configuration docs so the new MCP capabilities are discoverable and accurately documented (`26f7c468`).
