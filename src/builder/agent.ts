import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

export type CodingAgent = "codex" | "claude";

type AgentOptions = {
  timeoutMs?: number;
  /** Override only for a trusted local executable, such as a test double. */
  executable?: string;
};

const DEFAULT_TIMEOUT_MS = 180_000;
const CHECK_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const SAFE_ENV = new Set([
  "path", "home", "userprofile", "systemroot", "windir", "comspec", "pathext",
  "appdata", "localappdata", "xdg_config_home", "xdg_data_home", "lang", "lc_all", "codex_home",
]);
const EXEC_FLAGS = [
  "--ask-for-approval", "never", "exec",
  "--sandbox", "workspace-write", "--ephemeral", "--ignore-user-config",
  "--disable", "hooks", "--disable", "plugins", "--disable", "apps",
  "--disable", "browser_use", "--disable", "computer_use", "--disable", "multi_agent",
  "-c", "mcp_servers={}",
  "-c", "sandbox_workspace_write.network_access=false",
  "-c", "sandbox_workspace_write.writable_roots=[]",
  "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
  "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
  "-c", "shell_environment_policy.experimental_use_profile=false",
  "-c", 'web_search="disabled"',
  "--color", "never",
];

function agentEnvironment(): NodeJS.ProcessEnv {
  // The CLI may use an existing sign-in from its normal auth store. The event/team
  // credentials and other tokens from Synthe's process are not forwarded.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => SAFE_ENV.has(key.toLowerCase())));
}

function codexOnly(kind: CodingAgent) {
  if (kind !== "codex") {
    throw new Error("This preview runs through the local Codex CLI. Claude Code is not supported by this runner yet.");
  }
}

function run(executable: string, args: string[], timeoutMs: number, cwd?: string, input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== "win32";
    const child = spawn(executable, args, {
      cwd, env: agentEnvironment(), shell: false, windowsHide: true, detached: processGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let done = false;
    let bytes = 0;
    let stderr = "";
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
      if (error) reject(error);
      else resolve();
    };
    const stop = (message: string) => {
      if (done) return;
      try {
        if (processGroup && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // It may have exited while we were stopping it.
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(new Error(message));
    };
    const timer = setTimeout(() => stop("Codex did not finish within the trial time limit."), timeoutMs);
    const interrupted = () => stop("Codex trial interrupted.");
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop("Codex exceeded the trial output limit.");
    };
    child.stdout.on("data", count);
    child.stderr.on("data", (chunk: Buffer) => {
      count(chunk);
      // Retain just enough output to recognize sign-in errors. Never surface raw
      // agent output, which may include repo contents or secrets.
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });
    child.stdin.on("error", () => {}); // A CLI that rejects an invocation may close stdin early.
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(new Error(error.code === "ENOENT"
        ? "Codex CLI was not found. Install Codex and run codex login before trying again."
        : "Could not start the local Codex CLI."));
    });
    child.on("close", (code) => {
      if (code === 0) return finish();
      if (/not logged in|not authenticated|authentication required|run `?codex login/i.test(stderr)) {
        return finish(new Error("Codex is not signed in. Run codex login, then try again."));
      }
      finish(new Error("Codex did not complete the trial. Check that Codex is signed in and up to date."));
    });
    child.stdin.end(input);
  });
}

/** Check installed CLI and stored sign-in without running a model. */
export async function checkCodingAgent(kind: CodingAgent, options: AgentOptions = {}): Promise<void> {
  codexOnly(kind);
  const executable = options.executable ?? "codex";
  await run(executable, ["--version"], CHECK_TIMEOUT_MS);
  try {
    await run(executable, [...EXEC_FLAGS, "--help"], CHECK_TIMEOUT_MS);
  } catch {
    throw new Error("Update the local Codex CLI before trying a sandboxed builder run.");
  }
  await run(executable, ["login", "status"], CHECK_TIMEOUT_MS);
}

export function createCodingAgent(kind: CodingAgent, options: AgentOptions = {}) {
  codexOnly(kind);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new Error("Codex trial time must be between 1 ms and 10 minutes.");
  }
  return async (cwd: string, prompt: string): Promise<void> => {
    if (!prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
      throw new Error("Provide a coding prompt between 1 byte and 32 KiB.");
    }
    let workspace: string;
    try {
      workspace = realpathSync(cwd);
    } catch {
      throw new Error("The Codex trial directory is unavailable.");
    }
    await run(options.executable ?? "codex", [
      ...EXEC_FLAGS, "--cd", workspace,
      "-c", `projects.${JSON.stringify(workspace)}.trust_level="untrusted"`,
      "-",
    ], timeoutMs, workspace, prompt);
  };
}
