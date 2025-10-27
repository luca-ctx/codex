import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempRoot = path.join(os.tmpdir(), "figma-api-cli-tests");

describe("config helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    if (!fs.existsSync(tempRoot)) {
      fs.mkdirSync(tempRoot, { recursive: true });
    }
    tempDir = fs.mkdtempSync(path.join(tempRoot, path.sep));
    process.env.FIGMA_API_CONFIG_DIR = tempDir;
    delete process.env.FIGMA_PERSONAL_ACCESS_TOKEN;
    delete process.env.FIGMA_MCP_TOKEN;
    delete process.env.FIGMA_MCP_SERVER;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.FIGMA_API_CONFIG_DIR;
    delete process.env.FIGMA_PERSONAL_ACCESS_TOKEN;
    delete process.env.FIGMA_MCP_TOKEN;
    delete process.env.FIGMA_MCP_SERVER;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("falls back to defaults and persists merged config", async () => {
    const config = await import("../config.js");
    const { DEFAULT_API_BASE_URL, getConfigPath, loadResolvedConfig, writeStoredConfig } = config;

    const first = loadResolvedConfig();
    expect(first.apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(first.token).toBeUndefined();
    expect(getConfigPath().startsWith(tempDir)).toBeTruthy();

    writeStoredConfig({ token: "figd_test_token", apiBaseUrl: "https://custom" });

    const second = loadResolvedConfig();
    expect(second.apiBaseUrl).toBe("https://custom");
    expect(second.apiBaseSource).toBe("config");
    expect(second.token).toBe("figd_test_token");
    expect(second.tokenSource).toBe("config");
  });

  it("prefers environment variables over stored config", async () => {
    const config = await import("../config.js");
    const { loadResolvedConfig, writeStoredConfig } = config;

    writeStoredConfig({ token: "figd_stored", apiBaseUrl: "https://stored" });

    process.env.FIGMA_PERSONAL_ACCESS_TOKEN = "figd_env";
    process.env.FIGMA_API_BASE_URL = "https://env";

    const resolved = loadResolvedConfig();
    expect(resolved.apiBaseUrl).toBe("https://env");
    expect(resolved.apiBaseSource).toBe("env");
    expect(resolved.token).toBe("figd_env");
    expect(resolved.tokenSource).toBe("env");
  });

  it("allows call-site overrides to win", async () => {
    const config = await import("../config.js");
    const { loadResolvedConfig } = config;

    process.env.FIGMA_PERSONAL_ACCESS_TOKEN = "figd_env";
    const resolved = loadResolvedConfig({
      baseUrlOverride: "https://flag",
      tokenOverride: "figd_flag",
    });

    expect(resolved.apiBaseUrl).toBe("https://flag");
    expect(resolved.apiBaseSource).toBe("flag");
    expect(resolved.token).toBe("figd_flag");
    expect(resolved.tokenSource).toBe("flag");
  });
});
