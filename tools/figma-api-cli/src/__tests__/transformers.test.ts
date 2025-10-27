import { describe, expect, it } from "vitest";
import {
  buildDesignContext,
  buildMetadata,
  deriveDesignSystemRules,
  type DesignContextNode,
} from "../transformers.js";

const sampleResponse = {
  nodes: {
    "1:2": {
      document: {
        id: "1:2",
        name: "Frame",
        type: "FRAME",
        visible: true,
        absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 200 },
        layoutMode: "VERTICAL",
        paddingTop: 16,
        paddingRight: 24,
        paddingBottom: 16,
        paddingLeft: 24,
        itemSpacing: 8,
        children: [
          {
            id: "1:3",
            name: "Heading",
            type: "TEXT",
            characters: "Welcome",
            style: {
              fontFamily: "Inter",
              fontWeight: 600,
              fontSize: 32,
            },
            fills: [
              {
                type: "SOLID",
                color: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
              },
            ],
          },
        ],
      },
    },
  },
};

describe("transformers", () => {
  it("builds design context nodes with simplified fields", () => {
    const context = buildDesignContext(sampleResponse) as DesignContextNode[];
    expect(context.length).toBe(1);

    const root = context[0];
    expect(root.name).toBe("Frame");
    expect(root.layout?.padding?.left).toBe(24);
    expect(root.children?.[0].text?.characters).toBe("Welcome");
    expect(root.children?.[0].fills?.[0].color).toBe("#1a334d");
  });

  it("builds metadata tree with minimal fields", () => {
    const metadata = buildMetadata(sampleResponse);
    expect(metadata).toEqual([
      {
        id: "1:2",
        name: "Frame",
        type: "FRAME",
        children: [
          {
            id: "1:3",
            name: "Heading",
            type: "TEXT",
          },
        ],
      },
    ]);
  });

  it("derives design system rules summary", () => {
    const rules = deriveDesignSystemRules(sampleResponse);
    expect(rules.summary.nodes).toBe(2);
    expect(rules.summary.textNodes).toBe(1);
    expect(rules.typography[0].font).toBe("Inter");
    expect(rules.colors[0].color).toBe("#1a334d");
  });
});
