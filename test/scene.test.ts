import * as THREE from "three";
import { expect, test } from "vitest";
import { Flight, PLY_WARN_BYTES, httpErrorMessage, plyWarning } from "../src/scene";

test("a 404 under /local names the URL and the folder it maps to", () => {
  expect(httpErrorMessage("/local/roomtwin/living.spz", 404, "Not Found")).toBe(
    "Could not load /local/roomtwin/living.spz (HTTP 404 Not Found). Files in /config/www/ are served at /local/, so this URL expects /config/www/roomtwin/living.spz. If you just created the www folder, restart Home Assistant once.",
  );
});

test("other HTTP errors just name the URL and status", () => {
  expect(httpErrorMessage("https://example.com/a.spz", 503, "")).toBe("Could not load https://example.com/a.spz (HTTP 503).");
  expect(httpErrorMessage("https://example.com/a.spz", 404, "")).toBe("Could not load https://example.com/a.spz (HTTP 404).");
});

test("large .ply files get a warning recommending .spz", () => {
  expect(plyWarning("/local/roomtwin/big.ply", PLY_WARN_BYTES + 1)).toMatch(
    /^\/local\/roomtwin\/big\.ply is a 150 MB \.ply\. Export \.spz/,
  );
  expect(plyWarning("/local/roomtwin/big.ply", PLY_WARN_BYTES)).toBeUndefined();
  expect(plyWarning("/local/roomtwin/big.spz", PLY_WARN_BYTES * 3)).toBeUndefined();
});

const around = (theta: number) => new THREE.Vector3().setFromSpherical(new THREE.Spherical(2, Math.PI / 2, theta));

test("a flight starts at the first view, ends at the second and says when it is over", () => {
  const flight = new Flight(new THREE.Vector3(0, 0, 5), new THREE.Vector3(), new THREE.Vector3(1, 2, 3), new THREE.Vector3(1, 1, 1), 700, (t) => t);
  const position = new THREE.Vector3();
  const target = new THREE.Vector3();
  expect(flight.pose(0, position, target)).toBe(false);
  expect(position.distanceTo(new THREE.Vector3(0, 0, 5))).toBeLessThan(1e-9);
  expect(target.length()).toBeLessThan(1e-9);
  expect(flight.pose(700, position, target)).toBe(true);
  expect(position.distanceTo(new THREE.Vector3(1, 2, 3))).toBeLessThan(1e-9);
  expect(target.distanceTo(new THREE.Vector3(1, 1, 1))).toBeLessThan(1e-9);
});

test("a flight swings the short way round and keeps its distance", () => {
  const flight = new Flight(around(3), new THREE.Vector3(), around(-3), new THREE.Vector3(), 100, (t) => t);
  const position = new THREE.Vector3();
  flight.pose(50, position, new THREE.Vector3());
  expect(position.distanceTo(around(Math.PI))).toBeLessThan(1e-9);
  expect(position.length()).toBeCloseTo(2);
});
