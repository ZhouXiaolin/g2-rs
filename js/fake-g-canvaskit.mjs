import {
  AbstractRenderer,
  AbstractRendererPlugin,
  DomInteraction,
  HTMLRenderer,
  ImageLoader,
  parseColor,
  setDOMSize,
} from "@antv/g-lite";
import { Canvas as GCanvas } from "@antv/g";
import { CanvasPathGenerator, CanvasPicker } from "@antv/g-canvas";
import { CanvaskitRenderer } from "@antv/g-canvaskit";
import { createFakeCanvasKitInit } from "./shims/fake-canvaskit.js";

const CanvasKitInit = createFakeCanvasKitInit();
let canvasRunPatched = false;

function hostLog(level, message, extra) {
  const suffix =
    extra === undefined
      ? ""
      : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  if (typeof globalThis.__rust_log === "function") {
    globalThis.__rust_log(String(level), `${String(message)}${suffix}`);
  }
}

function patchCanvasRun() {
  if (canvasRunPatched) return;
  canvasRunPatched = true;

  const canvasProto = GCanvas?.prototype;
  if (!canvasProto || typeof canvasProto.run !== "function") {
    hostLog("warn", "failed to patch GCanvas.run");
    return;
  }

  canvasProto.run = function patchedRun() {
    hostLog("info", "patched GCanvas.run:single-frame");
    this.render({ reason: "single-frame-probe" });
    this.frameId = 0;
  };
}

function normalizeRectRadius(object) {
  if (!object || object.nodeName !== "rect" || !object.parsedStyle) return;
  const radius = object.parsedStyle.radius;
  if (Array.isArray(radius)) return;

  let normalized = [0, 0, 0, 0];
  if (typeof radius === "number") {
    normalized = [radius, radius, radius, radius];
  } else if (radius && typeof radius.length === "number") {
    normalized = Array.from(radius).slice(0, 4);
    while (normalized.length < 4) normalized.push(0);
  }

  object.parsedStyle = {
    ...object.parsedStyle,
    radius: normalized,
  };
  hostLog("debug", "normalized rect.radius", {
    radius,
    normalized,
    width: object.parsedStyle.width,
    height: object.parsedStyle.height,
  });
}

function normalizePaintOpacity(object) {
  if (!object?.parsedStyle) return;
  const next = { ...object.parsedStyle };
  let changed = false;

  for (const key of ["opacity", "fillOpacity", "strokeOpacity"]) {
    if (!Number.isFinite(Number(next[key]))) {
      next[key] = 1;
      changed = true;
    }
  }

  if (changed) {
    object.parsedStyle = next;
  }
}

function walkDisplayObjects(object, visit) {
  if (!object) return;
  visit(object);
  const children = Array.isArray(object.childNodes) ? object.childNodes : [];
  for (const child of children) {
    walkDisplayObjects(child, visit);
  }
}

class FakeCanvasKitContextService {
  constructor(context) {
    this.canvasConfig = context.config;
    this.contextRegisterPluginOptions = context.contextRegisterPluginOptions;
  }

  async initAsync() {
    const { container, canvas, dpr = 1 } = this.canvasConfig;
    if (canvas) {
      this.$canvas = canvas;
      this.$container = canvas.parentElement;
    } else if (container) {
      this.$container =
        typeof container === "string" ? document.getElementById(container) : container;
      if (this.$container) {
        this.$canvas = document.createElement("canvas");
        this.$container.appendChild(this.$canvas);
        if (!this.$container.style.position) this.$container.style.position = "relative";
      }
    }

    this.dpr = dpr;
    this.resize(this.canvasConfig.width, this.canvasConfig.height);

    const CanvasKit = await this.loadCanvaskit();
    const surface = CanvasKit.MakeWebGLCanvasSurface(this.$canvas);
    this.context = { CanvasKit, surface };
  }

  getContext() {
    return this.context;
  }

  getDomElement() {
    return this.$canvas;
  }

  getDPR() {
    return this.dpr;
  }

  getBoundingClientRect() {
    return this.$canvas?.getBoundingClientRect?.();
  }

  destroy() {
    if (this.$container && this.$canvas?.parentNode) {
      this.$container.removeChild(this.$canvas);
    }
  }

  resize(width, height) {
    if (!this.$canvas) return;
    this.$canvas.width = this.dpr * width;
    this.$canvas.height = this.dpr * height;
    setDOMSize(this.$canvas, width, height);
  }

  applyCursorStyle(cursor) {
    if (this.$container?.style) this.$container.style.cursor = cursor;
  }

  async toDataURL(options) {
    return this.contextRegisterPluginOptions.canvaskitRendererPlugin.toDataURL(options);
  }

  loadCanvaskit() {
    return CanvasKitInit({
      locateFile: (file) => `${this.contextRegisterPluginOptions.wasmDir}${file}`,
    });
  }
}

class ContextRegisterPlugin extends AbstractRendererPlugin {
  constructor(options) {
    super();
    this.name = "fake-canvaskit-context-register";
    this.options = options;
  }

  init() {
    this.context.contextRegisterPluginOptions = { ...this.options };
    this.context.ContextService = FakeCanvasKitContextService;
  }

  destroy() {
    delete this.context.ContextService;
  }
}

class PatchedCanvasKitPlugin extends CanvaskitRenderer.Plugin {
  init() {
    super.init();
    const internal = this.plugins[0];
    const originalRenderDisplayObject = internal.renderDisplayObject;

    internal.renderDisplayObject = function patchedRenderDisplayObject(object, canvas) {
      normalizeRectRadius(object);
      normalizePaintOpacity(object);
      const previousTextLayout = globalThis.__fakeCanvasKitTextLayoutContext;
      if (object?.nodeName === "text") {
        globalThis.__fakeCanvasKitTextLayoutContext = {
          textAlign: object.parsedStyle?.textAlign,
          textBaseline: object.parsedStyle?.textBaseline,
          x: object.parsedStyle?.x,
          y: object.parsedStyle?.y,
          dx: object.parsedStyle?.dx,
          dy: object.parsedStyle?.dy,
        };
      }
      try {
        return originalRenderDisplayObject.call(this, object, canvas);
      } catch (error) {
        hostLog("error", "renderDisplayObject:failed", {
          nodeName: object?.nodeName,
          radius: object?.parsedStyle?.radius,
          x: object?.parsedStyle?.x,
          y: object?.parsedStyle?.y,
          width: object?.parsedStyle?.width,
          height: object?.parsedStyle?.height,
          message: error?.message,
          name: error?.name,
          text: String(error),
        });
        throw error;
      } finally {
        globalThis.__fakeCanvasKitTextLayoutContext = previousTextLayout;
      }
    };

    internal.apply = function patchedApply(context) {
      this.context = context;
      const { renderingService, renderingContext } = context;

      renderingService.hooks.init.tap("fake-canvaskit-renderer", () => {
        const { surface } = this.context.contextService.getContext();
        const dpr = this.context.contextService.getDPR();
        hostLog("debug", "fake renderer init", { dpr });
        surface.getCanvas().scale(dpr, dpr);
      });

      renderingService.hooks.endFrame.tap("fake-canvaskit-renderer", () => {
        const { surface, CanvasKit } = this.context.contextService.getContext();
        const canvas = surface.getCanvas();
        const clearColor = parseColor(this.context.config.background);
        const tmpVec3 = [0, 0, 0];
        const tmpQuat = [0, 0, 0, 1];

        hostLog("debug", "fake renderer endFrame:begin");
        try {
          canvas.save();
          this.applyCamera(canvas, this.context.camera, tmpVec3, tmpQuat);
          canvas.clear(
            CanvasKit.Color4f(
              Number(clearColor.r) / 255,
              Number(clearColor.g) / 255,
              Number(clearColor.b) / 255,
              Number(clearColor.alpha),
            ),
          );
          walkDisplayObjects(renderingContext.root, normalizeRectRadius);
          this.drawWithSurface(canvas, renderingContext.root);
          surface.flush();
        } catch (error) {
          hostLog(
            "error",
            "fake renderer endFrame:failed",
            {
              message: error?.message,
              name: error?.name,
              text: String(error),
              stack: error?.stack,
            },
          );
          throw error;
        } finally {
          this.restoreStack.forEach(() => canvas.restore());
          this.restoreStack = [];
          canvas.restore();
          hostLog("debug", "fake renderer endFrame:done");
        }
      });

      renderingService.hooks.destroy.tap("fake-canvaskit-renderer", () => {
        const { surface } = this.context.contextService.getContext();
        this.fontLoader.destroy();
        surface.deleteLater();
        this.destroyed = true;
      });
    };
  }
}

export class Renderer extends AbstractRenderer {
  constructor(config = {}) {
    super(config);
    patchCanvasRun();
    const canvaskitRendererPlugin = new PatchedCanvasKitPlugin({
      fonts: config.fonts || [],
    });

    this.registerPlugin(
      new ContextRegisterPlugin({
        wasmDir: config.wasmDir || "fake://canvaskit/",
        canvaskitRendererPlugin,
      }),
    );
    this.registerPlugin(new ImageLoader.Plugin());
    this.registerPlugin(new CanvasPathGenerator.Plugin());
    this.registerPlugin(canvaskitRendererPlugin);
    this.registerPlugin(new DomInteraction.Plugin());
    this.registerPlugin(new CanvasPicker.Plugin());
    this.registerPlugin(new HTMLRenderer.Plugin());
  }
}
