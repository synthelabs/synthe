import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pythonSetup } from "./presets.ts";

// Stage 4g for improve mode (swarm/GOAL-3.md, stage 4j). The folders on pytest's path come before the standard
// library, and pytest imports some standard modules for the first time after it starts (pdb, cmd, code). So a new
// src/pdb.py could load the real module and then mark failing tests as passed. Improve mode refuses a change that adds
// a module with the name of a standard or installed module in a folder on the path.

// Every standard module name and every top-level installed module name, for the Python that runs the tests. -I leaves
// out the current folder, PYTHONPATH and the user site, as the measurement does. Each line is "s <name>" or "i <name>".
export const MODULE_NAMES = `import sys, pkgutil
std = set(getattr(sys, "stdlib_module_names", ()))
for n in sorted(std): print("s", n)
for n in sorted({m.name for m in pkgutil.iter_modules()} - std): print("i", n)`;

// The module names that a new file may not take in one folder. "." is the repository root.
export interface ModuleShadow { folder: string; names: string[] }

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// The folders on the path of `python -m pytest` in the repository: the root (python -m puts the current folder
// first), src/ for a src layout, and the folders that the root pytest configuration adds with `pythonpath`.
export function pytestPathFolders(top: string, src: boolean): string[] {
  const folders = [".", ...(src ? ["src"] : [])];
  for (const f of ["pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"]) {
    let text: string;
    try { text = readFileSync(join(top, f), "utf8"); } catch { continue; }
    const m = /^\s*pythonpath\s*=\s*(\[[^\]]*\]|.*)$/m.exec(text);
    if (!m) continue;
    for (const t of m[1].matchAll(/[A-Za-z0-9_.\/-]+/g)) {
      const folder = t[0].replace(/^\.\//, "").replace(/\/$/, "") || ".";
      if (!folder.split("/").includes("..") && !folders.includes(folder)) folders.push(folder);
    }
  }
  return folders;
}

// The names for each folder, or null when the Python could not list its modules. A name that the folder already
// holds is the project's own module, so it stays changeable: the rule refuses only a new module.
export function moduleShadows(top: string, interpreter: string, folders: string[]): ModuleShadow[] | null {
  let out: string;
  try {
    out = execFileSync(interpreter, ["-I", "-c", MODULE_NAMES], { cwd: top, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000, maxBuffer: 16 << 20 });
  } catch { return null; }
  const names = [...new Set(out.split("\n").map((l) => /^[si] ([A-Za-z_][A-Za-z0-9_]*)$/.exec(l.trim())?.[1]).filter((n): n is string => !!n))];
  if (!names.length) return null;
  return folders.map((folder) => {
    const at = join(top, folder);
    return { folder, names: names.filter((n) => !existsSync(join(at, `${n}.py`)) && !isDir(join(at, n))) };
  });
}

// A file that Python imports as a module: name.py, name.pyc, or an extension module such as name.cpython-312.so.
const MODULE_FILE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.pyc?|(?:\.[\w-]+)?\.(?:so|pyd))$/;

// null when the path may change; otherwise one sentence that starts with the path and gives the rule.
export function shadowProblem(path: string, shadows: ModuleShadow[] | undefined): string | null {
  for (const s of shadows ?? []) {
    const rest = s.folder === "." ? path : path.startsWith(`${s.folder}/`) ? path.slice(s.folder.length + 1) : null;
    if (!rest) continue;
    const parts = rest.split("/");
    const name = parts.length > 1 ? parts[0] : MODULE_FILE.exec(parts[0])?.[1];
    if (name && s.names.includes(name)) {
      return `${path} would add a module named ${name} in ${s.folder === "." ? "the repository root" : s.folder}, which is on the test path before the standard library and the installed modules; it would load in place of the real ${name}.`;
    }
  }
  return null;
}

// For a repository with Python tests (the pytest preset, or pytest as the regression check): the shadow lists for the
// Python that runs them. undefined for any other repository, or when that Python could not list its modules.
export function pythonShadows(top: string): ModuleShadow[] | undefined {
  const py = pythonSetup(top);
  if (!py) return undefined;
  return moduleShadows(top, py.interpreter, pytestPathFolders(top, py.src)) ?? undefined;
}
