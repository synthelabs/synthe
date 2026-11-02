import { createHash } from "node:crypto";
import type { Delimiter, PromptLocation } from "./goal.ts";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const MAX_PROMPT_CHARS = 20_000;

// From Synthe's synthe_risk.py: paths that run code, ship dependencies, alter CI or hold secrets.
const SENSITIVE_PATHS = [
  /^\.github\//, /^\.gitlab-ci\.yml$/, /^\.circleci\//, /^Jenkinsfile$/, /\.pem$/, /\.key$/, /(^|\/)id_rsa/, /(^|\/)id_ed25519/,
  /(^|\/)\.env(\.|$)/, /(^|\/)Dockerfile/, /(^|\/)package(-lock)?\.json$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)yarn\.lock$/,
  /(^|\/)(poetry|uv|Cargo)\.lock$/, /(^|\/)go\.sum$/, /(^|\/)setup\.py$/, /(^|\/)pyproject\.toml$/, /(^|\/)Makefile$/,
  /^scripts\/.*\.sh$/, /^bin\//, /(^|\/)CODEOWNERS$/, /(^|\/)\.gitattributes$/,
];

const SECRET_SHAPES = [/sk-ant-[\w-]{8,}/, /sk-[A-Za-z0-9]{20,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY/];

export function promptPathProblem(path: string): string | null {
  if (path.startsWith("/") || path.split("/").includes("..")) return "prompt path must stay inside the repo";
  return SENSITIVE_PATHS.some((p) => p.test(path)) ? `refusing sensitive path ${path}` : null;
}

// Returns why this text must not be written into the prompt, or null when it is safe.
export function candidateProblem(text: unknown, location: PromptLocation): string | null {
  if (typeof text !== "string" || !text.trim()) return "candidate is empty";
  if (text.length > MAX_PROMPT_CHARS) return "candidate is too long";
  if (SECRET_SHAPES.some((s) => s.test(text))) return "candidate looks like it contains a secret";
  if (location.kind === "inline") {
    const problem = literalProblem(text, location.delimiter);
    if (problem) return problem;
  }
  return null;
}

// An inline prompt is pasted between the source's own quotes, so it must not be able to end them.
function literalProblem(text: string, delimiter: Delimiter): string | null {
  if (text.includes("\\")) return "candidate contains a backslash";
  if (text.includes(delimiter)) return "candidate would end the source string";
  if (delimiter === "`" && text.includes("${")) return "candidate would run code in a template string";
  if ((delimiter === '"' || delimiter === "'") && /[\r\n]/.test(text)) return "candidate is multi-line in a one-line string";
  return null;
}
