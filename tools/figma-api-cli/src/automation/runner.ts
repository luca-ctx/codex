import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Page, type ConsoleMessage } from "playwright";
import { totp } from "otplib";
import {
  ensureStorageDirExists,
  getAccountLockPath,
  getStorageStatePath,
  loadAutomationConfig,
  type AutomationAccount,
  type AutomationConfig,
} from "../automationConfig.js";
import { encodeNodeId, parseFileReference } from "../fileReference.js";

const RESULT_PREFIX = "PH_AUTOMATION_RESULT:";
const ERROR_PREFIX = "PH_AUTOMATION_ERROR:";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface AutomationRunnerOptions {
  file: string;
  payload: unknown;
  accountHint?: string;
  pluginName?: string;
  pluginCommandId?: string;
  timeoutMs?: number;
  headless?: boolean;
  debug?: boolean;
}

export interface AutomationRunnerResult {
  status: "success" | "error";
  account: string;
  fileUrl: string;
  pluginResult?: unknown;
  message?: string;
  consoleLogs: string[];
  durationMs: number;
}

interface PluginResultPayload {
  status: "success" | "error";
  data?: unknown;
  message?: string;
}

export async function runAutomationJob(
  options: AutomationRunnerOptions,
  configOverride?: AutomationConfig
): Promise<AutomationRunnerResult> {
  const config = configOverride ?? loadAutomationConfig();
  const account = selectAccount(config.accounts, options.accountHint);
  const pluginName = options.pluginName ?? config.pluginName;

  if (!pluginName) {
    throw new Error(
      "Plugin name not configured. Set FIGMA_AUTOMATION_PLUGIN_NAME or pass --plugin-name."
    );
  }

  const pluginCommandId = options.pluginCommandId ?? config.pluginCommandId;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headless = options.headless !== false;
  const logs: string[] = [];
  const runStart = performance.now();

  ensureStorageDirExists(config.storageDir);
  const storagePath = getStorageStatePath(config.storageDir, account.email);
  const lockPath = getAccountLockPath(config.storageDir, account.email);
  const releaseLock = await acquireLock(lockPath);

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

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

    const fileUrl = buildDesignUrl(config.figmaBaseUrl, options.file);
    await page.goto(fileUrl, { waitUntil: "networkidle", timeout: timeoutMs });
    await page.waitForTimeout(4000);

    await injectJobPayload(page, {
      payload: options.payload,
      pluginCommandId,
    });

    const resultPromise = waitForPluginResult(page, timeoutMs);
    await launchPlugin(page, pluginName, timeoutMs);
    const pluginResult = await resultPromise;

    await context.storageState({ path: storagePath });
    try {
      fs.chmodSync(storagePath, 0o600);
    } catch (error) {
      logs.push(`Warning: unable to chmod storage state (${(error as Error).message})`);
    }

    const durationMs = performance.now() - runStart;

    if (pluginResult.status === "error") {
      return {
        status: "error",
        account: account.email,
        fileUrl,
        pluginResult: pluginResult.data,
        message: pluginResult.message ?? "Plugin reported an error",
        consoleLogs: logs,
        durationMs,
      };
    }

    return {
      status: "success",
      account: account.email,
      fileUrl,
      pluginResult: pluginResult.data,
      message: pluginResult.message,
      consoleLogs: logs,
      durationMs,
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

export function selectAccount(accounts: AutomationAccount[], hint?: string): AutomationAccount {
  if (accounts.length === 0) {
    throw new Error(
      "No automation accounts configured. Set FIGMA_AUTOMATION_ACCOUNTS or FIGMA_AUTOMATION_EMAIL/PASSWORD."
    );
  }
  if (!hint) {
    return accounts[0];
  }
  const normalizedHint = hint.toLowerCase();
  const match = accounts.find((account) => {
    if (account.email.toLowerCase() === normalizedHint) return true;
    if (account.label && account.label.toLowerCase() === normalizedHint) return true;
    return false;
  });
  if (!match) {
    throw new Error(`No automation account found matching "${hint}".`);
  }
  return match;
}

export async function acquireLock(lockPath: string, timeoutMs = 120000): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  const waitMs = 250;

  while (true) {
    try {
      const handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.close();
      return async () => {
        await fsp.rm(lockPath, { force: true });
      };
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr && nodeErr.code === "EEXIST") {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting to acquire automation account lock (${lockPath}).`);
        }
        await delay(waitMs);
        continue;
      }
      throw error;
    }
  }
}

export async function prepareContext(
  browser: Browser,
  storagePath: string,
  account: AutomationAccount,
  config: AutomationConfig,
  timeoutMs: number,
  logs: string[]
): Promise<BrowserContext> {
  if (fs.existsSync(storagePath)) {
    return browser.newContext({ storageState: storagePath });
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  await performLogin(page, config.figmaBaseUrl, account, timeoutMs, logs);
  await context.storageState({ path: storagePath });
  try {
    fs.chmodSync(storagePath, 0o600);
  } catch (error) {
    logs.push(`Warning: unable to chmod storage state (${(error as Error).message})`);
  }
  await context.close();
  return browser.newContext({ storageState: storagePath });
}

export async function performLogin(
  page: Page,
  baseUrl: string,
  account: AutomationAccount,
  timeoutMs: number,
  logs: string[]
): Promise<void> {
  const loginUrl = `${stripTrailingSlash(baseUrl)}/login`;
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForSelector('input[name="email"]', { timeout: timeoutMs });
  await page.fill('input[name="email"]', account.email, { timeout: timeoutMs });
  await page.fill('input[name="password"]', account.password, { timeout: timeoutMs });

  await Promise.all([
    page.waitForNavigation({ timeout: timeoutMs, waitUntil: "networkidle" }),
    page.click('button[type="submit"]'),
  ]);

  const totpInput =
    (await page.$('input[name="totp"]')) ??
    (await page.$('input[name*="twoFactor"]')) ??
    (await page.$('input[name*="otp"]'));

  if (totpInput) {
    if (!account.totpSecret) {
      throw new Error(
        "Figma requested a TOTP verification code, but FIGMA_AUTOMATION_TOTP_SECRET is not configured."
      );
    }
    const code = totp.generate(account.totpSecret);
    await totpInput.fill(code);
    const confirmButton = await page.$('button[type="submit"]');
    await Promise.all([
      page.waitForNavigation({ timeout: timeoutMs, waitUntil: "networkidle" }),
      confirmButton ? confirmButton.click() : page.keyboard.press("Enter"),
    ]);
  }

  await page.waitForURL(/figma\.com\/(design|files)/, { timeout: timeoutMs });
  logs.push("Logged into Figma and captured storage state.");
}

export function buildDesignUrl(baseUrl: string, fileInput: string): string {
  const ref = parseFileReference(fileInput);
  const root = `${stripTrailingSlash(baseUrl)}/design/${ref.fileKey}/Automation`;
  if (ref.nodeId) {
    return `${root}?node-id=${encodeNodeId(ref.nodeId)}`;
  }
  return root;
}

async function injectJobPayload(
  page: Page,
  payload: { payload: unknown; pluginCommandId?: string }
): Promise<void> {
  await page.evaluate(
    ({ payload: jobPayload, pluginCommandId }) => {
      const job = {
        payload: jobPayload,
        pluginCommandId: pluginCommandId ?? null,
        requestedAt: new Date().toISOString(),
      };
      window.localStorage.setItem("phAutomationJob", JSON.stringify(job));
      window.localStorage.removeItem("phAutomationResult");
    },
    payload
  );
}

async function launchPlugin(page: Page, pluginName: string, timeoutMs: number): Promise<void> {
  const combo = process.platform === "darwin" ? "Meta+Slash" : "Control+Slash";
  await page.keyboard.press(combo);
  if (process.platform === "darwin") {
    await page.keyboard.press("Control+Slash");
  }
  await page.waitForTimeout(250);
  await page.keyboard.type(pluginName, { delay: 50 });
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await page.waitForSelector(`iframe[title^="Plugin: ${pluginName}"]`, { timeout: timeoutMs });
}

function waitForPluginResult(page: Page, timeoutMs: number): Promise<PluginResultPayload> {
  return new Promise<PluginResultPayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for plugin result."));
    }, timeoutMs);

    const listener = (msg: ConsoleMessage) => {
      const text = msg.text();
      if (text.startsWith(RESULT_PREFIX)) {
        cleanup();
        try {
          const payload = JSON.parse(text.slice(RESULT_PREFIX.length));
          resolve({
            status: "success",
            data: payload.data ?? payload,
            message: payload.message,
          });
        } catch (error) {
          reject(
            new Error(`Failed to parse plugin result payload: ${(error as Error).message}`)
          );
        }
      } else if (text.startsWith(ERROR_PREFIX)) {
        cleanup();
        try {
          const payload = JSON.parse(text.slice(ERROR_PREFIX.length));
          resolve({
            status: "error",
            data: payload.data,
            message: payload.message ?? "Plugin error",
          });
        } catch {
          resolve({
            status: "error",
            message: text.slice(ERROR_PREFIX.length),
          });
        }
      }
    };

    function cleanup(): void {
      clearTimeout(timer);
      page.off("console", listener);
    }

    page.on("console", listener);
  });
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
