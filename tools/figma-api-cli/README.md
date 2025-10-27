# @icp/figma-api-cli

Deterministic pnpm-friendly CLI that mirrors the Figma Model Context Protocol tool surface using the public REST API. It allows engineers and AI agents to pull design context, metadata, variables, code connect maps, screenshots, and heuristic design-system rules without opening Figma.

## Setup

From the repo root:

```bash
pnpm install
pnpm --filter @icp/figma-api-cli build
```

Run the CLI through the workspace helper:

```bash
pnpm figma-api --help
```

All `pnpm figma-api …` invocations automatically run inside `pnpm infisical run`, so the dev Infisical environment is loaded for you.

## Authentication

The CLI expects a Figma Personal Access Token (PAT) with at least:

```
file_content:read
file_comment:read
file_variables:read   # required for variable-defs
```

Set the token via Infisical so every command inherits it deterministically:

```bash
pnpm -w infisical secrets set FIGMA_PERSONAL_ACCESS_TOKEN figd_…
```

You can also persist the token to the local config store:

```bash
pnpm figma-api auth login --pat figd_… --persist
pnpm figma-api auth status
```

To clear local config:

```bash
pnpm figma-api auth clear
```

## Command Surface

| Command | Description |
| --- | --- |
| `design-context` | Fetch a simplified node tree with layout, paint, text, and effect summaries. |
| `metadata` | Return lightweight metadata (id/name/type) for the selected node subtree. |
| `variable-defs` | Retrieve variable definitions defined in the file. Requires the `file_variables:read` scope. |
| `code-connect-map` | Fetch the Code Connect map for the file. |
| `screenshot` | Download a rendered node image to `/tmp/...`. No base64 is printed. |
| `design-system-rules` | Derive heuristic color, typography, and component summaries from the node selection. |
| `automation status` | Show configured automation accounts, storage directories, and plugin id (for write automation). |

### Examples

```bash
# Simplified design context for a node (URL or file key)
pnpm figma-api design-context --file https://www.figma.com/design/<key>?node-id=19-62607

# Save output JSON to disk
pnpm figma-api metadata --file <fileKey> --node 19:62607 --output outputs/metadata.json

# Variable definitions
pnpm figma-api variable-defs --file <fileKey>

# Screenshot saved under /tmp
pnpm figma-api screenshot --file <fileKey> --node 19:62607 --name hero
```

If a screenshot succeeds the CLI prints the saved path (`image saved to /tmp/...`). Consumers can open the file directly instead of dealing with base64 blobs.

## Automation (Playwright Runner)

The CLI can now mutate Figma files by launching the Profound Automation Runner plugin inside the real editor. Playwright reuses a cached session per automation account so jobs run headlessly.

### Required Secrets & Config

Set secrets in Infisical (dev environment):

```
FIGMA_AUTOMATION_EMAIL / FIGMA_AUTOMATION_PASSWORD   # or FIGMA_AUTOMATION_ACCOUNTS JSON array
FIGMA_AUTOMATION_TOTP_SECRET                         # optional, only if MFA enabled
FIGMA_AUTOMATION_STORAGE_DIR                         # optional override for session cache
FIGMA_AUTOMATION_PLUGIN_NAME                         # defaults to "Profound Automation Runner"
FIGMA_AUTOMATION_PLUGIN_COMMAND_ID                   # optional if plugin exposes multiple commands
FIGMA_AUTOMATION_FIGMA_BASE_URL                      # defaults to https://www.figma.com
```

Confirm everything is wired correctly (without revealing secrets):

```bash
pnpm figma-api automation status
```

The command prints the storage directory, configured accounts, and plugin metadata. Storage files are kept under `~/.cache/profoundhealth/figma-automation/<email>.json` with `0600` permissions. Locks live beside the storage files to guarantee that only one Playwright job uses an account at a time.

### Running Automation Jobs

Automation jobs contain arbitrary JSON that the plugin interprets. Provide the payload via `--payload` (path to JSON) or pipe JSON through stdin:

```bash
pnpm figma-api automation run \
  --file https://www.figma.com/design/<key>/<slug>?node-id=0:1 \
  --payload jobs/create-homepage.json \
  --account automation@profoundapp.org \
  --output outputs/job-result.json
```

Flags:
- `--plugin-name` / `--plugin-command` override the defaults when testing other plugins.
- `--timeout` adjusts how long the runner waits for the plugin to reply (default 5m).
- `--headful` launches a visible browser window (debugging).
- `--debug` opens DevTools and keeps console logs verbose.

Results are JSON with `status`, `message`, `pluginResult`, and captured `consoleLogs`. On success the plugin also writes the payload to `localStorage.phAutomationResult` in the editor. Errors include human-readable messages and stack traces when available.

### Payload Format

The companion plugin (see `@icp/figma-automation-plugin`) supports two patterns:

```jsonc
{
  "payload": {
    "description": "Create page + hero component",
    "script": "/* async function(figma, context, helpers) { ... } */"
  }
}
```

or declarative actions:

```jsonc
{
  "payload": {
    "actions": [
      { "kind": "set-page", "name": "Automation Playground" },
      { "kind": "create-frame", "name": "Hero", "width": 1440, "height": 1024, "layoutMode": "VERTICAL" },
      { "kind": "create-text", "characters": "Profound Health", "fontSize": 72 }
    ]
  }
}
```

Scripts execute inside the plugin main thread with helpers such as `ensurePage`, `createLayoutFrame`, and `loadFont`. Actions cover common primitives (frames, text, components) and can be extended as needed.

**Supported declarative actions**

- `set-page`
- `create-frame` (auto layout padding/spacing controls)
- `create-component`
- `create-rectangle`
- `create-ellipse`
- `create-line`
- `create-polygon`
- `create-star`
- `create-text`

**Parent references**

- Default (omitted) – append to the current page.
- `@page` / `@current` – explicit current page.
- `@last` – the most recently created node during this automation run.
- `@prev` – the node created immediately before the last one.
- `#Node Name` – search the current page for a node with that exact name.
- Specific node id – attach to a previously known node.

Each action accepts optional styling fields (`fills`, `strokes`, `strokeWeight`, `cornerRadius`, `opacity`, etc.), positional fields (`x`, `y`, `rotation`), and `parentNodeId` to target existing nodes.

### Installing the Plugin

Build the plugin package once:

```bash
pnpm --filter @icp/figma-automation-plugin build
```

Then in Figma:
1. **Menu → Plugins → Development → Import plugin from manifest…**
2. Select `icp/packages/figma-automation-plugin/dist/manifest.json`.
3. Verify the quick actions palette lists “Profound Automation Runner”.

Playwright launches the plugin via the command palette, injects the payload, and listens for console logs prefixed with `PH_AUTOMATION_RESULT:` / `PH_AUTOMATION_ERROR:`. The storage-state cache lets multiple automation accounts operate concurrently without cross-talk.

### Examples

Sample payloads live under `icp/packages/figma-api-cli/examples`.

- `schoolbus.json` uses the scripting mode to compose a stylised school bus complete with windows and wheels.
- `hero-actions.json` shows declarative actions that assemble a marketing hero section with buttons.

```bash
pnpm figma-api automation run \
  --file https://www.figma.com/design/<fileKey>/<slug>?node-id=0:1 \
  --payload icp/packages/figma-api-cli/examples/schoolbus.json \
  --account automation@profoundapp.org
```

After the job finishes, follow up with read-only commands (e.g., `design-context`, `screenshot`) to validate the output.

## Development

```bash
pnpm --filter @icp/figma-api-cli build
pnpm --filter @icp/figma-api-cli test
```

`pnpm verify:quiet` (run from repo root) will execute the workspace-wide build/lint/test pipeline and should succeed before handoff.
