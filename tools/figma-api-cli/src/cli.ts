import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_API_BASE_URL,
  clearStoredConfig,
  getConfigPath,
  loadResolvedConfig,
  maskSecret,
  writeStoredConfig,
  type LoadConfigOptions,
  type ResolvedConfig,
} from "./config.js";
import { parseFileReference } from "./fileReference.js";
import {
  ensureStorageDirExists,
  getStorageStatePath,
  loadAutomationConfig,
} from "./automationConfig.js";
import { installAutomationPlugin } from "./automation/pluginInstaller.js";
import { runAutomationJob } from "./automation/runner.js";
import { FigmaApiError, FigmaRestClient } from "./restClient.js";
import {
  buildDesignContext,
  buildMetadata,
  deriveDesignSystemRules,
  type DesignContextNode,
  type DesignSystemRules,
  type MetadataNode,
} from "./transformers.js";

interface JsonOutputOptions {
  output?: string;
  raw?: boolean;
}

interface ScreenshotCommandOptions {
  file: string;
  node?: string;
  scale?: string;
  format?: "png" | "jpg" | "svg";
  tmpDir?: string;
  name?: string;
}

interface AutomationRunCommandOptions {
  file: string;
  payload?: string;
  example?: string;
  account?: string;
  pluginName?: string;
  pluginCommand?: string;
  timeout?: string;
  headful?: boolean;
  debug?: boolean;
  output?: string;
}

interface AutomationInstallCommandOptions {
  manifest?: string;
  account?: string;
  pluginName?: string;
  timeout?: string;
  headful?: boolean;
  debug?: boolean;
  file?: string;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("figma-api")
    .description("Figma REST CLI for deterministic design context workflows")
    .version("0.1.0")
    .option("--api-base <url>", "Override Figma REST API base URL (defaults to https://api.figma.com/v1)")
    .option("--token <token>", "Override Figma personal access token (figd_…)");

  const auth = program.command("auth").description("Manage Figma authentication and configuration");

  auth
    .command("status")
    .description("Show the currently resolved API base and token sources")
    .action((_opts, command) => {
      const overrides = getGlobalOverrides(command);
      const resolved = loadResolvedConfig(overrides);
      const lines = [
        `API Base   : ${resolved.apiBaseUrl} (${resolved.apiBaseSource})`,
        resolved.token
          ? `Token      : ${maskSecret(resolved.token)} (${resolved.tokenSource})`
          : "Token      : <not set>",
        `Config file: ${getConfigPath()}`,
        resolved.tokenSource === "env"
          ? "Hint       : token resolved from environment/Infisical."
          : "",
      ].filter(Boolean);
      console.log(lines.join("\n"));
    });

  auth
    .command("login")
    .description("Capture a personal access token for CLI usage")
    .option("--pat <token>", "Figma personal access token (figd_…)", (value) => value.trim())
    .option("--api-base <url>", "Persist a specific REST API base URL", (value) => value.trim())
    .option("--persist", "Store credentials on disk (default: print shell export instructions)")
    .action((options: { pat?: string; apiBase?: string; persist?: boolean }, command) => {
      const overrides = getGlobalOverrides(command);
      const token = options.pat ?? overrides.tokenOverride;
      if (!token) {
        console.error(
          "[figma-api] Missing token. Provide --pat <token> or set FIGMA_PERSONAL_ACCESS_TOKEN via Infisical."
        );
        process.exitCode = 1;
        return;
      }

      const apiBase = options.apiBase ?? overrides.baseUrlOverride ?? DEFAULT_API_BASE_URL;

      if (options.persist) {
        writeStoredConfig({ token, apiBaseUrl: apiBase });
        console.log(
          `Stored token (${maskSecret(token)}) and API base at ${getConfigPath()} (mode 0600)`
        );
      } else {
        console.log("Token not persisted. Export it in your shell or Infisical:");
        console.log(`  export FIGMA_PERSONAL_ACCESS_TOKEN=${token}`);
        if (apiBase !== DEFAULT_API_BASE_URL) {
          console.log(`  export FIGMA_API_BASE_URL=${apiBase}`);
        }
      }
    });

  auth
    .command("clear")
    .description("Delete any persisted configuration on disk")
    .action(() => {
      clearStoredConfig();
      console.log(`Cleared stored config at ${getConfigPath()}`);
    });

  const automation = program
    .command("automation")
    .description("Manage Figma design automation credentials and storage");

  automation
    .command("status")
    .description("Show automation account, storage, and plugin configuration")
    .action(() => {
      const automationConfig = loadAutomationConfig();
      ensureStorageDirExists(automationConfig.storageDir);
      const examples = listExamplePayloads();

      const lines = [
        `Storage dir : ${automationConfig.storageDir} (${automationConfig.storageSource})`,
        `Figma base  : ${automationConfig.figmaBaseUrl} (${automationConfig.figmaBaseSource})`,
        automationConfig.pluginId
          ? `Plugin ID   : ${automationConfig.pluginId} (${automationConfig.pluginSource ?? "unknown"})`
          : "Plugin ID   : <not set>",
        automationConfig.pluginName
          ? `Plugin name : ${automationConfig.pluginName} (${automationConfig.pluginNameSource ?? "unknown"})`
          : "Plugin name : <not set>",
        automationConfig.pluginCommandId
          ? `Plugin cmd  : ${automationConfig.pluginCommandId}`
          : undefined,
        `Accounts    : ${automationConfig.accounts.length} (${automationConfig.accountsSource})`,
        examples.length > 0
          ? `Examples    : ${examples.join(", ")}`
          : "Examples    : <none>",
      ].filter(Boolean);

      console.log(lines.join("\n"));

      if (automationConfig.accounts.length === 0) {
        console.log(
          "Hint        : configure FIGMA_AUTOMATION_ACCOUNTS (JSON array) or FIGMA_AUTOMATION_EMAIL / PASSWORD via Infisical."
        );
      } else {
        automationConfig.accounts.forEach((account, index) => {
          const storagePath = getStorageStatePath(automationConfig.storageDir, account.email);
          const label = account.label ? `${account.label} – ` : "";
          console.log(
            `  [${index + 1}] ${label}${account.email} (storage: ${storagePath}${
              account.totpSecret ? ", TOTP configured" : ""
            })`
          );
        });
      }
    });

  automation
    .command("run")
    .description("Execute the Profound automation plugin via Playwright")
    .requiredOption("--file <fileOrUrl>", "Figma file key or URL")
    .option("--payload <file>", "Path to JSON payload (defaults to stdin)")
    .option("--example <name>", "Name of bundled automation example payload")
    .option("--account <emailOrLabel>", "Automation account email or label to use")
    .option("--plugin-name <name>", "Override the plugin name used in quick actions")
    .option("--plugin-command <id>", "Override the plugin command id")
    .option("--timeout <ms>", "Timeout in milliseconds (default 300000)")
    .option("--headful", "Run browser in headed mode (default headless)")
    .option("--debug", "Enable devtools and verbose browser logging")
    .option("--output <file>", "Write result JSON to file instead of stdout")
    .action(async (options: AutomationRunCommandOptions) => {
      try {
        if (options.payload && options.example) {
          throw new Error("Provide either --payload or --example, not both.");
        }
        const payloadRaw = await readAutomationPayload({
          payloadPath: options.payload,
          exampleName: options.example,
        });
        const payloadJson = parseJsonPayload(payloadRaw);
        const timeoutMs = options.timeout
          ? parseIntegerOption(options.timeout, "timeout")
          : undefined;

        const result = await runAutomationJob({
          file: options.file,
          payload: payloadJson,
          accountHint: options.account,
          pluginName: options.pluginName,
          pluginCommandId: options.pluginCommand,
          timeoutMs,
          headless: options.headful ? false : true,
          debug: Boolean(options.debug),
        });

        await writeJsonOutput(
          {
            status: result.status,
            account: result.account,
            fileUrl: result.fileUrl,
            message: result.message,
            pluginResult: result.pluginResult,
            consoleLogs: result.consoleLogs,
            durationMs: Math.round(result.durationMs),
          },
          options.output
        );

        if (result.status === "error") {
          process.exitCode = 1;
        }
      } catch (error) {
        handleError(error);
      }
    });

  automation
    .command("install-plugin")
    .description("Import the Profound automation plugin manifest into Figma via Playwright")
    .option("--manifest <path>", "Path to plugin manifest.json (default: packages/figma-automation-plugin/dist/manifest.json)")
    .option("--account <emailOrLabel>", "Automation account email or label to use")
    .option("--plugin-name <name>", "Override plugin name when verifying installation")
    .option("--timeout <ms>", "Timeout in milliseconds (default 300000)")
    .option("--file <fileOrUrl>", "Figma file key or URL to open during installation")
    .option("--headful", "Run browser in headed mode (default headless)")
    .option("--debug", "Enable devtools and verbose browser logging")
    .action(async (options: AutomationInstallCommandOptions) => {
      try {
        const timeoutMs = options.timeout
          ? parseIntegerOption(options.timeout, "timeout")
          : undefined;
        const result = await installAutomationPlugin({
          manifestPath: options.manifest,
          accountHint: options.account,
          pluginNameOverride: options.pluginName,
          timeoutMs,
          headless: options.headful ? false : true,
          debug: Boolean(options.debug),
          file: options.file,
        });
        console.log(
          JSON.stringify(
            {
              status: result.status,
              account: result.account,
              pluginName: result.pluginName,
              manifestPath: result.manifestPath,
              durationMs: Math.round(result.durationMs),
              logs: result.logs,
            },
            null,
            2
          )
        );
      } catch (error) {
        handleError(error);
      }
    });

  program
    .command("design-context")
    .description("Fetch a simplified design context for a node")
    .requiredOption("--file <fileOrUrl>", "Figma file key or URL")
    .option("--node <nodeId>", "Figma node id (defaults to node in URL)")
    .option("--depth <depth>", "Traversal depth for descendants (default 2)", (value) =>
      parseIntegerOption(value, "depth")
    )
    .option("--raw", "Return the raw Figma REST response instead of simplified context")
    .option("--output <file>", "Path to save JSON output instead of stdout")
    .action(
      async (options: JsonOutputOptions & { file: string; node?: string; depth?: number }, command) => {
        await runWithClient(command, async ({ client }) => {
          const ref = parseFileReference(options.file, { defaultNodeId: options.node });
          if (!ref.nodeId) {
            throw new Error("Node id required. Provide --node or include ?node-id= in the URL.");
          }
          const response = (await client.getFileNodes(ref.fileKey, [ref.nodeId], {
            depth: options.depth ?? 2,
          })) as Record<string, unknown>;

          const payload = options.raw
            ? response
            : (buildDesignContext(response as any) as DesignContextNode[]);
          await writeJsonOutput(payload, options.output);
        });
      }
    );

  program
    .command("metadata")
    .description("Fetch lightweight metadata for a node or page")
    .requiredOption("--file <fileOrUrl>", "Figma file key or URL")
    .option("--node <nodeId>", "Figma node id (defaults to node in URL)")
    .option("--output <file>", "Path to save JSON output instead of stdout")
    .action(async (options: JsonOutputOptions & { file: string; node?: string }, command) => {
      await runWithClient(command, async ({ client }) => {
        const ref = parseFileReference(options.file, { defaultNodeId: options.node });
        if (!ref.nodeId) {
          throw new Error("Node id required. Provide --node or include ?node-id= in the URL.");
        }
        const response = (await client.getFileNodes(ref.fileKey, [ref.nodeId])) as Record<
          string,
          unknown
        >;
        const payload = buildMetadata(response as any) as MetadataNode[];
        await writeJsonOutput(payload, options.output);
      });
    });

  program
    .command("variable-defs")
    .description("Retrieve variable definitions for a file")
    .requiredOption("--file <fileOrUrl>", "Figma file key or URL")
    .option("--output <file>", "Path to save JSON output instead of stdout")
    .action(async (options: JsonOutputOptions & { file: string }, command) => {
      await runWithClient(command, async ({ client }) => {
        const ref = parseFileReference(options.file);
        const data = await client.getVariables(ref.fileKey);
        await writeJsonOutput(data, options.output);
      });
    });

  program
    .command("code-connect-map")
    .description("Retrieve the code connect map for a file")
    .requiredOption("--file <fileOrUrl>", "Figma file key or URL")
    .option("--output <file>", "Path to save JSON output instead of stdout")
    .action(async (options: JsonOutputOptions & { file: string }, command) => {
      await runWithClient(command, async ({ client }) => {
        const ref = parseFileReference(options.file);
        const data = await client.getCodeConnectMap(ref.fileKey);
        await writeJsonOutput(data, options.output);
      });
    });

  program
    .command("screenshot")
    .description("Download a screenshot for a node and save it to /tmp")
    .requiredOption("--file <fileOrUrl>", "Figma file key or URL")
    .option("--node <nodeId>", "Figma node id (defaults to node in URL)")
    .option("--scale <number>", "Image scale 0.1–4 (default 1)", (value) =>
      parseFloatOption(value, "scale")
    )
    .option("--format <format>", "Image format png|jpg|svg (default png)", "png")
    .option("--tmp-dir <dir>", "Temporary directory to save the image")
    .option("--name <hint>", "Optional filename hint used in the saved image name")
    .action(async (options: ScreenshotCommandOptions, command) => {
      await runWithClient(command, async ({ client }) => {
        const ref = parseFileReference(options.file, { defaultNodeId: options.node });
        if (!ref.nodeId) {
          throw new Error("Node id required. Provide --node or include ?node-id= in the URL.");
        }

        const nodeId = ref.nodeId;
        const scale = options.scale ? Number(options.scale) : 1;
        if (!Number.isFinite(scale) || scale <= 0 || scale > 4) {
          throw new Error("Invalid --scale value. Provide a number between 0.1 and 4.");
        }

        const formatRaw = (options.format ?? "png").toLowerCase();
        if (!["png", "jpg", "svg"].includes(formatRaw)) {
          throw new Error("Invalid --format value. Expected png, jpg, or svg.");
        }
        const format = formatRaw as "png" | "jpg" | "svg";

        const urls = await client.getImageUrls(ref.fileKey, [nodeId], { format, scale });
        const imageUrl = urls[nodeId];
        if (!imageUrl) {
          throw new Error("Figma did not return an image URL for the requested node.");
        }

        const savedPath = await client.downloadImageToTmp(imageUrl, nodeId, {
          format,
          tmpDir: options.tmpDir,
          filenameHint: options.name ?? sanitizeFilename(nodeId),
        });

        console.log(`image saved to ${savedPath}`);
      });
    });

  program
    .command("design-system-rules")
    .description("Generate heuristic design system rules from a node selection")
    .requiredOption("--file <fileOrUrl>", "Figma file key or URL")
    .option("--node <nodeId>", "Figma node id (defaults to node in URL)")
    .option("--depth <depth>", "Traversal depth for descendants (default 3)", (value) =>
      parseIntegerOption(value, "depth")
    )
    .option("--output <file>", "Path to save JSON output instead of stdout")
    .action(
      async (options: JsonOutputOptions & { file: string; node?: string; depth?: number }, command) => {
        await runWithClient(command, async ({ client }) => {
          const ref = parseFileReference(options.file, { defaultNodeId: options.node });
          if (!ref.nodeId) {
            throw new Error("Node id required. Provide --node or include ?node-id= in the URL.");
          }
          const response = (await client.getFileNodes(ref.fileKey, [ref.nodeId], {
            depth: options.depth ?? 3,
          })) as Record<string, unknown>;
          const rules = deriveDesignSystemRules(response as any) as DesignSystemRules;
          await writeJsonOutput(rules, options.output);
        });
      }
    );

  program.hook("preAction", () => {
    // Reserved for future logging/tracing hooks.
  });

  return program;
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const program = createProgram();
  const args = Array.from(argv);
  if (args.length > 2 && args[2] === "--") {
    args.splice(2, 1);
  }
  try {
    await program.parseAsync(args as string[]);
  } catch (error) {
    handleError(error);
  }
}

function getGlobalOverrides(command: Command): LoadConfigOptions {
  const opts = command.optsWithGlobals?.() ?? {};
  const apiBase =
    typeof opts.apiBase === "string" && opts.apiBase.trim() ? opts.apiBase.trim() : undefined;
  const token =
    typeof opts.token === "string" && opts.token.trim() ? opts.token.trim() : undefined;
  return {
    baseUrlOverride: apiBase,
    tokenOverride: token,
  };
}

async function runWithClient(
  command: Command,
  handler: (context: { client: FigmaRestClient; resolved: ResolvedConfig }) => Promise<void>
): Promise<void> {
  const overrides = getGlobalOverrides(command);
  const resolved = loadResolvedConfig(overrides);
  const token = resolved.token;
  if (!token) {
    console.error(
      "[figma-api] Missing token. Set FIGMA_PERSONAL_ACCESS_TOKEN via Infisical or run `pnpm figma-api auth login`."
    );
    process.exitCode = 1;
    return;
  }

  const client = new FigmaRestClient({
    token,
    baseUrl: resolved.apiBaseUrl,
  });

  try {
    await handler({ client, resolved });
  } catch (error) {
    handleError(error);
  }
}

async function writeJsonOutput(data: unknown, outputPath?: string): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  if (outputPath) {
    const resolvedPath = path.resolve(outputPath);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
    fs.writeFileSync(resolvedPath, `${text}\n`, "utf8");
    console.log(`wrote ${resolvedPath}`);
  } else {
    console.log(text);
  }
}

async function readAutomationPayload(options: {
  payloadPath?: string;
  exampleName?: string;
} = {}): Promise<string> {
  const { payloadPath, exampleName } = options;

  if (exampleName) {
    return loadExamplePayload(exampleName);
  }

  if (payloadPath) {
    const resolved = path.resolve(payloadPath);
    return await fs.promises.readFile(resolved, "utf8");
  }

  if (process.stdin.isTTY) {
    throw new Error(
      "Missing payload. Provide --payload <file> or pipe JSON payload via stdin."
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    throw new Error("No payload data received from stdin.");
  }
  return text;
}

function parseJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Empty payload JSON. Provide valid JSON instructions for the automation plugin.");
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${(error as Error).message}`);
  }
}

function handleError(error: unknown): void {
  if (error instanceof FigmaApiError) {
    const prefix = `[figma-api] Request failed (${error.status})`;
    console.error(`${prefix} ${error.message}`);

    if (error.status === 403) {
      console.error(
        "Hint: ensure your PAT includes required scopes such as file_content:read, file_variables:read."
      );
    } else if (error.status === 404) {
      console.error("Hint: confirm the file key, node id, and PAT permissions are correct.");
    }

    if (error.details) {
      const details =
        typeof error.details === "string"
          ? error.details
          : JSON.stringify(error.details, null, 2);
      console.error(details);
    }
  } else if (error instanceof Error) {
    console.error(`[figma-api] ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}

function parseIntegerOption(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --${name} value.`);
  }
  return parsed;
}

function parseFloatOption(value: string, name: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --${name} value.`);
  }
  return parsed;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-z0-9-_]/gi, "_");
}

const EXAMPLES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../examples"
);

function loadExamplePayload(exampleName: string): string {
  const normalized = exampleName.trim();
  if (!normalized) {
    throw new Error("Example name cannot be empty.");
  }
  const safeName = normalized.replace(/[^a-z0-9-_]/gi, "").toLowerCase();
  const available = listExamplePayloads();
  const targetFile = path.join(EXAMPLES_DIR, `${safeName}.json`);
  if (!fs.existsSync(targetFile)) {
    const hint =
      available.length > 0 ? `Available examples: ${available.join(", ")}.` : "No examples found.";
    throw new Error(`Automation example "${normalized}" not found. ${hint}`);
  }
  return fs.readFileSync(targetFile, "utf8");
}

function listExamplePayloads(): string[] {
  if (!fs.existsSync(EXAMPLES_DIR)) {
    return [];
  }
  return fs
    .readdirSync(EXAMPLES_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.replace(/\.json$/i, ""))
    .sort();
}

export type { JsonOutputOptions, ScreenshotCommandOptions };
export { handleError };
