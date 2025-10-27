import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_API_BASE_URL = "https://api.figma.com/v1";

const ENV_CONFIG_DIR =
  process.env.FIGMA_API_CONFIG_DIR || process.env.FIGMA_API_CLI_HOME || undefined;
const CONFIG_DIR = ENV_CONFIG_DIR
  ? path.resolve(ENV_CONFIG_DIR)
  : path.join(os.homedir(), ".config", "profoundhealth", "figma-api-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export type TokenSource = "flag" | "env" | "config";
export type ApiBaseSource = "flag" | "env" | "config" | "default";

export interface StoredConfig {
  apiBaseUrl?: string;
  token?: string;
  /**
   * @deprecated legacy key retained for backwards-compatibility
   */
  server?: string;
}

export interface LoadConfigOptions {
  baseUrlOverride?: string;
  tokenOverride?: string;
}

export interface ResolvedConfig {
  apiBaseUrl: string;
  apiBaseSource: ApiBaseSource;
  token?: string;
  tokenSource?: TokenSource;
  configPath: string;
  storedConfig: StoredConfig;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function maskSecret(secret: string | undefined): string {
  if (!secret) return "<not set>";
  if (secret.length <= 6) return `${secret[0]}***${secret[secret.length - 1]}`;
  const prefix = secret.slice(0, 6);
  const suffix = secret.slice(-4);
  return `${prefix}…${suffix}`;
}

export function readStoredConfig(): StoredConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredConfig;
    const cleaned: StoredConfig = {};
    const apiBase = typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl.trim() : undefined;
    const legacyServer = typeof parsed.server === "string" ? parsed.server.trim() : undefined;

    if (apiBase) {
      cleaned.apiBaseUrl = apiBase;
    } else if (legacyServer) {
      cleaned.apiBaseUrl = legacyServer;
    }

    if (typeof parsed.token === "string" && parsed.token.trim()) {
      cleaned.token = parsed.token.trim();
    }

    return cleaned;
  } catch (error) {
    console.warn("[figma-api] Unable to read config file; ignoring.", error);
    return {};
  }
}

export function writeStoredConfig(update: StoredConfig): void {
  const existing = readStoredConfig();
  const merged: StoredConfig = {
    ...existing,
    ...update,
  };
  // strip undefined/empty values
  if (merged.apiBaseUrl?.trim() === "") {
    delete merged.apiBaseUrl;
  }
  if (merged.token?.trim() === "") {
    delete merged.token;
  }
  delete merged.server;

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  const payload = JSON.stringify(merged, null, 2);
  fs.writeFileSync(CONFIG_FILE, payload, { encoding: "utf8", mode: 0o600 });
}

export function clearStoredConfig(): void {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.rmSync(CONFIG_FILE, { force: true });
    }
  } catch (error) {
    console.warn("[figma-api] Failed to remove config file", error);
  }
}

export function loadResolvedConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const stored = readStoredConfig();

  const envBase =
    process.env.FIGMA_API_BASE_URL?.trim() || process.env.FIGMA_MCP_SERVER?.trim();
  const envToken =
    process.env.FIGMA_PERSONAL_ACCESS_TOKEN?.trim() ||
    process.env.FIGMA_MCP_TOKEN?.trim();

  let apiBaseUrl = DEFAULT_API_BASE_URL;
  let apiBaseSource: ApiBaseSource = "default";

  if (options.baseUrlOverride?.trim()) {
    apiBaseUrl = options.baseUrlOverride.trim();
    apiBaseSource = "flag";
  } else if (envBase) {
    apiBaseUrl = envBase;
    apiBaseSource = "env";
  } else if (stored.apiBaseUrl) {
    apiBaseUrl = stored.apiBaseUrl;
    apiBaseSource = "config";
  }

  let token: string | undefined;
  let tokenSource: TokenSource | undefined;

  if (options.tokenOverride?.trim()) {
    token = options.tokenOverride.trim();
    tokenSource = "flag";
  } else if (envToken) {
    token = envToken;
    tokenSource = "env";
  } else if (stored.token) {
    token = stored.token;
    tokenSource = "config";
  }

  return {
    apiBaseUrl,
    apiBaseSource,
    token,
    tokenSource,
    configPath: CONFIG_FILE,
    storedConfig: stored,
  };
}
