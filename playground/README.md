The playground is a space where we can queue the agent to work on throaway projects so we can test its abilities.

For example, we initialize the agent inside of playground/ai-lawyer and then let it try and build something end-to-end in there.

# Project Scaffold
Our capabilities are composed of 4 pillars:
1. The underlying LLM (gpt-5-codex)
2. The agent harness (the Codex CLI)
3. Custom tools (tools/ like figma-api-cli and ask-human-dev)
4. Operational strategies (agents/ directory + detailed instructions)

The fourth one requires that we maintain a default project scaffold. It should contain project-agnostic patterns, instructions, resources, and skills that make it more useful with the same harness and tools. For example, making it well-defined that we should define business and technical source of truth in specs creates an expectation for the agent which is proven to be a good strategy from our previous work.

So when we ask an agent to make a new project, we can usually just do something like copy the project scaffold, rename the copy, and initialize the agent in there with a prompt.

For example:
```
cp -r playground/project-scaffold/ playground/ai-lawyer-run-101/
cd playground/ai-laywer-run-101
codex -p "build an AI laywer app"
```