import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import readme from "../README.md?raw";
import { ConfigError, aspectRatio, bindingRefs, parseConfig, splatExtension } from "../src/config";

const base = { type: "custom:roomtwin-card", splat: "/local/roomtwin/living.spz" };

function error(raw: unknown): string {
  try {
    parseConfig(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected parseConfig to throw");
}

describe("parseConfig", () => {
  test("only splat is required, and defaults are filled in", () => {
    expect(parseConfig(base)).toEqual({
      type: "custom:roomtwin-card",
      splat: "/local/roomtwin/living.spz",
      up: [0, -1, 0],
      floor: 0,
      lod: true,
      lod_scale: 1,
      lights: [],
      pins: [],
    });
  });

  test("the example from the README parses", () => {
    const example = readme.split("## Configuration reference")[1].match(/```yaml\r?\n([\s\S]*?)```/)![1];
    const config = parseConfig(parse(example));
    expect(config.lights.length).toBeGreaterThan(0);
    expect(config.pins.length).toBeGreaterThan(0);
  });

  test("light options default when left out", () => {
    const config = parseConfig({ ...base, lights: [{ entity: "light.a", anchor: [0, 0, 0] }] });
    expect(config.lights[0]).toMatchObject({ radius: 1, soft_edge: 0.5, off_dim: 0.45 });
  });

  test.each([
    [{}, "splat is required: the URL of your capture, e.g. /local/roomtwin/living.spz"],
    [{ splat: "  " }, "splat is required"],
    [{ splat: "/local/room.glb" }, 'splat must end in .spz, .ply, .splat, .ksplat, .sog, .rad, got "/local/room.glb"'],
    [{ ...base, up: [0, 1] }, "up must be a list of three numbers like [0, 1.2, -0.5], got [0,1]"],
    [{ ...base, up: [0, 0, 0] }, "up must point somewhere, like [0, 1, 0], got [0,0,0]"],
    [{ ...base, up: [0, 0.0001, 0] }, "up must point somewhere"],
    [{ ...base, floor: Number.NaN }, "floor must be a number"],
    [{ ...base, lod_scale: Number.POSITIVE_INFINITY }, "lod_scale must be a number"],
    [{ ...base, aspect_ratio: Number.POSITIVE_INFINITY }, "aspect_ratio must look like"],
    [{ ...base, camera: { position: [0, 1, 2], target: [0, 0, 0], fov: 50 } }, 'Unknown option "camera.fov"'],
    [{ ...base, lod: "yes" }, 'lod must be true or false, got "yes"'],
    [{ ...base, lod_scale: 20 }, "lod_scale must be at most 8, got 20"],
    [{ ...base, ceiling_cut: -1 }, "ceiling_cut must be at least 0, got -1"],
    [{ ...base, ceiling_cut: "2.3" }, 'ceiling_cut must be a number, got "2.3"'],
    [{ ...base, aspect_ratio: "wide" }, 'aspect_ratio must look like "16:9" or be a number from 0.1 to 10, got "wide"'],
    [{ ...base, aspect_ratio: 969 }, 'aspect_ratio 969 is how YAML reads an unquoted 16:9. Put it in quotes: "16:9"'],
    [{ ...base, aspect_ratio: 40 }, "aspect_ratio must look like"],
    [{ ...base, camera: { position: [0, 1, 2] } }, "camera.target must be a list of three numbers"],
    [{ ...base, lights: { entity: "light.a" } }, "lights must be a list"],
    [{ ...base, lights: ["light.a"] }, 'lights[0] must be a mapping with entity and anchor, got "light.a"'],
    [
      { ...base, lights: [{ entity: "Light A", anchor: [0, 0, 0] }] },
      'lights[0].entity must be an entity id like light.floor_lamp, got "Light A"',
    ],
    [
      { ...base, lights: [{ entity: "light.a", anchor: [0, 0, 0] }, { entity: "light.b" }] },
      "lights[1].anchor must be a list of three numbers like [0, 1.2, -0.5], got nothing",
    ],
    [{ ...base, lights: [{ entity: "light.a", anchor: [0, 0, 0], off_dim: 1.5 }] }, "lights[0].off_dim must be at most 1, got 1.5"],
    [{ ...base, lights: [{ entity: "light.a", anchor: [0, 0, 0], radius: 0 }] }, "lights[0].radius must be at least 0.01, got 0"],
    [
      { ...base, pins: [{ entity: "sensor.t", anchor: [0, 0, "1"] }] },
      'pins[0].anchor must be a list of three numbers like [0, 1.2, -0.5], got [0,0,"1"]',
    ],
    [{ ...base, pins: [{ entity: "sensor.t", anchor: [0, 0, 1], name: ["a"] }] }, 'pins[0].name must be text, got ["a"]'],
    [{ ...base, pins: [{ entity: "sensor.t", anchor: [0, 0, 1], icon: "lamp" }] }, "pins[0].icon must be an icon like mdi:lamp"],
    [{ ...base, pins: [{ entity: "sensor.t", anchor: [0, 0, 1], nmae: "T" }] }, 'Unknown option "pins[0].nmae"'],
    [{ ...base, lights: [{ entity: "light.a", anchor: [0, 0, 0], raduis: 2 }] }, 'Unknown option "lights[0].raduis"'],
    [{ ...base, light: [] }, 'Unknown option "light"'],
  ])("rejects %j", (raw, message) => {
    expect(error(raw)).toContain(message);
  });

  test("not a mapping", () => {
    expect(error(null)).toBe("RoomTwin card config must be a mapping");
    expect(error([base])).toBe("RoomTwin card config must be a mapping");
  });

  test("keys the dashboard adds are kept, not rejected", () => {
    const config = parseConfig({
      ...base,
      grid_options: { columns: 12 },
      visibility: [{ condition: "screen", media_query: "(min-width: 0px)" }],
    });
    expect(config.grid_options).toEqual({ columns: 12 });
    expect(config.visibility).toHaveLength(1);
  });

  test("card_mod styling is kept", () => {
    expect(parseConfig({ ...base, card_mod: { style: "ha-card { border: none; }" } }).card_mod).toBeDefined();
  });

  test("an option left empty in YAML falls back to its default", () => {
    const config = parseConfig({ ...base, floor: null, lod_scale: null, ceiling_cut: null });
    expect([config.floor, config.lod_scale, config.ceiling_cut]).toEqual([0, 1, undefined]);
    const more = parseConfig({ ...base, up: null, lod: null, camera: null, aspect_ratio: null });
    expect([more.up, more.lod, more.camera, more.aspect_ratio]).toEqual([[0, -1, 0], true, undefined, undefined]);
  });

  test("an empty name counts as no name", () => {
    const config = parseConfig({ ...base, pins: [{ entity: "sensor.t", anchor: [0, 0, 1], name: "" }] });
    expect(config.pins[0]).toEqual({ entity: "sensor.t", anchor: [0, 0, 1] });
  });

  test("lights and pins take a name and an icon", () => {
    const config = parseConfig({
      ...base,
      lights: [{ entity: "light.a", anchor: [0, 0, 0], name: "Lamp", icon: "mdi:floor-lamp" }],
      pins: [{ entity: "sensor.t", anchor: [0, 0, 1], name: 21, icon: "local:ceiling_fan" }],
    });
    expect(config.lights[0]).toMatchObject({ name: "Lamp", icon: "mdi:floor-lamp" });
    expect(config.pins[0]).toEqual({ entity: "sensor.t", anchor: [0, 0, 1], name: "21", icon: "local:ceiling_fan" });
  });

  test("lights and pins take Home Assistant tap, hold and double tap actions", () => {
    const tap = { action: "navigate", navigation_path: "/lovelace/garage" };
    const hold = { action: "perform-action", perform_action: "cover.open_cover", confirmation: { text: "Open?" } };
    const double = { action: "more-info" };
    const pin = { entity: "cover.garage", anchor: [0, 0, 0], tap_action: tap, hold_action: hold, double_tap_action: double };
    const config = parseConfig({ ...base, pins: [pin] });
    expect(config.pins[0]).toMatchObject({ tap_action: tap, hold_action: hold, double_tap_action: double });
    expect(bindingRefs(config)[0]).toMatchObject({ double_tap_action: double });
    expect(error({ ...base, pins: [{ entity: "cover.garage", anchor: [0, 0, 0], tap_action: "toggle" }] })).toBe(
      'pins[0].tap_action must be a card action like { action: more-info }, got "toggle"',
    );
    expect(error({ ...base, lights: [{ entity: "light.a", anchor: [0, 0, 0], hold_action: { navigation_path: "/" } }] })).toMatch(
      /^lights\[0\]\.hold_action must be a card action/,
    );
  });

  test("an aspect ratio emptied in the visual editor counts as unset", () => {
    expect(parseConfig({ ...base, aspect_ratio: "" }).aspect_ratio).toBeUndefined();
  });

  test("layout keys from older dashboards are kept", () => {
    const config = parseConfig({ ...base, view_layout: { position: "main" }, layout_options: { grid_columns: 4 } });
    expect(config.view_layout).toEqual({ position: "main" });
    expect(config.layout_options).toEqual({ grid_columns: 4 });
  });
});

test("splatExtension ignores query strings and dots in folders", () => {
  expect(splatExtension("/local/roomtwin/living.SPZ?v=2")).toBe("spz");
  expect(splatExtension("/local/room.twin/living")).toBe("");
  expect(splatExtension("https://example.com/a.ply#x")).toBe("ply");
});

test("aspectRatio", () => {
  expect(aspectRatio(undefined)).toBeCloseTo(16 / 9);
  expect(aspectRatio("4:3")).toBeCloseTo(4 / 3);
  expect(aspectRatio("21/9")).toBeCloseTo(21 / 9);
  expect(aspectRatio(1.5)).toBe(1.5);
  expect(() => aspectRatio(0)).toThrow(ConfigError);
  expect(() => aspectRatio("0:1")).toThrow(ConfigError);
  expect(() => aspectRatio("1:0")).toThrow(ConfigError);
  // HA's visual editor sends text, so a plain number arrives as a string.
  expect(aspectRatio("1.5")).toBe(1.5);
  expect(aspectRatio(" 2 ")).toBe(2);
  expect(aspectRatio("4x3")).toBeCloseTo(4 / 3);
  expect(() => aspectRatio(61)).toThrow('Put it in quotes: "1:1"');
  expect(() => aspectRatio(243)).toThrow('unquoted 4:3. Put it in quotes: "4:3"');
});
