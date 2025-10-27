# ExecPlans Guide

Use ExecPlans for any multi-step change, cross-team initiative, or risky refactor. Each plan is a single living Markdown document that combines the design, execution instructions, decision log, and progress tracker for that effort. When an agent (or human) picks up the task, they should be able to rely on the ExecPlan alone plus the current repository state—no other memory or chat history.

## Storage and Naming

- Keep the guide you are reading at `agents/exec-plans/EXEC_PLANS.md`.
- Each new plan lives at `agents/exec-plans/<slug>/exec_plan.md`, where `<slug>` is short, lowercase, and hyphenated (for example `agents/exec-plans/migrate-tests/exec_plan.md`). The plan directory can include auxiliary assets (benchmarks, screenshots, transcripts) referenced by the plan.
- Reference the canonical specs under `agents/specs/` instead of copying or modifying them. Plans may link to spec sections but do not edit the specs.

## When to Draft a Plan

- The work spans multiple commits, touches several services/apps, or introduces new infrastructure.
- You expect to hand the work between agents or return to it later.
- Production impact is high enough that you want explicit validation and rollback guidance.

Skip ExecPlans for one-off fixes that a single agent can complete quickly and safely.

## Required Structure

Every plan must be self-contained and updated as work progresses. Use this outline (feel free to adapt headings to fit the work, but keep the same intent):

1. **Title and Metadata**

   - First line: `# ExecPlan: <Project Name>`.
   - Immediately follow with a short metadata block:
     - `Created:` ISO date.
     - `Status:` choose one of `Draft`, `In Progress`, `Paused`, `Complete`.
     - `Last Updated:` ISO date (refresh whenever you edit the plan).

2. **Why It Matters**

   - Two to four sentences describing the outcome users or the business gain once the plan is complete.

3. **Current Context**

   - Bullet list summarising relevant system state, linked specs, known constraints, and active environments. The reader should not need any other document to understand starting conditions.

4. **Success Criteria**

   - Checklist of observable results (e.g., “All payments flow through Stripe subscription webhooks,” “CI pipeline `deploy-edge` passes”). Keep them objective, not implementation details.

5. **Work Overview**

   - Brief paragraph that orients the reader to the planned approach.

6. **Milestones**
   For each milestone create a `## Milestone N: <Title>` section containing:

   - **Scope:** short paragraph describing what changes in this milestone.
   - **Steps:** ordered list mixing prose and commands. Include exact file paths, function names, and scripts to run. Assume a stateless agent will follow them verbatim.
   - **Validation:** commands/tests to run plus expected outcomes (e.g., “`pnpm --filter web lint` succeeds”, “Stripe test webhook recorded in `foo_bar` table”).
   - **Rollback/Fallback:** safe undo instructions if the milestone fails mid-way.
   - **Status:** start with `Not Started`, then update to `In Progress`, `Blocked`, or `Complete` as you work.

7. **Progress Log**

   - Append dated bullet entries noting when milestones start/finish, surprises, or blockers. Example: `2025-02-18 – Completed Milestone 1; Stripe webhooks disabled in staging.`

8. **Decision Log**

   - Table or bullet list capturing substantive decisions, including rationale, date, and who made it. Example: `2025-02-18 – Adopted Stripe usage-based pricing API; reduces custom billing logic.`

9. **Validation Summary**

   - Single location listing the full test/build commands that must pass before declaring success (e.g., `pnpm turbo run lint test --filter=...`, `supabase functions deploy`). Mark items when complete.

10. **Risks & Follow-Ups**

    - Call out open questions, external dependencies, or cleanup postponed beyond the current scope.

11. **Handoff Notes**

    - Instructions for the next contributor if you pause: which milestone to start next, outstanding reviews, temporary feature flags, etc.

12. **Upon Completion**
    - [keep this section at the end]
    - Once all milestones and tasks have been completed, call `permanently_terminate_session`.
    - permanently_terminate_session called: false

## Keeping Plans Current

- Update the metadata `Last Updated`, milestone statuses, progress log, and decision log immediately after each meaningful change.
- If new work is discovered, either add a milestone or capture it under Risks & Follow-Ups.
- Record validation command outputs in the progress log when they differ from expectations.

## Execution Flow

1. **Authoring:** When you request a new plan (e.g., “Create an exec plan to migrate tests”), the agent should create `agents/exec-plans/migrate-tests/exec_plan.md` using this template and perform any repository research needed to fill in context, risks, and milestones.
2. **Implementation:** To execute, start a session with the instruction “Implement `agents/exec-plans/migrate-tests/exec_plan.md`.” The agent reads the plan, follows the milestones in order, and edits the plan as the source of truth while making code changes.
3. **Continuation:** If work spans sessions, open the updated plan and continue from the next milestone. The document must contain all state needed to resume without previous chat history.
4. **Completion:** When success criteria are met and validation commands pass, mark the plan `Complete`, record final notes, and consider archiving ancillary artifacts in the same `agents/exec-plans/` directory if they help future readers.

## Sample Skeleton

```
# ExecPlan: Switch Billing to Stripe
Created: 2025-02-18
Status: Draft
Last Updated: 2025-02-18

## Why It Matters
Add a short paragraph here.

## Current Context
- item...

## Success Criteria
- [ ] ...

## Work Overview
Paragraph.

## Milestone 1: ...
Scope
Steps
Validation
Rollback/Fallback
Status: Not Started

... (additional milestones)

## Progress Log
- 2025-02-18 – ...

## Decision Log
- 2025-02-18 – ...

## Validation Summary
- [ ] Command

## Risks & Follow-Ups
- item

## Handoff Notes
Paragraph.
```

Feel free to copy/paste this skeleton when creating a new plan, then replace placeholder content with concrete details.
