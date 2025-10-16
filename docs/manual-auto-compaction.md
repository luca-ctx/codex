# Manual Auto-Compaction Validation

These steps generate a heavyweight input file and walk through a live
Codex session so you can observe the new auto-compaction behaviour,
including the fallback trimming that kicks in when the summariser
cannot run inside the model’s context window.

## 1. Generate a large fixture

Use the helper script to create an oversized file. The `--tokens`
flag matches the conservative 4-bytes-per-token heuristic used by the
backend.

```bash
python3 scripts/generate_long_context.py --tokens 220000 --output /tmp/context.txt
```

The script prints the actual byte count and an approximate token budget
so you can tweak the size quickly.

## 2. Configure Codex for a manual run

Ensure `config.toml` points at a model with a large context window
(e.g. `gpt-5-codex`) and adjust
`model_auto_compact_token_limit` if you want to experiment with
different thresholds. Launch Codex in the workspace that contains the
generated file.

## 3. Drive the session past the threshold

Prompt Codex to read or summarise the generated file and continue the
conversation until the context usage approaches the configured limit.
When the auto-compaction pass runs you should see:

- A background notification such as  
  `Auto-compaction prompt still exceeded the context window. Falling back to trimming conversation history without an LLM summary.`
- Follow-up messages documenting how many additional slices were
  removed:  
  `Removed additional history content N time(s) to keep the conversation within the context window.`

If the fallback activates (the summariser itself exceeded the context
window) an additional notification describes the manual trimming path.

## 4. Inspect the rollout

Open the current rollout file (printed in the session footer) to verify
that the `Compacted` entry contains either the model-produced summary
or the fallback placeholder:

```
Auto-compact fallback: trimmed conversation without model summary because the compact prompt exceeded the context window.
```

Repeating the exercise with different `--tokens` values or a stricter
`model_auto_compact_token_limit` allows you to confirm the behaviour at
various thresholds without crafting bespoke prompts.
