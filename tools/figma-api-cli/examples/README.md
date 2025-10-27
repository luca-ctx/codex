# Automation Examples

Use these payloads with `pnpm figma-api automation run`. They exercise both the declarative action surface and the scripting helpers provided by the Profound Automation Runner plugin.

## Files

- `schoolbus.json` – Demonstrates the scripting workflow by building a stylised school bus, including frames, windows, wheels, and typography.
- `hero-actions.json` – Uses declarative actions (with parent references like `@last` and `#CTA Row`) to create a marketing hero section with CTA buttons.

## Running an Example

```bash
pnpm figma-api automation run \
  --file https://www.figma.com/design/<fileKey>/<slug>?node-id=0:1 \
  --payload icp/packages/figma-api-cli/examples/schoolbus.json \
  --account automation@profoundapp.org
```

After the automation completes, validate the result:

```bash
# Capture a screenshot
pnpm figma-api screenshot --file <fileKey> --node <busNodeId>

# Inspect design context
pnpm figma-api design-context --file <fileKey> --node <busNodeId> --depth 2
```

Feel free to duplicate the payloads and adjust them to create new design snippets. Commit reusable examples here so other agents can discover them deterministically.
