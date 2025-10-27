import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempRoot = path.join(os.tmpdir(), "figma-automation-tests");

describe("automation config", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    if (!fs.existsSync(tempRoot)) {
      fs.mkdirSync(tempRoot, { recursive: true });
    }
    tempDir = fs.mkdtempSync(path.join(tempRoot, path.sep));
    configPath = path.join(tempDir, "config.json");
    process.env.FIGMA_AUTOMATION_CONFIG_PATH = configPath;
    delete process.env.FIGMA_AUTOMATION_ACCOUNTS;
    delete process.env.FIGMA_AUTOMATION_EMAIL;
    delete process.env.FIGMA_AUTOMATION_PASSWORD;
    delete process.env.FIGMA_AUTOMATION_TOTP_SECRET;
    delete process.env.FIGMA_AUTOMATION_STORAGE_DIR;
    delete process.env.FIGMA_AUTOMATION_PLUGIN_ID;
    delete process.env.FIGMA_AUTOMATION_PLUGIN_COMMAND_ID;
    delete process.env.FIGMA_AUTOMATION_PLUGIN_NAME;
    delete process.env.FIGMA_AUTOMATION_FIGMA_BASE_URL;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.FIGMA_AUTOMATION_CONFIG_PATH;
    delete process.env.FIGMA_AUTOMATION_ACCOUNTS;
    delete process.env.FIGMA_AUTOMATION_EMAIL;
    delete process.env.FIGMA_AUTOMATION_PASSWORD;
    delete process.env.FIGMA_AUTOMATION_TOTP_SECRET;
    delete process.env.FIGMA_AUTOMATION_STORAGE_DIR;
    delete process.env.FIGMA_AUTOMATION_PLUGIN_ID;
    delete process.env.FIGMA_AUTOMATION_PLUGIN_COMMAND_ID;
    delete process.env.FIGMA_AUTOMATION_PLUGIN_NAME;
    delete process.env.FIGMA_AUTOMATION_FIGMA_BASE_URL;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads accounts from environment JSON", async () => {
    process.env.FIGMA_AUTOMATION_ACCOUNTS = JSON.stringify([
      { email: "one@example.com", password: "pass-1", totpSecret: "AAA", label: "primary" },
      { email: "two@example.com", password: "pass-2" },
    ]);
    const config = await import("../automationConfig.js");
    const { loadAutomationConfig } = config;

    const resolved = loadAutomationConfig();
    expect(resolved.accountsSource).toBe("env");
    expect(resolved.accounts).toHaveLength(2);
    expect(resolved.accounts[0]).toMatchObject({
      email: "one@example.com",
      password: "pass-1",
      totpSecret: "AAA",
      label: "primary",
    });
    expect(resolved.accounts[1]).toMatchObject({
      email: "two@example.com",
      password: "pass-2",
    });
  });

  it("falls back to single account env variables", async () => {
    process.env.FIGMA_AUTOMATION_EMAIL = "admin@example.com";
    process.env.FIGMA_AUTOMATION_PASSWORD = "secret";
    process.env.FIGMA_AUTOMATION_TOTP_SECRET = "totp";

    const config = await import("../automationConfig.js");
    const { loadAutomationConfig } = config;

    const resolved = loadAutomationConfig();
    expect(resolved.accountsSource).toBe("env");
    expect(resolved.accounts).toHaveLength(1);
    expect(resolved.accounts[0]).toEqual({
      email: "admin@example.com",
      password: "secret",
      totpSecret: "totp",
    });
  });

  it("reads config file when environment missing", async () => {
    const filePayload = {
      storageDir: path.join(tempDir, "storage"),
      pluginId: "1234",
      pluginName: "Profound Automation",
      figmaBaseUrl: "https://staging.figma.com",
      accounts: [{ email: "file@example.com", password: "file-pass" }],
    };
    fs.writeFileSync(configPath, JSON.stringify(filePayload));

    const config = await import("../automationConfig.js");
    const { loadAutomationConfig } = config;

    const resolved = loadAutomationConfig();
    expect(resolved.accountsSource).toBe("config");
    expect(resolved.accounts[0].email).toBe("file@example.com");
    expect(resolved.storageDir).toBe(filePayload.storageDir);
    expect(resolved.storageSource).toBe("config");
    expect(resolved.pluginId).toBe("1234");
    expect(resolved.pluginSource).toBe("config");
    expect(resolved.pluginName).toBe("Profound Automation");
    expect(resolved.pluginNameSource).toBe("config");
    expect(resolved.figmaBaseUrl).toBe("https://staging.figma.com");
    expect(resolved.figmaBaseSource).toBe("config");
  });

  it("applies defaults when nothing configured", async () => {
    const config = await import("../automationConfig.js");
    const { loadAutomationConfig, getStorageStatePath } = config;

    const resolved = loadAutomationConfig();
    expect(resolved.accounts).toHaveLength(0);
    expect(resolved.accountsSource).toBe("default");
    expect(resolved.storageSource).toBe("default");
    expect(resolved.pluginName).toBe("Profound Automation Runner");
    expect(resolved.pluginNameSource).toBe("default");
    const storagePath = getStorageStatePath(resolved.storageDir, "user@example.com");
    expect(storagePath.endsWith("user_example.com.json")).toBe(true);
  });
});
