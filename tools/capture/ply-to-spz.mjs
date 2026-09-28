// Converts a Gaussian splat .ply (Brush, gsplat, Postshot, ...) to .spz with Spark's own encoder.
// Usage: node tools/capture/ply-to-spz.mjs input.ply [output.spz]
import { readFile, writeFile } from "node:fs/promises";
import { transcodeSpz } from "@sparkjsdev/spark";

const [input, outputArg] = process.argv.slice(2);
if (!input) {
  console.error("Usage: node tools/capture/ply-to-spz.mjs input.ply [output.spz]");
  process.exit(2);
}
const output = outputArg ?? input.replace(/\.ply$/i, "") + ".spz";

const started = Date.now();
const fileBytes = new Uint8Array(
  await readFile(input).catch((err) => {
    console.error(`Cannot read ${input}: ${err.code === "ENOENT" ? "no such file" : err.message}`);
    process.exit(1);
  }),
);
const { fileBytes: spz } = await transcodeSpz({ inputs: [{ fileBytes, pathOrUrl: input }], maxSh: 3 });
await writeFile(output, spz);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`${input} (${mb(fileBytes.length)} MB) -> ${output} (${mb(spz.length)} MB) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
