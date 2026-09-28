// Converts a Gaussian splat .ply (Brush, gsplat, Postshot, ...) to .spz with Spark's own encoder.
// Usage: node tools/capture/ply-to-spz.mjs input.ply [output.spz]
import { readFile, writeFile } from "node:fs/promises";
import { transcodeSpz } from "@sparkjsdev/spark";

const [input, output = input.replace(/\.ply$/i, "") + ".spz"] = process.argv.slice(2);
if (!input) {
  console.error("Usage: node tools/capture/ply-to-spz.mjs input.ply [output.spz]");
  process.exit(2);
}

const started = Date.now();
const fileBytes = new Uint8Array(await readFile(input));
const { fileBytes: spz } = await transcodeSpz({ inputs: [{ fileBytes, pathOrUrl: input }], maxSh: 3 });
await writeFile(output, spz);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`${input} (${mb(fileBytes.length)} MB) -> ${output} (${mb(spz.length)} MB) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
