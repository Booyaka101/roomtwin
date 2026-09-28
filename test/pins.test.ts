import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { HOLD_MS, PressGesture, pinLabel, pinState, projectToScreen, tapService } from "../src/pins";
import type { HomeAssistant } from "../src/hass";
import { entity } from "./helpers";

const hass = { states: {}, callService: async () => undefined } as HomeAssistant;

test("tap toggles lights, switches, covers, fans and input booleans; everything else opens more-info", () => {
  expect(tapService("light.lamp")).toEqual({ domain: "light", service: "toggle" });
  expect(tapService("switch.kettle")).toEqual({ domain: "switch", service: "toggle" });
  expect(tapService("cover.blind")).toEqual({ domain: "cover", service: "toggle" });
  expect(tapService("sensor.temperature")).toBeNull();
  expect(tapService("lock.front_door")).toBeNull();
});

test("sensor pins show state and unit, toggles show nothing", () => {
  expect(pinLabel(hass, entity("sensor.t", "21.5", { unit_of_measurement: "°C" }))).toBe("21.5 °C");
  expect(pinLabel(hass, entity("sensor.mode", "eco"))).toBe("eco");
  expect(pinLabel(hass, entity("light.lamp", "on"))).toBe("");
  expect(pinLabel(hass, undefined)).toBe("");
  const formatted = { ...hass, formatEntityState: () => "21,5 °C" };
  expect(pinLabel(formatted, entity("sensor.t", "21.5", { unit_of_measurement: "°C" }))).toBe("21,5 °C");
});

test("pinState", () => {
  expect(pinState(undefined)).toBe("missing");
  expect(pinState(entity("light.a", "unavailable"))).toBe("unavailable");
  expect(pinState(entity("light.a", "on"))).toBe("active");
  expect(pinState(entity("cover.a", "open"))).toBe("active");
  expect(pinState(entity("light.a", "off"))).toBe("idle");
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

  function setup() {
    const onTap = vi.fn();
    const onHold = vi.fn();
    return { onTap, onHold, gesture: new PressGesture(onTap, onHold) };
  }

  test("a quick press is a tap", () => {
    const { onTap, onHold, gesture } = setup();
    gesture.down(event());
    vi.advanceTimersByTime(100);
    gesture.up(event());
    expect(onTap).toHaveBeenCalledOnce();
    expect(onHold).not.toHaveBeenCalled();
  });

  test("holding opens more-info without also tapping", () => {
    const { onTap, onHold, gesture } = setup();
    gesture.down(event());
    vi.advanceTimersByTime(HOLD_MS);
    expect(onHold).toHaveBeenCalledOnce();
    gesture.up(event());
    expect(onTap).not.toHaveBeenCalled();
  });

  test("dragging off a pin does nothing", () => {
    const { onTap, onHold, gesture } = setup();
    gesture.down(event(0, 0));
    gesture.move(event(30, 0));
    vi.advanceTimersByTime(HOLD_MS);
    gesture.up(event(30, 0));
    expect(onTap).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
  });

  test("a small wobble is still a tap", () => {
    const { onTap, gesture } = setup();
    gesture.down(event(0, 0));
    gesture.move(event(4, 3));
    gesture.up(event(4, 3));
    expect(onTap).toHaveBeenCalledOnce();
  });
});
