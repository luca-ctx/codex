interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  absoluteBoundingBox?: BoundingBox;
  absoluteRenderBounds?: BoundingBox;
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  cornerRadius?: number;
  cornerSmoothing?: number;
  layoutAlign?: string;
  layoutGrow?: number;
  layoutGrids?: unknown[];
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects?: Effect[];
  characters?: string;
  style?: TextStyle;
  componentId?: string;
  children?: FigmaNode[];
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Paint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: RGBA;
  gradientStops?: GradientStop[];
  gradientHandlePositions?: Vector[];
  imageRef?: string;
}

interface GradientStop {
  position: number;
  color: RGBA;
}

interface Vector {
  x: number;
  y: number;
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Effect {
  type: string;
  visible?: boolean;
  radius?: number;
  offset?: { x: number; y: number };
  color?: RGBA;
}

interface TextStyle {
  fontFamily?: string;
  fontPostScriptName?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  letterSpacing?: number;
  textCase?: string;
  textDecoration?: string;
}

export interface DesignContextNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  layout?: {
    mode?: string;
    alignPrimary?: string;
    alignSecondary?: string;
    sizeModePrimary?: string;
    sizeModeSecondary?: string;
    padding?: { top?: number; right?: number; bottom?: number; left?: number };
    itemSpacing?: number;
    grow?: number;
    align?: string;
  };
  fills?: SimplifiedPaint[];
  strokes?: SimplifiedPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects?: SimplifiedEffect[];
  text?: {
    characters?: string;
    style?: TextStyle;
  };
  componentId?: string;
  children?: DesignContextNode[];
}

export interface SimplifiedPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: string;
  gradientStops?: { position: number; color: string }[];
  imageRef?: string;
}

export interface SimplifiedEffect {
  type: string;
  visible?: boolean;
  radius?: number;
  offset?: { x: number; y: number };
  color?: string;
}

export interface MetadataNode {
  id: string;
  name: string;
  type: string;
  children?: MetadataNode[];
}

export interface DesignSystemRules {
  summary: {
    nodes: number;
    textNodes: number;
    uniqueFonts: string[];
    uniqueColors: string[];
  };
  colors: { color: string; usage: number }[];
  typography: { font: string; weight?: number; size?: number; usage: number }[];
  components: string[];
}

interface NodesResponse {
  nodes?: Record<string, { document: FigmaNode }>;
}

export function buildDesignContext(response: NodesResponse): DesignContextNode[] {
  const entries = response.nodes ?? {};
  return Object.values(entries)
    .map((entry) => simplifyNode(entry.document))
    .filter(Boolean) as DesignContextNode[];
}

export function buildMetadata(response: NodesResponse): MetadataNode[] {
  const entries = response.nodes ?? {};
  return Object.values(entries)
    .map((entry) => pruneMetadata(entry.document))
    .filter(Boolean) as MetadataNode[];
}

export function deriveDesignSystemRules(response: NodesResponse): DesignSystemRules {
  const entries = response.nodes ?? {};
  const roots = Object.values(entries).map((entry) => entry.document);
  const colorMap = new Map<string, number>();
  const typeMap = new Map<string, { font: string; weight?: number; size?: number; usage: number }>();
  const components = new Set<string>();
  let nodeCount = 0;
  let textNodeCount = 0;

  roots.forEach((root) => {
    walkNodes(root, (node) => {
      nodeCount += 1;
      if (node.type === "TEXT") {
        textNodeCount += 1;
        if (node.style?.fontFamily) {
          const key = `${node.style.fontFamily}-${node.style.fontWeight ?? ""}-${node.style.fontSize ?? ""}`;
          if (!typeMap.has(key)) {
            typeMap.set(key, {
              font: node.style.fontFamily,
              weight: node.style.fontWeight,
              size: node.style.fontSize,
              usage: 0,
            });
          }
          typeMap.get(key)!.usage += 1;
        }
      }

      node.fills?.forEach((paint) => {
        const simplified = simplifyPaint(paint);
        if (simplified?.color) {
          colorMap.set(simplified.color, (colorMap.get(simplified.color) ?? 0) + 1);
        }
        simplified?.gradientStops?.forEach((stop) => {
          colorMap.set(stop.color, (colorMap.get(stop.color) ?? 0) + 1);
        });
      });

      if (node.componentId) {
        components.add(node.componentId);
      }
    });
  });

  const colors = Array.from(colorMap.entries())
    .map(([color, usage]) => ({ color, usage }))
    .sort((a, b) => b.usage - a.usage);

  const typography = Array.from(typeMap.values()).sort((a, b) => b.usage - a.usage);

  return {
    summary: {
      nodes: nodeCount,
      textNodes: textNodeCount,
      uniqueFonts: Array.from(
        new Set(typography.map((entry) => entry.font).filter(Boolean) as string[])
      ),
      uniqueColors: colors.map((entry) => entry.color),
    },
    colors,
    typography,
    components: Array.from(components).sort(),
  };
}

function simplifyNode(node: FigmaNode | undefined): DesignContextNode | undefined {
  if (!node) return undefined;
  const children =
    node.children?.map((child) => simplifyNode(child)).filter(Boolean) as DesignContextNode[] | undefined;

  const layoutPadding =
    node.paddingTop !== undefined ||
    node.paddingRight !== undefined ||
    node.paddingBottom !== undefined ||
    node.paddingLeft !== undefined
      ? {
          top: node.paddingTop,
          right: node.paddingRight,
          bottom: node.paddingBottom,
          left: node.paddingLeft,
        }
      : undefined;

  const fills = node.fills
    ?.map((paint) => simplifyPaint(paint))
    .filter((paint): paint is SimplifiedPaint => Boolean(paint));

  const strokes = node.strokes
    ?.map((paint) => simplifyPaint(paint))
    .filter((paint): paint is SimplifiedPaint => Boolean(paint));

  const effects = node.effects
    ?.map((effect) => simplifyEffect(effect))
    .filter((effect): effect is SimplifiedEffect => Boolean(effect));

  const simplified: DesignContextNode = pruneUndefined({
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    position: node.absoluteBoundingBox
      ? { x: node.absoluteBoundingBox.x, y: node.absoluteBoundingBox.y }
      : undefined,
    size: node.absoluteBoundingBox
      ? {
          width: node.absoluteBoundingBox.width,
          height: node.absoluteBoundingBox.height,
        }
      : undefined,
    layout:
      node.layoutMode ||
      node.primaryAxisAlignItems ||
      node.counterAxisAlignItems ||
      layoutPadding ||
      node.itemSpacing !== undefined ||
      node.layoutGrow !== undefined ||
      node.layoutAlign
        ? {
            mode: node.layoutMode,
            alignPrimary: node.primaryAxisAlignItems,
            alignSecondary: node.counterAxisAlignItems,
            sizeModePrimary: node.primaryAxisSizingMode,
            sizeModeSecondary: node.counterAxisSizingMode,
            padding: layoutPadding,
            itemSpacing: node.itemSpacing,
            grow: node.layoutGrow,
            align: node.layoutAlign,
          }
        : undefined,
    fills,
    strokes,
    strokeWeight: node.strokeWeight,
    strokeAlign: node.strokeAlign,
    effects,
    componentId: node.componentId,
    text:
      node.type === "TEXT"
        ? {
            characters: node.characters,
            style: node.style,
          }
        : undefined,
    children: children?.length ? children : undefined,
  });

  return simplified;
}

function pruneMetadata(node: FigmaNode | undefined): MetadataNode | undefined {
  if (!node) return undefined;
  const children =
    node.children?.map((child) => pruneMetadata(child)).filter(Boolean) as MetadataNode[] | undefined;
  const metadata: MetadataNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    children: children?.length ? children : undefined,
  };
  return metadata;
}

function simplifyPaint(paint: Paint | undefined): SimplifiedPaint | undefined {
  if (!paint) return undefined;
  const base = pruneUndefined<SimplifiedPaint>({
    type: paint.type,
    visible: paint.visible,
    opacity: paint.opacity,
  });
  if (paint.type === "SOLID" && paint.color) {
    base.color = rgbaToHex(paint.color);
  } else if (paint.type.startsWith("GRADIENT") && paint.gradientStops) {
    base.gradientStops = paint.gradientStops.map((stop) => ({
      position: stop.position,
      color: rgbaToHex(stop.color),
    }));
  } else if (paint.type === "IMAGE" && paint.imageRef) {
    base.imageRef = paint.imageRef;
  }
  return pruneUndefined<SimplifiedPaint>(base);
}

function simplifyEffect(effect: Effect | undefined): SimplifiedEffect | undefined {
  if (!effect) return undefined;
  const base = pruneUndefined<SimplifiedEffect>({
    type: effect.type,
    visible: effect.visible,
    radius: effect.radius,
    offset: effect.offset,
    color: effect.color ? rgbaToHex(effect.color) : undefined,
  });
  return pruneUndefined<SimplifiedEffect>(base);
}

function rgbaToHex(color: RGBA): string {
  const r = clampColorComponent(color.r);
  const g = clampColorComponent(color.g);
  const b = clampColorComponent(color.b);
  const a = clampColorComponent(color.a);
  if (a === 255) {
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`;
}

function clampColorComponent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function pruneUndefined<T extends object>(value: T): T {
  const clone = { ...value } as Record<string, unknown>;
  for (const key of Object.keys(clone)) {
    const current = clone[key];
    if (current === undefined || current === null) {
      delete clone[key];
    }
  }
  return clone as T;
}

function walkNodes(node: FigmaNode | undefined, visitor: (node: FigmaNode) => void): void {
  if (!node) return;
  visitor(node);
  node.children?.forEach((child) => walkNodes(child, visitor));
}
