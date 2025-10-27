import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_API_BASE_URL } from "./config.js";

export interface FigmaRestClientOptions {
  token: string;
  baseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export interface ScreenshotOptions {
  format?: "png" | "jpg" | "svg";
  scale?: number;
  tmpDir?: string;
  filenameHint?: string;
}

export class FigmaApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly details?: unknown;

  constructor(message: string, status: number, url: string, details?: unknown) {
    super(message);
    this.status = status;
    this.url = url;
    this.details = details;
  }
}

export class FigmaRestClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: FigmaRestClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Global fetch is not available; provide fetchImpl in options.");
    }
    this.userAgent = options.userAgent ?? "figma-api-cli/0.1.0";
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 300;
  }

  async getFile(fileKey: string): Promise<unknown> {
    return this.requestJson(`/files/${fileKey}`);
  }

  async getFileNodes(
    fileKey: string,
    nodeIds: string[],
    params: { depth?: number; geometry?: string } = {}
  ): Promise<unknown> {
    const search = new URLSearchParams();
    if (nodeIds.length > 0) {
      search.set("ids", nodeIds.join(","));
    }
    if (typeof params.depth === "number") {
      search.set("depth", String(params.depth));
    }
    if (params.geometry) {
      search.set("geometry", params.geometry);
    }
    const pathWithQuery = `/files/${fileKey}/nodes?${search.toString()}`;
    return this.requestJson(pathWithQuery);
  }

  async getVariables(fileKey: string): Promise<unknown> {
    return this.requestJson(`/files/${fileKey}/variables/local`);
  }

  async getCodeConnectMap(fileKey: string): Promise<unknown> {
    return this.requestJson(`/files/${fileKey}/code_map`);
  }

  async getFileMetadata(fileKey: string): Promise<unknown> {
    return this.requestJson(`/files/${fileKey}/metadata`);
  }

  async getImageUrls(
    fileKey: string,
    nodeIds: string[],
    options: { format?: "png" | "jpg" | "svg"; scale?: number } = {}
  ): Promise<Record<string, string>> {
    if (!nodeIds.length) {
      throw new Error("At least one node id is required to request images.");
    }
    const search = new URLSearchParams();
    search.set("ids", nodeIds.join(","));
    search.set("format", options.format ?? "png");
    if (options.scale) {
      search.set("scale", options.scale.toString());
    }
    const pathWithQuery = `/images/${fileKey}?${search.toString()}`;
    const payload = (await this.requestJson(pathWithQuery)) as { images?: Record<string, string> };
    return payload.images ?? {};
  }

  async downloadImageToTmp(
    imageUrl: string,
    nodeId: string,
    options: ScreenshotOptions = {}
  ): Promise<string> {
    const tmpDir = options.tmpDir
      ? path.resolve(options.tmpDir)
      : fs.mkdtempSync(path.join(os.tmpdir(), "figma-api-"));
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o755 });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const hint = options.filenameHint?.replace(/[^a-z0-9-_]/gi, "_") ?? "node";
    const ext = (options.format ?? "png").toLowerCase();
    const filename = `${timestamp}_${hint}_${nodeId.replace(/[:/]/g, "_")}.${ext}`;
    const outputPath = path.join(tmpDir, filename);

    const response = await this.fetchWithRetry(imageUrl, {
      method: "GET",
      headers: { "User-Agent": this.userAgent },
    });
    if (!response.ok || !response.body) {
      const body = await safeParseBody(response);
      throw new FigmaApiError(
        `Failed to download image (${response.status})`,
        response.status,
        imageUrl,
        body
      );
    }

    await pipeline(response.body, fs.createWriteStream(outputPath, { mode: 0o644 }));
    return outputPath;
  }

  private async requestJson(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchWithRetry(this.toAbsoluteUrl(pathname), {
      ...init,
      headers: this.buildHeaders(init.headers),
    });

    if (!response.ok) {
      const details = await safeParseBody(response);
      throw new FigmaApiError(
        `Request failed with status ${response.status}`,
        response.status,
        response.url,
        details
      );
    }

    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new FigmaApiError(
        "Received invalid JSON from Figma API",
        response.status,
        response.url,
        { raw: text, error: (error as Error).message }
      );
    }
  }

  private toAbsoluteUrl(pathname: string): string {
    if (pathname.startsWith("http://") || pathname.startsWith("https://")) {
      return pathname;
    }
    const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return `${this.baseUrl}${normalized}`;
  }

  private buildHeaders(headers: HeadersInit | undefined): Headers {
    const result = new Headers(headers ?? {});
    if (!result.has("X-Figma-Token")) {
      result.set("X-Figma-Token", this.token);
    }
    if (!result.has("Accept")) {
      result.set("Accept", "application/json");
    }
    if (!result.has("User-Agent")) {
      result.set("User-Agent", this.userAgent);
    }
    return result;
  }

  private async fetchWithRetry(url: string, init: RequestInit, attempt = 0): Promise<Response> {
    const response = await this.fetchImpl(url, init);

    if (shouldRetry(response) && attempt < this.maxRetries) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfter =
        retryAfterHeader !== null ? Number.parseFloat(retryAfterHeader) * 1000 : undefined;
      const backoff =
        retryAfter && Number.isFinite(retryAfter)
          ? retryAfter
          : this.retryBaseDelayMs * Math.pow(2, attempt);
      await delay(backoff);
      return this.fetchWithRetry(url, init, attempt + 1);
    }

    return response;
  }
}

function shouldRetry(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status >= 500 && response.status < 600) return true;
  return false;
}

async function safeParseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => undefined);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
