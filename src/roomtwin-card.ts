import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import * as THREE from "three";
import { aspectRatio, bindingRefs, parseConfig, type BindingRef, type RoomTwinConfig } from "./config";
import { canSave, dashboardUrlPath, saveCard } from "./dashboard";
import { toCardConfig, toYaml, type HelperDetail, type RoomTwinEditor } from "./editor";
import type { HassEntity, HomeAssistant } from "./hass";
import { LightRig } from "./lights";
import { PressGesture, pinLabel, pinState, projectToScreen, spokenState, tapService } from "./pins";
import { RoomScene, SplatLoadError, webgl2Available } from "./scene";
import { VERSION } from "./version";

// Long enough to flip between dashboard views without re-downloading the splat.
const DISPOSE_AFTER_MS = 60_000;
// HA's card editor makes a new preview card each time it opens, and browsers cap live WebGL contexts at a handful.
const PREVIEW_DISPOSE_AFTER_MS = 3_000;
// The card editor calls setConfig on every keystroke in the splat path.
const PREVIEW_LOAD_DELAY_MS = 600;
// A browser that keeps dropping the 3D view gets the Try again button instead of a reload loop.
const AUTO_RELOAD_GAP_MS = 60_000;
const TAP_SLOP_PX = 6;
const TAP_MAX_MS = 500;

const MDI_PENCIL =
  "M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z";
const MDI_HOME = "M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z";
const MDI_HELP = "M11,18H13V16H11V18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,6A4,4 0 0,0 8,10H10A2,2 0 0,1 12,8A2,2 0 0,1 14,10C14,12 11,11.75 11,15H13C13,12.75 16,12.5 16,10A4,4 0 0,0 12,6Z";

const NO_WEBGL2 =
  "RoomTwin needs WebGL2, which this browser or device doesn't provide. Use a current Chrome, Edge, Firefox or Safari with hardware acceleration turned on.";

type Status = { kind: "loading"; progress: number } | { kind: "ready" } | { kind: "error"; message: string; retry: boolean };

export class RoomTwinCard extends LitElement {
  static properties = {
    preview: { attribute: false },
    _config: { state: true },
    _draft: { state: true },
    _editing: { state: true },
    _status: { state: true },
    _warning: { state: true },
    _hint: { state: true },
  };

  /** Set by HA in dashboard edit mode and in the card editor, where HA owns the config being edited. */
  preview = false;
  private _hass?: HomeAssistant;
  private _config?: RoomTwinConfig;
  // The config as the dashboard stores it, to find this card again when saving.
  private rawConfig?: Record<string, unknown>;
  private dirtyMemo?: { draft: RoomTwinConfig; config: RoomTwinConfig; dirty: boolean };
  private loadTimer?: ReturnType<typeof setTimeout>;
  // Home Assistant builds new cards after the dashboard is saved, so this one won't come back.
  private replaced = false;
  private _draft: RoomTwinConfig | null = null;
  private _editing = false;
  private _status: Status = { kind: "loading", progress: 0 };
  private _warning = "";
  private _hint = "";
  private hintTimer?: ReturnType<typeof setTimeout>;

  private scene?: RoomScene;
  private lights?: LightRig;
  private abort?: AbortController;
  private loadedKey = "";
  private onScreen = false;
  private disposeTimer?: ReturnType<typeof setTimeout>;
  private intersection?: IntersectionObserver;
  private resize?: ResizeObserver;
  private pinEls: HTMLElement[] = [];
  private pins: BindingRef[] = [];
  private pressed = -1;
  private pinPointer?: PointerEvent;
  private lastAutoReload = 0;
  private tapStart?: { x: number; y: number; t: number };
  private readonly tmp = new THREE.Vector3();
  private readonly press = new PressGesture(
    () => this.pinTap(this.pins[this.pressed]),
    () => this.pinHold(this.pins[this.pressed]),
  );

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
    this._draft = null;
    this._editing = false;
    this.scene?.showHelper(null);
    if (this.scene?.mesh && this.loadKey(this._config) === this.loadedKey) {
      // HA's card editor calls this on every keystroke; only jump the camera when the saved view changed.
      this.applyConfig(this._config, JSON.stringify(old?.camera) !== JSON.stringify(this._config.camera));
    }
  }

  set hass(hass: HomeAssistant) {
    const old = this._hass;
    this._hass = hass;
    const config = this.shown;
    if (!config) return;
    // The editor looks up any entity, not just the bound ones. A new locale changes how every pin reads.
    const changed =
      !old || this._editing || old.locale !== hass.locale || bindingRefs(config).some((p) => old.states[p.entity] !== hass.states[p.entity]);
    if (changed) {
      if (this.lights?.applyStates(hass.states)) this.scene?.requestRender();
      this.requestUpdate();
    }
  }

  get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  getCardSize(): number {
    return 7;
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
    this.onScreen = false;
    this.updateActive();
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
    this.scene?.setActive(this.isConnected && this.onScreen && document.visibilityState === "visible");
  };

  private onVisibility = (): void => {
    this.updateActive();
    if (document.visibilityState === "visible") this.requestUpdate();
  };

  // OrbitControls listens for Ctrl on the canvas's root node, this shadow root, to tell a held Ctrl from a trackpad
  // pinch. Focus is rarely inside the card, so without this every Ctrl+wheel notch zooms ten times too far.
  // Leaving the window (Ctrl+Tab) sends the keyup elsewhere, so the window's blur counts as letting go. Blurs of
  // elements inside the page pass through this capture listener too, and Ctrl is still held for those.
  private onControlKey = (e: Event): void => {
    if (e.type === "blur") {
      if (e.target === window) this.renderRoot.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    }
    else if ((e as KeyboardEvent).key === "Control") this.renderRoot.dispatchEvent(new KeyboardEvent(e.type, { key: "Control" }));
  };

  private teardown(): void {
    clearTimeout(this.loadTimer);
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
    const config = this.shown;
    // Waiting until the card is on screen keeps a dashboard of rooms from downloading all of them at once.
    const visible = this.onScreen && document.visibilityState === "visible";
    if (config && this.canvasHost && visible && this.loadedKey !== this.loadKey(config)) this.scheduleLoad(config);
    this.pins = config ? bindingRefs(config) : [];
    this.pinEls = [...this.renderRoot.querySelectorAll<HTMLElement>(".pin")];
    this.positionPins();
  }

  private scheduleLoad(config: RoomTwinConfig): void {
    if (!this.preview || (!this.scene && this._status.kind !== "error")) {
      void this.load(config);
      return;
    }
    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => {
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
      this.applyConfig(this.shown ?? config, true);
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

  private applyConfig(config: RoomTwinConfig, resetView: boolean): void {
    const scene = this.scene;
    if (!scene?.mesh || !this.lights) return;
    const view = resetView ? config.camera : scene.currentView();
    scene.setOrientation(config.up, config.floor);
    scene.setCeilingCut(config.ceiling_cut);
    scene.setLodScale(config.lod_scale);
    this.lights.setBindings(config.lights);
    this.lights.applyStates(this._hass?.states ?? {});
    if (resetView || view) scene.setView(view);
    scene.requestRender();
  }

  private positionPins = (): void => {
    const scene = this.scene;
    const host = this.canvasHost;
    if (!scene?.mesh || !host) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    scene.camera.updateMatrixWorld();
    this.pinEls.forEach((el, i) => {
      const pin = this.pins[i];
      if (!pin) return;
      const p = projectToScreen(scene.captureToWorld(pin.anchor, this.tmp), scene.camera, width, height);
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
      el.style.visibility = p.visible ? "" : "hidden";
    });
  };

  private fire(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
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
    this.pressed = Number(el.dataset.i);
    // Keeps the release on the pin when the pointer slips off it, which would otherwise read as a long-press.
    el.setPointerCapture(e.pointerId);
    this.pinPointer = e;
    this.press.down(e);
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
    this.applyConfig(this._draft, false);
  }

  private closeEditor(): void {
    this._editing = false;
    this.scene?.showHelper(null);
    this.applyConfig(this._config!, false);
  }

  private onDraft(e: CustomEvent<RoomTwinConfig>): void {
    this._draft = e.detail;
    this.applyConfig(e.detail, false);
  }

  private onDiscard(): void {
    this._draft = this._config!;
    this.scene?.showHelper(null);
    this.applyConfig(this._config!, false);
  }

  private saveDraft = async (): Promise<void> => {
    const draft = this._draft!;
    const card = toCardConfig(draft);
    // Set first: the new cards can arrive before the save call returns.
    this.replaced = true;
    try {
      await saveCard(this._hass!, dashboardUrlPath(location.pathname), this.rawConfig!, card);
    } catch (err) {
      this.replaced = false;
      throw err;
    }
    this.rawConfig = card;
    this._config = draft;
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
    this.scene?.showHelper(e.detail.anchor, e.detail.radius);
  }

  private renderPin(pin: BindingRef, i: number, hass: HomeAssistant) {
    const stateObj: HassEntity | undefined = hass.states[pin.entity];
    const state = pinState(stateObj);
    const label = pinLabel(hass, stateObj);
    const name = pin.name ?? stateObj?.attributes.friendly_name ?? pin.entity;
    const title = stateObj ? name : `${pin.entity} is not in Home Assistant`;
    const spoken = spokenState(hass, stateObj);
    const toggles = !pin.tap_action && tapService(stateObj)?.service === "toggle";
    return html`<div
      class="pin ${state} ${pin.kind}"
      data-i=${i}
      role="button"
      tabindex="0"
      aria-pressed=${toggles ? String(state === "active") : nothing}
      title=${title}
      aria-label=${spoken ? `${name}: ${spoken}` : name}
    >
      ${stateObj
        ? html`<ha-state-icon .hass=${hass} .stateObj=${stateObj} .icon=${pin.icon}></ha-state-icon>`
        : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${MDI_HELP}></path></svg>`}
      ${label ? html`<span class="label">${label}</span>` : nothing}
    </div>`;
  }

  private renderStatus() {
    const status = this._status;
    if (status.kind === "ready") return nothing;
    if (status.kind === "loading") {
      const text = status.progress < 1 ? `Loading room ${Math.round(status.progress * 100)}%` : "Preparing room";
      const percent = Math.round(status.progress * 100);
      return html`<div class="overlay">
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
        class="stage ${this._editing ? "editing" : ""}"
        style="aspect-ratio: ${aspectRatio(config.aspect_ratio)}"
        @wheel=${this.onStageWheel}
      >
        <div
          class="canvas"
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
              ${bindingRefs(config).map((pin, i) => this.renderPin(pin, i, hass))}
            </div>`
          : nothing}
        ${this.renderStatus()}
        <div class="hint" role="status">${this._hint}</div>
        ${ready
          ? html`<div class="tools">
              <button title="Reset view" aria-label="Reset view" @click=${() => this.scene?.setView(config.camera)}>
                <svg viewBox="0 0 24 24"><path d=${MDI_HOME}></path></svg>
              </button>
              ${hass?.user?.is_admin && !this._editing
                ? html`<button title="Edit pins and lights" aria-label="Edit pins and lights" @click=${this.openEditor}>
                    <svg viewBox="0 0 24 24"><path d=${MDI_PENCIL}></path></svg>
                  </button>`
                : nothing}
            </div>`
          : nothing}
      </div>
      ${this._warning ? html`<ha-alert alert-type="warning">${this._warning}</ha-alert>` : nothing}
      ${this._editing && this._draft && hass && ready
        ? html`<roomtwin-editor
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
      position: relative;
      width: 100%;
      background: #111;
    }
    .canvas {
      position: absolute;
      inset: 0;
    }
    /* OrbitControls sets touch-action none inline. Outside edit mode a vertical swipe scrolls the dashboard. */
    .canvas canvas {
      touch-action: pan-y !important;
    }
    .editing .canvas canvas {
      touch-action: none !important;
    }
    .hint {
      position: absolute;
      left: 50%;
      bottom: 12px;
      transform: translateX(-50%);
      padding: 6px 12px;
      border-radius: 16px;
      background: rgba(0, 0, 0, 0.7);
      color: #fff;
      font-size: 13px;
      white-space: nowrap;
      pointer-events: none;
    }
    .hint:empty {
      opacity: 0;
    }
    .pins {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
    }
    .pin {
      position: absolute;
      left: 0;
      top: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      box-sizing: border-box;
      min-width: 36px;
      height: 36px;
      padding: 0 6px;
      justify-content: center;
      border-radius: 18px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      pointer-events: auto;
      cursor: pointer;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      will-change: transform;
      --mdc-icon-size: 20px;
    }
    .pin.active {
      background: var(--state-light-active-color, #ffb300);
      color: #000;
    }
    .pin.alert {
      /* Darkened so white text passes WCAG AA on HA's default red. */
      background: color-mix(in srgb, var(--error-color, #db4437) 85%, black);
      color: #fff;
    }
    .pin.missing,
    .pin.unavailable {
      background: rgba(110, 110, 110, 0.7);
      color: #ddd;
    }
    .pin:focus-visible {
      outline: 2px solid var(--primary-color);
    }
    .pin svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 16px;
      color: #eee;
      text-align: center;
    }
    .overlay ha-alert {
      max-width: 520px;
      text-align: left;
    }
    .bar {
      width: min(240px, 60%);
      height: 4px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.2);
      overflow: hidden;
    }
    .bar > div {
      height: 100%;
      background: var(--primary-color, #03a9f4);
    }
    .tools {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      gap: 8px;
    }
    .tools button,
    .retry {
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      color: #fff;
      background: rgba(0, 0, 0, 0.5);
      cursor: pointer;
    }
    .tools button {
      width: 40px;
      height: 40px;
      border-radius: 50%;
    }
    .tools svg {
      width: 22px;
      height: 22px;
      fill: currentColor;
    }
    .retry {
      font: inherit;
      padding: 8px 16px;
      border-radius: 18px;
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
