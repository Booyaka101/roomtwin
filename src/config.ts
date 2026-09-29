export type Vec3 = [number, number, number];

/** A Home Assistant card action like { action: "navigate", navigation_path: "/lovelace/1" }, handled by HA itself. */
export type ActionConfig = Record<string, unknown> & { action: string };

export interface PinBinding {
  entity: string;
  anchor: Vec3;
  name?: string;
  icon?: string;
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
}

export interface LightBinding extends PinBinding {
  radius: number;
  soft_edge: number;
  off_dim: number;
}

export interface CameraView {
  position: Vec3;
  target: Vec3;
}

export interface RoomTwinConfig {
  type: string;
  splat: string;
  up: Vec3;
  floor: number;
  ceiling_cut?: number;
  aspect_ratio?: string | number;
  lod: boolean;
  lod_scale: number;
  camera?: CameraView;
  lights: LightBinding[];
  pins: PinBinding[];
  view_layout?: unknown;
  grid_options?: unknown;
  layout_options?: unknown;
  visibility?: unknown;
  card_mod?: unknown;
  disabled?: unknown;
}

// Added by the dashboard editor on any card, or by card-mod; kept as-is so emitted YAML doesn't drop them.
const PASSTHROUGH = ["view_layout", "grid_options", "layout_options", "visibility", "card_mod", "disabled"] as const;

// Scaniverse .spz and COLMAP-based .ply captures (Brush, gsplat, Postshot) all load into Spark with Y pointing down.
export const DEFAULT_UP: Vec3 = [0, -1, 0];

export const LIGHT_DEFAULTS = { radius: 1.0, soft_edge: 0.5, off_dim: 0.45 };

export const SPLAT_EXTENSIONS = ["spz", "ply", "splat", "ksplat", "sog", "rad"];

export const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
export const ICON = /^[\w-]+:[\w-]+$/;

const TOP_KEYS = [
  "type", "splat", "up", "floor", "ceiling_cut", "aspect_ratio", "lod", "lod_scale", "camera", "lights", "pins",
  ...PASSTHROUGH,
];
const PIN_KEYS = ["entity", "anchor", "name", "icon", "tap_action", "hold_action", "double_tap_action"];
const LIGHT_KEYS = [...PIN_KEYS, "radius", "soft_edge", "off_dim"];

export interface BindingRef extends PinBinding {
  kind: "light" | "pin";
  index: number;
}

/** Lights then pins, the order the card draws them and the editor lists them in. */
export function bindingRefs(config: RoomTwinConfig): BindingRef[] {
  const ref =
    (kind: "light" | "pin") =>
    ({ entity, anchor, name, icon, tap_action, hold_action, double_tap_action }: PinBinding, index: number): BindingRef => ({
      kind, index, entity, anchor, name, icon, tap_action, hold_action, double_tap_action,
    });
  return [...config.lights.map(ref("light")), ...config.pins.map(ref("pin"))];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Lower-cased extension of a URL's path, ignoring any query string or fragment. */
export function splatExtension(url: string): string {
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf(".");
  return dot < 0 || dot < path.lastIndexOf("/") ? "" : path.slice(dot + 1).toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}

// An option left empty in YAML ("floor:") arrives as null.
function unset(value: unknown): value is undefined | null {
  return value === undefined || value === null;
}

/** Edits between two strings, counting a swap of neighbouring letters as one. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function checkKeys(value: Record<string, unknown>, known: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !known.includes(key));
  if (unknown.length === 0) return;
  const typo = unknown[0].toLowerCase();
  const distances = known.map((key) => editDistance(typo, key));
  const best = Math.min(...distances);
  const hint = unknown.length === 1 && best <= Math.min(2, typo.length / 3) ? `. Did you mean "${path}${known[distances.indexOf(best)]}"?` : "";
  throw new ConfigError(`Unknown option ${unknown.map((k) => `"${path}${k}"`).join(", ")}${hint}`);
}

function vec3(value: unknown, path: string): Vec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new ConfigError(`${path} must be a list of three numbers like [0, 1.2, -0.5], got ${describe(value)}`);
  }
  return [value[0], value[1], value[2]];
}

function number(
  value: unknown,
  path: string,
  { min, max, fallback }: { min?: number; max?: number; fallback?: number },
): number {
  if (unset(value) && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${path} must be a number, got ${describe(value)}`);
  }
  if (min !== undefined && value < min) throw new ConfigError(`${path} must be at least ${min}, got ${value}`);
  if (max !== undefined && value > max) throw new ConfigError(`${path} must be at most ${max}, got ${value}`);
  return value;
}

function entityId(value: unknown, path: string): string {
  if (typeof value !== "string" || !ENTITY_ID.test(value)) {
    throw new ConfigError(`${path} must be an entity id like light.floor_lamp, got ${describe(value)}`);
  }
  return value;
}

function list(value: unknown, path: string): unknown[] {
  if (unset(value)) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be a list, got ${describe(value)}`);
  return value;
}

/** Width over height for a validated aspect_ratio value; 16:9 when unset. */
export function aspectRatio(value: unknown): number {
  if (unset(value)) return 16 / 9;
  const match = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*(?:[:/x]\s*(\d+(?:\.\d+)?)\s*)?$/.exec(value) : null;
  const ratio = match ? Number(match[1]) / Number(match[2] ?? 1) : typeof value === "number" ? value : NaN;
  if (ratio >= 0.1 && ratio <= 10) return ratio;
  if (typeof value === "number" && Number.isInteger(value) && value > 60) {
    // YAML 1.1, which YAML-mode dashboards use, reads an unquoted 16:9 as the base-60 number 969.
    const guess = `${Math.floor(value / 60)}:${value % 60}`;
    throw new ConfigError(`aspect_ratio ${value} is how YAML reads an unquoted ${guess}. Put it in quotes: "${guess}"`);
  }
  throw new ConfigError(`aspect_ratio must look like "16:9" or be a number from 0.1 to 10, got ${describe(value)}`);
}

/** The name, icon and action overrides both kinds of binding share. */
function overrides(value: Record<string, unknown>, path: string): Omit<PinBinding, "entity" | "anchor"> {
  const result: Omit<PinBinding, "entity" | "anchor"> = {};
  if (!unset(value.name) && value.name !== "") {
    // An unquoted number in YAML, like a room number, is still meant as text.
    if (typeof value.name !== "string" && typeof value.name !== "number") {
      throw new ConfigError(`${path}.name must be text, got ${describe(value.name)}`);
    }
    result.name = String(value.name);
  }
  if (!unset(value.icon) && value.icon !== "") {
    if (typeof value.icon !== "string" || !ICON.test(value.icon)) {
      throw new ConfigError(`${path}.icon must be an icon like mdi:lamp, got ${describe(value.icon)}`);
    }
    result.icon = value.icon;
  }
  for (const key of ["tap_action", "hold_action", "double_tap_action"] as const) {
    const action = value[key];
    if (unset(action)) continue;
    if (!isObject(action) || typeof action.action !== "string") {
      throw new ConfigError(`${path}.${key} must be a card action like { action: more-info }, got ${describe(action)}`);
    }
    result[key] = action as ActionConfig;
  }
  return result;
}

function binding(value: unknown, path: string, keys: readonly string[]) {
  if (!isObject(value)) throw new ConfigError(`${path} must be a mapping with entity and anchor, got ${describe(value)}`);
  checkKeys(value, keys, `${path}.`);
  return { raw: value, entity: entityId(value.entity, `${path}.entity`), anchor: vec3(value.anchor, `${path}.anchor`) };
}

function light(value: unknown, i: number): LightBinding {
  const path = `lights[${i}]`;
  const { raw, entity, anchor } = binding(value, path, LIGHT_KEYS);
  return {
    entity,
    anchor,
    radius: number(raw.radius, `${path}.radius`, { min: 0.01, fallback: LIGHT_DEFAULTS.radius }),
    soft_edge: number(raw.soft_edge, `${path}.soft_edge`, { min: 0, fallback: LIGHT_DEFAULTS.soft_edge }),
    off_dim: number(raw.off_dim, `${path}.off_dim`, { min: 0, max: 1, fallback: LIGHT_DEFAULTS.off_dim }),
    ...overrides(raw, path),
  };
}

function pin(value: unknown, i: number): PinBinding {
  const path = `pins[${i}]`;
  const { raw, entity, anchor } = binding(value, path, PIN_KEYS);
  return { entity, anchor, ...overrides(raw, path) };
}

/** Validates a raw card config and fills in defaults. Throws ConfigError with a message meant for the user. */
export function parseConfig(raw: unknown): RoomTwinConfig {
  if (!isObject(raw)) throw new ConfigError("RoomTwin card config must be a mapping");

  checkKeys(raw, TOP_KEYS, "");

  if (typeof raw.splat !== "string" || raw.splat.trim() === "") {
    throw new ConfigError("splat is required: the URL of your capture, e.g. /local/roomtwin/living.spz");
  }
  const splat = raw.splat.trim();
  const ext = splatExtension(splat);
  if (!SPLAT_EXTENSIONS.includes(ext)) {
    throw new ConfigError(`splat must end in ${SPLAT_EXTENSIONS.map((e) => "." + e).join(", ")}, got "${splat}"`);
  }

  const up = unset(raw.up) ? DEFAULT_UP : vec3(raw.up, "up");
  // The card writes up with four decimals, so anything shorter would not survive a copy.
  if (Math.hypot(...up) < 1e-3) throw new ConfigError(`up must point somewhere, like [0, 1, 0], got ${describe(up)}`);

  if (!unset(raw.lod) && typeof raw.lod !== "boolean") {
    throw new ConfigError(`lod must be true or false, got ${describe(raw.lod)}`);
  }

  const config: RoomTwinConfig = {
    type: typeof raw.type === "string" ? raw.type : "custom:roomtwin-card",
    splat,
    up,
    floor: number(raw.floor, "floor", { fallback: 0 }),
    lod: raw.lod !== false,
    lod_scale: number(raw.lod_scale, "lod_scale", { min: 0.1, max: 8, fallback: 1 }),
    lights: list(raw.lights, "lights").map(light),
    pins: list(raw.pins, "pins").map(pin),
  };

  // HA's visual editor leaves an emptied text field as "".
  if (!unset(raw.aspect_ratio) && raw.aspect_ratio !== "") {
    aspectRatio(raw.aspect_ratio);
    config.aspect_ratio = raw.aspect_ratio as string | number;
  }

  if (!unset(raw.ceiling_cut)) {
    config.ceiling_cut = number(raw.ceiling_cut, "ceiling_cut", { min: 0 });
  }

  if (!unset(raw.camera)) {
    if (!isObject(raw.camera)) throw new ConfigError(`camera must have position and target, got ${describe(raw.camera)}`);
    checkKeys(raw.camera, ["position", "target"], "camera.");
    config.camera = {
      position: vec3(raw.camera.position, "camera.position"),
      target: vec3(raw.camera.target, "camera.target"),
    };
  }

  for (const key of PASSTHROUGH) if (raw[key] !== undefined) config[key] = raw[key];

  return config;
}
