import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MockAgent,
  MockPool,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { FigmaRestClient } from "../restClient.js";

describe("FigmaRestClient", () => {
  let agent: MockAgent;
  let apiPool: MockPool;
  let previousDispatcher: Dispatcher;

  beforeEach(() => {
    previousDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    apiPool = agent.get("https://api.figma.com");
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    setGlobalDispatcher(previousDispatcher);
    await agent.close();
  });

  it("attaches token header and parses json", async () => {
    const calls: RequestInit[] = [];
    const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: fetchSpy as typeof fetch,
      retryBaseDelayMs: 1,
    });

    const result = (await client.getFile("demo")) as { status: string };
    expect(result.status).toBe("ok");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = new Headers((calls[0]?.headers ?? {}) as any);
    expect(headers.get("x-figma-token")).toBe("figd_test");
  });

  it("retries on 429 and succeeds", async () => {
    const callOrder: number[] = [];
    apiPool
      .intercept({ path: "/v1/files/demo/nodes?ids=1:2", method: "GET" })
      .reply(() => {
        callOrder.push(1);
        return {
          statusCode: 429,
          responseOptions: {
            headers: { "Retry-After": "0" },
          },
          data: JSON.stringify({ err: "rate limit" }),
        };
      })
      .times(1);

    apiPool
      .intercept({ path: "/v1/files/demo/nodes?ids=1:2", method: "GET" })
      .reply(() => {
        callOrder.push(2);
        return {
          statusCode: 200,
          responseOptions: {
            headers: { "content-type": "application/json" },
          },
          data: JSON.stringify({ nodes: {} }),
        };
      })
      .times(1);

    const client = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: fetch,
      retryBaseDelayMs: 1,
    });

    const result = (await client.getFileNodes("demo", ["1:2"])) as { nodes: object };
    expect(result.nodes).toBeTruthy();
    expect(callOrder).toEqual([1, 2]);
  });

  it("downloads image to tmp directory", async () => {
    const imageUrl = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/test";

    apiPool
      .intercept({ path: "/v1/images/demo?ids=1:2&format=png", method: "GET" })
      .reply(() => ({
        statusCode: 200,
        responseOptions: {
          headers: { "content-type": "application/json" },
        },
        data: JSON.stringify({ images: { "1:2": imageUrl } }),
      }));

    const assetsPool = agent.get("https://figma-alpha-api.s3.us-west-2.amazonaws.com");
    assetsPool
      .intercept({ path: "/images/test", method: "GET" })
      .reply(() => ({
        statusCode: 200,
        data: Buffer.from("PNGDATA"),
        responseOptions: {
          headers: { "content-type": "image/png" },
        },
      }));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-api-test-"));

    const client = new FigmaRestClient({
      token: "figd_test",
      fetchImpl: fetch,
      retryBaseDelayMs: 1,
    });

    const urls = await client.getImageUrls("demo", ["1:2"]);
    const savedPath = await client.downloadImageToTmp(urls["1:2"], "1:2", {
      tmpDir,
      filenameHint: "demo",
    });

    expect(fs.existsSync(savedPath)).toBe(true);
    const contents = fs.readFileSync(savedPath, "utf8");
    expect(contents).toBe("PNGDATA");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
