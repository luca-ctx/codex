import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Source = "env" | "config" | "default";

export interface AutomationAccount {
  email: string;
  password: string;
  totpSecret?: string;
  label?: string;
}

export interface AutomationConfig {
  accounts: AutomationAccount[];
  accountsSource: Source;
  storageDir: string;
  storageSource: Source;
  pluginId?: string;
  pluginSource?: Source;
  pluginName?: string;
  pluginNameSource?: Source;
  pluginCommandId?: string;
  figmaBaseUrl: string;
  figmaBaseSource: Source;
}

const DEFAULT_STORAGE_DIR = path.join(
  os.homedir(),
  ".cache",
  "profoundhealth",
  "figma-automation"
);

const DEFAULT_FIGMA_BASE_URL = "https://www.figma.com";
const DEFAULT_PLUGIN_NAME = "Profound Automation Runner";

const CONFIG_PATH =
  process.env.FIGMA_AUTOMATION_CONFIG_PATH ||
  path.join(
    os.homedir(),
    ".config",
    "profoundhealth",
    "figma-automation.json"
  );

interface AutomationConfigFile {
  storageDir?: string;
  figmaBaseUrl?: string;
  pluginId?: string;
  pluginName?: string;
  pluginCommandId?: string;
  accounts?: Array<AutomationAccount>;
}

function readConfigFile(): AutomationConfigFile {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return {};
    }
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw) as AutomationConfigFile;
  } catch (error) {
    console.warn("[figma-automation] Unable to read config file, ignoring.", error);
    return {};
  }
}

function parseAccountsFromEnv(): AutomationAccount[] | undefined {
  const rawList = process.env.FIGMA_AUTOMATION_ACCOUNTS;
  if (rawList) {
    try {
      const parsed = JSON.parse(rawList);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => {
            if (!entry || typeof entry !== "object") return undefined;
            const email = typeof entry.email === "string" ? entry.email.trim() : "";
            const password =
              typeof entry.password === "string" ? entry.password.trim() : "";
            if (!email || !password) return undefined;
            const totpSecret =
              typeof entry.totpSecret === "string" ? entry.totpSecret.trim() : undefined;
            const label =
              typeof entry.label === "string" && entry.label.trim()
                ? entry.label.trim()
                : undefined;
            return { email, password, totpSecret, label };
          })
          .filter(Boolean) as AutomationAccount[];
      }
    } catch (error) {
      console.warn("[figma-automation] Failed to parse FIGMA_AUTOMATION_ACCOUNTS JSON", error);
    }
  }

  const singleEmail = process.env.FIGMA_AUTOMATION_EMAIL?.trim();
  const singlePassword = process.env.FIGMA_AUTOMATION_PASSWORD?.trim();
  if (singleEmail && singlePassword) {
    const singleTotp = process.env.FIGMA_AUTOMATION_TOTP_SECRET?.trim() || undefined;
    return [{ email: singleEmail, password: singlePassword, totpSecret: singleTotp }];
  }

  return undefined;
}

export function loadAutomationConfig(): AutomationConfig {
  const fileConfig = readConfigFile();

  const envAccounts = parseAccountsFromEnv();
  const fileAccounts = Array.isArray(fileConfig.accounts) ? fileConfig.accounts : undefined;
  const accounts =
    envAccounts && envAccounts.length > 0
      ? envAccounts
      : fileAccounts && fileAccounts.length > 0
        ? fileAccounts
        : [];
  const accountsSource: Source = envAccounts
    ? "env"
    : fileAccounts && fileAccounts.length > 0
      ? "config"
      : "default";

  const envStorage = process.env.FIGMA_AUTOMATION_STORAGE_DIR?.trim();
  const storageDir = envStorage || fileConfig.storageDir || DEFAULT_STORAGE_DIR;
  const storageSource: Source = envStorage ? "env" : fileConfig.storageDir ? "config" : "default";

  const envPluginId = process.env.FIGMA_AUTOMATION_PLUGIN_ID?.trim();
  const pluginId = envPluginId || fileConfig.pluginId || undefined;
  const pluginSource: Source | undefined = envPluginId
    ? "env"
    : fileConfig.pluginId
      ? "config"
      : undefined;

  const envPluginName = process.env.FIGMA_AUTOMATION_PLUGIN_NAME?.trim();
  const pluginName = envPluginName || fileConfig.pluginName || DEFAULT_PLUGIN_NAME;
  const pluginNameSource: Source | undefined = envPluginName
    ? "env"
    : fileConfig.pluginName
      ? "config"
      : "default";

  const envPluginCommand = process.env.FIGMA_AUTOMATION_PLUGIN_COMMAND_ID?.trim();
  const pluginCommandId = envPluginCommand || fileConfig.pluginCommandId || undefined;

  const envFigmaBase = process.env.FIGMA_AUTOMATION_FIGMA_BASE_URL?.trim();
  const figmaBaseUrl = envFigmaBase || fileConfig.figmaBaseUrl || DEFAULT_FIGMA_BASE_URL;
  const figmaBaseSource: Source = envFigmaBase
    ? "env"
    : fileConfig.figmaBaseUrl
      ? "config"
      : "default";

  return {
    accounts,
    accountsSource,
    storageDir,
    storageSource,
    pluginId,
    pluginSource,
    pluginCommandId,
    pluginName,
    pluginNameSource,
    figmaBaseUrl,
    figmaBaseSource,
  };
}

export function ensureStorageDirExists(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function getStorageStatePath(storageDir: string, email: string): string {
  const safeEmail = email.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(storageDir, `${safeEmail}.json`);
}

export function getAccountLockPath(storageDir: string, email: string): string {
  const locksDir = path.join(storageDir, "locks");
  if (!fs.existsSync(locksDir)) {
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  }
  const safeEmail = email.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(locksDir, `${safeEmail}.lock`);
}
