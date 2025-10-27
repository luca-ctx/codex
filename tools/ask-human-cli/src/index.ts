#!/usr/bin/env node

import { WebClient } from '@slack/web-api';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;

type CliOptions = {
  message: string;
  timeoutMs: number;
  noResponse: boolean;
};

function parseArgs(argv: string[]): CliOptions | null {
  const args = [...argv];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let noResponse = false;
  const messageParts: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === '--') {
      const remainder = args.slice(i + 1);
      messageParts.push(...remainder);
      break;
    }

    if (arg === '--help' || arg === '-h') {
      return null;
    }

    if (arg === '--timeout' || arg === '-t') {
      const value = args[i + 1];
      i += 1;
      if (!value) {
        throw new Error('Missing value for --timeout option.');
      }
      timeoutMs = parseTimeout(value);
      continue;
    }

    if (arg.startsWith('--timeout=')) {
      const [, value] = arg.split('=', 2);
      if (!value) {
        throw new Error('Missing value for --timeout option.');
      }
      timeoutMs = parseTimeout(value);
      continue;
    }

    if (arg === '--no-response') {
      noResponse = true;
      continue;
    }

    messageParts.push(arg);
  }

  return {
    message: messageParts.join(' ').trim(),
    timeoutMs,
    noResponse,
  };
}

function parseTimeout(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const isSeconds = trimmed.endsWith('s');
  const numericPortion = isSeconds ? trimmed.slice(0, -1) : trimmed;
  const numeric = Number(numericPortion);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Invalid timeout value: ${value}`);
  }
  return numeric * (isSeconds ? 1_000 : 1);
}

async function readFromStdin(): Promise<string> {
  const chunks: Array<Buffer> = [];
  if (process.stdin.isTTY) {
    return '';
  }

  for await (const chunk of process.stdin) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk, 'utf8'));
    } else {
      chunks.push(Buffer.from(chunk));
    }
  }

  return Buffer.concat(chunks).toString('utf8').trim();
}

function ensureEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

type SlackMessage = {
  ts?: string;
  user?: string;
  text?: string;
  subtype?: string;
};

async function waitForReply(
  client: WebClient,
  channel: string,
  threadTs: string,
  userId: string,
  timeoutMs: number
): Promise<SlackMessage | undefined> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const response = await client.conversations.replies({
      channel,
      ts: threadTs,
      inclusive: false,
      oldest: threadTs,
      limit: 50,
    });

    const messages = (response.messages ?? []) as SlackMessage[];
    const reply = messages
      .filter((message) => message.ts !== threadTs)
      .filter((message) => !message.subtype)
      .find((message) => message.user === userId);

    if (reply) {
      return reply;
    }

    await delay(POLL_INTERVAL_MS);
  }

  return undefined;
}

function printUsage() {
  console.error(
    [
      'Usage: ask-human-dev [options] "your question here"',
      '',
      'Options:',
      '  -t, --timeout <ms>   Timeout in milliseconds (default 300000)',
      '                      Add an "s" suffix to interpret as seconds (e.g. --timeout=120s)',
      '  --no-response        Send only the Slack message and exit without waiting for a reply',
      '  -h, --help           Show this message',
      '',
      'The message can also be piped via STDIN when no positional text is provided.',
    ].join('\n')
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options === null) {
      printUsage();
      process.exit(0);
    }

    const { timeoutMs, noResponse } = options;
    let message = options.message;

    if (!message) {
      message = await readFromStdin();
    }

    if (!message) {
      printUsage();
      process.exit(1);
    }

    const botToken = ensureEnv('SLACK_BOT_TOKEN');
    const userId = ensureEnv('SLACK_USER_ID');

    const client = new WebClient(botToken);

    const open = await client.conversations.open({ users: userId });
    const channelId = open.channel?.id;
    if (!channelId) {
      throw new Error('Failed to open DM channel with configured user.');
    }

    const post = await client.chat.postMessage({
      channel: channelId,
      text: `${message}\n\n(Please reply in this thread.)`,
    });

    if (!post.ts) {
      throw new Error('Slack did not return a timestamp for the posted message.');
    }

    if (noResponse) {
      return;
    }

    const reply = await waitForReply(client, channelId, post.ts, userId, timeoutMs);
    if (!reply) {
      console.error('Timed out waiting for Slack reply.');
      process.exit(1);
    }

    if (reply.ts) {
      try {
        await client.reactions.add({
          name: 'white_check_mark',
          channel: channelId,
          timestamp: reply.ts,
        });
      } catch {
        // Non-fatal if the reaction fails (insufficient permissions, etc).
      }
    }

    process.stdout.write((reply.text ?? '').trim());
    process.stdout.write('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ask-human-dev: ${message}`);
    process.exit(1);
  }
}

void main();
