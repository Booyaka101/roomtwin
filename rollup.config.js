import resolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/roomtwin-card.ts",
  output: {
    file: "dist/roomtwin-card.js",
    format: "es",
    inlineDynamicImports: true,
  },
  plugins: [
    resolve({ browser: true }),
    typescript({ tsconfig: "./tsconfig.json", include: ["src/**/*.ts"] }),
    terser({ format: { comments: /@license|@preserve|^!/ } }),
  ],
};
