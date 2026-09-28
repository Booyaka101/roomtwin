import { domainOf, type HassEntity, type HomeAssistant } from "../src/hass";

/** Entity attributes and state the demo starts from, keyed by entity id. Anything missing is guessed. */
export type StateOverrides = Record<string, { state?: string; attributes?: Record<string, unknown> }>;

const SENSOR_CLASSES: Record<string, { state: string; unit: string; step: number }> = {
  temperature: { state: "21.5", unit: "°C", step: 0.1 },
  humidity: { state: "46", unit: "%", step: 1 },
  power: { state: "120", unit: "W", step: 5 },
  energy: { state: "3.2", unit: "kWh", step: 0 },
  illuminance: { state: "180", unit: "lx", step: 10 },
  battery: { state: "87", unit: "%", step: 0 },
  carbon_dioxide: { state: "620", unit: "ppm", step: 10 },
};
const OPENINGS = ["garage_door", "garage", "gate", "door", "window"];
const BINARY_CLASSES = [...OPENINGS, "motion", "occupancy", "moisture", "smoke"];
// Words in an entity id that name a sensor's device class without the usual spelling.
const CLASS_ALIASES: Record<string, string> = { temp: "temperature", lux: "illuminance", co2: "carbon_dioxide" };
const TOGGLES = new Set(["light", "switch", "fan", "input_boolean"]);
// HA clears these while a light is off and brings them back when it turns on again.
const OFF_LOOK = { brightness: null, rgb_color: null, color_mode: null };

const BINARY_TEXT: Record<string, [string, string]> = {
  door: ["Open", "Closed"],
  garage_door: ["Open", "Closed"],
  window: ["Open", "Closed"],
  opening: ["Open", "Closed"],
  motion: ["Detected", "Clear"],
  occupancy: ["Detected", "Clear"],
  moisture: ["Wet", "Dry"],
  smoke: ["Detected", "Clear"],
};

function titleCase(objectId: string): string {
  const words = objectId.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function guessClass(entityId: string, classes: string[]): string | undefined {
  const words = entityId.split(".")[1].split("_").map((w) => CLASS_ALIASES[w] ?? w);
  const id = `_${words.join("_")}_`;
  return classes.find((c) => id.includes(`_${c}_`));
}

/** A plausible starting state for an entity the demo only knows by its id. */
export function guessEntity(entityId: string, now = new Date().toISOString()): HassEntity {
  const domain = domainOf(entityId);
  const attributes: HassEntity["attributes"] = { friendly_name: titleCase(entityId.split(".")[1]) };
  let state = "on";
  if (domain === "light") {
    Object.assign(attributes, { brightness: 255, color_mode: "hs", rgb_color: [255, 255, 255], supported_color_modes: ["hs"] });
  } else if (domain === "sensor") {
    const cls = guessClass(entityId, Object.keys(SENSOR_CLASSES));
    const sensor = cls ? SENSOR_CLASSES[cls] : undefined;
    state = sensor?.state ?? "12";
    if (cls) Object.assign(attributes, { device_class: cls, unit_of_measurement: sensor!.unit });
  } else if (domain === "binary_sensor") {
    state = "off";
    const cls = guessClass(entityId, BINARY_CLASSES);
    if (cls) attributes.device_class = ({ garage: "garage_door", gate: "opening" } as Record<string, string>)[cls] ?? cls;
  } else if (domain === "cover") {
    state = "closed";
    const cls = guessClass(entityId, OPENINGS);
    if (cls) attributes.device_class = cls === "garage_door" ? "garage" : cls;
  } else if (domain === "scene" || domain === "button" || domain === "input_button") {
    state = domain === "scene" ? now : "unknown";
  } else if (domain === "script" || domain === "fan" || domain === "input_boolean") {
    state = "off";
  } else if (domain === "lock") {
    state = "locked";
  } else if (domain === "media_player") {
    state = "idle";
  } else if (domain === "climate") {
    state = "heat";
    Object.assign(attributes, { current_temperature: 20.5, temperature: 21 });
  }
  return { entity_id: entityId, state, attributes, last_changed: now, last_updated: now };
}

/** The text HA's frontend would show for a state, for the handful of domains the demo simulates. */
export function formatState(stateObj: HassEntity): string {
  const { state, attributes } = stateObj;
  if (attributes.unit_of_measurement) return `${state} ${attributes.unit_of_measurement}`;
  const domain = domainOf(stateObj.entity_id);
  if (domain === "binary_sensor") {
    const [on, off] = BINARY_TEXT[String(attributes.device_class)] ?? ["On", "Off"];
    return state === "on" ? on : off;
  }
  if (/^\d{4}-\d\d-\d\dT/.test(state)) return `Last run ${new Date(state).toLocaleTimeString()}`;
  if (state === "unknown") return "Never used";
  return titleCase(state);
}

/**
 * The devices of a pretend home. Service calls change its states the way Home Assistant would, and every
 * change hands the page a new hass object, so the card sees exactly what it sees in a real dashboard.
 */
export class SimHome {
  states: Record<string, HassEntity> = {};
  // One pending transition per entity, so a newer command replaces an older one.
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly driftStart: Record<string, number> = {};
  private readonly lastLook: Record<string, Record<string, unknown>> = {};

  constructor(
    entityIds: string[],
    overrides: StateOverrides,
    private readonly onChange: (hass: HomeAssistant) => void,
  ) {
    for (const id of new Set([...entityIds, ...Object.keys(overrides)])) {
      const guess = guessEntity(id);
      const extra = overrides[id] ?? {};
      const stateObj = (this.states[id] = {
        ...guess,
        // YAML reads an unquoted 12 as a number, and HA states are always strings.
        state: extra.state == null ? guess.state : String(extra.state),
        attributes: { ...guess.attributes, ...extra.attributes },
      });
      if (domainOf(id) === "light" && stateObj.state === "off") this.dim(stateObj);
    }
  }

  get hass(): HomeAssistant {
    return {
      states: this.states,
      user: { is_admin: true },
      callService: (domain, service, data) => this.callService(domain, service, data),
      formatEntityState: formatState,
    };
  }

  /** Changes one entity and tells the page. Untouched entities keep their object, as they do in HA. */
  set(entityId: string, state: string, attributes: Record<string, unknown> = {}): void {
    if (this.write(entityId, state, attributes)) this.onChange(this.hass);
  }

  private write(entityId: string, state: string, attributes: Record<string, unknown> = {}): boolean {
    const old = this.states[entityId];
    if (!old) return false;
    const now = new Date().toISOString();
    this.states = {
      ...this.states,
      [entityId]: {
        ...old,
        state,
        attributes: { ...old.attributes, ...attributes },
        last_changed: state === old.state ? old.last_changed : now,
        last_updated: now,
      },
    };
    return true;
  }

  /** Remembers how a light looked and returns the attributes that clear it, as turning it off does in HA. */
  private dim(stateObj: HassEntity): typeof OFF_LOOK {
    const { brightness, rgb_color, color_mode } = stateObj.attributes;
    this.lastLook[stateObj.entity_id] = { brightness, rgb_color, color_mode };
    Object.assign(stateObj.attributes, OFF_LOOK);
    return OFF_LOOK;
  }

  async callService(domain: string, service: string, data: Record<string, unknown> = {}): Promise<void> {
    const id = String(data.entity_id ?? "");
    const stateObj = this.states[id];
    if (!stateObj) throw new Error(id ? `${id} is not in this demo home` : `${domain}.${service} needs an entity_id in this demo`);
    const on = stateObj.state === "on";
    const { entity_id: _, ...attrs } = data;
    if (TOGGLES.has(domain) && ["toggle", "turn_on", "turn_off"].includes(service)) {
      const next = service === "toggle" ? !on : service === "turn_on";
      if (attrs.rgb_color) attrs.color_mode = "hs";
      if (attrs.color_temp_kelvin) attrs.color_mode = "color_temp";
      if (domain === "light" && next && !on) Object.assign(attrs, { brightness: 255, ...this.lastLook[id], ...attrs });
      if (domain === "light" && !next && on) Object.assign(attrs, this.dim({ ...stateObj, attributes: { ...stateObj.attributes } }));
      this.set(id, next ? "on" : "off", attrs);
    } else if (domain === "cover" && ["toggle", "open_cover", "close_cover", "stop_cover"].includes(service)) {
      const moving = stateObj.state === "opening" || stateObj.state === "closing";
      if (service === "stop_cover" || (service === "toggle" && moving)) {
        // A cover stopped part way reports open, as it does in HA.
        this.cancel(id);
        this.set(id, "open");
        return;
      }
      const open = service === "toggle" ? stateObj.state !== "open" : service === "open_cover";
      this.set(id, open ? "opening" : "closing");
      this.later(id, 1500, () => this.set(id, open ? "open" : "closed"));
    } else if ((domain === "scene" && service === "turn_on") || service === "press") {
      this.set(id, new Date().toISOString());
    } else if (domain === "script" && service === "turn_on") {
      this.set(id, "on");
      this.later(id, 1000, () => this.set(id, "off"));
    } else if (domain === "lock" && (service === "lock" || service === "unlock")) {
      this.set(id, service === "lock" ? "locked" : "unlocked");
    } else {
      throw new Error(`${domain}.${service} isn't simulated in this demo`);
    }
  }

  /** Nudges numeric sensors a little, so readings on the pins visibly update the way live ones do. */
  drift(random = Math.random): void {
    let changed = false;
    for (const stateObj of Object.values(this.states)) {
      const step = SENSOR_CLASSES[String(stateObj.attributes.device_class)]?.step;
      const value = Number(stateObj.state);
      if (!step || !Number.isFinite(value)) continue;
      const decimals = (String(step).split(".")[1] ?? "").length;
      const start = (this.driftStart[stateObj.entity_id] ??= value);
      // A page left open for an hour should still show a believable room, so wander no more than five steps.
      const away = (value - start) / step;
      const up = away <= -4.5 || (away < 4.5 && random() >= 0.5);
      changed = this.write(stateObj.entity_id, (value + (up ? step : -step)).toFixed(decimals)) || changed;
    }
    if (changed) this.onChange(this.hass);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private later(entityId: string, ms: number, fn: () => void): void {
    this.cancel(entityId);
    this.timers.set(
      entityId,
      setTimeout(() => {
        this.timers.delete(entityId);
        fn();
      }, ms),
    );
  }

  private cancel(entityId: string): void {
    clearTimeout(this.timers.get(entityId));
    this.timers.delete(entityId);
  }
}
