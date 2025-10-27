import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keyboardPressed: string[] = [];
const typedChunks: string[] = [];
const evaluatePayloads: Array<{ payload: unknown; pluginCommandId?: string }> = [];
const gotoUrls: string[] = [];
const consoleHandlers: Array<(msg: { text(): string }) => void> = [];

const keyboardMock = {
  press: vi.fn(async (key: string) => {
    keyboardPressed.push(key);
  }),
  type: vi.fn(async (text: string) => {
    typedChunks.push(text);
  }),
};

const pageMock = {
  goto: vi.fn(async (url: string) => {
    gotoUrls.push(url);
  }),
  waitForTimeout: vi.fn(async () => {}),
  evaluate: vi.fn(async (_fn: unknown, arg: any) => {
    evaluatePayloads.push(arg);
  }),
  keyboard: keyboardMock,
  waitForSelector: vi.fn(async () => ({})),
  on: vi.fn((event: string, handler: (msg: { text(): string }) => void) => {
    if (event === "console") {
      consoleHandlers.push(handler);
      setTimeout(() => {
        handler({
          text: () => 'PH_AUTOMATION_RESULT:{"message":"ok","data":{"created":3}}',
        });
      }, 10);
    }
  }),
  off: vi.fn((event: string, handler: (msg: { text(): string }) => void) => {
    if (event === "console") {
      const index = consoleHandlers.indexOf(handler);
      if (index >= 0) {
        consoleHandlers.splice(index, 1);
      }
    }
  }),
};

const contextMock = {
  newPage: vi.fn(async () => pageMock),
  storageState: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
};

const browserMock = {
  newContext: vi.fn(async () => contextMock),
  close: vi.fn(async () => {}),
};

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => browserMock),
  },
}));

describe("automation runner", () => {
  const tempRoot = path.join(os.tmpdir(), "figma-automation-runner-tests");
  let storageDir: string;
  let runAutomationJob: typeof import("../automation/runner.js").runAutomationJob;
  let getStorageStatePath: typeof import("../automationConfig.js").getStorageStatePath;
  let ensureStorageDirExists: typeof import("../automationConfig.js").ensureStorageDirExists;

  beforeEach(async () => {
    vi.resetModules();
    keyboardPressed.length = 0;
    typedChunks.length = 0;
    evaluatePayloads.length = 0;
    gotoUrls.length = 0;
    consoleHandlers.length = 0;
    Object.values(keyboardMock).forEach((fn) => (fn as any).mockClear?.());
    Object.values(pageMock).forEach((fn) => (fn as any).mockClear?.());
    Object.values(contextMock).forEach((fn) => (fn as any).mockClear?.());
    Object.values(browserMock).forEach((fn) => (fn as any).mockClear?.());

    if (!fs.existsSync(tempRoot)) {
      fs.mkdirSync(tempRoot, { recursive: true });
    }
    storageDir = fs.mkdtempSync(path.join(tempRoot, path.sep));
    process.env.FIGMA_AUTOMATION_STORAGE_DIR = storageDir;
    process.env.FIGMA_AUTOMATION_ACCOUNTS = JSON.stringify([
      { email: "runner@example.com", password: "secret" },
    ]);
    process.env.FIGMA_AUTOMATION_PLUGIN_NAME = "Automation Runner";

    ({ getStorageStatePath, ensureStorageDirExists } = await import("../automationConfig.js"));
    ({ runAutomationJob } = await import("../automation/runner.js"));
  });

  afterEach(() => {
    delete process.env.FIGMA_AUTOMATION_STORAGE_DIR;
    delete process.env.FIGMA_AUTOMATION_ACCOUNTS;
    delete process.env.FIGMA_AUTOMATION_PLUGIN_NAME;
    vi.resetAllMocks();
    if (fs.existsSync(storageDir)) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it("injects payload, launches plugin, and returns result", async () => {
    ensureStorageDirExists(storageDir);
    const storageStatePath = getStorageStatePath(storageDir, "runner@example.com");
    fs.writeFileSync(storageStatePath, JSON.stringify({}));

    const result = await runAutomationJob({
      file: "https://www.figma.com/design/GB2JY7YS9LVIifmcIu83Ju/Automation?node-id=19-62607",
      payload: { instructions: "build" },
    });

    expect(browserMock.newContext).toHaveBeenCalledWith({ storageState: storageStatePath });
    expect(pageMock.goto).toHaveBeenCalled();
    expect(gotoUrls[0]).toMatch(/GB2JY7YS9LVIifmcIu83Ju/);
    expect(evaluatePayloads[0]).toMatchObject({
      payload: { instructions: "build" },
    });
    expect(keyboardPressed).toContain("Control+Slash");
    expect(typedChunks.join("")).toContain("Automation Runner");
    expect(contextMock.storageState).toHaveBeenCalledWith({ path: storageStatePath });
    expect(result.status).toBe("success");
    expect(result.pluginResult).toMatchObject({ created: 3 });
  });
});
