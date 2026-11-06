// Runs before `npm publish`. Event setups write `uses: synthelabs/synthe@v<version>` into each team's workflow
// (CRIMSON_ACTION in src/cli/init.ts), so a package published before its tag exists installs workflows that
// GitHub cannot resolve: no receipt, no round, nothing on the organizer dashboard. 1.8.0 shipped that way.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PIN_FILES, pinProblems } from "./version-pins.mjs";

// `git ls-remote` output for one tag: an annotated tag lists the tag object and its peeled commit (`^{}`).
export function releaseTagProblem(version, head, lsRemote) {
  const tag = `refs/tags/v${version}`;
  const refs = new Map(lsRemote.split("\n").filter(Boolean).map((line) => line.split("\t").reverse()));
  const commit = refs.get(`${tag}^{}`) ?? refs.get(tag);
  if (!commit) return `Tag v${version} is not on GitHub. Push it at this commit before publishing: git tag -a v${version} -m "Synthe ${version}" && git push origin v${version}`;
  if (commit !== head) return `Tag v${version} points to ${commit.slice(0, 7)}, but you are publishing ${head.slice(0, 7)}. Publish from the tagged commit.`;
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const stale = pinProblems(version, Object.fromEntries([...PIN_FILES, "src/cli/guide.ts"].map((file) => [file, read(file)])));
  if (stale.length) {
    console.error(`These setup pins name another version than ${version}: ${stale.join(", ")}. Run \`node scripts/version-pins.mjs && npm run build\` and commit.`);
    process.exit(1);
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const problem = releaseTagProblem(version, git("rev-parse", "HEAD"), git("ls-remote", "--tags", "origin", `refs/tags/v${version}`, `refs/tags/v${version}^{}`));
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Tag v${version} is on GitHub at this commit.`);
}
