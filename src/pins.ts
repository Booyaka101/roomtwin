import * as THREE from "three";
import { domainOf, type HassEntity, type HomeAssistant } from "./hass";

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

const view = new THREE.Vector3();

/** Pixel position of a world-space point, and whether it is in front of the camera and on screen. */
export function projectToScreen(world: THREE.Vector3, camera: THREE.Camera, width: number, height: number): ScreenPoint {
  view.copy(world).applyMatrix4(camera.matrixWorldInverse);
  const inFront = view.z < 0;
  view.applyMatrix4(camera.projectionMatrix);
  const x = (view.x * 0.5 + 0.5) * width;
  const y = (-view.y * 0.5 + 0.5) * height;
  const margin = 8;
  const visible = inFront && x >= -margin && x <= width + margin && y >= -margin && y <= height + margin;
  return { x, y, visible };
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

const ACTIVE_STATES = new Set(["on", "open", "opening", "closing", "playing", "home", "heat", "cool", "heat_cool"]);
// Binary sensors whose "on" means something to look at: an open door or window, smoke, a leak.
const ALERT_CLASSES = new Set([
  "door", "garage_door", "window", "opening", "smoke", "gas", "carbon_monoxide", "moisture", "safety", "problem", "tamper",
]);

export function pinState(stateObj: HassEntity | undefined): "missing" | "unavailable" | "alert" | "active" | "idle" {
  if (!stateObj) return "missing";
  if (notReady(stateObj)) return "unavailable";
  const alert = stateObj.state === "on" && domainOf(stateObj.entity_id) === "binary_sensor";
  if (alert && ALERT_CLASSES.has(String(stateObj.attributes.device_class))) return "alert";
  return ACTIVE_STATES.has(stateObj.state) ? "active" : "idle";
}

export const HOLD_MS = 500;
const MOVE_TOLERANCE = 10;

/**
 * Tap versus long-press on one element. A press that moves further than a finger's wobble is
 * treated as a drag and does nothing, so pins never fire while the user is orbiting.
 */
export class PressGesture {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startX = 0;
  private startY = 0;

  constructor(
    private readonly onTap: () => void,
    private readonly onHold: () => void,
  ) {}

  down = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onHold();
    }, HOLD_MS);
  };

  move = (e: PointerEvent): void => {
    if (this.timer && Math.hypot(e.clientX - this.startX, e.clientY - this.startY) > MOVE_TOLERANCE) this.clear();
  };

  up = (e: PointerEvent): void => {
    e.stopPropagation();
    if (!this.timer) return;
    this.clear();
    this.onTap();
  };

  cancel = (): void => this.clear();

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
