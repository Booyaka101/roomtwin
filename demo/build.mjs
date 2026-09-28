// Builds the live demo page into site/: the shipped card, a simulated home and your scan.
// Usage: node demo/build.mjs [--config demo/room.yaml] [--splat demo/room.spz] [--states demo/states.yaml] [--out site] [--serve] [--port 4173]
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import resolvePlugin from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { rollup } from "rollup";
import { parse } from "yaml";
import { mdiPath } from "./mdi.mjs";

const root = resolve(import.meta.dirname, "..");
const { values: args } = parseArgs({
  options: {
    config: { type: "string", default: "demo/room.yaml" },
    splat: { type: "string" },
    states: { type: "string" },
    out: { type: "string", default: "site" },
    serve: { type: "boolean", default: false },
    port: { type: "string", default: "4173" },
  },
});
const SPLAT_EXTENSIONS = ["spz", "ply", "splat", "ksplat", "sog", "rad"];
const port = Number(args.port);

function fail(message) {
  console.error(`demo: ${message}`);
  process.exit(1);
}

function readYaml(path, what) {
  try {
    return parse(readFileSync(path, "utf8")) ?? {};
  } catch (err) {
    fail(`${what} ${path} is not valid YAML: ${err.message}`);
  }
}

if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--port must be a number from 1 to 65535, got ${args.port}.`);

const card = join(root, "dist", "roomtwin-card.js");
if (!existsSync(card)) fail("dist/roomtwin-card.js is missing. Run npm run build first, or use npm run demo.");

const configPath = resolve(root, args.config);
if (!existsSync(configPath)) {
  fail(`${args.config} is missing. Paste the YAML from the card's Copy YAML button into it (see demo/README.md).`);
}
const config = readYaml(configPath, "The card config");
if (typeof config !== "object" || Array.isArray(config)) fail(`${args.config} must be the card's YAML mapping.`);
for (const key of ["lights", "pins"]) {
  if (config[key] != null && !Array.isArray(config[key])) fail(`${key} in ${args.config} must be a list.`);
}

const splat = args.splat
  ? resolve(root, args.splat)
  : SPLAT_EXTENSIONS.map((ext) => join(root, "demo", `room.${ext}`)).find((path) => existsSync(path));
if (!splat || !existsSync(splat)) fail(`No scan found. Put it at demo/room.spz or pass --splat <file>.`);
const splatExt = extname(splat).slice(1).toLowerCase();
if (!SPLAT_EXTENSIONS.includes(splatExt)) fail(`${splat} must end in ${SPLAT_EXTENSIONS.map((e) => "." + e).join(", ")}.`);
const splatMb = statSync(splat).size / 1e6;
if (splatMb > 100) fail(`${splat} is ${splatMb.toFixed(0)} MB. GitHub refuses files over 100 MB; export an .spz instead.`);
if (splatMb > 50) console.warn(`demo: ${splat} is ${splatMb.toFixed(0)} MB, which visitors on mobile will wait for. An .spz is usually 5 to 10 times smaller.`);
const head = Buffer.alloc(64);
const fd = openSync(splat, "r");
readSync(fd, head, 0, head.length, 0);
closeSync(fd);
if (head.toString("latin1").startsWith("version https://git-lfs")) {
  fail(`${splat} is a Git LFS pointer, not the scan. Run git lfs pull first.`);
}

const statesPath = resolve(root, args.states ?? "demo/states.yaml");
if (args.states && !existsSync(statesPath)) fail(`${args.states} is missing.`);
const states = existsSync(statesPath) ? readYaml(statesPath, "The states file") : {};
if (typeof states !== "object" || Array.isArray(states)) fail(`${statesPath} must map entity ids to a state and attributes.`);

const out = resolve(root, args.out);
if (out === root || !out.startsWith(root + sep)) fail(`--out must be a folder inside the repo, got ${args.out}.`);
if (existsSync(out) && !statSync(out).isDirectory()) fail(`--out must be a folder, and ${args.out} is a file.`);
// The folder is emptied first, so never take one this script didn't make.
if (existsSync(out) && readdirSync(out).length && !existsSync(join(out, "config.json"))) {
  fail(`${args.out} already has other files in it. Pick an empty or new folder for --out.`);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const bundle = await rollup({
  input: join(root, "demo", "demo.ts"),
  plugins: [
    resolvePlugin({ browser: true }),
    typescript({ tsconfig: join(root, "tsconfig.json"), include: ["demo/**/*.ts", "src/**/*.ts"], noEmitOnError: true }),
  ],
  onwarn(warning, warn) {
    if (warning.code !== "CIRCULAR_DEPENDENCY") warn(warning);
  },
});
await bundle.write({ file: join(out, "demo.js"), format: "es" });
await bundle.close();

copyFileSync(join(root, "demo", "index.html"), join(out, "index.html"));
copyFileSync(card, join(out, "roomtwin-card.js"));
copyFileSync(splat, join(out, `room.${splatExt}`));
writeFileSync(join(out, "config.json"), JSON.stringify({ config: { ...config, splat: `room.${splatExt}` }, states }));
writeFileSync(join(out, ".nojekyll"), "");

// Only the icons the page can show get packed, instead of all 7000 MDI paths.
const names = new Set(readFileSync(join(root, "demo", "icons.ts"), "utf8").match(/mdi:[a-z0-9-]+/g));
for (const binding of [...(config.lights ?? []), ...(config.pins ?? [])]) {
  if (typeof binding?.icon === "string") names.add(binding.icon);
}
const icons = {};
for (const name of names) {
  const path = mdiPath(name);
  if (!path) fail(`${name} is not an MDI icon the demo can draw. Check the spelling at https://pictogrammers.com/library/mdi/.`);
  icons[name] = path;
}
writeFileSync(join(out, "icons.json"), JSON.stringify(icons));
console.log(`demo: built ${args.out}/ with ${splat.startsWith(root + sep) ? relative(root, splat).split(sep).join("/") : splat} (${splatMb.toFixed(1)} MB) and ${names.size} icons`);

if (args.serve) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" };
  createServer((req, res) => {
    let path;
    try {
      path = join(out, decodeURIComponent(new URL(req.url, "http://x").pathname));
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }
    const file = path.endsWith(sep) ? join(path, "index.html") : path;
    if (!file.startsWith(out + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  })
    .on("error", (err) => fail(err.code === "EADDRINUSE" ? `port ${port} is taken. Pass --port with another one.` : err.message))
    .listen(port, "localhost", () => console.log(`demo: serving http://localhost:${port}/ (Ctrl+C to stop)`));
}
