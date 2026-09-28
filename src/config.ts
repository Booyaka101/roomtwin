export type Vec3 = [number, number, number];

export interface LightBinding {
  entity: string;
  anchor: Vec3;
  radius: number;
  soft_edge: number;
  off_dim: number;
}

export interface PinBinding {
  entity: string;
  anchor: Vec3;
  name?: string;
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
}

// Added by the dashboard editor on any card, or by card-mod; kept as-is so emitted YAML doesn't drop them.
const PASSTHROUGH = ["view_layout", "grid_options", "layout_options", "visibility", "card_mod"] as const;

// Scaniverse .spz and COLMAP-based .ply captures (Brush, gsplat, Postshot) all load into Spark with Y pointing down.
export const DEFAULT_UP: Vec3 = [0, -1, 0];

export const LIGHT_DEFAULTS = { radius: 1.0, soft_edge: 0.5, off_dim: 0.45 };

export const SPLAT_EXTENSIONS = ["spz", "ply", "splat", "ksplat", "sog", "rad"];

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

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
  return JSON.stringify(value);
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
  // An option left empty in YAML ("floor:") arrives as null.
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
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
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be a list, got ${describe(value)}`);
  return value;
}

/** Width over height for a validated aspect_ratio value; 16:9 when unset. */
export function aspectRatio(value: unknown): number {
  if (value === undefined) return 16 / 9;
  if (typeof value === "number" && value > 0) return value;
  const match = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/.exec(value) : null;
  if (match && Number(match[1]) > 0 && Number(match[2]) > 0) return Number(match[1]) / Number(match[2]);
  throw new ConfigError(`aspect_ratio must look like "16:9" or be a positive number, got ${describe(value)}`);
}

function light(value: unknown, i: number): LightBinding {
  const path = `lights[${i}]`;
  if (!isObject(value)) throw new ConfigError(`${path} must be a mapping with entity and anchor, got ${describe(value)}`);
  return {
    entity: entityId(value.entity, `${path}.entity`),
    anchor: vec3(value.anchor, `${path}.anchor`),
    radius: number(value.radius, `${path}.radius`, { min: 0.01, fallback: LIGHT_DEFAULTS.radius }),
    soft_edge: number(value.soft_edge, `${path}.soft_edge`, { min: 0, fallback: LIGHT_DEFAULTS.soft_edge }),
    off_dim: number(value.off_dim, `${path}.off_dim`, { min: 0, max: 1, fallback: LIGHT_DEFAULTS.off_dim }),
  };
}

function pin(value: unknown, i: number): PinBinding {
  const path = `pins[${i}]`;
  if (!isObject(value)) throw new ConfigError(`${path} must be a mapping with entity and anchor, got ${describe(value)}`);
  const result: PinBinding = {
    entity: entityId(value.entity, `${path}.entity`),
    anchor: vec3(value.anchor, `${path}.anchor`),
  };
  if (value.name !== undefined) {
    if (typeof value.name !== "string") throw new ConfigError(`${path}.name must be text, got ${describe(value.name)}`);
    result.name = value.name;
  }
  return result;
}

/** Validates a raw card config and fills in defaults. Throws ConfigError with a message meant for the user. */
export function parseConfig(raw: unknown): RoomTwinConfig {
  if (!isObject(raw)) throw new ConfigError("RoomTwin card config must be a mapping");

  const known = new Set<string>([
    "type", "splat", "up", "floor", "ceiling_cut", "aspect_ratio", "lod", "lod_scale", "camera", "lights", "pins",
    ...PASSTHROUGH,
  ]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new ConfigError(`Unknown option ${unknown.map((k) => `"${k}"`).join(", ")}`);

  if (typeof raw.splat !== "string" || raw.splat.trim() === "") {
    throw new ConfigError("splat is required: the URL of your capture, e.g. /local/roomtwin/living.spz");
  }
  const splat = raw.splat.trim();
  const ext = splatExtension(splat);
  if (!SPLAT_EXTENSIONS.includes(ext)) {
    throw new ConfigError(`splat must end in ${SPLAT_EXTENSIONS.map((e) => "." + e).join(", ")}, got "${splat}"`);
  }

  const up = raw.up === undefined ? DEFAULT_UP : vec3(raw.up, "up");
  if (Math.hypot(...up) < 1e-6) throw new ConfigError("up must not be [0, 0, 0]");

  if (raw.lod !== undefined && typeof raw.lod !== "boolean") {
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

  if (raw.aspect_ratio !== undefined) {
    aspectRatio(raw.aspect_ratio);
    config.aspect_ratio = raw.aspect_ratio as string | number;
  }

  if (raw.ceiling_cut !== undefined && raw.ceiling_cut !== null) {
    config.ceiling_cut = number(raw.ceiling_cut, "ceiling_cut", { min: 0 });
  }

  if (raw.camera !== undefined) {
    if (!isObject(raw.camera)) throw new ConfigError(`camera must have position and target, got ${describe(raw.camera)}`);
    config.camera = {
      position: vec3(raw.camera.position, "camera.position"),
      target: vec3(raw.camera.target, "camera.target"),
    };
  }

  for (const key of PASSTHROUGH) if (raw[key] !== undefined) config[key] = raw[key];

  return config;
}
