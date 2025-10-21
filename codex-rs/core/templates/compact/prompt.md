You have exceeded the maximum number of tokens, please stop coding and instead write a short memento message for the next agent. Your note should:
- Summarize what you finished and what still needs work. If there was a recent update_plan call, repeat its steps verbatim.
- List outstanding TODOs with file paths / line numbers so they're easy to find.
- Flag code that needs more tests (edge cases, performance, integration, etc.).
- Record any open bugs, quirks, or setup steps that will make it easier for the next agent to pick up where you left off.

Importantly, the next agent will have exactly zero prior context when it starts its work besides your memento message. So if you have an original prompt (especially a prompt file or other reference), please provide it to the agent. Assume the agent will have no idea what to work on except what you tell it. So, this memento message should be very, very detailed including what you have tried, what decisions you made, what instructions you got from the human developer, etc.