# Ask Human CLI

Thin command-line wrapper over Slack that lets engineers quickly DM the designated human developer and wait for their threaded reply.

## Usage

1. Ensure the following environment variables are available (typically via Infisical):
   - `SLACK_BOT_TOKEN`
   - `SLACK_USER_ID`
2. Build the package once:

   ```bash
   pnpm --dir icp install --filter @icp/ask-human-cli
   pnpm --dir icp --filter @icp/ask-human-cli build
   ```

3. From any directory, run:

   ```bash
   pnpm --dir ~/code/profoundhealth/icp exec --package @icp/ask-human-cli ask-human-dev "Need guidance on dispatcher backlog?"
   ```

   You may also pipe input:

   ```bash
   echo "Any blockers I should know about?" | pnpm --dir ~/code/profoundhealth/icp exec --package @icp/ask-human-cli ask-human-dev
   ```

The CLI posts the prompt, waits for the human's threaded reply (default timeout 5 minutes), prints their response to STDOUT, and reacts to the reply with ✅.
