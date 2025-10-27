type AsyncFunctionConstructor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

const RESULT_PREFIX = "PH_AUTOMATION_RESULT:";
const ERROR_PREFIX = "PH_AUTOMATION_ERROR:";
const JOB_STORAGE_KEY = "phAutomationJob";
const RESULT_STORAGE_KEY = "phAutomationResult";

interface AutomationJob {
  payload: AutomationPayload | null | undefined;
  requestedAt?: string;
  pluginCommandId?: string | null;
}

interface AutomationPayload {
  script?: string;
  description?: string;
  actions?: AutomationAction[];
  metadata?: Record<string, unknown>;
}

interface BaseCreationProps {
  name?: string;
  parentNodeId?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  locked?: boolean;
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  cornerRadius?: number;
  constraints?: Constraints;
  layoutGrow?: number;
  layoutAlign?: "STRETCH" | "INHERIT" | "MIN" | "CENTER" | "MAX";
  effects?: readonly Effect[];
  opacity?: number;
}

type AutomationAction =
  | ({
      kind: "set-page";
      name: string;
    } & BaseCreationProps)
  | ({
      kind: "create-frame";
      layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
      padding?: number;
      paddingTop?: number;
      paddingBottom?: number;
      paddingLeft?: number;
      paddingRight?: number;
      itemSpacing?: number;
      primaryAxisSizingMode?: "FIXED" | "AUTO";
      counterAxisSizingMode?: "FIXED" | "AUTO";
    } & BaseCreationProps)
  | ({
      kind: "create-component";
      description?: string;
    } & BaseCreationProps)
  | ({
      kind: "create-rectangle";
    } & BaseCreationProps)
  | ({
      kind: "create-ellipse";
    } & BaseCreationProps)
  | ({
      kind: "create-line";
      length?: number;
    } & BaseCreationProps)
  | ({
      kind: "create-polygon";
      pointCount?: number;
    } & BaseCreationProps)
  | ({
      kind: "create-star";
      pointCount?: number;
    } & BaseCreationProps)
  | ({
      kind: "create-text";
      characters: string;
      fontName?: FontName;
      fontSize?: number;
      fills?: Paint[];
      textCase?: TextCase;
      textDecoration?: TextDecoration;
      textAutoResize?: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT";
      paragraphSpacing?: number;
      paragraphIndent?: number;
      textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
      textAlignVertical?: "TOP" | "CENTER" | "BOTTOM";
      lineHeight?: LineHeight;
    } & BaseCreationProps);

figma.on("run", ({ command }) => {
  void runAutomation(command ?? null);
});

async function runAutomation(command: string | null): Promise<void> {
  figma.showUI(__html__, { visible: false });

  let jobHandled = false;
  figma.ui.onmessage = async (message: AutomationUiMessage) => {
    if (message.type === "automation-job") {
      if (jobHandled) {
        return;
      }
      jobHandled = true;
      await handleAutomationJob(message.job, command);
    }
  };

  // Request job payload from UI bridge.
  figma.ui.postMessage({ type: "request-job", key: JOB_STORAGE_KEY });
}

async function handleAutomationJob(job: AutomationJob | null, command: string | null): Promise<void> {
  if (!job) {
    reportError("No automation job found in storage.");
    return;
  }

  const payload = job.payload ?? {};
  const start = Date.now();

  try {
    const result = await executeAutomationPayload(payload, {
      commandOverride: command ?? job.pluginCommandId ?? null,
      requestedAt: job.requestedAt ?? null,
    });

    const elapsed = Date.now() - start;
    const envelope = {
      status: "success",
      message: result.message ?? "Automation completed.",
      data: {
        ...result.data,
        elapsedMs: elapsed,
        command: command ?? job.pluginCommandId ?? null,
      },
    };

    figma.ui.postMessage({
      type: "automation-result",
      key: RESULT_STORAGE_KEY,
      result: envelope,
    });

    console.log(`${RESULT_PREFIX}${JSON.stringify(envelope)}`);
    figma.closePlugin(envelope.message);
  } catch (error) {
    const details =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: "Unknown error", data: error };

    const payload = {
      status: "error",
      message: details.message,
      data: { stack: details.stack },
    };

    figma.ui.postMessage({
      type: "automation-result",
      key: RESULT_STORAGE_KEY,
      result: payload,
    });

    console.error(`${ERROR_PREFIX}${JSON.stringify(payload)}`);
    figma.closePlugin(details.message);
  }
}

async function executeAutomationPayload(
  payload: AutomationPayload,
  context: { commandOverride: string | null; requestedAt: string | null }
): Promise<{ message?: string; data?: Record<string, unknown> }> {
  if (typeof payload.script === "string" && payload.script.trim().length > 0) {
    const result = await executeAutomationScript(payload.script, context);
    return {
      message: payload.description ?? "Automation script executed.",
      data: {
        scriptResult: result,
        mode: "script",
        requestedAt: context.requestedAt,
      },
    };
  }

  if (Array.isArray(payload.actions) && payload.actions.length > 0) {
    const summary = await executeAutomationActions(payload.actions);
    return {
      message: payload.description ?? `Executed ${payload.actions.length} automation actions.`,
      data: {
        actions: summary,
        mode: "actions",
        requestedAt: context.requestedAt,
      },
    };
  }

  return {
    message: "No automation payload provided; nothing to do.",
    data: {
      mode: "noop",
      requestedAt: context.requestedAt,
    },
  };
}

async function executeAutomationScript(
  script: string,
  context: { commandOverride: string | null; requestedAt: string | null }
): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor;
  const fn = new AsyncFunction("figma", "context", "helpers", script);
  const helpers = {
    ensurePage,
    loadFont,
    withSelection,
    createLayoutFrame,
  };
  return await fn(figma, context, helpers);
}

async function executeAutomationActions(actions: AutomationAction[]): Promise<Record<string, unknown>> {
  const createdNodeIds: string[] = [];
  let pageSet = false;

  for (const action of actions) {
    switch (action.kind) {
      case "set-page": {
        pageSet = true;
        figma.currentPage = findOrCreatePage(action.name);
        break;
      }
      case "create-frame": {
        const frame = figma.createFrame();
        applyBaseProps(frame, action, { defaultName: "Automation Frame" });
        const width = action.width ?? 1024;
        const height = action.height ?? 768;
        frame.resize(width, height);
        if (action.layoutMode && action.layoutMode !== "NONE") {
          frame.layoutMode = action.layoutMode;
        }
        if (typeof action.padding === "number") {
          frame.paddingTop = action.padding;
          frame.paddingBottom = action.padding;
          frame.paddingLeft = action.padding;
          frame.paddingRight = action.padding;
        }
        if (typeof action.paddingTop === "number") frame.paddingTop = action.paddingTop;
        if (typeof action.paddingBottom === "number") frame.paddingBottom = action.paddingBottom;
        if (typeof action.paddingLeft === "number") frame.paddingLeft = action.paddingLeft;
        if (typeof action.paddingRight === "number") frame.paddingRight = action.paddingRight;
        if (typeof action.itemSpacing === "number") frame.itemSpacing = action.itemSpacing;
        if (action.primaryAxisSizingMode) frame.primaryAxisSizingMode = action.primaryAxisSizingMode;
        if (action.counterAxisSizingMode) frame.counterAxisSizingMode = action.counterAxisSizingMode;
        placeNodeInParent(frame, action.parentNodeId, createdNodeIds);
        createdNodeIds.push(frame.id);
        break;
      }
      case "create-component": {
        const component = figma.createComponent();
        applyBaseProps(component, action, { defaultName: "Automation Component" });
        if (typeof action.width === "number" || typeof action.height === "number") {
          const width = action.width ?? component.width;
          const height = action.height ?? component.height;
          component.resize(width, height);
        }
        placeNodeInParent(component, action.parentNodeId, createdNodeIds);
        createdNodeIds.push(component.id);
        break;
      }
      case "create-rectangle": {
        const rectangle = figma.createRectangle();
        applyBaseProps(rectangle, action, { defaultName: "Automation Rectangle" });
        resizeNode(rectangle, action.width, action.height);
        placeNodeInParent(rectangle, action.parentNodeId, createdNodeIds);
        createdNodeIds.push(rectangle.id);
        break;
      }
      case "create-ellipse": {
        const ellipse = figma.createEllipse();
        applyBaseProps(ellipse, action, { defaultName: "Automation Ellipse" });
        resizeNode(ellipse, action.width ?? action.height ?? 120, action.height ?? action.width ?? 120);
        placeNodeInParent(ellipse, action.parentNodeId, createdNodeIds);
        createdNodeIds.push(ellipse.id);
        break;
      }
      case "create-line": {
        const line = figma.createLine();
        applyBaseProps(line, action, { defaultName: "Automation Line" });
        const length = action.length ?? action.width ?? 400;
        resizeNode(line, length, line.height || 0);
        placeNodeInParent(line, action.parentNodeId, createdNodeIds);
        createdNodeIds.push(line.id);
        break;
      }
      case "create-polygon": {
        const polygon = figma.createPolygon();
        applyBaseProps(polygon, action, { defaultName: "Automation Polygon" });
        if (typeof action.pointCount === "number") {
          polygon.pointCount = Math.max(3, Math.min(12, Math.round(action.pointCount)));
        }
        resizeNode(polygon, action.width ?? 140, action.height ?? 140);
        placeNodeInParent(polygon, action.parentNodeId, createdNodeIds);
        createdNodeIds.push(polygon.id);
        break;
      }
      case "create-star": {
        const star = figma.createStar();
        applyBaseProps(star, action, { defaultName: "Automation Star" });
        if (typeof action.pointCount === "number") {
          star.pointCount = Math.max(3, Math.min(12, Math.round(action.pointCount)));
        }
        resizeNode(star, action.width ?? 140, action.height ?? 140);
        placeNodeInParent(star, action.parentNodeId, createdNodeIds);
        createdNodeIds.push(star.id);
        break;
      }
      case "create-text": {
        await loadFont(action.fontName ?? { family: "Inter", style: "Regular" });
        const textNode = figma.createText();
        applyBaseProps(textNode, action, { defaultName: "Automation Text" });
        if (typeof action.fontSize === "number") {
          textNode.fontSize = action.fontSize;
        }
        if (action.fills) {
          textNode.fills = action.fills;
        }
        if (action.textCase) textNode.textCase = action.textCase;
        if (action.textDecoration) textNode.textDecoration = action.textDecoration;
        if (action.textAutoResize) textNode.textAutoResize = action.textAutoResize;
        if (typeof action.paragraphSpacing === "number") textNode.paragraphSpacing = action.paragraphSpacing;
        if (typeof action.paragraphIndent === "number") textNode.paragraphIndent = action.paragraphIndent;
        if (action.textAlignHorizontal) textNode.textAlignHorizontal = action.textAlignHorizontal;
        if (action.textAlignVertical) textNode.textAlignVertical = action.textAlignVertical;
        if (action.lineHeight) textNode.lineHeight = action.lineHeight;
        textNode.characters = action.characters;
        placeNodeInParent(textNode, action.parentNodeId, createdNodeIds);
        createdNodeIds.push(textNode.id);
        break;
      }
      default: {
        throw new Error(`Unsupported automation action ${(action as AutomationAction).kind}`);
      }
    }
  }

  if (!pageSet && createdNodeIds.length > 0) {
    figma.currentPage.selection = createdNodeIds
      .map((id) => figma.getNodeById(id))
      .filter((node): node is SceneNode => !!node);
  }

  return {
    createdNodeIds,
    pageId: figma.currentPage.id,
  };
}

async function loadFont(fontName: FontName): Promise<void> {
  await figma.loadFontAsync(fontName);
}

function ensurePage(name: string): PageNode {
  return findOrCreatePage(name);
}

async function withSelection<T>(
  callback: (nodes: readonly SceneNode[]) => T | Promise<T>
): Promise<T> {
  const selection = figma.currentPage.selection;
  return await Promise.resolve(callback(selection));
}

function createLayoutFrame(options: {
  name?: string;
  width?: number;
  height?: number;
  layoutMode?: "HORIZONTAL" | "VERTICAL";
}): FrameNode {
  const frame = figma.createFrame();
  frame.name = options.name ?? "Automation Frame";
  frame.resize(options.width ?? 1024, options.height ?? 768);
  frame.layoutMode = options.layoutMode ?? "VERTICAL";
  frame.counterAxisSizingMode = "AUTO";
  frame.primaryAxisSizingMode = "FIXED";
  return frame;
}

function findOrCreatePage(name: string): PageNode {
  const existing = figma.root.children.find((page) => page.name === name);
  if (existing) {
    return existing;
  }
  const page = figma.createPage();
  page.name = name;
  return page;
}

function placeNodeInParent(node: SceneNode, parentRef: string | undefined, createdNodeIds: string[]): void {
  const parent = resolveParentNode(parentRef, createdNodeIds);
  if (parent && isAppendChildParent(parent)) {
    parent.appendChild(node);
    return;
  }
  figma.currentPage.appendChild(node);
}

function isAppendChildParent(node: BaseNode): node is BaseNode & ChildrenMixin {
  return typeof (node as BaseNode & Partial<ChildrenMixin>).appendChild === "function";
}

function resolveParentNode(parentRef: string | undefined, createdNodeIds: string[]): (BaseNode & ChildrenMixin) | null {
  if (!parentRef || parentRef === "@page" || parentRef === "@current") {
    return figma.currentPage;
  }
  if (parentRef === "@last") {
    const lastId = createdNodeIds[createdNodeIds.length - 1];
    if (!lastId) return figma.currentPage;
    const node = figma.getNodeById(lastId);
    if (node && isAppendChildParent(node)) {
      return node;
    }
    return figma.currentPage;
  }
  if (parentRef === "@prev") {
    const prevId = createdNodeIds[createdNodeIds.length - 2];
    if (!prevId) return figma.currentPage;
    const node = figma.getNodeById(prevId);
    if (node && isAppendChildParent(node)) {
      return node;
    }
    return figma.currentPage;
  }
  if (parentRef.startsWith("#")) {
    const targetName = parentRef.slice(1).trim();
    if (targetName.length > 0) {
      const found = figma.currentPage.findOne((node) => node.name === targetName);
      if (found && isAppendChildParent(found)) {
        return found;
      }
    }
    return figma.currentPage;
  }

  const explicit = figma.getNodeById(parentRef);
  if (explicit && isAppendChildParent(explicit)) {
    return explicit;
  }
  return null;
}

function applyBaseProps(
  node: SceneNode,
  props: BaseCreationProps,
  options: { defaultName: string }
): void {
  const mixin = node as any;
  mixin.name = props.name ?? options.defaultName;
  if (typeof props.x === "number") mixin.x = props.x;
  if (typeof props.y === "number") mixin.y = props.y;
  if (typeof props.rotation === "number" && "rotation" in mixin) mixin.rotation = props.rotation;
  if (typeof props.locked === "boolean") mixin.locked = props.locked;
  if (typeof props.opacity === "number" && "opacity" in mixin) mixin.opacity = props.opacity;

  if (props.effects && "effects" in mixin) {
    try {
      mixin.effects = props.effects;
    } catch (error) {
      console.warn(`[automation] Unable to apply effects: ${(error as Error).message}`);
    }
  }
  if (props.fills && "fills" in mixin) {
    try {
      mixin.fills = props.fills;
    } catch (error) {
      console.warn(`[automation] Unable to apply fills: ${(error as Error).message}`);
    }
  }
  if (props.strokes && "strokes" in mixin) {
    mixin.strokes = props.strokes;
  }
  if (typeof props.strokeWeight === "number" && "strokeWeight" in mixin) {
    mixin.strokeWeight = props.strokeWeight;
  }
  if (typeof props.cornerRadius === "number" && "cornerRadius" in mixin) {
    try {
      mixin.cornerRadius = props.cornerRadius;
    } catch (error) {
      console.warn(`[automation] Unable to apply corner radius: ${(error as Error).message}`);
    }
  }
  if (props.constraints && "constraints" in mixin) {
    mixin.constraints = props.constraints;
  }
  if (typeof props.layoutGrow === "number" && "layoutGrow" in mixin) {
    mixin.layoutGrow = props.layoutGrow;
  }
  if (props.layoutAlign && "layoutAlign" in mixin) {
    mixin.layoutAlign = props.layoutAlign;
  }
}

function resizeNode(node: SceneNode, width?: number, height?: number): void {
  if (typeof width !== "number" && typeof height !== "number") {
    return;
  }
  const mixin = node as any;
  const currentWidth = "width" in mixin ? mixin.width : undefined;
  const currentHeight = "height" in mixin ? mixin.height : undefined;
  const nextWidth = typeof width === "number" ? width : currentWidth ?? width ?? 0;
  const nextHeight = typeof height === "number" ? height : currentHeight ?? height ?? 0;
  if ("resizeWithoutConstraints" in mixin && typeof mixin.resizeWithoutConstraints === "function") {
    mixin.resizeWithoutConstraints(nextWidth, nextHeight);
  } else if ("resize" in mixin && typeof mixin.resize === "function") {
    mixin.resize(nextWidth, nextHeight);
  }
}

function reportError(message: string): void {
  const payload = {
    status: "error",
    message,
  };
  figma.ui.postMessage({
    type: "automation-result",
    key: RESULT_STORAGE_KEY,
    result: payload,
  });
  console.error(`${ERROR_PREFIX}${JSON.stringify(payload)}`);
  figma.closePlugin(message);
}

type AutomationUiMessage =
  | {
      type: "automation-job";
      job: AutomationJob | null;
    }
  | {
      type: "noop";
    };
