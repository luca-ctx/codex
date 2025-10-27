# Profound Automation Runner (Figma Plugin)

This plugin receives automation jobs from the Profound Health Figma CLI and mutates Figma documents on behalf of automation agents. Jobs are stored in the editor `localStorage` by the CLI’s Playwright runner. When the plugin launches it:

1. Loads a hidden UI bridge that reads the `phAutomationJob` entry from the editor.
2. Sends the parsed job to the plugin main thread.
3. Executes either a provided script or a list of high-level automation actions.
4. Emits results back to the CLI via console logs and writes them to `localStorage` under `phAutomationResult`.

## Build

```bash
pnpm --dir icp/packages/figma-automation-plugin install
pnpm --dir icp/packages/figma-automation-plugin build
```

The build step compiles TypeScript into `dist/main.js` and copies the UI/manifest assets into `dist/`. Import the contents of `dist/` into Figma as a development plugin.

## Job Payloads

The CLI writes JSON of the form:

```json
{
  "payload": {
    "description": "Create landing page components",
    "script": "/* async plugin code */"
  },
  "requestedAt": "2025-10-22T23:15:00.000Z"
}
```

- `payload.script` — JavaScript/TypeScript (transpiled) executed inside the plugin main context. It receives `(figma, context, helpers)` where helpers include `ensurePage`, `loadFont`, `createLayoutFrame`, and `withSelection`.
- `payload.actions` — Optional declarative operations (`create-frame`, `create-text`, `create-component-set`, `set-page`). Actions run when `script` is omitted.

Results (success or error) are logged to the Figma console prefixed with `PH_AUTOMATION_RESULT:` or `PH_AUTOMATION_ERROR:`. The CLI listens for these markers to finish the automation job.

### Declarative Parent Targets

Declarative actions support several shortcuts in `parentNodeId`:

- (omitted) – append to the current page.
- `@page` / `@current` – explicit current page.
- `@last` – the most recently created node during this run.
- `@prev` – the node created immediately before the last one.
- `#Node Name` – search the current page for a node with that exact name.
- Concrete node id – attach to an existing node.

These references make it easier to compose complex layouts without switching to scripting mode.

## Configuration

Set the following secrets via Infisical for automation accounts:

- `FIGMA_AUTOMATION_EMAIL` / `FIGMA_AUTOMATION_PASSWORD`
- Optional `FIGMA_AUTOMATION_TOTP_SECRET` if MFA is enabled.
- `FIGMA_AUTOMATION_PLUGIN_NAME` should match the plugin name shown in Figma (“Profound Automation Runner” by default).

Run `pnpm figma-api automation status` to confirm configuration and storage-state paths before executing jobs.
