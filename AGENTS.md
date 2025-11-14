Please read AGENTS_ORIGINAL.md as well and follow those instructions too.

# Temporary Files

If you need to write any temporary files in the repo workspace for throwaway purposes, please do so in /tmp

# Using git

- Unless explicitly instructed otherwise, only use git for read-only purposes. Do not switch branches, commit changes, or reset changes unless specifically instructed. The reason for this is very important: there are likely other AI coding agents and/or human developers working alongside you, possibly on adjacent tasks. If you use git to make commits when not instructed to do so, you will mess up code review and agent management processes. It is usually 100% fine that there is a dirty workspace with other unstaged changes. Just focus on your task without worrying about that.

# ExecPlans

- Canonical specs live under `agents/specs/` and are the source of truth. Link to them from plans, but never edit spec files without explicit human approval.
- For any multi-step or high-impact effort, create or update an ExecPlan as defined in `agents/exec-plans/EXEC_PLANS.md`. When prompted (for example, “create an exec plan to migrate tests”), produce `agents/exec-plans/<slug>/exec_plan.md` with the required sections and metadata.
- ExecPlans are living documents. Update the metadata, milestone statuses, progress log, decision log, and validation checklist every time you make progress or learn something new.
- When instructed to implement a plan (e.g. “implement agents/exec-plans/migrate_tests/exec_plan.md”), follow the milestones in order and record outcomes and surprises directly inside that plan before moving on.
- If you pause work, leave clear next steps in the plan’s “Handoff Notes” section so the next agent can resume without extra context.

# Principles

1. Developer Velocity is #1
   Above all else, we should make choices that increase developer velocity. Since AI is enabling fast-moving changes in markets, we need to be able to build and adapt quickly. A slow developer loop will kill us. All other principles are actually in service of Developer Velocity.
2. Determinism, Isomorphism & IaC
   All of our systems should work in dev and prod exactly the same way. We should not have conditional surprises. To accomplish this, all configurations should be committed as code (not tinkered in a dashboard). Putting everything in code increases discoverability, especially for AI coding agents.
3. Idempotentcy
   Deploys and logic in our application should be idempotent to avoid confusing issues.
4. Less Code is Better
   Almost always prefer to use an off-the-shelf tool rather than something we script together ourselves, even if it seems like a quick and easy script. Only after trying and failing all available open/commercial tooling should we revert to scripting ourselves. The code we do write needs to be bulletproof, so we have to invest a lot of effort in writing and maintaining it.

# AI Coding Assistant Rules

- Remember that because of your RL training, you are biased towards always working to a solution until it is achieved, even if it is hacky. This is not good. If you cannot find a clean solution to a problem, you need to ask for help instead of trying to hack around something. For example, when we use pre-blessed tools, those tools work out-of-the-box for virtually all cases. Trying to do something hacky or a workaround is considered out of scope for your tasks. You need to resist the urge to quickly hack around something and instead just focus on clean solutions. You can always pause to research online or ask for help if you are stuck. Likewise, we don't want to be building extensive mocks for things that we could simply use a live sandbox for.
- Avoid hacks / workarounds. We should be biased to work with our tools rather than against them. For example, instead of trying to work around types in typescript with `as any` or `as never`, try to use the actual type. Perhaps you need to regenerate library types or something like that.

# Always respect agents/specs

- In a previous conversation with you, we collaborated to write agents/specs, which are markdown files representing the source of truth for our business and technical decisions. It also represents specific implementation decisions that we are aligned on. Never change any files in specs. However you should point out to me if you find any issues in there (inconsistencies, significant oversights, etc). Before you start any task, make sure to read agents/specs in full so you totally understand the context of the project. Then research relevant parts of the codebase before beginning work, even if you feel like the task is relatively simple.

# Agentic loop

When I start you out on a task, please do as much work towards it as you can. Eventually your turn will end, and then I will send an automated message to send you back into the loop. This will continue until you call the tool to permanently end the session. Don't call this function until you are absolutely done with everything and there is nothing left you could do on your task (such as reviewing your code, making sure tests pass, making sure a manual QA pass over the functionality works, additional cleanup from your work, etc).

Before handing off completed work, invoke the MCP `codex-code-review` tool (or delegate to a codex review agent) so we keep the automated review loop tight.

# Agent-level tools

- When keep-going (continue) mode is active, only end the session by calling the `permanently_terminate_session` tool once nothing remains to fix or improve.
- Use the MCP `codex-code-review` tool to spin up a reviewer before handoff; feel free to pass a plan or explicit scope via the tool instructions.
- Reach for the MCP `codex-batch` tool (and follow up with `codex-reply`) when you want to fan out multiple Codex sub-sessions in parallel.

# Working with Other AI Agents in a Dirty Workspace

You should assume that there are other AI coding agents working concurrently with you (or a human developer) in the same git workspace. If you see changes in `git diff` that are unrelated to your work, please don't try to reset them. They are probably from other work that is ongoing (especially as related to other exec_plans).

# Dealing with Compatability Issues

Whenever you hit a mismatch between major dependency versions or incompatible architectural assumptions (type systems, runtime models, build pipelines, etc.) stop immediately and propose a coherent upgrade or rollback plan. Unless you can resolve it cleanly right then, escalate instead of forcing the pieces together. For example, if one library depends on zod 3 and another on zod 4, do not try to cast the types `as any`. Instead, we need to pause the current task, take a step back, and coordinate a proper upgrade or fallback path before continuing.

# MCP Tools

You have the following MCP tools available at your disposal:
• Server: codex
• Tools: codex, codex-reply, codex-code-review, codex-batch

Using codex is really great when you want to farm of a well-contained task. You should be mindful of your own context window. You can use codex to do a one-off change. Think of this like delegating to an engineer on your team. You are the tech lead and you need to provide a good prompt and clear instructions on when to escalate back to you for further assistance. You can also use a codex sub-agent to perform a code review for you. Just give it proper context on what you did and why. If you want to continue a conversation with the same sub-agent, just use codex-reply. Also, whenever you finish a major milestone or a full task, use codex-code-review to have an AI code review agent check your work. You'll have to provide a clear message as to what you were working on and why. Ideally, you should provide a message that contains a list of files you touched so the agent can focus on those. There may be other concurrent tasks by other AI coding agents on the same git worktree. So if you get back irrelevant content in the code review response, you can safely ignore it. Codex batch is great for farming off many tasks to several subagents at once.

## Continuous Context Cleaner

- Disabled by default; enable via `config.toml`:
  ```toml
  [context.cleaner]
  enabled = true
  # Optional overrides (defaults shown):
  min_usage_percent = 55      # run once this % of context is consumed
  max_history_items = 120     # cap entries inspected each pass
  max_item_bytes = 4096       # truncate individual entry previews
  max_removals_per_turn = 3   # maximum deletions per turn
  protected_tail_items = 6    # always keep the freshest turn data
  ```
- Runs after non-review turns once the usage threshold is crossed. It only proposes removals for entries marked `removable: yes` (mostly shell/stdout noise) and will safely no-op if nothing is obvious.
- The cleaner never touches human messages, instructions, specs, or the protected tail. Removals are conservative and logged via background events; the cleaner may emit a short agent summary when it actually trims content.
- Pair this with auto-compaction for long missions. Start with default safeguards, validate the summaries, and only lower thresholds if you are comfortable with the removal behaviour.
