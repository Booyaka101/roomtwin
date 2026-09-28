import { domainOf, type HassEntity } from "../src/hass";

// [when active, when idle]. build.mjs looks for every "mdi:" name in this file to pack the icon paths.
type Pair = [string, string];

const DOMAINS: Record<string, Pair> = {
  light: ["mdi:lightbulb", "mdi:lightbulb-outline"],
  switch: ["mdi:toggle-switch-variant", "mdi:toggle-switch-variant-off"],
  fan: ["mdi:fan", "mdi:fan-off"],
  input_boolean: ["mdi:check-circle-outline", "mdi:close-circle-outline"],
  lock: ["mdi:lock-open-variant", "mdi:lock"],
  media_player: ["mdi:cast-connected", "mdi:cast"],
  climate: ["mdi:thermostat", "mdi:thermostat"],
  scene: ["mdi:palette", "mdi:palette"],
  script: ["mdi:script-text-play", "mdi:script-text"],
  button: ["mdi:button-pointer", "mdi:button-pointer"],
  input_button: ["mdi:button-pointer", "mdi:button-pointer"],
  camera: ["mdi:video", "mdi:video"],
  vacuum: ["mdi:robot-vacuum", "mdi:robot-vacuum"],
};

const CLASSES: Record<string, Record<string, Pair>> = {
  cover: {
    garage: ["mdi:garage-open", "mdi:garage"],
    gate: ["mdi:gate-open", "mdi:gate"],
    door: ["mdi:door-open", "mdi:door-closed"],
    window: ["mdi:window-open", "mdi:window-closed"],
    "": ["mdi:window-shutter-open", "mdi:window-shutter"],
  },
  binary_sensor: {
    door: ["mdi:door-open", "mdi:door-closed"],
    garage_door: ["mdi:garage-open", "mdi:garage"],
    window: ["mdi:window-open", "mdi:window-closed"],
    motion: ["mdi:motion-sensor", "mdi:motion-sensor-off"],
    occupancy: ["mdi:home", "mdi:home-outline"],
    moisture: ["mdi:water", "mdi:water-off"],
    smoke: ["mdi:smoke-detector-alert", "mdi:smoke-detector"],
    "": ["mdi:checkbox-marked-circle", "mdi:radiobox-blank"],
  },
  sensor: {
    temperature: ["mdi:thermometer", "mdi:thermometer"],
    humidity: ["mdi:water-percent", "mdi:water-percent"],
    power: ["mdi:flash", "mdi:flash"],
    energy: ["mdi:lightning-bolt", "mdi:lightning-bolt"],
    illuminance: ["mdi:brightness-5", "mdi:brightness-5"],
    battery: ["mdi:battery", "mdi:battery"],
    carbon_dioxide: ["mdi:molecule-co2", "mdi:molecule-co2"],
    "": ["mdi:eye", "mdi:eye"],
  },
};

const FALLBACK = "mdi:bookmark";
const ACTIVE = new Set(["on", "open", "opening", "closing", "unlocked", "playing"]);

export const ICON_NAMES = [
  ...new Set([...Object.values(DOMAINS), ...Object.values(CLASSES).flatMap(Object.values)].flat().concat(FALLBACK)),
];

/** The icon HA's ha-state-icon would pick when a binding sets none. */
export function defaultIcon(stateObj: HassEntity): string {
  const domain = domainOf(stateObj.entity_id);
  const byClass = CLASSES[domain];
  const pair = byClass ? (byClass[String(stateObj.attributes.device_class ?? "")] ?? byClass[""]) : DOMAINS[domain];
  if (!pair) return FALLBACK;
  return ACTIVE.has(stateObj.state) ? pair[0] : pair[1];
}
