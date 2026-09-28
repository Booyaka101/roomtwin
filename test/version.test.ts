import { expect, test } from "vitest";
import pkg from "../package.json";
import { VERSION } from "../src/version";

test("the card reports the version in package.json", () => {
  expect(VERSION).toBe(pkg.version);
});
