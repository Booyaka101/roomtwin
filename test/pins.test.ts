import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { DOUBLE_TAP_MS, HOLD_MS, PressGesture, activeColor, flipsLabel, pinLabel, pinState, projectToScreen, spokenState, tapService, tuckedLabels, type PinBox } from "../src/pins";
import type { HomeAssistant } from "../src/hass";
import { entity } from "./helpers";

const hass = { states: {}, callService: async () => undefined } as HomeAssistant;

test("tap toggles lights, switches, covers, fans and input booleans; sensors and locks open more-info", () => {
  expect(tapService(entity("light.lamp", "off"))).toEqual({ domain: "light", service: "toggle" });
  expect(tapService(entity("switch.kettle", "on"))).toEqual({ domain: "switch", service: "toggle" });
  expect(tapService(entity("cover.blind", "open", { device_class: "blind" }))).toEqual({ domain: "cover", service: "toggle" });
  expect(tapService(entity("sensor.temperature", "21"))).toBeNull();
  expect(tapService(entity("lock.front_door", "locked"))).toBeNull();
});

test("scenes, scripts and buttons run on a tap", () => {
  expect(tapService(entity("scene.movie", "unknown"))).toEqual({ domain: "scene", service: "turn_on" });
  expect(tapService(entity("script.bedtime", "off"))).toEqual({ domain: "script", service: "turn_on" });
  expect(tapService(entity("button.restart", "unknown"))).toEqual({ domain: "button", service: "press" });
  expect(tapService(entity("input_button.doorbell", "unknown"))).toEqual({ domain: "input_button", service: "press" });
  expect(pinLabel(hass, entity("scene.movie", "2026-09-28T10:00:00+00:00"))).toBe("");
});

test("garage doors, gates, doors and unavailable or missing entities open more-info instead", () => {
  expect(tapService(entity("cover.garage", "closed", { device_class: "garage" }))).toBeNull();
  expect(tapService(entity("cover.drive", "closed", { device_class: "gate" }))).toBeNull();
  expect(tapService(entity("cover.patio", "closed", { device_class: "door" }))).toBeNull();
  expect(tapService(entity("light.lamp", "unavailable"))).toBeNull();
  expect(tapService(entity("switch.kettle", "unknown"))).toBeNull();
  expect(tapService(undefined)).toBeNull();
});

test("sensor pins show state and unit, toggles show nothing", () => {
  expect(pinLabel(hass, entity("sensor.t", "21.5", { unit_of_measurement: "°C" }))).toBe("21.5 °C");
  expect(pinLabel(hass, entity("sensor.mode", "eco"))).toBe("eco");
  expect(pinLabel(hass, entity("light.lamp", "on"))).toBe("");
  expect(pinLabel(hass, undefined)).toBe("");
  const formatted = { ...hass, formatEntityState: () => "21,5 °C" };
  expect(pinLabel(formatted, entity("sensor.t", "21.5", { unit_of_measurement: "°C" }))).toBe("21,5 °C");
});

test("screen readers hear the state of toggles and readings, but not a scene's last-run time", () => {
  const formatted = { ...hass, formatEntityState: (s: { state: string }) => s.state.toUpperCase() };
  expect(spokenState(formatted, entity("light.lamp", "on"))).toBe("ON");
  expect(spokenState(hass, entity("sensor.t", "21.5", { unit_of_measurement: "°C" }))).toBe("21.5 °C");
  expect(spokenState(formatted, entity("scene.movie", "2026-09-28T10:00:00+00:00"))).toBe("");
  expect(spokenState(formatted, entity("button.push", "unknown"))).toBe("");
  expect(spokenState(hass, undefined)).toBe("not in Home Assistant");
});

test("pinState", () => {
  expect(pinState(undefined)).toBe("missing");
  expect(pinState(entity("light.a", "unavailable"))).toBe("unavailable");
  expect(pinState(entity("switch.a", "unknown"))).toBe("unavailable");
  expect(pinState(entity("scene.movie", "unknown"))).toBe("idle");
  expect(pinState(entity("light.a", "on"))).toBe("active");
  expect(pinState(entity("cover.a", "open"))).toBe("active");
  expect(pinState(entity("light.a", "off"))).toBe("idle");
  expect(pinState(entity("binary_sensor.balcony", "on", { device_class: "door" }))).toBe("alert");
  expect(pinState(entity("binary_sensor.kitchen_leak", "on", { device_class: "moisture" }))).toBe("alert");
  expect(pinState(entity("binary_sensor.balcony", "off", { device_class: "door" }))).toBe("idle");
  expect(pinState(entity("binary_sensor.hall", "on", { device_class: "motion" }))).toBe("active");
  expect(pinState(entity("binary_sensor.plain", "on"))).toBe("active");
  expect(pinState(entity("lock.front", "unlocked"))).toBe("active");
  expect(pinState(entity("lock.front", "locked"))).toBe("idle");
  expect(pinState(entity("lock.front", "jammed"))).toBe("alert");
  expect(pinState(entity("alarm_control_panel.home", "triggered"))).toBe("alert");
  expect(pinState(entity("vacuum.robot", "error"))).toBe("alert");
  expect(pinState(entity("vacuum.robot", "cleaning"))).toBe("active");
});

describe("activeColor", () => {
  test("follows the theme's state colours, most specific first", () => {
    expect(activeColor(entity("cover.blind", "open", { device_class: "blind" }))).toBe(
      "var(--state-cover-blind-open-color, var(--state-cover-open-color, var(--state-cover-active-color, var(--state-active-color, #ffb300))))",
    );
    expect(activeColor(entity("climate.hall", "heat_cool"))).toBe(
      "var(--state-climate-heat_cool-color, var(--state-climate-active-color, var(--state-active-color, #ffb300)))",
    );
  });

  test("a coloured light shows its colour, a white one the theme's", () => {
    expect(activeColor(entity("light.strip", "on", { color_mode: "hs", rgb_color: [0, 0, 255] }))).toBe(
      "color-mix(in srgb, rgb(0, 0, 255) 60%, white)",
    );
    expect(activeColor(entity("light.lamp", "on", { color_mode: "color_temp", rgb_color: [255, 180, 100] }))).toContain("--state-light-on-color");
  });
});

describe("projectToScreen", () => {
  const camera = new THREE.PerspectiveCamera(90, 2, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  test("the point the camera looks at lands in the middle", () => {
    const p = projectToScreen(new THREE.Vector3(0, 0, 0), camera, 800, 400);
    expect(p.x).toBeCloseTo(400);
    expect(p.y).toBeCloseTo(200);
    expect(p.visible).toBe(true);
    expect(p.depth).toBeCloseTo(5);
  });

  test("up in the world is up on screen", () => {
    expect(projectToScreen(new THREE.Vector3(0, 1, 0), camera, 800, 400).y).toBeLessThan(200);
  });

  test("points behind the camera or far off to the side are hidden", () => {
    expect(projectToScreen(new THREE.Vector3(0, 0, 10), camera, 800, 400).visible).toBe(false);
    expect(projectToScreen(new THREE.Vector3(50, 0, 0), camera, 800, 400).visible).toBe(false);
  });
});

describe("PressGesture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const event = (x = 0, y = 0) => ({ button: 0, clientX: x, clientY: y, stopPropagation() {} }) as PointerEvent;

  function setup(doubleTaps = false) {
    const onTap = vi.fn();
    const onHold = vi.fn();
    const onDoubleTap = vi.fn();
    const gesture = new PressGesture<number>({ tap: onTap, hold: onHold, hasDoubleTap: () => doubleTaps, doubleTap: onDoubleTap });
    const press = (key = 0) => {
      gesture.down(event(), key);
      gesture.up(event());
    };
    return { onTap, onHold, onDoubleTap, gesture, press };
  }

  test("a quick press is a tap", () => {
    const { onTap, onHold, gesture } = setup();
    gesture.down(event(), 0);
    vi.advanceTimersByTime(100);
    gesture.up(event());
    expect(onTap).toHaveBeenCalledOnce();
    expect(onHold).not.toHaveBeenCalled();
  });

  test("holding opens more-info without also tapping", () => {
    const { onTap, onHold, gesture } = setup();
    gesture.down(event(), 0);
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledOnce();
    gesture.up(event());
    expect(onTap).not.toHaveBeenCalled();
  });

  test("a press the browser took over for a scroll or pinch does nothing", () => {
    const { onTap, onHold, gesture } = setup();
    gesture.down(event(), 0);
    gesture.cancel();
    gesture.up(event());
    vi.advanceTimersByTime(HOLD_MS);
    expect(onTap).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
  });

  test("dragging off a pin does nothing", () => {
    const { onTap, onHold, gesture } = setup();
    gesture.down(event(0, 0), 0);
    gesture.move(event(30, 0));
    vi.advanceTimersByTime(HOLD_MS);
    gesture.up(event(30, 0));
    expect(onTap).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
  });

  test("a small wobble is still a tap", () => {
    const { onTap, gesture } = setup();
    gesture.down(event(0, 0), 0);
    gesture.move(event(4, 3));
    gesture.up(event(4, 3));
    expect(onTap).toHaveBeenCalledOnce();
  });

  test("without a double tap action a tap fires straight away", () => {
    const { onTap, press } = setup();
    press(3);
    expect(onTap).toHaveBeenCalledWith(3);
  });

  test("two quick taps are a double tap and not a tap", () => {
    const { onTap, onDoubleTap, press } = setup(true);
    press();
    expect(onTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOUBLE_TAP_MS - 50);
    press();
    vi.advanceTimersByTime(DOUBLE_TAP_MS * 2);
    expect(onDoubleTap).toHaveBeenCalledOnce();
    expect(onTap).not.toHaveBeenCalled();
  });

  test("a single tap fires once the double tap window has passed", () => {
    const { onTap, onDoubleTap, press } = setup(true);
    press(2);
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(onTap).toHaveBeenCalledWith(2);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  test("a tap on another pin inside the window is two taps", () => {
    const { onTap, onDoubleTap, press } = setup(true);
    press(0);
    press(1);
    expect(onTap).toHaveBeenCalledWith(0);
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(onTap).toHaveBeenLastCalledWith(1);
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  test("a waiting tap is dropped when its pin goes away", () => {
    const { onTap, gesture, press } = setup(true);
    press();
    gesture.forget();
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(onTap).not.toHaveBeenCalled();
  });

  test("tap then hold is a tap and a hold", () => {
    const { onTap, onHold, onDoubleTap, gesture, press } = setup(true);
    press();
    gesture.down(event(), 0);
    vi.advanceTimersByTime(HOLD_MS);
    expect(onTap).toHaveBeenCalledOnce();
    expect(onHold).toHaveBeenCalledOnce();
    expect(onDoubleTap).not.toHaveBeenCalled();
  });
});

describe("tuckedLabels", () => {
  const box = (x: number, y: number, depth: number, labelWidth = 60): PinBox => ({ x, y, depth, visible: true, size: 36, labelWidth });

  test("pins far apart keep their labels", () => {
    expect(tuckedLabels([box(100, 100, 2), box(300, 100, 3), box(100, 300, 1)])).toEqual([false, false, false]);
  });

  test("the farther pin tucks its label when it runs into a nearer pin, whichever comes first in the config", () => {
    expect(tuckedLabels([box(100, 100, 2), box(140, 105, 3)])).toEqual([false, true]);
    expect(tuckedLabels([box(140, 105, 3), box(100, 100, 2)])).toEqual([true, false]);
  });

  test("a label only counts to the right of its icon", () => {
    // The nearer pin's label runs away from the farther one, and the farther one's label clears it.
    expect(tuckedLabels([box(200, 100, 1), box(100, 100, 2, 50)])).toEqual([false, false]);
    expect(tuckedLabels([box(200, 100, 1), box(100, 100, 2, 70)])).toEqual([false, true]);
  });

  test("a flipped label counts to the left of its icon", () => {
    const flipped = { ...box(200, 100, 2, 70), flipped: true };
    expect(tuckedLabels([box(100, 100, 1), flipped])).toEqual([false, true]);
    expect(tuckedLabels([box(300, 100, 1), flipped])).toEqual([false, false]);
  });

  test("a label flips to the left only when it would be cut off on the right and fits on the left", () => {
    expect(flipsLabel(box(100, 100, 1), 400)).toBe(false);
    expect(flipsLabel(box(360, 100, 1), 400)).toBe(true);
    expect(flipsLabel(box(60, 100, 1), 100)).toBe(false);
    expect(flipsLabel(box(390, 100, 1, 0), 400)).toBe(false);
  });

  test("a tucked label frees its space, and hidden pins take none", () => {
    // 1 tucks behind 0, so 2 only has to clear 1's icon.
    expect(tuckedLabels([box(100, 100, 1), box(150, 100, 2), box(200, 100, 3)])).toEqual([false, true, false]);
    expect(tuckedLabels([{ ...box(100, 100, 1), visible: false }, box(140, 100, 2)])).toEqual([false, false]);
  });

  test("pins without a label never tuck", () => {
    expect(tuckedLabels([box(100, 100, 1), box(110, 100, 2, 0)])).toEqual([false, false]);
  });
});
