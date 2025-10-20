**Core Workflow & Automation**
- Autocompaction now checkpoint/restores transcripts, auto-triggers at 95%, and truncates logs after compaction to stay within context budgets (4b06d4b8, 77f0c2cd, f9f6bab7, 687a13bb).
- Progress support landed with continue mode plus new delegate_worker, review_agent, and session termination tools so managers can orchestrate sub-tasks or halt runs directly (0579ad90, 8044e912).
- A feature-flag registry, agent override file, and related config plumbing let deployments toggle behavior and customize agents without patches (f7b4e296, 897d4d5f).
- Task metadata and telemetry now emit task-kind headers, push thread/user identifiers into notifications, and normalize token-count payloads for downstream consumers (268a10f9, 13035561, c146585c, b09f62a1).

**Approvals & Safety**
- Auto update approval flow adds a reusable consent experience in CLI/TUI, including a dedicated modal for reviewing release notes before enabling trust (272e13dd).
- Exec requests respect auto-approval policies and carry full command lists in approval events to reduce redundant prompts and aid auditing (774892c6, 995f5c36).
- Stream recovery notifies users when output resumes and resets history navigation after Ctrl-C to prevent stale approval states (f98fa85b, 0016346d).
- Guardrails warn when reasoning effort spikes and discard slash-prefixed prompts before they leave the composer, shrinking accidental command churn (18d00e36, 5346cc42).

**CLI, Tools & Ops**
- Added `list_dir` and `grep_files` tools plus an indentation-aware `read_file`, giving agents richer filesystem introspection primitives (226215f3, f52320be, 0026b126).
- Codex Cloud execution is exposed through the cloud-tasks CLI so remote runs can be launched without leaving the workflow (8662162f).
- CLI UX tweaks detect Bun installs for upgrade hints, remind users about `codex resume`, rename the device-auth flag, and drop stale “experimental” labels (d6c5df9a, 5833508a, b6165aee, abd51709).
- Release automation now supports manual/dry-run triggers, macOS notarization, and codesigning to ship compliant binaries (5fa7844a, 84c9b574, 7b4a4c22).
- Exec clients—including the TypeScript SDK—tag responses with originator metadata for consistent cross-surface tracking (60f9e85c).

**TUI Experience**
- Update workflows gained a rich approval modal while stream resumptions surface inline so operators know when output is flowing again (272e13dd, f98fa85b).
- Composer ergonomics improved via ^Y/kill-buffer, case-insensitive shortcuts, Ctrl-C history resets, slash-command suppression, image-name placeholders, and a one-cell right margin (17550fee, 961ed319, 0016346d, 5346cc42, 90af046c, 9be704a9).
- Chat presentation keeps the context line visible, lets users name chats, and reclaims space by dropping bottom padding (c89229db, ec238a2c, 12fd2b41).
- Diff/log viewers wrap long lines, size line numbers dynamically, align transcript rendering closer to display mode, and adopt tree-sitter Bash highlighting for clearer diffs (56296cad, 75176dae, 0e5d72cc, b8b04514).
- Visual polish includes a hardened xterm palette with shimmer blending and animated breathing spinners on true-color terminals (e896db11, a0d56541).

**MCP & Integrations**
- Streamable HTTP MCP servers are supported end-to-end, including automatic OAuth login prompts and bearer-token handling (a43ae86b, 8a281cd1).
- Operators can choose explicit credential stores for MCP connections, tightening control over secret management (496cb801).
- MCP auth status is surfaced through the CLI/TUI, and connections now honor per-server enabled flags in config (3c5e12e2, d3820f47).
- Docs and configs expanded accordingly so the new MCP capabilities are discoverable and manageable in production environments (a43ae86b, d3820f47, 3c5e12e2).
