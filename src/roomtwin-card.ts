import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import * as THREE from "three";
import { aspectRatio, bindingRefs, parseConfig, type BindingRef, type RoomTwinConfig } from "./config";
import { canSave, dashboardUrlPath, saveCard, viewPath } from "./dashboard";
import { toCardConfig, toYaml, type HelperDetail, type RoomTwinEditor, type Selected } from "./editor";
import type { HassEntity, HomeAssistant } from "./hass";
import { LightRig } from "./lights";
import { PressGesture, activeColor, flipsLabel, pinLabel, pinState, projectToScreen, spokenState, tapService, tuckedLabels, type PinBox } from "./pins";
import { RoomScene, SplatLoadError, savingData, webgl2Available, type Motion } from "./scene";
import { VERSION } from "./version";

// Long enough to flip between dashboard views without re-downloading the splat.
const DISPOSE_AFTER_MS = 60_000;
// HA's card editor makes a new preview card each time it opens, and browsers cap live WebGL contexts at a handful.
const PREVIEW_DISPOSE_AFTER_MS = 3_000;
// HA's card editor swaps in a new preview card on every change, down to each keystroke in the splat path.
const PREVIEW_LOAD_DELAY_MS = 600;
// A browser that keeps dropping the 3D view gets the Try again button instead of a reload loop.
const AUTO_RELOAD_GAP_MS = 60_000;
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;
// A card scrolled away or on a hidden tab holds a scene's worth of graphics memory; let it go after this long.
const OFFSCREEN_DISPOSE_MS = 4 * 60_000;
// Pin occlusion is raycast work, so it waits for the camera to settle and only sticks two checks in a row.
const OCCLUSION_SETTLE_MS = 350;
const OCCLUSION_EVERY_MS = 250;

const MDI_PENCIL =
  "M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z";
const MDI_HOME = "M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z";
const MDI_CUBE_SCAN =
  "M17,22V20H20V17H22V20.5C22,20.89 21.84,21.24 21.54,21.54C21.24,21.84 20.89,22 20.5,22H17M7,22H3.5C3.11,22 2.76,21.84 2.46,21.54C2.16,21.24 2,20.89 2,20.5V17H4V20H7V22M17,2H20.5C20.89,2 21.24,2.16 21.54,2.46C21.84,2.76 22,3.11 22,3.5V7H20V4H17V2M7,2V4H4V7H2V3.5C2,3.11 2.16,2.76 2.46,2.46C2.76,2.16 3.11,2 3.5,2H7M13,17.25L17,14.95V10.36L13,12.66V17.25M12,10.92L16,8.63L12,6.28L8,8.63L12,10.92M7,14.95L11,17.25V12.66L7,10.36V14.95M18.23,7.59C18.73,7.91 19,8.34 19,8.91V15.23C19,15.8 18.73,16.23 18.23,16.55L12.75,19.73C12.25,20.05 11.75,20.05 11.25,19.73L5.77,16.55C5.27,16.23 5,15.8 5,15.23V8.91C5,8.34 5.27,7.91 5.77,7.59L11.25,4.41C11.5,4.28 11.75,4.22 12,4.22C12.25,4.22 12.5,4.28 12.75,4.41L18.23,7.59Z";
const MDI_HELP = "M11,18H13V16H11V18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,6A4,4 0 0,0 8,10H10A2,2 0 0,1 12,8A2,2 0 0,1 14,10C14,12 11,11.75 11,15H13C13,12.75 16,12.5 16,10A4,4 0 0,0 12,6Z";

const NO_WEBGL2 =
  "RoomTwin needs WebGL2, which this browser or device doesn't provide. Use a current Chrome, Edge, Firefox or Safari with hardware acceleration turned on.";

type Status = { kind: "loading"; progress: number } | { kind: "ready" } | { kind: "error"; message: string; retry: boolean };

// The same refs while the config is unchanged, so a tap waiting out the double tap window still matches.
const refs = new WeakMap<RoomTwinConfig, BindingRef[]>();
function refsOf(config: RoomTwinConfig): BindingRef[] {
  let list = refs.get(config);
  if (!list) refs.set(config, (list = bindingRefs(config)));
  return list;
}

export class RoomTwinCard extends LitElement {
  static properties = {
    preview: { attribute: false },
    _config: { state: true },
    _draft: { state: true },
    _editing: { state: true },
    _status: { state: true },
    _warning: { state: true },
    _hint: { state: true },
    _selected: { state: true },
    _defer: { state: true },
  };

  /** Set by HA in dashboard edit mode and in the card editor, where HA owns the config being edited. */
  preview = false;
  private _hass?: HomeAssistant;
  private _config?: RoomTwinConfig;
  // The config as the dashboard stores it, to find this card again when saving.
  private rawConfig?: Record<string, unknown>;
  private dirtyMemo?: { draft: RoomTwinConfig; config: RoomTwinConfig; dirty: boolean };
  private loadTimer?: ReturnType<typeof setTimeout>;
  private timerKey = "";
  // Home Assistant builds new cards after the dashboard is saved, so this one won't come back.
  private replaced = false;
  private _draft: RoomTwinConfig | null = null;
  private _editing = false;
  private _status: Status = { kind: "loading", progress: 0 };
  private _warning = "";
  private _hint = "";
  // The browser's data saver is on, so the room waits for a Load room tap.
  private _defer = false;
  private userLoaded = false;
  // The editor's selection, ringed on the stage.
  private _selected: Selected | null = null;
  private hintTimer?: ReturnType<typeof setTimeout>;

  private scene?: RoomScene;
  private lights?: LightRig;
  private abort?: AbortController;
  private loadedKey = "";
  private onScreen = false;
  private disposeTimer?: ReturnType<typeof setTimeout>;
  private intersection?: IntersectionObserver;
  private resize?: ResizeObserver;
  // Overridable from probes, so the off-screen release can be exercised without waiting minutes.
  private offscreenDisposeMs = OFFSCREEN_DISPOSE_MS;
  private offscreenTimer?: ReturnType<typeof setTimeout>;
  // Pin occlusion, recomputed once the camera settles: value seen, value applied, and when the camera last moved.
  private occluded: boolean[] = [];
  private occludedSeen: boolean[] = [];
  private occlusionFor?: BindingRef[];
  private occlusionTimer?: ReturnType<typeof setTimeout>;
  private cameraMovedAt = 0;
  private readonly lastCameraPos = new THREE.Vector3();
  private readonly lastCameraQuat = new THREE.Quaternion();
  private readonly occlWorld = new THREE.Vector3();
  private pinEls: HTMLElement[] = [];
  private pins: BindingRef[] = [];
  private pinPointer?: PointerEvent;
  private lastAutoReload = 0;
  private tapStart?: { x: number; y: number; t: number };
  private readonly tmp = new THREE.Vector3();
  // Keyed by the binding itself, so a tap still waiting out the double tap window can't land on another pin if the config changes.
  private readonly press = new PressGesture<BindingRef>({
    tap: (pin) => this.pinTap(pin),
    hold: (pin) => this.pinHold(pin),
    hasDoubleTap: (pin) => !this._editing && !!pin.double_tap_action && pin.double_tap_action.action !== "none",
    doubleTap: (pin) => this.fire("hass-action", { config: pin, action: "double_tap" }),
  });

  static getStubConfig(): Record<string, unknown> {
    return { splat: "/local/roomtwin/room.spz" };
  }

  /** HA's visual editor for the plain options. Lights, pins and the view are placed on the card itself. */
  static getConfigForm() {
    const labels: Record<string, string> = {
      splat: "Splat file",
      aspect_ratio: "Aspect ratio",
      lod_scale: "Detail",
      ceiling_cut: "Ceiling cut height",
    };
    const helpers: Record<string, string> = {
      splat: "Like /local/roomtwin/living.spz, for a file in /config/www/roomtwin/",
      aspect_ratio: "Pick one or type your own, like 5:4",
      lod_scale: "Lower is faster on weak tablets, higher is sharper. 1 by default",
      ceiling_cut: "Hides everything above this height, to look in from above. Easier to set with the pencil button on the card",
    };
    return {
      schema: [
        { name: "splat", required: true, selector: { text: {} } },
        {
          type: "grid",
          name: "",
          schema: [
            {
              name: "aspect_ratio",
              selector: { select: { mode: "dropdown", custom_value: true, options: ["16:9", "4:3", "3:2", "1:1", "21:9", "3:4"] } },
            },
            { name: "lod_scale", selector: { number: { min: 0.1, max: 8, step: 0.1, mode: "box" } } },
          ],
        },
        { name: "ceiling_cut", selector: { number: { min: 0, step: 0.01, mode: "box" } } },
      ],
      computeLabel: (item: { name: string }) => labels[item.name],
      computeHelper: (item: { name: string }) => helpers[item.name],
    };
  }

  setConfig(raw: unknown): void {
    const old = this._config;
    this._config = parseConfig(raw);
    this.rawConfig = raw as Record<string, unknown>;
    this.replaced = false;
    this._draft = null;
    this._editing = false;
    this.scene?.showHelper(null);
    if (this.scene?.mesh && this.loadKey(this._config) === this.loadedKey) {
      // Only move the camera when the saved view changed, not on every edit to the rest.
      this.applyConfig(this._config, JSON.stringify(old?.camera) !== JSON.stringify(this._config.camera) ? "glide" : null);
    }
  }

  set hass(hass: HomeAssistant) {
    const old = this._hass;
    this._hass = hass;
    const config = this.shown;
    if (!config) return;
    // The editor looks up any entity, not just the bound ones. A new locale or formatter changes how every pin reads.
    const changed =
      !old ||
      this._editing ||
      old.locale !== hass.locale ||
      old.formatEntityState !== hass.formatEntityState ||
      old.user !== hass.user ||
      refsOf(config).some((p) => old.states[p.entity] !== hass.states[p.entity]);
    if (changed) {
      if (this.lights?.applyStates(hass.states)) this.scene?.requestRender();
      this.requestUpdate();
    }
  }

  get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  getCardSize(): number {
    // In units of 50px, for a masonry column about 500px wide.
    return Math.max(3, Math.ceil(10 / aspectRatio(this._config?.aspect_ratio)));
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6 };
  }

  /** The config on screen: the edit draft while editing, otherwise the saved one. */
  private get shown(): RoomTwinConfig | undefined {
    return (this._editing && this._draft) || this._config;
  }

  private loadKey(config: RoomTwinConfig): string {
    return `${config.splat}|${config.lod}`;
  }

  private get canvasHost(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(".canvas");
  }

  private get editor(): RoomTwinEditor | null {
    return this.renderRoot.querySelector<RoomTwinEditor>("roomtwin-editor");
  }

  connectedCallback(): void {
    super.connectedCallback();
    clearTimeout(this.disposeTimer);
    this.replaced = false;
    document.addEventListener("visibilitychange", this.onVisibility);
    for (const type of ["keydown", "keyup", "blur"]) window.addEventListener(type, this.onControlKey, true);
    if (this.hasUpdated) {
      this.observe();
      this.requestUpdate();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this.onVisibility);
    for (const type of ["keydown", "keyup", "blur"]) window.removeEventListener(type, this.onControlKey, true);
    this.intersection?.disconnect();
    this.resize?.disconnect();
    this.press.cancel();
    this.press.forget();
    this.onScreen = false;
    clearTimeout(this.offscreenTimer);
    this.offscreenTimer = undefined;
    clearTimeout(this.occlusionTimer);
    this.occlusionTimer = undefined;
    this.updateActive();
    // A preview card that goes away mid-load has usually been swapped for a new one, so it stops parsing now.
    if (this.preview && this._status.kind === "loading") this.teardown();
    this.disposeTimer = setTimeout(() => this.teardown(), this.preview || this.replaced ? PREVIEW_DISPOSE_AFTER_MS : DISPOSE_AFTER_MS);
  }

  private observe(): void {
    const host = this.canvasHost;
    if (!host) return;
    this.intersection?.disconnect();
    this.intersection = new IntersectionObserver((entries) => {
      this.onScreen = entries.some((e) => e.isIntersecting);
      this.updateActive();
      if (this.onScreen) this.requestUpdate();
    });
    this.intersection.observe(host);
    this.resize?.disconnect();
    this.resize = new ResizeObserver(() => this.scene?.resize(host.clientWidth, host.clientHeight));
    this.resize.observe(host);
  }

  private updateActive = (): void => {
    const active = this.isConnected && this.onScreen && document.visibilityState === "visible";
    this.scene?.setActive(active);
    this.updateOffscreenTimer();
  };

  /** A card that has been off-screen or on a hidden tab for minutes gives its scene back. */
  private updateOffscreenTimer(): void {
    clearTimeout(this.offscreenTimer);
    this.offscreenTimer = undefined;
    if (this.onScreen || !this.isConnected || this._editing || this.preview || this._status.kind !== "ready") return;
    this.offscreenTimer = setTimeout(() => {
      this.offscreenTimer = undefined;
      if (!this.isConnected || this.onScreen || this._editing || this.preview || this._status.kind !== "ready") return;
      this.teardown();
    }, this.offscreenDisposeMs);
  }

  private onVisibility = (): void => {
    this.updateActive();
    if (document.visibilityState === "visible") this.requestUpdate();
  };

  // OrbitControls tracks Ctrl on this shadow root, and focus is rarely inside it. Only the window's blur means Ctrl
  // was let go elsewhere; blurs inside the page pass through this capture listener too.
  private onControlKey = (e: Event): void => {
    if (e.type === "blur") {
      if (e.target === window) this.renderRoot.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    }
    else if ((e as KeyboardEvent).key === "Control") this.renderRoot.dispatchEvent(new KeyboardEvent(e.type, { key: "Control" }));
  };

  private teardown(): void {
    clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
    clearTimeout(this.occlusionTimer);
    this.occlusionTimer = undefined;
    this.abort?.abort();
    this.lights?.dispose();
    this.lights = undefined;
    this.scene?.dispose();
    this.scene = undefined;
    this.pinPointer = undefined;
    this.loadedKey = "";
    this._status = { kind: "loading", progress: 0 };
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (!this.intersection) this.observe();
    if (changed.has("_status")) this.updateOffscreenTimer();
    const config = this.shown;
    // A room scan is a big bite out of a metered connection, so with data saver on it loads on request.
    // A preview card is the dashboard's own editor dialog, where the file is already the point, so it skips the gate.
    this._defer = !this.userLoaded && !this.preview && savingData();
    // Waiting until the card is on screen keeps a dashboard of rooms from downloading all of them at once.
    const visible = this.onScreen && document.visibilityState === "visible";
    if (config && this.canvasHost && visible && !this._defer && this.loadedKey !== this.loadKey(config)) this.scheduleLoad(config);
    this.pins = config ? refsOf(config) : [];
    if (this.occlusionFor !== this.pins || !config?.occlude_pins) {
      this.occlusionFor = config ? this.pins : undefined;
      this.occluded = this.pins.map(() => false);
      this.occludedSeen = this.pins.map(() => false);
      // The camera may not move again, so the fresh state is cast for straight away.
      if (config?.occlude_pins && this.scene?.mesh && !this.occlusionTimer) {
        this.occlusionTimer = setTimeout(this.checkOcclusion, OCCLUSION_EVERY_MS);
      }
    }
    this.pinEls = [...this.renderRoot.querySelectorAll<HTMLElement>(".pin")];
    this.positionPins();
  }

  private scheduleLoad(config: RoomTwinConfig): void {
    if (!this.preview) {
      void this.load(config);
      return;
    }
    // Every hass update comes through here, so only a different splat restarts the wait.
    if (this.loadTimer !== undefined && this.timerKey === this.loadKey(config)) return;
    clearTimeout(this.loadTimer);
    this.timerKey = this.loadKey(config);
    this.loadTimer = setTimeout(() => {
      this.loadTimer = undefined;
      const latest = this.shown;
      if (latest && this.isConnected && this.loadedKey !== this.loadKey(latest)) void this.load(latest);
    }, PREVIEW_LOAD_DELAY_MS);
  }

  private async load(config: RoomTwinConfig): Promise<void> {
    this.teardown();
    this.loadedKey = this.loadKey(config);
    this._warning = "";
    if (!webgl2Available()) {
      this._status = { kind: "error", message: NO_WEBGL2, retry: false };
      return;
    }
    const host = this.canvasHost!;
    const abort = (this.abort = new AbortController());
    this._status = { kind: "loading", progress: 0 };
    try {
      const scene = (this.scene = new RoomScene(host));
      scene.onRender = () => this.positionPins();
      scene.onContextLost = () => this.onContextLost(config);
      scene.resize(host.clientWidth, host.clientHeight);
      this.updateActive();
      const result = await scene.load(config.splat, {
        lod: config.lod,
        signal: abort.signal,
        onProgress: (progress) => (this._status = { kind: "loading", progress }),
      });
      this._warning = result.warning ?? "";
      this.lights = new LightRig(scene.mesh!);
      this.applyConfig(this.shown ?? config, "enter");
      this._status = { kind: "ready" };
    } catch (err) {
      if (abort.signal.aborted) return;
      const message = err instanceof SplatLoadError ? err.message : `Could not load ${config.splat}: ${(err as Error)?.message ?? err}`;
      this._status = { kind: "error", message, retry: true };
    }
  }

  /** Phones drop the WebGL context of a backgrounded tab, so reload once the card is visible again. */
  private onContextLost(config: RoomTwinConfig): void {
    this.teardown();
    if (Date.now() - this.lastAutoReload > AUTO_RELOAD_GAP_MS) {
      this.lastAutoReload = Date.now();
      this.requestUpdate();
      return;
    }
    this.loadedKey = this.loadKey(config);
    this._status = { kind: "error", message: "The browser dropped the 3D view to free graphics memory.", retry: true };
  }

  private retry(): void {
    this.loadedKey = "";
    this.requestUpdate();
  }

  private loadNow(): void {
    this.userLoaded = true;
    this._defer = false;
    this.requestUpdate();
  }

  /** Applies a config to the scene, moving the camera to its saved view with `motion`, or keeping the current view for null. */
  private applyConfig(config: RoomTwinConfig, motion: Motion | null): void {
    const scene = this.scene;
    if (!scene?.mesh || !this.lights) return;
    const view = motion ? config.camera : scene.currentView();
    scene.setOrientation(config.up, config.floor);
    scene.setCeilingCut(config.ceiling_cut);
    scene.setLodScale(config.lod_scale);
    this.lights.setBindings(config.lights);
    this.lights.applyStates(this._hass?.states ?? {});
    // Editing mid-flight leaves the flight to land.
    if (motion || !scene.flying) scene.setView(view, motion ?? "jump");
    scene.requestRender();
  }

  private positionPins = (): void => {
    const scene = this.scene;
    const host = this.canvasHost;
    if (!scene?.mesh || !host) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    scene.camera.updateMatrixWorld();
    // Occlusion is raycast work, so it waits until the camera has been still for a moment.
    // OrbitControls re-derives the pose every frame with float noise, so "still" means no move past these epsilons.
    const now = performance.now();
    const jolted =
      this.lastCameraPos.distanceToSquared(scene.camera.position) > 1e-10 || this.lastCameraQuat.angleTo(scene.camera.quaternion) > 1e-6;
    if (jolted) {
      this.lastCameraPos.copy(scene.camera.position);
      this.lastCameraQuat.copy(scene.camera.quaternion);
      this.cameraMovedAt = now;
      // No frame renders once the camera stops, so the check is timed from the last move.
      clearTimeout(this.occlusionTimer);
      this.occlusionTimer = setTimeout(this.checkOcclusion, OCCLUSION_SETTLE_MS + OCCLUSION_EVERY_MS);
    }
    // Every read before any write, so a frame lays the pins out once.
    const boxes = this.pinEls.map((el, i): PinBox => {
      const pin = this.pins[i];
      const p = pin ? projectToScreen(scene.captureToWorld(pin.anchor, this.tmp), scene.camera, width, height) : { x: 0, y: 0, depth: 0, visible: false };
      const face = el.firstElementChild as HTMLElement | null;
      const label = face?.querySelector<HTMLElement>(".label");
      const box = { ...p, size: face?.offsetHeight ?? 0, labelWidth: label?.offsetWidth ?? 0 };
      return { ...box, flipped: flipsLabel(box, width) };
    });
    const tucked = tuckedLabels(boxes);
    // Nearer pins on top, ranked the way tuckedLabels ranks them so the pin keeping its label is the one drawn over the rest.
    const layer = new Array<number>(boxes.length);
    boxes
      .map((_, i) => i)
      .sort((a, b) => boxes[a].depth - boxes[b].depth)
      .forEach((i, rank) => (layer[i] = boxes.length - rank));
    this.pinEls.forEach((el, i) => {
      const p = boxes[i];
      // A flipped pin hangs from the icon's right edge, so the icon stays put when hovering shows a tucked label.
      el.style.transform = p.flipped
        ? `translate(${p.x + p.size / 2}px, ${p.y - p.size / 2}px) translateX(-100%)`
        : `translate(${p.x - p.size / 2}px, ${p.y - p.size / 2}px)`;
      el.classList.toggle("flipped", !!p.flipped);
      el.style.visibility = p.visible ? "" : "hidden";
      el.style.zIndex = String(layer[i]);
      el.classList.toggle("tucked", tucked[i]);
      el.classList.toggle("occluded", p.visible && this.occluded[i]);
    });
  };

  /** Recasts pin occlusion once the camera has settled, and keeps waiting while it still is moving. */
  private checkOcclusion = (): void => {
    this.occlusionTimer = undefined;
    const scene = this.scene;
    if (!scene?.mesh || !this.shown?.occlude_pins) return;
    const now = performance.now();
    if (now - this.cameraMovedAt < OCCLUSION_SETTLE_MS) {
      this.occlusionTimer = setTimeout(this.checkOcclusion, OCCLUSION_SETTLE_MS + OCCLUSION_EVERY_MS - (now - this.cameraMovedAt));
      return;
    }
    // Closer than this and a hit is the device the pin sits on or the wall just behind a thin or
    // dark object, not a wall in front of the pin: slack grows with how far away the pin is.
    const extent = scene.roomExtent();
    const camera = scene.camera.position;
    let pending = false;
    this.pins.forEach((pin, i) => {
      const world = scene.captureToWorld(pin.anchor, this.occlWorld);
      const seen = scene.occludes(world, Math.max(extent / 50, camera.distanceTo(world) * 0.1));
      // Two casts in a row before a pin changes, so a coarse LoD ray can't flicker it while orbiting.
      if (seen === this.occludedSeen[i]) this.occluded[i] = seen;
      else this.occludedSeen[i] = seen;
      if (this.occluded[i] !== seen) pending = true;
      this.pinEls[i]?.classList.toggle("occluded", this.occluded[i]);
    });
    if (pending) this.occlusionTimer = setTimeout(this.checkOcclusion, OCCLUSION_EVERY_MS);
  };

  private fire(type: string, detail: unknown, from: EventTarget = this): void {
    from.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private moreInfo(entityId: string | undefined): void {
    if (entityId) this.fire("hass-more-info", { entityId });
  }

  private pinTap(pin: BindingRef | undefined): void {
    if (!pin) return;
    if (this._editing) {
      this.editor?.select(pin.kind, pin.index);
      return;
    }
    if (pin.tap_action) {
      this.fire("hass-action", { config: pin, action: "tap" });
      return;
    }
    const service = tapService(this._hass?.states[pin.entity]);
    if (!service || !this._hass) {
      this.moreInfo(pin.entity);
      return;
    }
    this.fire("haptic", "light");
    // HA's own failure toast names only the service, so it's turned off in favour of one naming the entity.
    this._hass.callService(service.domain, service.service, { entity_id: pin.entity }, undefined, false).catch((err: Error) => {
      this.fire("hass-notification", { message: `Could not ${service.service.replace("_", " ")} ${pin.entity}: ${err?.message ?? err}` });
    });
  }

  private pinHold(pin: BindingRef | undefined): void {
    if (pin?.hold_action && !this._editing) this.fire("hass-action", { config: pin, action: "hold" });
    else this.moreInfo(pin?.entity);
  }

  private onPinDown(e: PointerEvent): void {
    const el = (e.target as Element).closest<HTMLElement>(".pin");
    if (!el) return;
    if (!e.isPrimary) {
      this.handToControls(e);
      return;
    }
    // Keeps the release on the pin when the pointer slips off it, which would otherwise read as a long-press.
    el.setPointerCapture(e.pointerId);
    this.pinPointer = e;
    const pin = this.pins[Number(el.dataset.i)];
    if (pin) this.press.down(e, pin);
  }

  private onPinMove = (e: PointerEvent): void => {
    // A pinch hands this finger to the orbit controls from where it is now, not where it landed.
    if (e.pointerId === this.pinPointer?.pointerId) this.pinPointer = e;
    this.press.move(e);
  };

  private onPinUp = (e: PointerEvent): void => {
    this.pinPointer = undefined;
    this.press.up(e);
  };

  private onPinCancel = (): void => {
    this.pinPointer = undefined;
    this.press.cancel();
  };

  /** A second finger means a pinch, so any finger on a pin goes to the orbit controls instead. */
  private handToControls(extra?: PointerEvent): void {
    const canvas = this.scene?.renderer.domElement;
    if (!canvas) return;
    this.press.cancel();
    for (const e of [this.pinPointer, extra]) {
      if (!e) continue;
      canvas.dispatchEvent(new PointerEvent("pointerdown", e));
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Already lifted.
      }
    }
    this.pinPointer = undefined;
  }

  /** Enter or Space taps a pin. Shift+Enter or the menu key opens more-info, the keyboard's long-press. */
  private onPinKey(e: KeyboardEvent): void {
    const el = (e.target as Element).closest<HTMLElement>(".pin");
    const pin = el ? this.pins[Number(el.dataset.i)] : undefined;
    if (!pin) return;
    if (this._editing) {
      // Delete on a focused pin means that pin, not whichever one was selected before.
      if (e.key === "Delete" || e.key === "Backspace") this.editor?.select(pin.kind, pin.index);
      this.editor?.handleKey(e);
      if (e.defaultPrevented) return;
    }
    if (e.key === "ContextMenu" || (e.key === "Enter" && e.shiftKey)) {
      e.preventDefault();
      this.pinHold(pin);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!e.repeat) this.pinTap(pin);
    }
  }

  // Scrolling a dashboard past the card should scroll it, so outside edit mode zooming takes Ctrl, as on embedded maps.
  private readonly onStageWheel = {
    capture: true,
    handleEvent: (e: WheelEvent) => {
      if (this._editing || e.ctrlKey || e.metaKey) {
        // Pins sit on top of the canvas, and a zoom that starts on one would otherwise zoom the whole page.
        const canvas = this.canvasHost?.querySelector("canvas");
        if (canvas && (e.target as Element).closest(".pin")) {
          e.preventDefault();
          canvas.dispatchEvent(new WheelEvent(e.type, e));
        }
        return;
      }
      e.stopPropagation();
      this._hint = "Hold Ctrl and scroll to zoom";
      clearTimeout(this.hintTimer);
      this.hintTimer = setTimeout(() => (this._hint = ""), 1500);
    },
  };

  // The canvas lets one finger scroll the page vertically; a second finger must not scroll it too.
  private readonly onStageTouch = {
    passive: false,
    handleEvent: (e: TouchEvent) => {
      if (e.touches.length > 1 && e.cancelable) e.preventDefault();
    },
  };

  private resetView(): void {
    this.scene?.setView(this.shown?.camera, "glide");
  }

  private onStageKey(e: KeyboardEvent): void {
    if (this._editing) this.editor?.handleKey(e);
    if (e.key !== "Home") return;
    e.preventDefault();
    this.resetView();
  }

  private onStageDown(e: PointerEvent): void {
    if (!e.isPrimary) this.handToControls();
    else if (e.pointerType === "touch") this.scene?.markView();
    this.tapStart = this._editing && e.isPrimary && e.button === 0 ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : undefined;
  }

  // The browser cancels a finger once it decides the swipe scrolls the page, by which time the orbit has turned a little.
  private onStageCancel(e: PointerEvent): void {
    if (e.isPrimary && e.pointerType === "touch" && !this._editing) this.scene?.undoDrag();
  }

  private onStageUp(e: PointerEvent): void {
    const start = this.tapStart;
    this.tapStart = undefined;
    const host = this.canvasHost;
    if (!start || !this._editing || !this.scene || !host) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP_PX || e.timeStamp - start.t > TAP_MAX_MS) return;
    const rect = host.getBoundingClientRect();
    this.editor?.handlePick(this.scene.pick(e.clientX - rect.left, e.clientY - rect.top));
  }

  private openEditor(): void {
    this._draft ??= this._config!;
    this._editing = true;
    this.applyConfig(this._draft, null);
    void this.updateComplete.then(() => this.editor?.focusTask());
  }

  private closeEditor(): void {
    this._editing = false;
    this.scene?.showHelper(null);
    this.applyConfig(this._config!, null);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>("button.edit")?.focus());
  }

  private onDraft(e: CustomEvent<RoomTwinConfig>): void {
    this._draft = e.detail;
    this.applyConfig(e.detail, null);
  }

  private onDiscard(): void {
    this._draft = this._config!;
    this.scene?.showHelper(null);
    this.applyConfig(this._config!, null);
  }

  private saveDraft = async (): Promise<void> => {
    const draft = this._draft!;
    const card = toCardConfig(draft);
    // Set first: the new cards can arrive before the save call returns.
    this.replaced = true;
    try {
      await saveCard(this._hass!, dashboardUrlPath(location.pathname), this.rawConfig!, card, viewPath(location.pathname));
    } catch (err) {
      this.replaced = false;
      throw err;
    }
    this.rawConfig = card;
    this._config = draft;
    // Home Assistant has usually swapped this card for a new one by now, so the toast goes to its root.
    this.fire("hass-notification", { message: "Saved to the dashboard." }, this.isConnected ? this : (document.querySelector("home-assistant") ?? this));
  };

  private get dirty(): boolean {
    const draft = this._draft;
    const config = this._config;
    if (!draft || !config || draft === config) return false;
    const memo = this.dirtyMemo;
    if (memo?.draft === draft && memo.config === config) return memo.dirty;
    const dirty = toYaml(draft) !== toYaml(config);
    this.dirtyMemo = { draft, config, dirty };
    return dirty;
  }

  private getView = () => this.scene!.currentView();

  private getRoomHeight = () => this.scene!.roomBounds().max.y;

  private onHelper(e: CustomEvent<HelperDetail>): void {
    this.scene?.showHelper(e.detail.anchor, e.detail.radius, e.detail.end);
    this._selected = e.detail.selected;
  }

  private renderPin(pin: BindingRef, i: number, hass: HomeAssistant) {
    const stateObj: HassEntity | undefined = hass.states[pin.entity];
    const state = pinState(stateObj);
    const label = pinLabel(hass, stateObj);
    const name = pin.name ?? stateObj?.attributes.friendly_name ?? pin.entity;
    const title = stateObj ? name : `${pin.entity} is not in Home Assistant`;
    const spoken = spokenState(hass, stateObj);
    const tapToggles = !pin.tap_action || (pin.tap_action.action === "toggle" && !pin.tap_action.entity);
    const toggles = tapToggles && tapService(stateObj)?.service === "toggle";
    const selected = this._editing && this._selected?.kind === pin.kind && this._selected.index === pin.index;
    return html`<div
      class="pin ${state} ${pin.kind} ${selected ? "selected" : ""}"
      data-i=${i}
      role="button"
      tabindex="0"
      aria-pressed=${toggles ? String(state === "active") : nothing}
      style=${styleMap({ "--roomtwin-active": state === "active" && stateObj ? activeColor(stateObj) : undefined, "--n": String(i) })}
      title=${title}
      aria-label=${spoken ? `${name}: ${spoken}` : name}
    >
      <div class="face">
        <span class="bubble">
          ${stateObj
            ? html`<ha-state-icon .hass=${hass} .stateObj=${stateObj} .icon=${pin.icon}></ha-state-icon>`
            : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${MDI_HELP}></path></svg>`}
        </span>
        ${label ? html`<span class="label">${label}</span>` : nothing}
      </div>
    </div>`;
  }

  private renderStatus() {
    const status = this._status;
    if (status.kind === "ready") return nothing;
    if (this._defer) {
      return html`<div class="overlay">
        <span>Data saver is on in this browser, so the room hasn't been downloaded. A scan can be tens of megabytes.</span>
        <button class="retry" @click=${this.loadNow}>Load room</button>
      </div>`;
    }
    if (status.kind === "loading") {
      const text = status.progress < 1 ? `Loading room ${Math.round(status.progress * 100)}%` : "Preparing room";
      const percent = Math.round(status.progress * 100);
      return html`<div class="overlay loading">
        <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d=${MDI_CUBE_SCAN}></path></svg>
        <div class="bar" role="progressbar" aria-label="Loading room" aria-valuenow=${percent} aria-valuetext=${text}>
          <div style="width: ${percent}%"></div>
        </div>
        <span aria-hidden="true">${text}</span>
      </div>`;
    }
    return html`<div class="overlay">
      <ha-alert alert-type="error">${status.message}</ha-alert>
      ${status.retry ? html`<button class="retry" @click=${this.retry}>Try again</button>` : nothing}
    </div>`;
  }

  protected render() {
    const config = this.shown;
    const hass = this._hass;
    if (!config) return nothing;
    const ready = this._status.kind === "ready";
    return html`<ha-card>
      <div
        class="stage ${ready ? "ready" : ""} ${this._editing ? "editing" : ""}"
        style="aspect-ratio: ${aspectRatio(config.aspect_ratio)}"
        @wheel=${this.onStageWheel}
      >
        <div
          class="canvas"
          @keydown=${this.onStageKey}
          @pointerdown=${this.onStageDown}
          @pointerup=${this.onStageUp}
          @pointercancel=${this.onStageCancel}
          @touchstart=${this.onStageTouch}
          @touchmove=${this.onStageTouch}
        ></div>
        ${ready && hass
          ? html`<div
              class="pins"
              @pointerdown=${this.onPinDown}
              @pointermove=${this.onPinMove}
              @pointerup=${this.onPinUp}
              @pointercancel=${this.onPinCancel}
              @keydown=${this.onPinKey}
              @contextmenu=${(e: Event) => e.preventDefault()}
            >
              ${refsOf(config).map((pin, i) => this.renderPin(pin, i, hass))}
            </div>`
          : nothing}
        ${this.renderStatus()}
        <div class="hint" role="status">${this._hint}</div>
        ${ready
          ? html`<div class="tools">
              <button title="Reset view" aria-label="Reset view" @click=${this.resetView}>
                <svg viewBox="0 0 24 24"><path d=${MDI_HOME}></path></svg>
              </button>
              ${hass?.user?.is_admin && !this._editing
                ? html`<button
                    class=${this.dirty ? "edit unsaved" : "edit"}
                    title=${this.dirty ? "Edit pins and lights (unsaved changes)" : "Edit pins and lights"}
                    aria-label=${this.dirty ? "Edit pins and lights, unsaved changes" : "Edit pins and lights"}
                    @click=${this.openEditor}
                  >
                    <svg viewBox="0 0 24 24"><path d=${MDI_PENCIL}></path></svg>
                  </button>`
                : nothing}
            </div>`
          : nothing}
        ${ready && this._editing
          ? html`<div class="badge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d=${MDI_PENCIL}></path></svg>Editing</div>`
          : nothing}
      </div>
      ${this._warning ? html`<ha-alert alert-type="warning">${this._warning}</ha-alert>` : nothing}
      ${this._draft && hass && ready
        ? html`<roomtwin-editor
            ?hidden=${!this._editing}
            .hass=${hass}
            .config=${this._draft}
            .dirty=${this.dirty}
            .save=${!this.preview && this.rawConfig && canSave(hass, dashboardUrlPath(location.pathname)) ? this.saveDraft : undefined}
            .getView=${this.getView}
            .getRoomHeight=${this.getRoomHeight}
            @draft-changed=${this.onDraft}
            @draft-discarded=${this.onDiscard}
            @helper-changed=${this.onHelper}
            @editor-closed=${this.closeEditor}
          ></roomtwin-editor>`
        : nothing}
    </ha-card>`;
  }

  static styles = css`
    ha-card {
      overflow: hidden;
    }
    .stage {
      --glass: rgba(18, 20, 26, 0.55);
      position: relative;
      width: 100%;
      container-type: inline-size;
      background: var(--roomtwin-stage-background, radial-gradient(120% 100% at 50% 30%, #262a31, #111 70%));
    }
    .canvas {
      position: absolute;
      inset: 0;
      opacity: 0;
      transition: opacity 0.8s ease;
    }
    .ready .canvas {
      opacity: 1;
    }
    /* Keeps the buttons and pins readable over a bright wall. */
    .canvas::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(to bottom, rgba(0, 0, 0, 0.3), transparent 72px),
        radial-gradient(130% 100% at 50% 50%, transparent 60%, rgba(0, 0, 0, 0.3));
    }
    /* OrbitControls sets touch-action none inline. Outside edit mode a vertical swipe scrolls the dashboard. */
    .canvas canvas {
      touch-action: pan-y !important;
    }
    .editing .canvas canvas {
      touch-action: none !important;
    }
    .face,
    .hint,
    .badge,
    .tools button {
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: var(--glass);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      color: #fff;
    }
    /* Not on pins: a stress room with two dozen of them lost about a tenth of its frame rate to the blur. */
    .hint,
    .badge,
    .tools button {
      -webkit-backdrop-filter: blur(10px) saturate(1.4);
      backdrop-filter: blur(10px) saturate(1.4);
    }
    .hint {
      position: absolute;
      left: 50%;
      bottom: 14px;
      transform: translateX(-50%);
      padding: 7px 14px;
      border-radius: 18px;
      font-size: 13px;
      white-space: nowrap;
      pointer-events: none;
      transition: opacity 0.2s;
    }
    .hint:empty {
      opacity: 0;
    }
    /* Placement assumes the icon comes first, so right-to-left text only flips inside a label. */
    .pins {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      isolation: isolate;
      direction: ltr;
    }
    .pin {
      --size: var(--roomtwin-pin-size, 36px);
      position: absolute;
      left: 0;
      top: 0;
      outline: none;
      pointer-events: auto;
      cursor: pointer;
      touch-action: pan-y;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      will-change: transform;
      --mdc-icon-size: calc(var(--size) * 5 / 9);
    }
    .pin:hover,
    .pin:focus-visible {
      z-index: 1000000 !important;
    }
    .pin.selected {
      z-index: 999999 !important;
    }
    .face {
      position: relative;
      display: flex;
      align-items: center;
      box-sizing: border-box;
      min-width: var(--size);
      height: var(--size);
      padding: 3px;
      border-radius: calc(var(--size) / 2);
      background: var(--roomtwin-pin-background, rgba(18, 20, 26, 0.75));
      color: var(--roomtwin-pin-text-color, #fff);
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      transition:
        transform 0.15s ease,
        opacity 0.25s ease,
        border-color 0.3s,
        box-shadow 0.3s;
      animation: pin-in 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.25) backwards;
      animation-delay: calc(min(var(--n), 12) * 40ms + 150ms);
    }
    .editing .face {
      animation-delay: 0s;
    }
    .bubble {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
      width: calc(var(--size) - 8px);
      height: calc(var(--size) - 8px);
      border-radius: 50%;
      transition:
        background-color 0.3s,
        color 0.3s,
        box-shadow 0.3s;
    }
    .editing .pin {
      touch-action: none;
    }
    .label {
      padding: 0 9px 0 3px;
      unicode-bidi: plaintext;
    }
    .pin.flipped .face {
      flex-direction: row-reverse;
    }
    .pin.flipped .label {
      padding: 0 3px 0 9px;
    }
    .pin.tucked:not(:hover, :focus-visible, .selected) .label {
      position: absolute;
      visibility: hidden;
    }
    /* Behind a wall from where the camera is: dimmed but findable, and hovering, focusing or selecting it brings it back. */
    .pin.occluded:not(:hover, :focus-visible, .selected) .face {
      opacity: 0.25;
    }
    @media (hover: hover) {
      .pin:hover .face {
        transform: scale(1.08);
      }
    }
    .pin:active .face {
      transform: scale(0.94);
    }
    .pin:focus-visible .face {
      outline: 2px solid var(--primary-color, #03a9f4);
      outline-offset: 2px;
    }
    .pin.active .face {
      border-color: color-mix(in srgb, var(--roomtwin-active) 60%, transparent);
      box-shadow:
        0 4px 14px rgba(0, 0, 0, 0.35),
        0 0 18px color-mix(in srgb, var(--roomtwin-active) 45%, transparent);
    }
    .pin.active .bubble {
      background: var(--roomtwin-active);
      color: rgba(0, 0, 0, 0.87);
      box-shadow: 0 0 10px color-mix(in srgb, var(--roomtwin-active) 70%, transparent);
    }
    .pin.alert .face {
      border-color: var(--error-color, #db4437);
    }
    .pin.alert .bubble {
      /* Darkened so the white icon passes WCAG AA on HA's default red. */
      background: color-mix(in srgb, var(--error-color, #db4437) 85%, black);
      color: #fff;
    }
    .pin.alert .face::after {
      content: "";
      position: absolute;
      inset: -1px;
      border-radius: inherit;
      border: 2px solid var(--error-color, #db4437);
      pointer-events: none;
      animation: ring 1.8s ease-out infinite;
    }
    .pin.selected .face {
      outline: 3px solid var(--primary-color, #03a9f4);
      outline-offset: 3px;
      transform: scale(1.1);
    }
    .pin.selected:active .face {
      transform: scale(1.02);
    }
    .pin.missing .face,
    .pin.unavailable .face {
      border-style: dashed;
      border-color: rgba(255, 255, 255, 0.4);
      border-color: color-mix(in srgb, currentColor 45%, transparent);
    }
    .pin.missing .face > *,
    .pin.unavailable .face > * {
      opacity: 0.7;
    }
    .pin svg {
      width: var(--mdc-icon-size);
      height: var(--mdc-icon-size);
      fill: currentColor;
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding: 16px;
      color: rgba(255, 255, 255, 0.85);
      text-align: center;
    }
    .overlay span {
      max-width: 460px;
      font-size: 13px;
      letter-spacing: 0.02em;
      font-variant-numeric: tabular-nums;
    }
    .overlay ha-alert {
      max-width: 520px;
      text-align: left;
    }
    .glyph {
      width: 44px;
      height: 44px;
      fill: var(--primary-color, #03a9f4);
      filter: drop-shadow(0 0 12px color-mix(in srgb, var(--primary-color, #03a9f4) 60%, transparent));
      animation: float 2.4s ease-in-out infinite;
    }
    .bar {
      width: min(260px, 60%);
      height: 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.12);
      overflow: hidden;
    }
    .bar > div {
      position: relative;
      height: 100%;
      overflow: hidden;
      border-radius: inherit;
      background: var(--primary-color, #03a9f4);
      transition: width 0.3s ease;
    }
    /* A var() inside makes an unsupported color-mix fail at computed time, past the fallback above. */
    @supports (color: color-mix(in srgb, red, blue)) {
      .bar > div {
        background: linear-gradient(90deg, color-mix(in srgb, var(--primary-color, #03a9f4) 55%, white), var(--primary-color, #03a9f4));
      }
    }
    .bar > div::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent);
      transform: translateX(-100%);
      animation: shimmer 1.4s linear infinite;
    }
    .retry {
      font: inherit;
      padding: 8px 18px;
      border: none;
      border-radius: 18px;
      background: var(--primary-color, #03a9f4);
      color: var(--text-primary-color, #fff);
      cursor: pointer;
    }
    .tools {
      position: absolute;
      top: 10px;
      right: 10px;
      display: flex;
      gap: 8px;
      animation: fade-in 0.4s ease 0.3s backwards;
    }
    .tools button {
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      width: 40px;
      height: 40px;
      padding: 0;
      border-radius: 50%;
      cursor: pointer;
      transition:
        background-color 0.2s,
        transform 0.15s;
    }
    .tools button:hover {
      background: rgba(18, 20, 26, 0.8);
    }
    .tools button.unsaved::after {
      content: "";
      position: absolute;
      top: 3px;
      right: 3px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--warning-color, #ffa600);
    }
    .tools button:active {
      transform: scale(0.92);
    }
    .tools button:focus-visible,
    .retry:focus-visible {
      outline: 2px solid var(--primary-color, #03a9f4);
      outline-offset: 2px;
    }
    .tools svg {
      width: 22px;
      height: 22px;
      fill: currentColor;
    }
    .badge {
      position: absolute;
      top: 14px;
      left: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      box-sizing: border-box;
      padding: 0 12px 0 10px;
      border-radius: 16px;
      font-size: 13px;
      font-weight: 500;
      pointer-events: none;
      animation: fade-in 0.3s ease;
    }
    .badge svg {
      width: 16px;
      height: 16px;
      fill: var(--primary-color, #03a9f4);
    }
    @container (max-width: 520px) {
      .pin {
        --size: var(--roomtwin-pin-size, 32px);
      }
      .face {
        font-size: 12px;
      }
    }
    @keyframes pin-in {
      from {
        opacity: 0;
        transform: translateY(8px) scale(0.3);
      }
    }
    @keyframes ring {
      from {
        opacity: 0.9;
      }
      to {
        opacity: 0;
        transform: scale(1.6);
      }
    }
    @keyframes float {
      50% {
        opacity: 0.6;
        transform: translateY(-5px);
      }
    }
    @keyframes shimmer {
      to {
        transform: translateX(100%);
      }
    }
    @keyframes fade-in {
      from {
        opacity: 0;
      }
    }
    @media (forced-colors: active) {
      .pin.active .bubble,
      .bar > div {
        forced-color-adjust: none;
        background: Highlight;
        color: HighlightText;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .face,
      .glyph,
      .tools,
      .badge,
      .bar > div::after {
        animation: none;
      }
      .pin.alert .face::after {
        animation: none;
        opacity: 0.9;
      }
      .canvas,
      .face,
      .hint,
      .bar > div,
      .tools button {
        transition: none;
      }
    }
  `;
}

if (!customElements.get("roomtwin-card")) {
  customElements.define("roomtwin-card", RoomTwinCard);
  const cards = ((window as unknown as { customCards?: unknown[] }).customCards ??= []);
  cards.push({
    type: "roomtwin-card",
    name: "RoomTwin",
    description: "A Gaussian splat of a real room with your lights and sensors pinned where they are.",
    documentationURL: "https://github.com/Booyaka101/roomtwin",
  });
  console.info(`%c ROOMTWIN %c ${VERSION} `, "background:#ffb300;color:#000;font-weight:700", "");
}
