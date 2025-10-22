This is the OpenAI Codex repo, specifically a fork off of it that is adding new capabilities on top of their core.

Codex is a CLI coding agent harness, which is actually capable of a lot more than just coding.

The purpose of this fork is to add extra capabilities directly into the harness layer (rather than on top as an MCP server).

Such features include:
- hooking into agent-finished turns to do things like send notifications to the human
- give the agent an automated prompt to keep going every time until completion of the task, and then a way to actually terminate the task (since agents will stop prematurely, even when prompted not to)
- exposing code review and parallel agents via MCP so that the agent itself can invoke subagents to do useful tasks like review the code, write some sharded code jobs, etc.
- automatically compacting context when it starts to grow too big

The key principles that we need to follow:
- *Build in capabilities in the agent hardness which are only possible from that layer. Otherwise, build a simple external tool*: I'll give you an example. Most coding jobs (and other digital jobs) take hours or days, equivalent to millions of tokens of context. However, modern LLMs can only use ~400k tokens at maximum (and even after ~100k, we start to see degraded performance on many tasks). So we need to wire these agents up to keep going to accomplish long-running tasks (which may take them many, many "turns" and millions of total tokens). This type of wiring is not possible at the MCP layer outside of the agent scaffold, so we chose to build these things into the agent scaffold directly. So the principle is: build capabilities into the model layer when it provides capabilities that are not possible with external tools. A counter example would be a tool to ping a human to ask for help when stuck. This is an amazing concept that makes the agent stay on track way better, but you just build a simple CLI tool like `ask-human-dev "where should i write the new files?"` and then you can instruct the agent to do it in AGENTS.md.
- *Always do things that minimize context usage*: As I mentioned, we want to limit the amount of context usage to complete a task. One thing that harms agents is letting them ingest too many useless tokens (ie. some noisy output from stdout commands). We want to build capabilities that limit or purge the context usage to only what is necessary. That is why we have tricks like `skills/`, `exec_plans/`, and `specs/`. These are all ways to densely organize information so that an agent can pick back up where the previous one left off (or the same agent, but with its context compacted). So when we think about building features (like a tool that consumes Playwright output), we want to measure and limit the amount of context needed to the absolute minimum to still convey the information. One example here: the official Figma MCP server actually sends images of the designs back as base64-encoded images. When these are ingested by the model via the agent harness, these immediately consume tens or hundreds of thousands of tokens. This is obviously unacceptable. So we made a custom figma API tool that simply saves the image as a file. This way, when the agent reads the image through the correct image API with openai, it is only about ~1k tokens because its in its compressed form. For this reason, when we are evaluating tools and solutions, we ought to measure the necessary vs actual token consumption and consider what might be going on under the hood that would cause token inflation.
- *Build in ways for agents to work for a ridiculously long time*: Most of the early performance gains have come from letting the agents keep going. With /continue command and auto-compaction, the agents can do end-to-end implementations of very complex features. Yes, they will make mistakes along the way, but so do human developers. As we go along, we give them nice commands to quickly check their work (for example, use turborepo remote caching to make sure that there is a lightning fast way to make sure builds and tests pass with every change). When there are errors (either from compiling or testing) the agent can go independently fix the issues. When the work is done, the agent can ask for a code review to be performed so that everything is confirmed to be correctly implemented. There are probably more things we could be doing here to further extend this, but right now, its basically like the human asks the agent to make an exec plan for some concept or feature, then the agent drafts the spec, then goes off and completes it end-to-end with sub-agents and then its finally done. This is awesome by itself, but it would be even cooler for the agent to be "always on" (with occassional checks to touch base with human on big decisions, strategic direction, etc).
- *Always have a way to test it for real*: A lot of times, the test suites from within the agent harness only show part of the picture. An end-to-end test on a real use case is actually extremely valuable. We should be able to ask a question like: "does adding this feature allow the agent to get more autonomously capable". For example, we can add unit tests to make sure that our codex MCP server works to expose sub-agents, but do we really know if the top level agent using the sub-agents actually improves performance? Might there be some extra prompting that is required?


With all of this in mind, here is the ultimate goal:
Build an agent that can autonomously improve itself and then create fully AI-run companies.

Right now, the agent can basically make all of the software for a very complex project. By heavily leveraging documentation in agents/ directory and by sitting alongside the agent brainstorming, I was able to get the agent to make a ~2m LOC repo that performed a lot of complex software functionality (many different nextjs portals, 2 mobile apps in expo, and a very complex backend on supabase). However its ability to do this even more autonomously, and automate other parts of the stack (design, sales, etc) are still limited.

So, as we think about what to build (whether its an improvement to the agent harness itself or a tool to give the agent access to or even just a functional improvement like agents/), we should keep in mind that we are working towards this ultimate goal.

Here are the functional areas that we need to have a fully AI-run company:

CORE PRODUCT STACK
- If we can get code + design to work, we can basically build any full software product from scratch
1. Agent can build and maintain the codebase and deploy headless software into production (basically solved, but some babysitting required)
2. Agent can read figma designs and build true-to-spec UIs out of them (unsolved, work-in-progress)
3. Agent can autonomously make designs, given inspiration resources and some guidelines (unsolved, work-in-progress)

OPS STACK (B2B focus)
1. Agent can research customers and reach out to them via cold email
2. Agent can cold call customers or even demo the product live with a potential customer
3. Agent can handle support issues (hopefully each support issue can be handled via ad-hoc remediation by the AI, or integrated into the software to remove that support use case)
4. Agent can do digital services that normally require humans (such as doing actual consulting work for customers, for example)


Out of scope
- We only really need the agent to be able to do things which are scale-related bottlenecks (building software is extremely resource intensive, so automating it is a huge unlock). We don't care about it being able to open a company bank account or produce a compliance policy for the company because these are one-off events that a human can easily do once in an afternoon. What we can about would be like things that would be transformative if you could snap your fingers and the task is done. If you could snap your fingers and suddenly you have a company bank account, that's not actually very valuable at all.
- We don't need robotics right now, but in the future this would be the next phase. You can imagine a future version of this agent would be able to autonomously deploy factories.