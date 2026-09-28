import { describe, expect, test } from "vitest";
import { ConfigError, aspectRatio, parseConfig, splatExtension } from "../src/config";

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
    const config = parseConfig({
      ...base,
      up: [0, 1, 0],
      ceiling_cut: 2.3,
      lights: [{ entity: "light.floor_lamp", anchor: [1.42, 0.35, -2.1], radius: 1.6, soft_edge: 0.6, off_dim: 0.45 }],
      pins: [{ entity: "sensor.living_temperature", anchor: [-0.8, 1.1, -2.9] }],
    });
    expect(config.ceiling_cut).toBe(2.3);
    expect(config.lights[0]).toEqual({
      entity: "light.floor_lamp",
      anchor: [1.42, 0.35, -2.1],
      radius: 1.6,
      soft_edge: 0.6,
      off_dim: 0.45,
    });
    expect(config.pins[0]).toEqual({ entity: "sensor.living_temperature", anchor: [-0.8, 1.1, -2.9] });
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
    [{ ...base, aspect_ratio: "wide" }, 'aspect_ratio must look like "16:9" or be a positive number, got "wide"'],
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

  test("lights and pins take a name and an icon", () => {
    const config = parseConfig({
      ...base,
      lights: [{ entity: "light.a", anchor: [0, 0, 0], name: "Lamp", icon: "mdi:floor-lamp" }],
      pins: [{ entity: "sensor.t", anchor: [0, 0, 1], name: 21, icon: "hass:thermometer" }],
    });
    expect(config.lights[0]).toMatchObject({ name: "Lamp", icon: "mdi:floor-lamp" });
    expect(config.pins[0]).toEqual({ entity: "sensor.t", anchor: [0, 0, 1], name: "21", icon: "hass:thermometer" });
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
});
