import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { ICON, LIGHT_DEFAULTS, type CameraView, type LightBinding, type PinBinding, type RoomTwinConfig, type Vec3 } from "./config";
import { domainOf, type HomeAssistant } from "./hass";

export class CollinearError extends Error {}

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
  if (typeof value === "number") return String(round(value));
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

/** Card YAML for the dashboard's code editor, leaving out options that are at their default. */
export function toYaml(config: RoomTwinConfig): string {
  const { type, splat, up, floor, ceiling_cut, aspect_ratio, lod, lod_scale, camera, lights, pins, ...rest } = config;
  const ordered: Record<string, unknown> = {
    type,
    splat,
    up,
    floor: floor === 0 ? undefined : floor,
    ceiling_cut,
    aspect_ratio,
    lod: lod ? undefined : false,
    lod_scale: lod_scale === 1 ? undefined : lod_scale,
    camera,
    lights: lights.length ? lights : undefined,
    pins: pins.length ? pins : undefined,
    ...rest,
  };
  return yamlLines(ordered, "").join("\n") + "\n";
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

export const LIGHT_DOMAINS = new Set(["light", "switch"]);

type Selection = { kind: "light" | "pin"; index: number };

export interface HelperDetail {
  anchor: Vec3 | null;
  radius: number;
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
    _selected: { state: true },
    _pending: { state: true },
    _floorPoints: { state: true },
    _entity: { state: true },
    _message: { state: true },
    _copied: { state: true },
  };

  hass!: HomeAssistant;
  config!: RoomTwinConfig;
  /** The draft differs from the saved card config. */
  dirty = false;
  getView!: () => CameraView;
  /** Height of the room's top above the floor, from the splat itself. */
  getRoomHeight!: () => number;
  private _selected: Selection | null = null;
  private _pending: Vec3 | null = null;
  private _floorPoints: Vec3[] | null = null;
  private _entity = "";
  private _message = "";
  private _copied: "" | "ok" | "failed" = "";

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
    this._message = "";
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("_selected") || changed.has("_pending") || changed.has("config")) {
      this.dispatchEvent(new CustomEvent<HelperDetail>("helper-changed", { detail: this.helper() }));
    }
  }

  private helper(): HelperDetail {
    if (this._pending) return { anchor: this._pending, radius: 0 };
    const binding = this.selectedBinding();
    if (!binding) return { anchor: null, radius: 0 };
    return { anchor: binding.anchor, radius: "radius" in binding ? binding.radius : 0 };
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

  private commit(config: RoomTwinConfig): void {
    this.config = config;
    this._copied = "";
    this.dispatchEvent(new CustomEvent<RoomTwinConfig>("draft-changed", { detail: config }));
  }

  private add(kind: "light" | "pin"): void {
    if (!this._pending) return;
    const entity = this._entity.trim();
    const anchor = this._pending;
    if (kind === "light") {
      const { radius, softEdge } = roomRanges(this.getRoomHeight());
      const light = { entity, anchor, radius, soft_edge: softEdge, off_dim: LIGHT_DEFAULTS.off_dim };
      this.commit({ ...this.config, lights: [...this.config.lights, light] });
      this._selected = { kind, index: this.config.lights.length - 1 };
    } else {
      this.commit({ ...this.config, pins: [...this.config.pins, { entity, anchor }] });
      this._selected = { kind, index: this.config.pins.length - 1 };
    }
    this._pending = null;
    this._entity = "";
  }

  private removeSelected(): void {
    if (!this._selected) return;
    const { kind, index } = this._selected;
    this._selected = null;
    if (kind === "light") this.commit({ ...this.config, lights: this.config.lights.filter((_, i) => i !== index) });
    else this.commit({ ...this.config, pins: this.config.pins.filter((_, i) => i !== index) });
  }

  private async copy(): Promise<void> {
    this._copied = (await copyText(toYaml(this.config))) ? "ok" : "failed";
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent("editor-closed"));
  }

  private discard(): void {
    this.clearTask();
    this._copied = "";
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
          this.commit(this.withBinding("light", index, { [key]: Number((e.target as HTMLInputElement).value) }))}
      />
      <output>${binding[key]}</output>
    </label>`;
  }

  private textField(label: string, key: "name" | "icon", placeholder: string) {
    const { kind, index } = this._selected!;
    return html`<label class="slider"
      ><span>${label}</span
      ><input
        .value=${this.selectedBinding()?.[key] ?? ""}
        placeholder=${placeholder}
        @change=${(e: Event) => {
          const value = (e.target as HTMLInputElement).value.trim();
          if (key === "icon" && value && !ICON.test(value)) {
            this._message = `${value} is not an icon name. Icons look like mdi:lamp.`;
            return;
          }
          this._message = "";
          this.commit(this.withBinding(kind, index, { [key]: value || undefined }));
        }}
    /></label>`;
  }

  private renderTask() {
    if (this._floorPoints) {
      return html`<p>Tap ${3 - this._floorPoints.length} more point${this._floorPoints.length === 2 ? "" : "s"} on the floor, spread out.</p>
        <div class="row"><button @click=${() => (this._floorPoints = null)}>Cancel</button></div>`;
    }
    if (this._pending) {
      const entity = this._entity.trim();
      const valid = /^[a-z0-9_]+\.[a-z0-9_]+$/.test(entity);
      const known = valid && entity in this.hass.states;
      return html`<p>New point at [${this._pending.join(", ")}]. Which entity goes here?</p>
        <input
          class="entity"
          list="entities"
          placeholder="light.floor_lamp"
          .value=${this._entity}
          @input=${(e: Event) => (this._entity = (e.target as HTMLInputElement).value)}
        />
        <datalist id="entities">
          ${Object.keys(this.hass.states)
            .sort()
            .map((id) => html`<option value=${id}>${this.hass.states[id].attributes.friendly_name ?? ""}</option>`)}
        </datalist>
        ${valid && !known ? html`<p class="note">${entity} is not in Home Assistant right now. It will show as a grey pin.</p>` : nothing}
        <div class="row">
          <button ?disabled=${!valid || !LIGHT_DOMAINS.has(domainOf(entity))} @click=${() => this.add("light")}>Add as light</button>
          <button ?disabled=${!valid} @click=${() => this.add("pin")}>Add as pin</button>
          <button @click=${() => (this._pending = null)}>Cancel</button>
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
        ${this.textField("Icon", "icon", "mdi:lamp")}
        <div class="row">
          <button @click=${() => (this._selected = null)}>Done</button>
          <button class="danger" @click=${this.removeSelected}>Remove</button>
        </div>`;
    }
    return html`<p>Tap the room to place a light or a pin. Tap an existing pin to select it.</p>`;
  }

  protected render() {
    const cut = this.config.ceiling_cut;
    const { step, cutMax, suggestedCut } = roomRanges(this.getRoomHeight());
    const bindings = [
      ...this.config.lights.map((b, index) => ({ kind: "light" as const, index, entity: b.entity, name: b.name })),
      ...this.config.pins.map((b, index) => ({ kind: "pin" as const, index, entity: b.entity, name: b.name })),
    ];
    return html`
      <section class="task">
        ${this.renderTask()} ${this._message ? html`<p class="note" role="status">${this._message}</p>` : nothing}
      </section>
      ${bindings.length
        ? html`<section class="chips">
            ${bindings.map(
              (b) => html`<button
                class=${this._selected?.kind === b.kind && this._selected.index === b.index ? "chip selected" : "chip"}
                @click=${() => this.select(b.kind, b.index)}
              >
                ${b.kind === "light" ? "💡" : "📍"} ${b.name ?? this.hass.states[b.entity]?.attributes.friendly_name ?? b.entity}
              </button>`,
            )}
          </section>`
        : nothing}
      <section class="room">
        <label class="slider">
          <span><input type="checkbox" .checked=${cut !== undefined} @change=${(e: Event) =>
            this.commit({ ...this.config, ceiling_cut: (e.target as HTMLInputElement).checked ? suggestedCut : undefined })} /> Ceiling cut</span>
          <input
            type="range"
            min=${step * 10}
            max=${Math.max(cutMax, cut ?? 0)}
            step=${step}
            ?disabled=${cut === undefined}
            aria-label="Ceiling cut height"
            .value=${String(cut ?? suggestedCut)}
            @input=${(e: Event) => this.commit({ ...this.config, ceiling_cut: Number((e.target as HTMLInputElement).value) })}
          />
          <output>${cut === undefined ? "off" : `${cut} m`}</output>
        </label>
        <div class="row">
          <button @click=${() => (this.clearTask(), (this._floorPoints = []))}>
            Set floor (tap 3 points)
          </button>
          <button @click=${() => this.commit({ ...this.config, camera: this.getView() })}>Use this view as default</button>
        </div>
      </section>
      <section class="row footer">
        <button class="primary" @click=${this.copy}>Copy YAML</button>
        <button @click=${this.discard}>Discard changes</button>
        <button @click=${this.close}>Close</button>
      </section>
      ${this._copied === "ok"
        ? html`<p class="note" role="status">
            Copied. Open the card's code editor, replace everything with the clipboard and save.
          </p>`
        : this.dirty
          ? html`<p class="note">Changes live only in this browser tab until you copy the YAML into the card and save.</p>`
          : nothing}
      <details ?open=${this._copied === "failed"}>
        <summary>${this._copied === "failed" ? "Couldn't reach the clipboard. Select and copy this:" : "YAML"}</summary>
        <textarea readonly rows="10" .value=${toYaml(this.config)}></textarea>
      </details>
    `;
  }

  static styles = css`
    :host {
      display: block;
      padding: 8px 16px 16px;
      font-size: 14px;
      color: var(--primary-text-color);
    }
    section {
      margin: 8px 0;
    }
    p {
      margin: 4px 0;
    }
    .note {
      color: var(--secondary-text-color);
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
      padding: 0 12px;
      border-radius: 18px;
      border: 1px solid var(--divider-color, #ccc);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color);
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    button.primary,
    .chip.selected {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: var(--text-primary-color, #fff);
    }
    button.danger {
      color: var(--error-color, #db4437);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
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
    }
    input.entity,
    .slider input:not([type]) {
      font: inherit;
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--divider-color, #ccc);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color);
    }
    input.entity {
      width: 100%;
      box-sizing: border-box;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      font-family: var(--code-font-family, monospace);
      font-size: 12px;
    }
  `;
}

if (!customElements.get("roomtwin-editor")) customElements.define("roomtwin-editor", RoomTwinEditor);
