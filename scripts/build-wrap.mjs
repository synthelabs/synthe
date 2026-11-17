// Builds the package entry `synthe/pilot` (the pilot's recorder, src/pilot/wrap.ts) as dist/wrap.mjs and
// dist/wrap.cjs, with types in dist/wrap.d.ts and dist/wrap.d.cts. The output is the same bytes on every build.
// Usage: node scripts/build-wrap.mjs [output folder]   (default: dist; the test builds into a temporary folder)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? join(root, "dist"));
const entry = join(root, "src/pilot/wrap.ts");
mkdirSync(outDir, { recursive: true });

for (const [format, file] of [["esm", "wrap.mjs"], ["cjs", "wrap.cjs"]]) {
  await build({ entryPoints: [entry], bundle: true, platform: "node", format, target: "node20", outfile: join(outDir, file), logLevel: "warning" });
}

// Types: tsc runs in a temporary folder (so the repo's tsconfig.json is not read, which tsc refuses beside a file
// argument) and writes there, then the one file is copied under both names. The .d.cts is the
// same text: wrap.ts has no default export, so a CommonJS consumer sees the same names.
const tmp = mkdtempSync(join(tmpdir(), "synthe-wrap-types-"));
try {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), entry, "--declaration", "--emitDeclarationOnly", "--allowImportingTsExtensions", "--module", "nodenext", "--target", "es2022", "--types", "node", "--typeRoots", join(root, "node_modules/@types"), "--outDir", tmp], { cwd: tmp, stdio: ["ignore", "pipe", "pipe"] });
  copyFileSync(join(tmp, "wrap.d.ts"), join(outDir, "wrap.d.ts"));
  copyFileSync(join(tmp, "wrap.d.ts"), join(outDir, "wrap.d.cts"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
