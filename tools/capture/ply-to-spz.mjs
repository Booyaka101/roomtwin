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
// Spark compiles its wasm in the background on import and exports no promise for it, so retry until it is ready.
async function transcode(options) {
  for (let waited = 0; ; waited += 50) {
    try {
      return await transcodeSpz(options);
    } catch (err) {
      if (waited > 10000 || !String(err?.message).includes("__wbindgen")) throw err;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}
const { fileBytes: spz } = await transcode({ inputs: [{ fileBytes, pathOrUrl: input }], maxSh: 3 });
await writeFile(output, spz);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`${input} (${mb(fileBytes.length)} MB) -> ${output} (${mb(spz.length)} MB) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
