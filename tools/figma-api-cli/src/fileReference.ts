import { URL } from "node:url";

export interface FileReference {
  fileKey: string;
  nodeId?: string;
}

export interface ParseFileReferenceOptions {
  defaultNodeId?: string;
}

const FILE_KEY_REGEX = /^[A-Za-z0-9]{10,64}$/;

export function parseFileReference(
  input: string,
  options: ParseFileReferenceOptions = {}
): FileReference {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Expected a Figma file key or URL.");
  }

  let fileKey: string | undefined;
  let nodeId: string | undefined;

  if (isProbablyUrl(trimmed)) {
    try {
      const url = new URL(trimmed);
      const segments = url.pathname.split("/").filter(Boolean);
      const typeIndex = segments.findIndex((segment) => segment === "file" || segment === "design");
      if (typeIndex !== -1 && segments[typeIndex + 1]) {
        fileKey = segments[typeIndex + 1];
      }
      nodeId = url.searchParams.get("node-id") ?? url.searchParams.get("nodeId") ?? undefined;
      if (!nodeId && segments[typeIndex + 2]) {
        // Figma sometimes encodes node id after the file slug using -- or : separators.
        const maybeNode = segments[typeIndex + 2];
        if (maybeNode.includes("-") || maybeNode.includes(":")) {
          nodeId = maybeNode;
        }
      }
    } catch (error) {
      throw new Error(`Invalid Figma URL: ${(error as Error).message}`);
    }
  } else if (FILE_KEY_REGEX.test(trimmed)) {
    fileKey = trimmed;
  } else {
    throw new Error("Unrecognized Figma reference. Provide a file key or a Figma URL.");
  }

  if (!fileKey) {
    throw new Error("Unable to determine Figma file key from input.");
  }

  const normalizedNode = normalizeNodeId(nodeId ?? options.defaultNodeId);

  return {
    fileKey,
    nodeId: normalizedNode,
  };
}

export function normalizeNodeId(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const decoded = decodeURIComponent(raw.trim());
  if (!decoded) return undefined;
  if (decoded.includes(":")) {
    return decoded;
  }
  if (decoded.includes("-")) {
    return decoded.replace(/-/g, ":");
  }
  return decoded;
}

export function encodeNodeId(nodeId: string): string {
  return encodeURIComponent(nodeId);
}

function isProbablyUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
