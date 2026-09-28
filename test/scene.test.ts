import { expect, test } from "vitest";
import { PLY_WARN_BYTES, httpErrorMessage, plyWarning } from "../src/scene";

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
