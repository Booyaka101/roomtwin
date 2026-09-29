import { afterEach, expect, test, vi } from "vitest";
import { SimHome, formatState, guessEntity } from "../demo/home";
import { ICON_NAMES, defaultIcon } from "../demo/icons";
import { mdiPath } from "../demo/mdi.mjs";
import { tapService } from "../src/pins";
import type { HomeAssistant } from "../src/hass";

const NOW = "2026-09-28T10:00:00.000Z";

function home(ids: string[], overrides = {}) {
  const seen: HomeAssistant[] = [];
  const sim = new SimHome(ids, overrides, (hass) => seen.push(hass));
  return { sim, seen };
}

afterEach(() => {
  vi.useRealTimers();
});

test("entities get a plausible starting state from their id", () => {
  expect(guessEntity("light.ceiling_lights", NOW)).toMatchObject({ state: "on", attributes: { friendly_name: "Ceiling lights", brightness: 255 } });
  expect(guessEntity("sensor.living_temperature", NOW)).toMatchObject({ state: "21.5", attributes: { device_class: "temperature", unit_of_measurement: "°C" } });
  expect(guessEntity("sensor.office_co2", NOW).attributes).toMatchObject({ device_class: "carbon_dioxide", unit_of_measurement: "ppm" });
  expect(guessEntity("sensor.mystery", NOW)).toMatchObject({ state: "12", attributes: { friendly_name: "Mystery" } });
  expect(guessEntity("binary_sensor.balcony_door", NOW)).toMatchObject({ state: "off", attributes: { device_class: "door" } });
  expect(guessEntity("binary_sensor.garage_contact", NOW).attributes.device_class).toBe("garage_door");
  expect(guessEntity("binary_sensor.front_gate", NOW).attributes.device_class).toBe("opening");
  expect(guessEntity("binary_sensor.indoor_motion", NOW).attributes.device_class).toBe("motion");
  expect(guessEntity("cover.garage_door", NOW)).toMatchObject({ state: "closed", attributes: { device_class: "garage" } });
  expect(guessEntity("cover.lounge_curtains", NOW).attributes.device_class).toBe("curtain");
  expect(guessEntity("cover.playroom_blind", NOW).attributes.device_class).toBe("blind");
  expect(guessEntity("scene.movie_time", NOW).state).toBe("unknown");
  expect(guessEntity("button.doorbell", NOW).state).toBe("unknown");
  expect(guessEntity("script.bedtime", NOW).state).toBe("off");
  expect(guessEntity("lock.front", NOW).state).toBe("locked");
});

test("overrides replace the guessed state and add attributes, and add entities the card doesn't bind", () => {
  const { sim } = home(["light.lamp"], {
    "light.lamp": { state: "off", attributes: { friendly_name: "Reading lamp" } },
    "sensor.outside": { state: "9", attributes: { unit_of_measurement: "°C" } },
  });
  expect(sim.states["light.lamp"]).toMatchObject({ state: "off", attributes: { friendly_name: "Reading lamp", brightness: null } });
  expect(sim.states["sensor.outside"].state).toBe("9");
});

test("toggling a light hands the card a new hass with only that entity replaced", async () => {
  const { sim, seen } = home(["light.lamp", "sensor.temp"]);
  const before = sim.hass;
  await sim.callService("light", "toggle", { entity_id: "light.lamp" });
  expect(seen).toHaveLength(1);
  expect(seen[0].states).not.toBe(before.states);
  expect(seen[0].states["light.lamp"].state).toBe("off");
  expect(seen[0].states["sensor.temp"]).toBe(before.states["sensor.temp"]);
  await sim.callService("light", "turn_on", { entity_id: "light.lamp", rgb_color: [255, 0, 0] });
  expect(sim.states["light.lamp"].attributes).toMatchObject({ rgb_color: [255, 0, 0], color_mode: "hs", brightness: 255 });
  await sim.callService("light", "turn_on", { entity_id: "light.lamp", color_temp_kelvin: 3000 });
  expect(sim.states["light.lamp"].attributes.color_mode).toBe("color_temp");
});

test("a light off has no brightness or colour, and turned back on looks as it did", async () => {
  const { sim } = home(["light.lamp", "light.shelf"], { "light.shelf": { state: "off" } });
  await sim.callService("light", "turn_on", { entity_id: "light.lamp", brightness: 40, rgb_color: [255, 0, 0] });
  await sim.callService("light", "turn_off", { entity_id: "light.lamp" });
  expect(sim.states["light.lamp"].attributes).toMatchObject({ brightness: null, rgb_color: null, color_mode: null });
  await sim.callService("light", "toggle", { entity_id: "light.lamp" });
  expect(sim.states["light.lamp"]).toMatchObject({ state: "on", attributes: { brightness: 40, rgb_color: [255, 0, 0], color_mode: "hs" } });
  await sim.callService("light", "turn_on", { entity_id: "light.shelf" });
  expect(sim.states["light.shelf"].attributes).toMatchObject({ brightness: 255, color_mode: "color_temp", color_temp_kelvin: 3000 });
});

test("covers pass through opening and closing, scripts run and stop", async () => {
  vi.useFakeTimers();
  const { sim } = home(["cover.blind", "script.bedtime"]);
  await sim.callService("cover", "toggle", { entity_id: "cover.blind" });
  expect(sim.states["cover.blind"].state).toBe("opening");
  vi.advanceTimersByTime(1500);
  expect(sim.states["cover.blind"].state).toBe("open");
  await sim.callService("cover", "close_cover", { entity_id: "cover.blind" });
  expect(sim.states["cover.blind"].state).toBe("closing");
  await sim.callService("script", "turn_on", { entity_id: "script.bedtime" });
  expect(sim.states["script.bedtime"].state).toBe("on");
  vi.advanceTimersByTime(1500);
  expect(sim.states["cover.blind"].state).toBe("closed");
  expect(sim.states["script.bedtime"].state).toBe("off");
});

test("a tap on a moving cover stops it, and a newer command replaces the pending one", async () => {
  vi.useFakeTimers();
  const { sim } = home(["cover.blind", "cover.shutter"]);
  await sim.callService("cover", "open_cover", { entity_id: "cover.blind" });
  await sim.callService("cover", "toggle", { entity_id: "cover.blind" });
  expect(sim.states["cover.blind"].state).toBe("open");
  await sim.callService("cover", "open_cover", { entity_id: "cover.shutter" });
  vi.advanceTimersByTime(1000);
  await sim.callService("cover", "close_cover", { entity_id: "cover.shutter" });
  vi.advanceTimersByTime(1000);
  expect(sim.states["cover.shutter"].state).toBe("closing");
  vi.advanceTimersByTime(500);
  expect(sim.states["cover.shutter"].state).toBe("closed");
  expect(sim.states["cover.blind"].state).toBe("open");
});

test("a target with several entities runs the service on each, and brightness_pct sets brightness", async () => {
  const { sim } = home(["light.a", "light.b"], { "light.b": { state: "off" } });
  await sim.callService("light", "turn_on", { entity_id: ["light.a", "light.b"], brightness_pct: 40, transition: 2 });
  expect(sim.states["light.a"]).toMatchObject({ state: "on", attributes: { brightness: 102 } });
  expect(sim.states["light.b"]).toMatchObject({ state: "on", attributes: { brightness: 102 } });
  expect(sim.states["light.a"].attributes).not.toHaveProperty("transition");
});

test("stopping a cover that isn't moving leaves it be", async () => {
  const { sim, seen } = home(["cover.blind"]);
  await sim.callService("cover", "stop_cover", { entity_id: "cover.blind" });
  expect(sim.states["cover.blind"].state).toBe("closed");
  expect(seen).toHaveLength(0);
});

test("motion sensors trip now and then and clear 20 seconds later, other sensors stay put", () => {
  vi.useFakeTimers();
  const { sim } = home(["binary_sensor.hall_motion", "binary_sensor.balcony_door"]);
  sim.stir(() => 0.5);
  expect(sim.states["binary_sensor.hall_motion"].state).toBe("off");
  sim.stir(() => 0);
  expect(sim.states["binary_sensor.hall_motion"].state).toBe("on");
  expect(sim.states["binary_sensor.balcony_door"].state).toBe("off");
  vi.advanceTimersByTime(20_000);
  expect(sim.states["binary_sensor.hall_motion"].state).toBe("off");
});

test("dispose cancels pending transitions", async () => {
  vi.useFakeTimers();
  const { sim, seen } = home(["cover.blind"]);
  await sim.callService("cover", "open_cover", { entity_id: "cover.blind" });
  sim.dispose();
  vi.advanceTimersByTime(5000);
  expect(seen).toHaveLength(1);
});

test("scenes and buttons record when they ran, locks lock", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const { sim } = home(["scene.movie", "button.doorbell", "lock.front"]);
  await sim.callService("scene", "turn_on", { entity_id: "scene.movie" });
  await sim.callService("button", "press", { entity_id: "button.doorbell" });
  await sim.callService("lock", "unlock", { entity_id: "lock.front" });
  expect(sim.states["scene.movie"].state).toBe(NOW);
  expect(sim.states["button.doorbell"].state).toBe(NOW);
  expect(sim.states["lock.front"].state).toBe("unlocked");
});

test("media players play, pause and stop", async () => {
  const { sim } = home(["media_player.tv"]);
  await sim.callService("media_player", "media_play_pause", { entity_id: "media_player.tv" });
  expect(sim.states["media_player.tv"].state).toBe("playing");
  await sim.callService("media_player", "media_play_pause", { entity_id: "media_player.tv" });
  expect(sim.states["media_player.tv"].state).toBe("paused");
  await sim.callService("media_player", "turn_off", { entity_id: "media_player.tv" });
  expect(sim.states["media_player.tv"].state).toBe("off");
  await sim.callService("media_player", "toggle", { entity_id: "media_player.tv" });
  expect(sim.states["media_player.tv"].state).toBe("idle");
});

test("a thermostat takes a target within its range and changes mode", async () => {
  const { sim } = home(["climate.lounge"]);
  await sim.callService("climate", "set_temperature", { entity_id: "climate.lounge", temperature: 22.5 });
  expect(sim.states["climate.lounge"].attributes.temperature).toBe(22.5);
  await expect(sim.callService("climate", "set_temperature", { entity_id: "climate.lounge", temperature: 40 })).rejects.toThrow(
    "Provided temperature 40 is not valid. Accepted range is 7 to 35.",
  );
  await sim.callService("climate", "toggle", { entity_id: "climate.lounge" });
  expect(sim.states["climate.lounge"].state).toBe("off");
  await sim.callService("climate", "set_hvac_mode", { entity_id: "climate.lounge", hvac_mode: "cool" });
  expect(sim.states["climate.lounge"].state).toBe("cool");
});

test("a script runs when called by its own name, and homeassistant services reach the entity's domain", async () => {
  vi.useFakeTimers();
  const { sim } = home(["script.goodnight", "cover.blind", "light.lamp"]);
  await sim.callService("script", "goodnight");
  expect(sim.states["script.goodnight"].state).toBe("on");
  await sim.callService("homeassistant", "turn_on", { entity_id: "cover.blind" });
  expect(sim.states["cover.blind"].state).toBe("opening");
  await sim.callService("homeassistant", "toggle", { entity_id: "light.lamp" });
  expect(sim.states["light.lamp"].state).toBe("off");
  sim.dispose();
});

test("a light asked for brightness 0 turns off, and hs_color sets its colour", async () => {
  const { sim } = home(["light.lamp"]);
  await sim.callService("light", "turn_on", { entity_id: "light.lamp", hs_color: [240, 100] });
  expect(sim.states["light.lamp"].attributes.rgb_color).toEqual([0, 0, 255]);
  await sim.callService("light", "turn_on", { entity_id: "light.lamp", brightness_pct: 0 });
  expect(sim.states["light.lamp"].state).toBe("off");
});

test("services the demo can't simulate, and unknown entities, reject with a message", async () => {
  const { sim, seen } = home(["light.lamp", "sensor.temp"]);
  await expect(sim.callService("light", "turn_on", { entity_id: "light.gone" })).rejects.toThrow("light.gone is not in this demo home");
  await expect(sim.callService("light", "turn_on")).rejects.toThrow("light.turn_on needs an entity_id in this demo");
  await expect(sim.callService("sensor", "reload", { entity_id: "sensor.temp" })).rejects.toThrow("sensor.reload isn't simulated in this demo");
  expect(seen).toHaveLength(0);
});

test("every service a card tap sends is one the demo simulates", async () => {
  const ids = ["light.a", "switch.b", "fan.c", "input_boolean.d", "cover.e", "scene.f", "script.g", "button.h", "input_button.i"];
  const { sim } = home(ids);
  for (const id of ids) {
    const call = tapService(sim.states[id]);
    expect(call, id).not.toBeNull();
    await expect(sim.callService(call!.domain, call!.service, { entity_id: id })).resolves.toBeUndefined();
  }
  sim.dispose();
});

test("drift moves numeric sensors by one step and leaves the rest alone", () => {
  const { sim } = home(["sensor.temperature", "sensor.humidity", "sensor.energy", "sensor.mystery", "light.lamp"]);
  sim.drift(() => 0.9);
  expect(sim.states["sensor.temperature"].state).toBe("21.6");
  expect(sim.states["sensor.humidity"].state).toBe("47");
  sim.drift(() => 0.1);
  expect(sim.states["sensor.temperature"].state).toBe("21.5");
  expect(sim.states["sensor.energy"].state).toBe("3.2");
  expect(sim.states["sensor.mystery"].state).toBe("12");
  expect(sim.states["light.lamp"].state).toBe("on");
});

test("drift hands the card one new hass for all the sensors it moved", () => {
  const { sim, seen } = home(["sensor.temperature", "sensor.humidity", "light.lamp"]);
  sim.drift(() => 0.9);
  expect(seen).toHaveLength(1);
  expect(seen[0].states["sensor.humidity"].state).toBe("47");
});

test("drift walks a thermostat's room temperature to its target, unless it's off", async () => {
  const { sim } = home(["climate.lounge"]);
  const current = () => sim.states["climate.lounge"].attributes.current_temperature;
  await sim.callService("climate", "set_temperature", { entity_id: "climate.lounge", temperature: 21.8 });
  sim.drift();
  expect(current()).toBe(21);
  sim.drift();
  expect(current()).toBe(21.5);
  sim.drift();
  sim.drift();
  expect(current()).toBe(21.8);
  await sim.callService("climate", "turn_off", { entity_id: "climate.lounge" });
  await sim.callService("climate", "set_temperature", { entity_id: "climate.lounge", temperature: 19 });
  sim.drift();
  expect(current()).toBe(21.8);
});

test("drift stays within five steps of where a sensor started", () => {
  const { sim } = home(["sensor.temperature"]);
  for (let i = 0; i < 20; i++) sim.drift(() => 0.9);
  expect(sim.states["sensor.temperature"].state).toBe("21.9");
  for (let i = 0; i < 20; i++) sim.drift(() => 0.1);
  expect(sim.states["sensor.temperature"].state).toBe("21.1");
});

test("states read the way HA's frontend writes them", () => {
  expect(formatState(guessEntity("sensor.temperature", NOW))).toBe("21.5 °C");
  expect(formatState(guessEntity("binary_sensor.balcony_door", NOW))).toBe("Closed");
  expect(formatState({ ...guessEntity("binary_sensor.hall_motion", NOW), state: "on" })).toBe("Detected");
  expect(formatState({ ...guessEntity("binary_sensor.thing", NOW), state: "on" })).toBe("On");
  expect(formatState(guessEntity("button.doorbell", NOW))).toBe("Never used");
  expect(formatState(guessEntity("scene.movie", NOW))).toBe("Unknown");
  expect(formatState({ ...guessEntity("scene.movie", NOW), state: NOW })).toMatch(/^Last run /);
  expect(formatState(guessEntity("sensor.humidity", NOW))).toBe("46%");
  expect(formatState({ ...guessEntity("sensor.temperature", NOW), state: "unavailable" })).toBe("Unavailable");
  expect(formatState(guessEntity("cover.blind", NOW))).toBe("Closed");
  expect(formatState({ ...guessEntity("media_player.tv", NOW), state: "playing" })).toBe("Playing");
});

test("default icons follow the domain, device class and state", () => {
  expect(defaultIcon(guessEntity("light.lamp", NOW))).toBe("mdi:lightbulb");
  expect(defaultIcon({ ...guessEntity("light.lamp", NOW), state: "off" })).toBe("mdi:lightbulb-outline");
  expect(defaultIcon(guessEntity("binary_sensor.balcony_door", NOW))).toBe("mdi:door-closed");
  expect(defaultIcon({ ...guessEntity("binary_sensor.balcony_door", NOW), state: "on" })).toBe("mdi:door-open");
  expect(defaultIcon(guessEntity("cover.garage_door", NOW))).toBe("mdi:garage");
  expect(defaultIcon(guessEntity("cover.playroom_blind", NOW))).toBe("mdi:blinds-horizontal-closed");
  expect(defaultIcon({ ...guessEntity("cover.bedroom_shade", NOW), state: "open" })).toBe("mdi:roller-shade");
  expect(defaultIcon(guessEntity("sensor.mystery", NOW))).toBe("mdi:eye");
  expect(defaultIcon(guessEntity("vacuum.robbie", NOW))).toBe("mdi:robot-vacuum");
  expect(defaultIcon(guessEntity("weather.home", NOW))).toBe("mdi:bookmark");
});

test("every icon the demo can pick exists in @mdi/js, which build.mjs packs them from", () => {
  const missing = ICON_NAMES.filter((name) => !mdiPath(name));
  expect(ICON_NAMES.length).toBeGreaterThan(30);
  expect(missing).toEqual([]);
});
