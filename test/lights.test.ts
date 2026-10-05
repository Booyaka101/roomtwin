import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType } from "@sparkjsdev/spark";
import { LightRig, lightColor, type Rgb } from "../src/lights";
import type { Vec3 } from "../src/config";
import { entity } from "./helpers";

function expectRgb(actual: number[], expected: number[]) {
  expected.forEach((value, i) => expect(Math.abs(actual[i] - value)).toBeLessThan(1e-4));
}

describe("lightColor", () => {
  test("off dims to off_dim", () => {
    expectRgb(lightColor(entity("light.lamp", "off"), 0.45), [0.45, 0.45, 0.45]);
  });

  test("full brightness without colour is untouched", () => {
    expectRgb(lightColor(entity("light.lamp", "on", { brightness: 255 }), 0.45), [1, 1, 1]);
  });

  test("half brightness with a warm colour", () => {
    const color = lightColor(entity("light.lamp", "on", { brightness: 128, rgb_color: [255, 180, 120] }), 0.45);
    expectRgb(color, [0.72608, 0.56592, 0.43779]);
    const hs = { brightness: 128, rgb_color: [255, 180, 120] as Rgb, color_mode: "hs" };
    expectRgb(lightColor(entity("light.lamp", "on", hs), 0.45), [0.72608, 0.56592, 0.43779]);
  });

  test("a saturated colour tints the room without blacking out the other channels", () => {
    expectRgb(lightColor(entity("light.lamp", "on", { brightness: 255, rgb_color: [255, 0, 0], color_mode: "hs" }), 0.45), [1, 0.25, 0.25]);
  });

  test("a white bulb in color_temp mode is not tinted by the rgb_color HA derives for it", () => {
    const warm = { brightness: 255, color_mode: "color_temp", color_temp_kelvin: 2700, rgb_color: [255, 167, 87] as Rgb };
    expectRgb(lightColor(entity("light.lamp", "on", warm), 0.45), [1, 1, 1]);
  });

  test("unavailable and missing entities count as off", () => {
    expectRgb(lightColor(entity("light.lamp", "unavailable"), 0.3), [0.3, 0.3, 0.3]);
    expectRgb(lightColor(undefined, 0.3), [0.3, 0.3, 0.3]);
  });

  test("an on switch has no brightness and counts as full", () => {
    expectRgb(lightColor(entity("switch.lamp", "on"), 0.45), [1, 1, 1]);
  });

  test("a light reporting only brightness_pct still scales the room", () => {
    expectRgb(lightColor(entity("light.lamp", "on", { brightness: null, brightness_pct: 50 }), 0.45), [0.725, 0.725, 0.725]);
    expectRgb(lightColor(entity("light.lamp", "on", { brightness_pct: 100 }), 0.45), [1, 1, 1]);
    // brightness wins when both are there, as in HA.
    expectRgb(lightColor(entity("light.lamp", "on", { brightness: 128, brightness_pct: 100 }), 0.45), [0.72608, 0.72608, 0.72608]);
  });

  test("null brightness or a black rgb_color fall back to plain white", () => {
    expectRgb(lightColor(entity("light.lamp", "on", { brightness: null, rgb_color: [0, 0, 0] }), 0.45), [1, 1, 1]);
  });

  test("off_dim of 1 means the light never changes the room", () => {
    expectRgb(lightColor(entity("light.lamp", "off"), 1), [1, 1, 1]);
    expectRgb(lightColor(entity("light.lamp", "on", { brightness: 1 }), 1), [1, 1, 1]);
  });
});

describe("LightRig", () => {
  const binding = (entity: string, x: number) => ({
    entity,
    anchor: [x, 1, 2] as Vec3,
    radius: 1.5,
    soft_edge: 0.4,
    off_dim: 0.45,
  });

  function sdfs(parent: THREE.Object3D): SplatEditSdf[] {
    return parent.children.map((edit) => {
      expect(edit).toBeInstanceOf(SplatEdit);
      expect((edit as SplatEdit).rgbaBlendMode).toBe(SplatEditRgbaBlendMode.MULTIPLY);
      expect(edit.children).toHaveLength(1);
      return edit.children[0] as SplatEditSdf;
    });
  }

  test("one soft multiply sphere per light, placed at its anchor", () => {
    const parent = new THREE.Object3D();
    new LightRig(parent).setBindings([binding("light.a", 0), binding("light.b", 3)]);
    const [a, b] = sdfs(parent);
    expect(a.type).toBe(SplatEditSdfType.SPHERE);
    expect(a.radius).toBe(1.5);
    expect(b.position.toArray()).toEqual([3, 1, 2]);
    expect((parent.children[0] as SplatEdit).softEdge).toBe(0.4);
  });

  test("a soft edge wider than the sphere is narrowed so its middle still takes the full colour", () => {
    const parent = new THREE.Object3D();
    new LightRig(parent).setBindings([{ ...binding("light.a", 0), radius: 0.2, soft_edge: 1 }]);
    expect((parent.children[0] as SplatEdit).softEdge).toBe(0.4);
  });

  test("an end point turns the light into a capsule between the two", () => {
    const parent = new THREE.Object3D();
    new LightRig(parent).setBindings([{ ...binding("light.a", 0), end: [0, 4, 2] }]);
    const [sdf] = sdfs(parent);
    expect(sdf.type).toBe(SplatEditSdfType.CAPSULE);
    // Spark's SDF takes a segment of full length along local +Y, centred on the shape.
    expect(sdf.scale.y).toBe(3);
    expect(sdf.position.toArray()).toEqual([0, 2.5, 2]);
    expect(sdf.radius).toBe(1.5);
    // The far end straight up: no rotation away from +Y.
    expect(sdf.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
    // A capsule across the room rotates +Y onto the direction between the ends.
    const other = new THREE.Object3D();
    new LightRig(other).setBindings([{ ...binding("light.a", 0), end: [3, 1, 2] }]);
    const [across] = sdfs(other);
    expect(across.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(Math.PI / 2, 6);
    expect(across.position.toArray()).toEqual([1.5, 1, 2]);
  });

  test("a capsule turns back into a sphere at its anchor when the end is removed", () => {
    const parent = new THREE.Object3D();
    const rig = new LightRig(parent);
    rig.setBindings([{ ...binding("light.a", 0), end: [4, 1, 2] }]);
    rig.setBindings([binding("light.a", 0)]);
    const [sdf] = sdfs(parent);
    expect(sdf.type).toBe(SplatEditSdfType.SPHERE);
    expect(sdf.position.toArray()).toEqual([0, 1, 2]);
    expect(sdf.scale.toArray()).toEqual([1, 1, 1]);
    expect(sdf.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
  });

  test("applyStates recolours and reports whether anything changed", () => {
    const parent = new THREE.Object3D();
    const rig = new LightRig(parent);
    rig.setBindings([binding("light.a", 0)]);
    const states = { "light.a": entity("light.a", "off") };
    expect(rig.applyStates(states)).toBe(true);
    expect(sdfs(parent)[0].color.toArray()).toEqual([0.45, 0.45, 0.45]);
    expect(rig.applyStates(states)).toBe(false);
    expect(rig.applyStates({ "light.a": entity("light.a", "on", { brightness: 255 }) })).toBe(true);
    expect(sdfs(parent)[0].color.toArray()).toEqual([1, 1, 1]);
  });

  test("more than 16 lights each get their own edit, and removing bindings removes edits", () => {
    const parent = new THREE.Object3D();
    const rig = new LightRig(parent);
    rig.setBindings(Array.from({ length: 24 }, (_, i) => binding(`light.l${i}`, i)));
    expect(sdfs(parent)).toHaveLength(24);
    rig.setBindings([binding("light.l0", 0)]);
    expect(sdfs(parent)).toHaveLength(1);
    rig.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
