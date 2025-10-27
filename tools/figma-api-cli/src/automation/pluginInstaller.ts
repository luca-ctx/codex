import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  ensureStorageDirExists,
  getAccountLockPath,
  getStorageStatePath,
  loadAutomationConfig,
  type AutomationConfig,
} from "../automationConfig.js";
import { acquireLock, buildDesignUrl, prepareContext, selectAccount } from "./runner.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const QUICK_ACTION_IMPORT_LABEL = "Import plugin from manifest";

export interface InstallPluginOptions {
  manifestPath?: string;
  accountHint?: string;
  timeoutMs?: number;
  headless?: boolean;
  debug?: boolean;
  file?: string;
  pluginNameOverride?: string;
}

export interface InstallPluginResult {
  status: "success";
  account: string;
  manifestPath: string;
  pluginName: string;
  durationMs: number;
  logs: string[];
}

export async function installAutomationPlugin(
  options: InstallPluginOptions = {},
  configOverride?: AutomationConfig
): Promise<InstallPluginResult> {
  const logs: string[] = [];
  const config = configOverride ?? loadAutomationConfig();
  const account = selectAccount(config.accounts, options.accountHint);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headless = options.headless !== false;
  const pluginName = options.pluginNameOverride ?? config.pluginName ?? "Profound Automation Runner";
  const manifestPath = resolveManifestPath(options.manifestPath);

  ensureStorageDirExists(config.storageDir);
  const storagePath = getStorageStatePath(config.storageDir, account.email);
  const lockPath = getAccountLockPath(config.storageDir, account.email);
  const releaseLock = await acquireLock(lockPath);

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  const start = performance.now();

  try {
    browser = await chromium.launch({
      headless,
      args: options.debug ? ["--auto-open-devtools-for-tabs"] : undefined,
    });

    context = await prepareContext(browser, storagePath, account, config, timeoutMs, logs);
    const page = await context.newPage();

    page.on("console", (msg) => {
      logs.push(msg.text());
    });

    const targetUrl = resolveTargetUrl(config, options.file);
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: timeoutMs });
    await page.waitForTimeout(2000);

    await importPluginViaQuickActions(page, manifestPath, timeoutMs, logs);
    await verifyPluginRegistration(page, pluginName, timeoutMs, logs);

    await context.storageState({ path: storagePath });
    try {
      fs.chmodSync(storagePath, 0o600);
    } catch (error) {
      logs.push(`Warning: unable to chmod storage state (${(error as Error).message})`);
    }

    const durationMs = performance.now() - start;
    logs.push(`Imported plugin manifest ${manifestPath}`);

    return {
      status: "success",
      account: account.email,
      manifestPath,
      pluginName,
      durationMs,
      logs,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    await releaseLock().catch(() => {});
  }
}

function resolveManifestPath(manifestPath?: string): string {
  const candidate =
    manifestPath && manifestPath.trim()
      ? path.resolve(manifestPath.trim())
      : path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../figma-automation-plugin/dist/manifest.json"
        );
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `Plugin manifest not found at ${candidate}. Build @icp/figma-automation-plugin or provide --manifest.`
    );
  }
  return candidate;
}

function resolveTargetUrl(config: AutomationConfig, fileInput?: string): string {
  if (fileInput) {
    return buildDesignUrl(config.figmaBaseUrl, fileInput);
  }
  const base = stripTrailingSlash(config.figmaBaseUrl);
  return `${base}/files`;
}

async function importPluginViaQuickActions(
  page: Page,
  manifestPath: string,
  timeoutMs: number,
  logs: string[]
): Promise<void> {
  await openQuickActions(page, timeoutMs);
  await page.keyboard.type(QUICK_ACTION_IMPORT_LABEL, { delay: 60 });
  await page.waitForTimeout(250);

  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: timeoutMs });
  await page.keyboard.press("Enter");
  const chooser = await fileChooserPromise;
  await chooser.setFiles(manifestPath);
  logs.push(`Selected manifest ${manifestPath} via quick actions.`);

  // Give Figma time to process the manifest.
  await page.waitForTimeout(2000);
}

async function verifyPluginRegistration(
  page: Page,
  pluginName: string,
  timeoutMs: number,
  logs: string[]
): Promise<void> {
  await openQuickActions(page, timeoutMs);
  await page.keyboard.type(pluginName, { delay: 50 });

  const candidate = page.locator('[data-testid="quick-switcher-item"], [data-testid="typeahead-item"]')
    .filter({ hasText: pluginName })
    .first();

  await candidate.waitFor({ timeout: timeoutMs });
  logs.push(`Verified plugin "${pluginName}" appears in quick actions.`);
}

async function openQuickActions(page: Page, timeoutMs: number): Promise<void> {
  const combo = process.platform === "darwin" ? "Meta+Slash" : "Control+Slash";
  await page.keyboard.press(combo);
  if (process.platform === "darwin") {
    await page.keyboard.press("Control+Slash");
  }
  await waitForQuickActionInput(page, timeoutMs);
}

async function waitForQuickActionInput(page: Page, timeoutMs: number): Promise<void> {
  const selectors: string[] = [
    '[data-testid="quick-switcher"] input',
    '[data-testid="quick-switcher-search"] input',
    'input[placeholder*="Search"]',
    'input[placeholder*="Quick actions"]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      await locator.waitFor({ state: "visible", timeout: 500 });
      return;
    }
  }
  await page.waitForSelector(selectors.join(","), { timeout: timeoutMs });
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
