import * as THREE from "three";
import { SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType } from "@sparkjsdev/spark";
import type { LightBinding } from "./config";
import type { HassEntity } from "./hass";

export type Rgb = [number, number, number];

// HA also reports rgb_color for a white bulb in color_temp mode, but the capture already shows that warmth.
const COLOR_MODES = new Set(["hs", "xy", "rgb", "rgbw", "rgbww"]);
// How far a colour pulls the other channels down. At 1 a saturated bulb would black out the other channels.
const TINT = 0.75;

function validRgb(value: unknown): value is Rgb {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
    Math.max(...value) > 0
  );
}

/**
 * Multiplier applied to the splats around a light. Anything but "on" (off, unavailable,
 * a missing entity) dims to off_dim; "on" scales from off_dim up to 1 with brightness and,
 * in a colour mode, takes most of its hue from rgb_color normalised so the brightest channel is 1.
 */
export function lightColor(state: HassEntity | undefined, offDim: number): Rgb {
  if (!state || state.state !== "on") return [offDim, offDim, offDim];
  const raw = state.attributes.brightness;
  const brightness = typeof raw === "number" && Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 255) : 255;
  const f = offDim + (1 - offDim) * (brightness / 255);
  const rgb = colorOf(state);
  if (!rgb) return [f, f, f];
  const max = Math.max(...rgb);
  const tint = (c: number) => f * (1 - TINT * (1 - c / max));
  return [tint(rgb[0]), tint(rgb[1]), tint(rgb[2])];
}

/** The colour a light is set to, or undefined for a white bulb or one that doesn't report a colour. */
export function colorOf(state: HassEntity): Rgb | undefined {
  const rgb = state.attributes.rgb_color;
  const mode = state.attributes.color_mode;
  return validRgb(rgb) && !(typeof mode === "string" && !COLOR_MODES.has(mode)) ? rgb : undefined;
}

interface LightEdit {
  edit: SplatEdit;
  sdf: SplatEditSdf;
}

/**
 * One MULTIPLY SplatEdit with a single soft sphere per bound light. The edits are children of
 * `parent` (the SplatMesh), so anchors are in the capture's own coordinates.
 */
export class LightRig {
  private edits: LightEdit[] = [];
  private bindings: LightBinding[] = [];

  constructor(private readonly parent: THREE.Object3D) {}

  /** Creates, moves or removes edits to match `bindings`, reusing existing ones by index. */
  setBindings(bindings: LightBinding[]): void {
    this.bindings = bindings;
    while (this.edits.length > bindings.length) {
      const { edit } = this.edits.pop()!;
      this.parent.remove(edit);
    }
    while (this.edits.length < bindings.length) {
      const edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY });
      const sdf = new SplatEditSdf({ type: SplatEditSdfType.SPHERE });
      edit.add(sdf);
      this.parent.add(edit);
      this.edits.push({ edit, sdf });
    }
    bindings.forEach((binding, i) => {
      const { edit, sdf } = this.edits[i];
      edit.name = `roomtwin ${binding.entity}`;
      edit.softEdge = binding.soft_edge;
      sdf.radius = binding.radius;
      sdf.position.fromArray(binding.anchor);
    });
  }

  /** Recolours every light from `states`. Returns true if any colour changed. */
  applyStates(states: Record<string, HassEntity>): boolean {
    let changed = false;
    this.bindings.forEach((binding, i) => {
      const [r, g, b] = lightColor(states[binding.entity], binding.off_dim);
      const { color } = this.edits[i].sdf;
      if (color.r !== r || color.g !== g || color.b !== b) {
        color.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
        changed = true;
      }
    });
    return changed;
  }

  dispose(): void {
    this.setBindings([]);
  }
}
