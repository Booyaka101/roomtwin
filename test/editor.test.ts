import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { parseConfig, type Vec3 } from "../src/config";
import { CollinearError, floorFromPoints, roomRanges, toCardConfig, toYaml } from "../src/editor";

describe("floorFromPoints", () => {
  test("a level floor gives +Y up and its height", () => {
    const { up, floor } = floorFromPoints([[0, -1.2, 0], [2, -1.2, 0], [0, -1.2, 3]], [0, 1, 0]);
    expect(up).toEqual([0, 1, 0]);
    expect(floor).toBe(-1.2);
  });

  test("the normal points towards the viewer whatever order the taps came in", () => {
    const viewer: Vec3 = [0, 5, 0];
    expect(floorFromPoints([[0, 0, 0], [0, 0, 3], [2, 0, 0]], viewer).up).toEqual([0, 1, 0]);
    expect(floorFromPoints([[0, 0, 0], [2, 0, 0], [0, 0, 3]], viewer).up).toEqual([0, 1, 0]);
  });

  test("a Z-up capture", () => {
    const { up, floor } = floorFromPoints([[0, 0, 0.5], [1, 0, 0.5], [0, 1, 0.5]], [0, 0, 3]);
    expect(up).toEqual([0, 0, 1]);
    expect(floor).toBe(0.5);
  });

  test("a sloped capture: every tapped point ends up at height 0", () => {
    const points: [Vec3, Vec3, Vec3] = [[0.1, 0.3, -1], [2.2, 0.5, 0.4], [-1, 0.9, 2.5]];
    const { up, floor } = floorFromPoints(points, [0, 5, 0]);
    expect(Math.hypot(...up)).toBeCloseTo(1, 3);
    for (const p of points) expect(up[0] * p[0] + up[1] * p[1] + up[2] * p[2] - floor).toBeCloseTo(0, 3);
  });

  test.each([
    ["in a line", [[0, 0, 0], [1, 0, 0], [3, 0, 0]]],
    ["nearly in a line", [[0, 0, 0], [1, 0, 0.01], [3, 0, 0]]],
    ["with two the same", [[1, 0, 1], [1, 0, 1], [3, 0, 0]]],
    ["all the same", [[1, 0, 1], [1, 0, 1], [1, 0, 1]]],
    ["with two a centimetre apart", [[0, 0, 0], [0.01, 0, 0.001], [3, 0, 2]]],
  ])("rejects points %s", (_, points) => {
    expect(() => floorFromPoints(points as [Vec3, Vec3, Vec3], [0, 1, 0])).toThrow(CollinearError);
  });
});

describe("toYaml", () => {
  const full = {
    type: "custom:roomtwin-card",
    splat: "/local/roomtwin/living room.spz",
    up: [0.0012, 0.9999, -0.0105],
    floor: -1.234,
    ceiling_cut: 2.3,
    aspect_ratio: "4:3",
    lod: false,
    lod_scale: 0.5,
    camera: { position: [1, 1.6, 3], target: [0, 0.8, -1] },
    lights: [
      { entity: "light.floor_lamp", anchor: [1.42, 0.35, -2.1], radius: 1.6, soft_edge: 0.6, off_dim: 0.45 },
      { entity: "switch.fairy_lights", anchor: [-3, 2, 0], radius: 0.5, soft_edge: 0, off_dim: 1 },
    ],
    pins: [
      { entity: "sensor.living_temperature", anchor: [-0.8, 1.1, -2.9] },
      { entity: "binary_sensor.door", anchor: [0, 0, 0], name: "Door: front # main" },
      { entity: "sensor.yes", anchor: [0, 0, 0], name: "yes" },
      { entity: "sensor.quote", anchor: [0, 0, 0], name: 'Say "hi"\nthere' },
      {
        entity: "cover.garage",
        anchor: [2, 0, 1],
        tap_action: { action: "navigate", navigation_path: "/lovelace/garage" },
        hold_action: { action: "perform-action", perform_action: "cover.toggle", target: { entity_id: "cover.garage" }, confirmation: true },
      },
    ],
    grid_options: { columns: "full" },
    visibility: [{ condition: "screen", media_query: "(min-width: 600px)" }],
    card_mod: { style: "ha-card {\n  border: none;\n}\n" },
  };

  test("round-trips a full config through YAML and back into the card's parser", () => {
    const config = parseConfig(full);
    expect(parseConfig(parse(toYaml(config)))).toEqual(config);
  });

  test("round-trips the minimal config and leaves defaults out", () => {
    const config = parseConfig({ type: "custom:roomtwin-card", splat: "/local/roomtwin/living.spz" });
    const yaml = toYaml(config);
    expect(yaml).toBe("type: custom:roomtwin-card\nsplat: /local/roomtwin/living.spz\nup: [0, -1, 0]\n");
    expect(parseConfig(parse(yaml))).toEqual(config);
  });

  test("the stored card config leaves defaults and cleared options out", () => {
    const config = parseConfig({ ...full, floor: 0, lod: true, lod_scale: 1, lights: [], pins: [{ entity: "sensor.t", anchor: [0, 0, 0] }] });
    config.pins[0].name = undefined;
    const card = toCardConfig(config);
    expect(Object.keys(card)).toEqual(["type", "splat", "up", "ceiling_cut", "aspect_ratio", "camera", "pins", "grid_options", "visibility", "card_mod"]);
    expect(card.pins).toEqual([{ entity: "sensor.t", anchor: [0, 0, 0] }]);
  });

  test("writes anchors as flow lists and lights as a block list", () => {
    const yaml = toYaml(parseConfig(full));
    expect(yaml).toContain(
      [
        "lights:",
        "  - entity: light.floor_lamp",
        "    anchor: [1.42, 0.35, -2.1]",
        "    radius: 1.6",
        "    soft_edge: 0.6",
        "    off_dim: 0.45",
      ].join("\n"),
    );
    expect(yaml).toContain('splat: "/local/roomtwin/living room.spz"');
    expect(yaml).toContain('aspect_ratio: "4:3"');
  });

  test("float noise from sliders is rounded away", () => {
    const config = parseConfig({
      ...full,
      lights: [{ entity: "light.a", anchor: [0.1 + 0.2, 0, 0], radius: 0.30000000000000004 }],
    });
    const yaml = toYaml(config);
    expect(yaml).toContain("anchor: [0.3, 0, 0]");
    expect(yaml).toContain("radius: 0.3\n");
  });

  test("actions and other cards' options keep their numbers exactly", () => {
    const config = parseConfig({
      ...full,
      pins: [{ entity: "sensor.t", anchor: [0.1 + 0.2, 0, 0], tap_action: { action: "perform-action", perform_action: "light.turn_on", data: { brightness_pct: 0.123456789 } } }],
      visibility: [{ condition: "numeric_state", entity: "sensor.t", above: 20.000012345 }],
    });
    const card = toCardConfig(config) as { pins: { anchor: number[]; tap_action: { data: { brightness_pct: number } } }[]; visibility: { above: number }[] };
    expect(card.pins[0].anchor).toEqual([0.3, 0, 0]);
    expect(card.pins[0].tap_action.data.brightness_pct).toBe(0.123456789);
    expect(card.visibility[0].above).toBe(20.000012345);
    expect(parse(toYaml(config))).toEqual(card);
  });

  test("keys that YAML would misread are quoted, and empty mappings survive", () => {
    const config = parseConfig({
      ...full,
      card_mod: { style: { "#states > div": "padding: 0;", "": "x" } },
      grid_options: {},
      visibility: [{}],
    });
    const yaml = toYaml(config);
    expect(yaml).toContain('"#states > div": "padding: 0;"');
    expect(yaml).toContain("grid_options: {}");
    expect(parseConfig(parse(yaml))).toEqual(config);
  });
});

describe("roomRanges", () => {
  test("a metric room gets centimetre steps and a cut just under its ceiling", () => {
    expect(roomRanges(2.6)).toEqual({ step: 0.01, radiusMax: 5.2, softEdgeMax: 2.6, cutMax: 3.2, suggestedCut: 2.34, radius: 1, softEdge: 0.5 });
  });

  test("an unscaled COLMAP capture gets ranges that fit it", () => {
    expect(roomRanges(8.62)).toEqual({ step: 0.01, radiusMax: 17.3, softEdgeMax: 8.7, cutMax: 10.4, suggestedCut: 7.76, radius: 3.4, softEdge: 1.7 });
  });

  test("a capture in small units gets finer steps", () => {
    expect(roomRanges(0.4)).toEqual({ step: 0.001, radiusMax: 0.8, softEdgeMax: 0.4, cutMax: 0.48, suggestedCut: 0.36, radius: 0.16, softEdge: 0.08 });
  });

  test("very large and very small captures get whole or fine steps without float noise", () => {
    expect(roomRanges(150)).toMatchObject({ step: 1, radiusMax: 300, cutMax: 180, radius: 60, softEdge: 30 });
    expect(roomRanges(0.05).step).toBe(0.0001);
    expect(roomRanges(0.005).step).toBe(0.00001);
  });

  test("an empty or flat capture falls back to a normal room", () => {
    expect(roomRanges(0)).toEqual({ step: 0.01, radiusMax: 5, softEdgeMax: 2.5, cutMax: 3, suggestedCut: 2.25, radius: 1, softEdge: 0.5 });
  });
});

