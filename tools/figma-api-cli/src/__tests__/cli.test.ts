import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli.js";
import { FigmaApiError, FigmaRestClient } from "../restClient.js";

const FILE_URL =
  "https://www.figma.com/design/GB2JY7YS9LVIifmcIu83Ju/TLDR--Website?node-id=19-62607";

describe("figma-api CLI commands", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "figma-cli-test-"));
  let logSpy: any;
  let errorSpy: any;

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.FIGMA_PERSONAL_ACCESS_TOKEN = "figd_test";
    vi.restoreAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.FIGMA_PERSONAL_ACCESS_TOKEN;
    delete process.env.FIGMA_AUTOMATION_ACCOUNTS;
    delete process.env.FIGMA_AUTOMATION_STORAGE_DIR;
    delete process.env.FIGMA_AUTOMATION_PLUGIN_ID;
    delete process.env.FIGMA_AUTOMATION_PLUGIN_COMMAND_ID;
    delete process.env.FIGMA_AUTOMATION_FIGMA_BASE_URL;
    vi.restoreAllMocks();
    process.exitCode = 0;
    for (const entry of fs.readdirSync(tmpRoot)) {
      fs.rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
    }
  });

  it("prints simplified design context JSON", async () => {
    const getFileNodes = vi
      .spyOn(FigmaRestClient.prototype, "getFileNodes")
      .mockResolvedValue({
        nodes: {
          "19:62607": {
            document: {
              id: "19:62607",
              name: "Demo Frame",
              type: "FRAME",
            },
          },
        },
      });

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(["design-context", "--file", FILE_URL], { from: "user" });

    const logCalls = logSpy.mock.calls;
    expect(logCalls.length).toBe(1);
    const printed = JSON.parse(logCalls[0][0]) as Array<{ id: string; name: string }>;
    expect(printed[0].name).toBe("Demo Frame");

    expect(getFileNodes).toHaveBeenCalledWith("GB2JY7YS9LVIifmcIu83Ju", ["19:62607"], {
      depth: 2,
    });
  });

  it("saves screenshot to tmp and prints location", async () => {
    vi.spyOn(FigmaRestClient.prototype, "getImageUrls").mockResolvedValue({
      "19:62607": "https://example.com/image.png",
    });
    vi.spyOn(FigmaRestClient.prototype, "downloadImageToTmp").mockResolvedValue(
      path.join(tmpRoot, "example.png")
    );

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(
      ["screenshot", "--file", FILE_URL, "--tmp-dir", tmpRoot, "--name", "demo"],
      { from: "user" }
    );

    const logCalls = logSpy.mock.calls;
    expect(logCalls[0][0]).toContain(`image saved to ${path.join(tmpRoot, "example.png")}`);
  });

  it("reports API errors with helpful hints", async () => {
    vi.spyOn(FigmaRestClient.prototype, "getVariables").mockRejectedValue(
      new FigmaApiError("Forbidden", 403, "https://api.figma.com/v1/files/demo/variables/local")
    );

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(
      ["variable-defs", "--file", "GB2JY7YS9LVIifmcIu83Ju"],
      { from: "user" }
    );

    const errorCalls = errorSpy.mock.calls.flat().join("\n");
    expect(errorCalls).toContain("Request failed (403)");
    expect(errorCalls).toContain("file_variables:read");
  });

  it("shows automation status with configured accounts", async () => {
    process.env.FIGMA_AUTOMATION_ACCOUNTS = JSON.stringify([
      { email: "runner@example.com", password: "secret", label: "runner-1" },
    ]);
    process.env.FIGMA_AUTOMATION_STORAGE_DIR = path.join(tmpRoot, "storage");
    process.env.FIGMA_AUTOMATION_PLUGIN_ID = "1234";
    process.env.FIGMA_AUTOMATION_PLUGIN_COMMAND_ID = "RUN";
    process.env.FIGMA_AUTOMATION_FIGMA_BASE_URL = "https://staging.figma.com";

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(["automation", "status"], { from: "user" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Storage dir :");
    expect(output).toContain("runner@example.com");
    expect(output).toContain("Plugin ID");
    expect(output).toContain("Examples    :");
    expect(fs.existsSync(path.join(tmpRoot, "storage"))).toBe(true);
  });

  it("shows default plugin name when none configured", async () => {
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(["automation", "status"], { from: "user" });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Plugin name : Profound Automation Runner (default)");
  });

  it("runs automation job using JSON payload file", async () => {
    const payloadPath = path.join(tmpRoot, "job.json");
    fs.writeFileSync(payloadPath, JSON.stringify({ instructions: "build-bus" }), "utf8");
    const outputPath = path.join(tmpRoot, "result.json");

    const runner = await import("../automation/runner.js");
    const runAutomationJobSpy = vi.spyOn(runner, "runAutomationJob").mockResolvedValue({
      status: "success",
      account: "runner@example.com",
      fileUrl: "https://www.figma.com/design/GB2/file",
      pluginResult: { ok: true },
      message: "done",
      consoleLogs: ["log"],
      durationMs: 5123,
    });

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(
      [
        "automation",
        "run",
        "--file",
        FILE_URL,
        "--payload",
        payloadPath,
        "--account",
        "runner@example.com",
        "--timeout",
        "10000",
        "--output",
        outputPath,
      ],
      { from: "user" }
    );

    expect(runAutomationJobSpy).toHaveBeenCalledTimes(1);
    expect(runAutomationJobSpy.mock.calls[0][0]).toMatchObject({
      file: FILE_URL,
      payload: { instructions: "build-bus" },
      accountHint: "runner@example.com",
      timeoutMs: 10000,
    });
    const saved = JSON.parse(fs.readFileSync(outputPath, "utf8")) as { status: string };
    expect(saved.status).toBe("success");
  });

  it("runs automation job using bundled example payload", async () => {
    const runner = await import("../automation/runner.js");
    const runAutomationJobSpy = vi.spyOn(runner, "runAutomationJob").mockResolvedValue({
      status: "success",
      account: "runner@example.com",
      fileUrl: "https://www.figma.com/design/GB2/file",
      pluginResult: { ok: true },
      message: "done",
      consoleLogs: ["log"],
      durationMs: 2000,
    });

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(
      ["automation", "run", "--file", FILE_URL, "--example", "schoolbus"],
      { from: "user" }
    );

    expect(runAutomationJobSpy).toHaveBeenCalledTimes(1);
    const call = runAutomationJobSpy.mock.calls[0][0];
    expect(call.payload).toMatchObject({
      payload: {
        description: "Create a stylised school bus layout",
      },
    });
  });

  it("fails when both payload and example are provided", async () => {
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(
      [
        "automation",
        "run",
        "--file",
        FILE_URL,
        "--payload",
        path.join(tmpRoot, "job.json"),
        "--example",
        "schoolbus",
      ],
      { from: "user" }
    );

    const errorOutput = errorSpy.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("Provide either --payload or --example");
    expect(process.exitCode).toBe(1);
  });

  it("installs automation plugin via CLI helper", async () => {
    const installer = await import("../automation/pluginInstaller.js");
    const installSpy = vi.spyOn(installer, "installAutomationPlugin").mockResolvedValue({
      status: "success",
      account: "runner@example.com",
      pluginName: "Profound Automation Runner",
      manifestPath: "/tmp/manifest.json",
      durationMs: 1234,
      logs: ["Imported"],
    });

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(
      [
        "automation",
        "install-plugin",
        "--manifest",
        "/tmp/manifest.json",
        "--account",
        "runner@example.com",
        "--timeout",
        "10000",
        "--file",
        FILE_URL,
      ],
      { from: "user" }
    );

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(installSpy.mock.calls[0][0]).toMatchObject({
      manifestPath: "/tmp/manifest.json",
      accountHint: "runner@example.com",
      pluginNameOverride: undefined,
      timeoutMs: 10000,
      headless: true,
      debug: false,
      file: FILE_URL,
    });

    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain('"status": "success"');
    expect(output).toContain('"manifestPath": "/tmp/manifest.json"');
  });
});
