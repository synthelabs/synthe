// Operator mutation testing for the decision code, with StrykerJS. It replaces the slow approach of copying the repo
// and running every test file once per mutant: Stryker builds all mutants into one copy behind switches, records which
// test files reach each mutant, runs only those (stopping at the first failure), and with --incremental re-runs only
// mutants whose code or covering tests changed since the last report.
//
//   npm run mutation:operators              existing tests + the Lean differential test
//   MUTATION_SET=existing npm run ...        existing tests alone (to see what only Lean catches)
//   MUTATION_SKIP=test/a.test.ts,...         leave out test files that fail on this machine before any mutation
//   node mutation/compare.mjs                kill rates for both sets, and the mutants only Lean kills
//
// This is separate from `npm run mutation` (scripts/mutation-check.mjs), whose mutants were written by hand for
// known failure modes; these are generated mechanically, so they also find what nobody thought to write.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const MUTATE = ["src/core/merge-rule.ts", "src/improve/verdict.ts"];
const set = process.env.MUTATION_SET === "existing" ? "existing" : "with-lean";
const skip = new Set((process.env.MUTATION_SKIP ?? "").split(",").filter(Boolean));

// Only test files that import a mutated file, directly or through other modules, so the first full run (which
// records coverage) doesn't spend minutes on unrelated end-to-end tests.
const files = [
  ...readdirSync("src", { recursive: true }).filter((f) => f.endsWith(".ts")).map((f) => `src/${f}`),
  ...readdirSync("test").filter((f) => f.endsWith(".ts")).map((f) => `test/${f}`),
];
const imports = Object.fromEntries(files.map((f) => [f, [...readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)]
  .map((m) => normalize(join(dirname(f), m[1])).replace(/\.js$/, ".ts"))]));
const reaches = (f, seen = new Set()) => { if (seen.has(f)) return seen; seen.add(f); for (const d of imports[f] ?? []) reaches(d, seen); return seen; };
const testFiles = files.filter((f) => f.endsWith(".test.ts") && !skip.has(f) && MUTATE.some((m) => reaches(f).has(m)))
  .filter((f) => set === "with-lean" || f !== "test/lean-spec.test.ts");

export default {
  testRunner: "tap",
  plugins: ["@stryker-mutator/tap-runner"],
  tap: { testFiles },
  mutate: MUTATE,
  coverageAnalysis: "perTest",
  // TypeScript 7 has no JavaScript API for Stryker's tsconfig step, and Node strips the types itself.
  tsconfigFile: "mutation/no-tsconfig.json",
  timeoutMS: 60000,
  // Keep the Lean binary in Stryker's sandbox copy (it is gitignored).
  ignorePatterns: ["!spec/.lake/build/bin/**", "mutation/reports"],
  // Operator mutants only: comparisons, &&/||, +/-, and conditions forced true or false. Text and literal mutants
  // mostly change wording, which is reviewed by reading, not by tests.
  mutator: { excludedMutations: ["StringLiteral", "ObjectLiteral", "ArrayDeclaration", "BlockStatement", "Regex", "OptionalChaining",
    "MethodExpression", "UpdateOperator", "AssignmentOperator", "BooleanLiteral", "UnaryOperator", "ArrowFunction"] },
  incremental: true,
  incrementalFile: `mutation/reports/incremental-${set}.json`,
  // The run fails below this kill rate (with-lean set: 81.0% at 4ef9a76), so a change that weakens the tests is caught.
  thresholds: { high: 90, low: 80, break: set === "with-lean" ? 80 : null },
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: `mutation/reports/${set}.json` },
  cleanTempDir: "always",
};
