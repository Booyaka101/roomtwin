import * as THREE from "three";
import { domainOf, type HassEntity, type HomeAssistant } from "./hass";
import { colorOf } from "./lights";

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
  /** Distance in front of the camera. */
  depth: number;
}

const view = new THREE.Vector3();

/** Pixel position of a world-space point, and whether it is in front of the camera and on screen. */
export function projectToScreen(world: THREE.Vector3, camera: THREE.Camera, width: number, height: number): ScreenPoint {
  view.copy(world).applyMatrix4(camera.matrixWorldInverse);
  const depth = -view.z;
  const inFront = depth > 0;
  view.applyMatrix4(camera.projectionMatrix);
  const x = (view.x * 0.5 + 0.5) * width;
  const y = (-view.y * 0.5 + 0.5) * height;
  const margin = 8;
  const visible = inFront && x >= -margin && x <= width + margin && y >= -margin && y <= height + margin;
  return { x, y, visible, depth };
}

export interface PinBox extends ScreenPoint {
  /** The round icon's diameter. The icon is centred on the point. */
  size: number;
  labelWidth: number;
  /** The label runs to the left of the icon instead of the right. */
  flipped?: boolean;
}

/** Whether a label would be cut off at the right edge and fits on the left instead. */
export function flipsLabel({ x, size, labelWidth }: PinBox, width: number): boolean {
  return labelWidth > 0 && x + size / 2 + labelWidth > width && x - size / 2 - labelWidth >= 0;
}

/** Which pins hide their label: those whose label would run into a nearer pin. Nearer pins keep theirs. */
export function tuckedLabels(boxes: PinBox[]): boolean[] {
  const tucked = boxes.map(() => false);
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  const order = boxes.flatMap((b, i) => (b.visible ? [i] : [])).sort((a, b) => boxes[a].depth - boxes[b].depth);
  for (const i of order) {
    const { x, y, size, labelWidth, flipped } = boxes[i];
    const icon = { left: x - size / 2, right: x + size / 2, top: y - size / 2, bottom: y + size / 2 };
    const full = flipped ? { ...icon, left: icon.left - labelWidth } : { ...icon, right: icon.right + labelWidth };
    tucked[i] = labelWidth > 0 && placed.some((r) => full.left < r.right && full.right > r.left && full.top < r.bottom && full.bottom > r.top);
    placed.push(tucked[i] ? icon : full);
  }
  return tucked;
}

const TOGGLE_DOMAINS = new Set(["light", "switch", "cover", "fan", "input_boolean"]);
const PRESS_SERVICES = new Map([
  ["scene", "turn_on"],
  ["script", "turn_on"],
  ["button", "press"],
  ["input_button", "press"],
]);
const TIMESTAMP_STATES = new Set(["scene", "button", "input_button"]);
// Opening one of these by brushing a pin is worse than the extra tap through more-info.
const GUARDED_COVERS = new Set(["garage", "gate", "door"]);

// Scenes and buttons sit at unknown until first used, and still work.
function notReady(stateObj: HassEntity): boolean {
  return stateObj.state === "unavailable" || (stateObj.state === "unknown" && !PRESS_SERVICES.has(domainOf(stateObj.entity_id)));
}

/** Service a tap calls for this entity, or null when a tap should open more-info instead. */
export function tapService(stateObj: HassEntity | undefined): { domain: string; service: string } | null {
  if (!stateObj || notReady(stateObj)) return null;
  const domain = domainOf(stateObj.entity_id);
  if (domain === "cover" && GUARDED_COVERS.has(String(stateObj.attributes.device_class))) return null;
  if (TOGGLE_DOMAINS.has(domain)) return { domain, service: "toggle" };
  const service = PRESS_SERVICES.get(domain);
  return service ? { domain, service } : null;
}

/** Text shown on a pin: the formatted state for readings, nothing for things you tap to use. */
export function pinLabel(hass: HomeAssistant, stateObj: HassEntity | undefined): string {
  if (!stateObj) return "";
  const domain = domainOf(stateObj.entity_id);
  if (TOGGLE_DOMAINS.has(domain) || PRESS_SERVICES.has(domain)) return "";
  if (hass.formatEntityState) return hass.formatEntityState(stateObj);
  const unit = stateObj.attributes.unit_of_measurement;
  return unit ? `${stateObj.state} ${unit}` : stateObj.state;
}

/** State read out to screen readers after the pin's name. Scenes and buttons only hold the time they last ran. */
export function spokenState(hass: HomeAssistant, stateObj: HassEntity | undefined): string {
  if (!stateObj) return "not in Home Assistant";
  if (TIMESTAMP_STATES.has(domainOf(stateObj.entity_id))) return "";
  return pinLabel(hass, stateObj) || (hass.formatEntityState?.(stateObj) ?? stateObj.state);
}

const ACTIVE_STATES = new Set([
  "on", "open", "opening", "closing", "playing", "home", "heat", "cool", "heat_cool", "unlocked", "unlocking", "cleaning", "mowing",
]);
const ALERT_STATES = new Set(["jammed", "triggered", "error"]);
// Binary sensors whose "on" means something to look at: an open door or window, smoke, a leak.
const ALERT_CLASSES = new Set([
  "door", "garage_door", "window", "opening", "smoke", "gas", "carbon_monoxide", "moisture", "safety", "problem", "tamper",
]);

export function pinState(stateObj: HassEntity | undefined): "missing" | "unavailable" | "alert" | "active" | "idle" {
  if (!stateObj) return "missing";
  if (notReady(stateObj)) return "unavailable";
  const alert = stateObj.state === "on" && domainOf(stateObj.entity_id) === "binary_sensor";
  if (alert && ALERT_CLASSES.has(String(stateObj.attributes.device_class))) return "alert";
  if (ALERT_STATES.has(stateObj.state)) return "alert";
  return ACTIVE_STATES.has(stateObj.state) ? "active" : "idle";
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/**
 * Background of an active pin. A coloured light shows its colour, anything else takes the theme's
 * state colour the way Home Assistant's tiles look it up, most specific first.
 */
export function activeColor(stateObj: HassEntity): string {
  const domain = domainOf(stateObj.entity_id);
  const rgb = domain === "light" ? colorOf(stateObj) : undefined;
  // Lightened so the black text stays readable on a deep blue.
  if (rgb) return `color-mix(in srgb, rgb(${rgb.join(", ")}) 60%, white)`;
  const state = slug(stateObj.state);
  const deviceClass = stateObj.attributes.device_class;
  const names = [
    ...(typeof deviceClass === "string" ? [`--state-${domain}-${slug(deviceClass)}-${state}-color`] : []),
    `--state-${domain}-${state}-color`,
    `--state-${domain}-active-color`,
    "--state-active-color",
  ];
  return names.reduceRight((fallback, name) => `var(${name}, ${fallback})`, "#ffb300");
}

export const HOLD_MS = 500;
export const DOUBLE_TAP_MS = 250;
const MOVE_TOLERANCE = 10;

export interface PressActions<K> {
  tap(key: K): void;
  hold(key: K): void;
  /** Whether a double tap does something here. Only then does a single tap wait to rule one out. */
  hasDoubleTap(key: K): boolean;
  doubleTap(key: K): void;
}

/**
 * Tap, double tap and long-press on a set of elements told apart by key. A press that moves further
 * than a finger's wobble is treated as a drag and does nothing, so pins never fire while the user is orbiting.
 */
export class PressGesture<K> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private key: K | undefined;
  private waiting: { key: K; timer: ReturnType<typeof setTimeout> } | undefined;
  private startX = 0;
  private startY = 0;

  constructor(private readonly actions: PressActions<K>) {}

  down = (e: PointerEvent, key: K): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (this.waiting?.key !== key) this.flush();
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.key = key;
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
      this.actions.hold(key);
    }, HOLD_MS);
  };

  move = (e: PointerEvent): void => {
    if (this.timer && Math.hypot(e.clientX - this.startX, e.clientY - this.startY) > MOVE_TOLERANCE) this.clear();
  };

  up = (e: PointerEvent): void => {
    e.stopPropagation();
    const key = this.key as K;
    if (!this.timer) return;
    this.clear();
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting = undefined;
      this.actions.doubleTap(key);
    } else if (this.actions.hasDoubleTap(key)) {
      this.waiting = { key, timer: setTimeout(() => this.flush(), DOUBLE_TAP_MS) };
    } else {
      this.actions.tap(key);
    }
  };

  cancel = (): void => this.clear();

  /** Drops a single tap still waiting out the double tap window, for when its target goes away. */
  forget(): void {
    if (this.waiting) clearTimeout(this.waiting.timer);
    this.waiting = undefined;
  }

  /** Runs a single tap that was waiting to see if a second one followed. */
  private flush(): void {
    if (!this.waiting) return;
    clearTimeout(this.waiting.timer);
    const { key } = this.waiting;
    this.waiting = undefined;
    this.actions.tap(key);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
