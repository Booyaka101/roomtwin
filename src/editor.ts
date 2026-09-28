import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { live } from "lit/directives/live.js";
import { ENTITY_ID, ICON, LIGHT_DEFAULTS, bindingRefs, type BindingRef, type CameraView, type LightBinding, type PinBinding, type RoomTwinConfig, type Vec3 } from "./config";
import { SaveError } from "./dashboard";
import { domainOf, type HomeAssistant } from "./hass";

export class CollinearError extends Error {}

const MDI_LIGHTBULB =
  "M12,2A7,7 0 0,0 5,9C5,11.38 6.19,13.47 8,14.74V17A1,1 0 0,0 9,18H15A1,1 0 0,0 16,17V14.74C17.81,13.47 19,11.38 19,9A7,7 0 0,0 12,2M9,21A1,1 0 0,0 10,22H14A1,1 0 0,0 15,21V20H9V21Z";
const MDI_MAP_MARKER =
  "M12,11.5A2.5,2.5 0 0,1 9.5,9A2.5,2.5 0 0,1 12,6.5A2.5,2.5 0 0,1 14.5,9A2.5,2.5 0 0,1 12,11.5M12,2A7,7 0 0,0 5,9C5,14.25 12,22 12,22C12,22 19,14.25 19,9A7,7 0 0,0 12,2Z";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export function round(n: number, places = 4): number {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Up axis and floor height from three points tapped on the floor. The normal is flipped to
 * point towards `viewer` (the camera, which is above the floor), and `floor` is the plane's
 * offset along it, so `dot(up, p) - floor` is a point's height above the floor.
 */
export function floorFromPoints(points: [Vec3, Vec3, Vec3], viewer: Vec3): { up: Vec3; floor: number } {
  const [a, b, c] = points;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const normal = cross(ab, ac);
  // |ab x ac| is twice the triangle's area. Against the longest side squared it is small for any sliver,
  // whether the points are nearly in a line or two of them nearly coincide, and then the plane is mostly noise.
  const longest = Math.max(length(ab), length(ac), length(sub(c, b)));
  if (longest < 1e-4 || length(normal) / longest ** 2 < 0.05) {
    throw new CollinearError(
      "Those three points are in a line or on top of each other. Tap three spots spread out across the floor, like the corners of a rug.",
    );
  }
  let up = normal.map((n) => n / length(normal)) as Vec3;
  if (dot(up, sub(viewer, a)) < 0) up = up.map((n) => -n) as Vec3;
  const floor = (dot(up, a) + dot(up, b) + dot(up, c)) / 3;
  return { up: up.map((n) => round(n)) as Vec3, floor: round(floor) };
}

export interface RoomRanges {
  step: number;
  radiusMax: number;
  softEdgeMax: number;
  cutMax: number;
  suggestedCut: number;
  /** Starting size of a new light: 1 m and 0.5 m in a 2.5 m room. */
  radius: number;
  softEdge: number;
}

/**
 * Slider ranges for lengths, from the room's measured height. Captures without real-world scale
 * can be any size, so fixed ranges in metres would not fit them.
 */
export function roomRanges(roomHeight: number): RoomRanges {
  const height = roomHeight > 0 ? roomHeight : 2.5;
  const places = Math.max(0, 2 - Math.floor(Math.log10(height)));
  const coarse = 10 ** (places - 1);
  const roundUp = (n: number) => round(Math.ceil(n * coarse - 1e-9) / coarse, places);
  return {
    step: 1 / 10 ** places,
    radiusMax: roundUp(height * 2),
    softEdgeMax: roundUp(height),
    cutMax: roundUp(height * 1.2),
    suggestedCut: round(height * 0.9, places),
    radius: round(height * 0.4, places - 1),
    softEdge: round(height * 0.2, places - 1),
  };
}

const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;

function yamlString(s: string): string {
  const plain = /^[A-Za-z_/][\w/.:-]*$/.test(s) && !s.endsWith(":") && !RESERVED.test(s);
  return plain ? s : JSON.stringify(s);
}

function yamlScalar(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return yamlString(value);
  if (typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  throw new Error(`Cannot write ${typeof value} as YAML`);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

function definedEntries(value: object): [string, unknown][] {
  return Object.entries(value).filter(([, v]) => v !== undefined);
}

/** Values written on the same line as their key or list dash. */
function isInline(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isScalar);
  return isScalar(value) || definedEntries(value as object).length === 0;
}

function yamlLines(value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    if (value.every(isScalar)) return [`[${value.map(yamlScalar).join(", ")}]`];
    return value.flatMap((item) => {
      const [first, ...rest] = yamlLines(item, indent + "  ");
      return [`${indent}- ${first.trimStart()}`, ...rest];
    });
  }
  if (typeof value === "object" && value !== null) {
    const entries = definedEntries(value);
    if (entries.length === 0) return [`${indent}{}`];
    return entries.flatMap(([key, v]) => {
      if (isInline(v)) return [`${indent}${yamlString(key)}: ${yamlLines(v, "")[0]}`];
      return [`${indent}${yamlString(key)}:`, ...yamlLines(v, indent + "  ")];
    });
  }
  return [yamlScalar(value)];
}

/** The card config as the dashboard should store it, leaving out options that are at their default. */
export function toCardConfig(config: RoomTwinConfig): Record<string, unknown> {
  const { type, splat, up, floor, ceiling_cut, aspect_ratio, lod, lod_scale, camera, lights, pins, ...rest } = config;
  // Only the card's own numbers pick up float noise from sliders and taps. Actions and other cards' options stay exact.
  const point = (v: Vec3) => v.map((n) => round(n));
  const ordered = {
    type,
    splat,
    up: point(up),
    floor: floor === 0 ? undefined : round(floor),
    ceiling_cut: ceiling_cut === undefined ? undefined : round(ceiling_cut),
    aspect_ratio,
    lod: lod ? undefined : false,
    lod_scale: lod_scale === 1 ? undefined : round(lod_scale),
    camera: camera && { position: point(camera.position), target: point(camera.target) },
    lights: lights.length
      ? lights.map((b) => ({ ...b, anchor: point(b.anchor), radius: round(b.radius), soft_edge: round(b.soft_edge), off_dim: round(b.off_dim) }))
      : undefined,
    pins: pins.length ? pins.map((b) => ({ ...b, anchor: point(b.anchor) })) : undefined,
    ...rest,
  };
  // The round trip drops options left undefined, down to a cleared label on one pin.
  return JSON.parse(JSON.stringify(ordered));
}

/** Card YAML for the dashboard's code editor. */
export function toYaml(config: RoomTwinConfig): string {
  return yamlLines(toCardConfig(config), "").join("\n") + "\n";
}

/** Copies text, falling back to execCommand because HA over plain http is not a secure context. */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied; try the old way.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  // iOS Safari ignores select() on its own.
  area.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

// Configs are replaced, never changed in place, so each one's YAML only needs working out once.
const yamlCache = new WeakMap<RoomTwinConfig, string>();
function yamlOf(config: RoomTwinConfig): string {
  let yaml = yamlCache.get(config);
  if (yaml === undefined) yamlCache.set(config, (yaml = toYaml(config)));
  return yaml;
}

export const LIGHT_DOMAINS = new Set(["light", "switch"]);

export type Selected = Pick<BindingRef, "kind" | "index">;

export interface HelperDetail {
  anchor: Vec3 | null;
  radius: number;
  selected: Selected | null;
}

/**
 * Edit panel under the room. It owns the selection and tap mode; the card forwards taps on the
 * splat to `handlePick` and applies every `draft-changed` config to the live scene.
 */
export class RoomTwinEditor extends LitElement {
  static properties = {
    hass: { attribute: false },
    config: { attribute: false },
    dirty: { attribute: false },
    getView: { attribute: false },
    getRoomHeight: { attribute: false },
    save: { attribute: false },
    _selected: { state: true },
    _pending: { state: true },
    _floorPoints: { state: true },
    _entity: { state: true },
    _message: { state: true },
    _copied: { state: true },
    _saving: { state: true },
    _saveError: { state: true },
    _history: { state: true },
    _typing: { state: true },
  };

  hass!: HomeAssistant;
  config!: RoomTwinConfig;
  /** The draft differs from the saved card config. */
  dirty = false;
  getView!: () => CameraView;
  /** Height of the room's top above the floor, from the splat itself. */
  getRoomHeight!: () => number;
  private _selected: Selected | null = null;
  private _pending: Vec3 | null = null;
  private _floorPoints: Vec3[] | null = null;
  private _entity = "";
  private _message = "";
  private _copied: "" | "ok" | "failed" = "";
  /** Writes the draft into the dashboard. Missing where the card can't save itself, like in the demo or a preview. */
  save?: () => Promise<void>;
  private _saving = false;
  private _saveError = "";
  private _history: RoomTwinConfig[] = [];
  /** Text as typed, so a live update can't strip a trailing space or an icon name that isn't finished. */
  private _typing: { for: Selected; key: "name" | "icon"; value: string } | null = null;
  // A slider drag is one step to undo, not one per pixel.
  private dragging = "";
  // Sorted when the entity picker opens, not on every state update while it's open.
  private ids: string[] = [];
  // The button that was pressed goes away with its task, so focus moves back into the task.
  private refocus = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent): void => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.composedPath()[0] as HTMLElement).tagName ?? "");
    if (e.key === "Escape" && (this._selected || this._pending || this._floorPoints)) {
      e.preventDefault();
      e.stopPropagation();
      this.endTask();
    } else if (typing) return;
    else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      this.undo();
    } else if ((e.key === "Delete" || e.key === "Backspace") && this._selected) {
      e.preventDefault();
      this.removeSelected();
    }
  };

  /** A tap on the splat landed on `point` (capture coordinates), or on nothing solid when null. */
  handlePick(point: Vec3 | null): void {
    this._copied = "";
    if (!point) {
      this._message = "Nothing solid under that spot. Tap on a surface in the room.";
      return;
    }
    this._message = "";
    if (this._floorPoints) {
      const points = [...this._floorPoints, point];
      if (points.length < 3) {
        this._floorPoints = points;
        return;
      }
      this._floorPoints = null;
      try {
        const { up, floor } = floorFromPoints(points as [Vec3, Vec3, Vec3], this.getView().position);
        this.commit({ ...this.config, up, floor });
        this._message = "Floor set. The room is now upright with the floor at height 0.";
      } catch (err) {
        if (!(err instanceof CollinearError)) throw err;
        this._message = err.message;
      }
      return;
    }
    if (this._selected) {
      const { kind, index } = this._selected;
      this.commit(this.withBinding(kind, index, { anchor: point }));
      return;
    }
    this._pending = point;
    this.ids = Object.keys(this.hass.states).sort();
  }

  /** Selects the binding for a pin tapped on the stage. */
  select(kind: "light" | "pin", index: number): void {
    this.clearTask();
    this._selected = { kind, index };
  }

  private clearTask(): void {
    this._selected = null;
    this._pending = null;
    this._floorPoints = null;
    this._entity = "";
    this._message = "";
    this._typing = null;
    this.dragging = "";
  }

  /** Clears the task from one of its own buttons or a key, keeping the keyboard in the panel. */
  private endTask(): void {
    this.clearTask();
    this.refocus = true;
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("_pending") && this._pending) this.renderRoot.querySelector<HTMLInputElement>("input.entity")?.focus();
    else if (this.refocus) {
      const task = this.renderRoot.querySelector<HTMLElement>(".task");
      (task?.querySelector<HTMLElement>("input") ?? task)?.focus();
    }
    this.refocus = false;
    if (changed.has("_selected") || changed.has("_pending") || changed.has("config")) {
      this.dispatchEvent(new CustomEvent<HelperDetail>("helper-changed", { detail: this.helper() }));
    }
  }

  private helper(): HelperDetail {
    if (this._pending) return { anchor: this._pending, radius: 0, selected: null };
    const binding = this.selectedBinding();
    if (!binding) return { anchor: null, radius: 0, selected: null };
    return { anchor: binding.anchor, radius: "radius" in binding ? binding.radius : 0, selected: this._selected };
  }

  private selectedBinding(): LightBinding | PinBinding | undefined {
    if (!this._selected) return undefined;
    const { kind, index } = this._selected;
    return kind === "light" ? this.config.lights[index] : this.config.pins[index];
  }

  private withBinding(kind: "light" | "pin", index: number, patch: Partial<LightBinding & PinBinding>): RoomTwinConfig {
    if (kind === "light") {
      return { ...this.config, lights: this.config.lights.map((b, i) => (i === index ? { ...b, ...patch } : b)) };
    }
    return { ...this.config, pins: this.config.pins.map((b, i) => (i === index ? { ...b, ...patch } : b)) };
  }

  private commit(config: RoomTwinConfig, drag = ""): void {
    if (!drag || drag !== this.dragging) this._history = [...this.steps(), this.config];
    this.dragging = drag;
    this.show(config);
  }

  /** The undo history, minus a last step that changed nothing, like a slider let go where it started. */
  private steps(): RoomTwinConfig[] {
    const last = this._history[this._history.length - 1];
    return last && yamlOf(last) === yamlOf(this.config) ? this._history.slice(0, -1) : this._history;
  }

  private undo(): void {
    const steps = this.steps();
    const previous = steps[steps.length - 1];
    if (!previous) return;
    const selected = this.selectedBinding()?.entity;
    this._history = steps.slice(0, -1);
    this.dragging = "";
    this._typing = null;
    this.show(previous);
    // Undoing a removal shifts the indexes, so keep the selection only if it still points at the same entity.
    if (this.selectedBinding()?.entity !== selected) this._selected = null;
  }

  private endDrag(): void {
    this.dragging = "";
  }

  private show(config: RoomTwinConfig): void {
    this.config = config;
    this._copied = "";
    this._saveError = "";
    this.dispatchEvent(new CustomEvent<RoomTwinConfig>("draft-changed", { detail: config }));
  }

  private add(kind: "light" | "pin"): void {
    if (!this._pending) return;
    const entity = this._entity.trim();
    const anchor = this._pending;
    if (kind === "light") {
      const { radius, softEdge } = roomRanges(this.getRoomHeight());
      // Rooms captured at a tiny scale would otherwise start below the smallest radius the card accepts.
      const light = { entity, anchor, radius: Math.max(radius, 0.01), soft_edge: softEdge, off_dim: LIGHT_DEFAULTS.off_dim };
      this.commit({ ...this.config, lights: [...this.config.lights, light] });
      this._selected = { kind, index: this.config.lights.length - 1 };
    } else {
      this.commit({ ...this.config, pins: [...this.config.pins, { entity, anchor }] });
      this._selected = { kind, index: this.config.pins.length - 1 };
    }
    this._pending = null;
    this._entity = "";
    this._message = "";
    this.refocus = true;
  }

  private removeSelected(): void {
    if (!this._selected) return;
    const { kind, index } = this._selected;
    this.endTask();
    if (kind === "light") this.commit({ ...this.config, lights: this.config.lights.filter((_, i) => i !== index) });
    else this.commit({ ...this.config, pins: this.config.pins.filter((_, i) => i !== index) });
  }

  private async copy(): Promise<void> {
    this._saveError = "";
    this._copied = (await copyText(yamlOf(this.config))) ? "ok" : "failed";
  }

  private async onSave(): Promise<void> {
    this._saving = true;
    this._copied = "";
    this._saveError = "";
    try {
      await this.save!();
    } catch (err) {
      this._saveError = err instanceof SaveError ? err.message : `Couldn't save: ${(err as Error)?.message ?? err}.`;
    } finally {
      this._saving = false;
    }
  }

  private close(): void {
    this.clearTask();
    this.dispatchEvent(new CustomEvent("editor-closed"));
  }

  private discard(): void {
    this.clearTask();
    this._copied = "";
    this._saveError = "";
    this._history = [];
    this.dispatchEvent(new CustomEvent("draft-discarded"));
  }

  private name(entity: string): string {
    const name = this.hass.states[entity]?.attributes.friendly_name;
    return name ? `${name} (${entity})` : entity;
  }

  private slider(label: string, key: "radius" | "soft_edge" | "off_dim", min: number, max: number, step: number) {
    const binding = this.selectedBinding() as LightBinding;
    const index = this._selected!.index;
    return html`<label class="slider">
      <span>${label}</span>
      <input
        type="range"
        min=${min}
        max=${Math.max(max, binding[key])}
        step=${step}
        .value=${String(binding[key])}
        @input=${(e: Event) =>
          this.commit(this.withBinding("light", index, { [key]: Number((e.target as HTMLInputElement).value) }), `${key}:${index}`)}
        @change=${this.endDrag}
      />
      <output>${binding[key]}</output>
    </label>`;
  }

  private textField(label: string, key: "name" | "icon", placeholder: string) {
    const selected = this._selected!;
    const typed = this._typing?.for === selected && this._typing.key === key ? this._typing.value : undefined;
    return html`<label class="slider"
      ><span>${label}</span
      ><input
        .value=${live(typed ?? this.selectedBinding()?.[key] ?? "")}
        placeholder=${placeholder}
        autocapitalize=${key === "icon" ? "off" : nothing}
        autocorrect=${key === "icon" ? "off" : nothing}
        spellcheck=${key === "icon" ? "false" : nothing}
        @input=${(e: Event) => {
          const typed = (e.target as HTMLInputElement).value;
          const value = typed.trim();
          this._typing = { for: selected, key, value: typed };
          if (key === "icon" && value && !ICON.test(value)) return;
          this._message = "";
          this.commit(this.withBinding(selected.kind, selected.index, { [key]: value || undefined }), `${key}:${selected.kind}:${selected.index}`);
        }}
        @change=${(e: Event) => {
          const value = (e.target as HTMLInputElement).value.trim();
          this.endDrag();
          if (key === "icon" && value && !ICON.test(value)) {
            this._message = `${value} is not an icon name. Icons look like mdi:lamp.`;
            return;
          }
          this._typing = null;
        }}
    /></label>`;
  }

  private renderTask() {
    if (this._floorPoints) {
      return html`<p>Tap ${3 - this._floorPoints.length} more point${this._floorPoints.length === 2 ? "" : "s"} on the floor, spread out.</p>
        <div class="row"><button @click=${this.endTask}>Cancel</button></div>`;
    }
    if (this._pending) {
      const entity = this._entity.trim();
      const valid = ENTITY_ID.test(entity);
      const known = valid && entity in this.hass.states;
      return html`<p>New point at [${this._pending.join(", ")}]. Which entity goes here?</p>
        <input
          class="entity"
          list="entities"
          aria-label="Entity id"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="light.floor_lamp"
          .value=${this._entity}
          @input=${(e: Event) => (this._entity = (e.target as HTMLInputElement).value)}
        />
        <datalist id="entities">
          ${this.ids.map((id) => html`<option value=${id}>${this.hass.states[id]?.attributes.friendly_name ?? ""}</option>`)}
        </datalist>
        ${entity && !valid
          ? html`<p class="note">Entity ids look like light.floor_lamp: a domain, a dot, then lowercase letters, digits and underscores.</p>`
          : valid && !known
            ? html`<p class="note">${entity} is not in Home Assistant right now. It will show as a grey pin.</p>`
            : nothing}
        <div class="row">
          <button ?disabled=${!valid || !LIGHT_DOMAINS.has(domainOf(entity))} @click=${() => this.add("light")}>Add as light</button>
          <button ?disabled=${!valid} @click=${() => this.add("pin")}>Add as pin</button>
          <button @click=${this.endTask}>Cancel</button>
        </div>`;
    }
    const binding = this.selectedBinding();
    if (binding && this._selected) {
      const ranges = roomRanges(this.getRoomHeight());
      return html`<p><strong>${this.name(binding.entity)}</strong>. Tap the room to move it.</p>
        ${this._selected.kind === "light"
          ? html`${this.slider("Radius (m)", "radius", Math.max(0.01, ranges.step * 10), ranges.radiusMax, ranges.step)}
            ${this.slider("Soft edge (m)", "soft_edge", 0, ranges.softEdgeMax, ranges.step)}
            ${this.slider("Brightness when off", "off_dim", 0, 1, 0.01)}`
          : nothing}
        ${this.textField("Label", "name", this.hass.states[binding.entity]?.attributes.friendly_name ?? "")}
        ${this.textField("Icon", "icon", String(this.hass.states[binding.entity]?.attributes.icon ?? "The entity's icon"))}
        <div class="row">
          <button @click=${this.endTask}>Done</button>
          <button class="danger" @click=${this.removeSelected}>Remove</button>
        </div>`;
    }
    return html`<p>Tap the room to place a light or a pin. Tap an existing pin to select it.</p>`;
  }

  private footerNote() {
    if (this._saveError) {
      return html`<p class="note error" role="alert">${this._saveError} Copy the YAML into the card's code editor instead.</p>`;
    }
    if (this._copied === "ok") {
      return html`<p class="note" role="status">Copied. Paste it over this card's config, in the card's code editor or the dashboard's YAML file, and save.</p>`;
    }
    if (!this.dirty) return nothing;
    return html`<p class="note">
      ${this.save
        ? "Changes live only in this browser tab until you save."
        : "Changes live only in this browser tab until you copy the YAML into the card and save."}
    </p>`;
  }

  protected render() {
    const cut = this.config.ceiling_cut;
    const { step, cutMax, suggestedCut } = roomRanges(this.getRoomHeight());
    const bindings = bindingRefs(this.config);
    return html`
      <section class="task" tabindex="-1">
        ${this.renderTask()}
        <p class="note" role="status">${this._message}</p>
      </section>
      ${bindings.length
        ? html`<h3>In this room</h3>
          <section class="chips">
            ${bindings.map(
              (b) => html`<button
                class=${this._selected?.kind === b.kind && this._selected.index === b.index ? "chip selected" : "chip"}
                aria-pressed=${String(this._selected?.kind === b.kind && this._selected.index === b.index)}
                @click=${() => this.select(b.kind, b.index)}
              >
                <svg class=${b.kind} viewBox="0 0 24 24" aria-hidden="true"><path d=${b.kind === "light" ? MDI_LIGHTBULB : MDI_MAP_MARKER}></path></svg>
                ${b.name ?? this.hass.states[b.entity]?.attributes.friendly_name ?? b.entity}
              </button>`,
            )}
          </section>`
        : nothing}
      <h3>Room</h3>
      <section class="room">
        <div class="slider">
          <label><input type="checkbox" .checked=${cut !== undefined} @change=${(e: Event) =>
            this.commit({ ...this.config, ceiling_cut: (e.target as HTMLInputElement).checked ? suggestedCut : undefined })} /> Ceiling cut</label>
          <input
            type="range"
            min=${step * 10}
            max=${Math.max(cutMax, cut ?? 0)}
            step=${step}
            ?disabled=${cut === undefined}
            aria-label="Ceiling cut height"
            .value=${String(cut ?? suggestedCut)}
            @input=${(e: Event) => this.commit({ ...this.config, ceiling_cut: Number((e.target as HTMLInputElement).value) }, "ceiling_cut")}
            @change=${this.endDrag}
          />
          <output>${cut === undefined ? "off" : `${cut} m`}</output>
        </div>
        <div class="row">
          <button @click=${() => (this.clearTask(), (this._floorPoints = []))}>
            Set floor (tap 3 points)
          </button>
          <button @click=${() => this.commit({ ...this.config, camera: this.getView() })}>Use this view as default</button>
        </div>
      </section>
      <section class="row footer">
        ${this.save
          ? html`<button class="primary" ?disabled=${this._saving || !this.dirty} @click=${this.onSave}>
              ${this._saving ? "Saving…" : "Save"}
            </button>`
          : nothing}
        <button class=${this.save ? "" : "primary"} @click=${this.copy}>Copy YAML</button>
        <button ?disabled=${!this.steps().length} @click=${this.undo}>Undo</button>
        <button @click=${this.discard}>Discard changes</button>
        <button @click=${this.close}>Close</button>
      </section>
      ${this.footerNote()}
      <details ?open=${this._copied === "failed"}>
        <summary>${this._copied === "failed" ? "Couldn't reach the clipboard. Select and copy this:" : "YAML"}</summary>
        <textarea readonly rows="10" .value=${yamlOf(this.config)}></textarea>
      </details>
    `;
  }

  static styles = css`
    :host {
      display: block;
      padding: 12px 16px 16px;
      font-size: 14px;
      color: var(--primary-text-color);
      --accent: var(--primary-color, #03a9f4);
    }
    section {
      margin: 8px 0;
    }
    p {
      margin: 4px 0;
    }
    h3 {
      margin: 16px 0 6px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--secondary-text-color);
    }
    .task {
      margin-top: 0;
      padding: 10px 14px;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
      background: color-mix(in srgb, var(--accent) 8%, transparent);
    }
    :host([hidden]) {
      display: none;
    }
    .task:focus {
      outline: none;
    }
    .note {
      color: var(--secondary-text-color);
    }
    .note:empty {
      margin: 0;
    }
    .note.error {
      color: var(--error-color, #db4437);
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    button {
      font: inherit;
      min-height: 36px;
      padding: 0 14px;
      border-radius: 18px;
      border: 1px solid var(--divider-color, #ccc);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color);
      cursor: pointer;
      transition:
        background-color 0.15s,
        border-color 0.15s;
    }
    button:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--accent) 50%, transparent);
      background: color-mix(in srgb, var(--accent) 10%, var(--card-background-color, #fff));
    }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    button.primary,
    .chip.selected,
    button.primary:hover:not(:disabled),
    .chip.selected:hover {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--text-primary-color, #fff);
    }
    button.danger {
      color: var(--error-color, #db4437);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 0;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px 0 8px;
    }
    .chip svg {
      width: 18px;
      height: 18px;
      flex: none;
      fill: var(--accent);
    }
    .chip svg.light {
      fill: var(--state-light-active-color, #ffc107);
    }
    .chip.selected svg {
      fill: currentColor;
    }
    .slider {
      display: grid;
      grid-template-columns: 11em 1fr 4em;
      align-items: center;
      gap: 8px;
      min-height: 36px;
    }
    .slider output {
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: var(--secondary-text-color);
    }
    input[type="range"],
    input[type="checkbox"] {
      accent-color: var(--accent);
    }
    input.entity,
    .slider input:not([type]) {
      font: inherit;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid var(--divider-color, #ccc);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color);
    }
    input.entity:focus,
    .slider input:not([type]):focus {
      outline: none;
      border-color: var(--accent);
    }
    input.entity {
      width: 100%;
      box-sizing: border-box;
    }
    .footer {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--divider-color, #ccc);
    }
    details {
      margin-top: 8px;
    }
    summary {
      cursor: pointer;
      color: var(--secondary-text-color);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      margin-top: 6px;
      padding: 8px;
      border-radius: 8px;
      border: 1px solid var(--divider-color, #ccc);
      background: var(--secondary-background-color, transparent);
      color: var(--primary-text-color);
      font-family: var(--code-font-family, monospace);
      font-size: 12px;
    }
  `;
}

if (!customElements.get("roomtwin-editor")) customElements.define("roomtwin-editor", RoomTwinEditor);
