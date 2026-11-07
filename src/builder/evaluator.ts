import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export const EVALUATOR_IMAGE = "docker.io/library/node@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9";
const COMMAND_TIMEOUT = 65_000;
const CONTROL_TIMEOUT = 10_000;
const MAX_OUTPUT = 256 * 1024;
const docker = promisify(execFile);

export class EvaluationInterrupted extends Error {
  constructor() { super("Builder was interrupted."); }
}

export async function createEvaluator(root: string) {
  if (process.platform === "win32") {
    throw new Error("Run Builder from macOS or Linux, or from WSL with Docker integration enabled.");
  }
  const { HOME, DOCKER_CONFIG, DOCKER_CONTEXT, DOCKER_HOST } = process.env;
  const PATH = process.env.PATH?.split(delimiter).filter(isAbsolute).join(delimiter) || "/usr/bin:/bin";
  let socket: string;
  try {
    const context = await docker("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
      cwd: root, env: { PATH, HOME, DOCKER_CONFIG, DOCKER_CONTEXT, DOCKER_HOST },
      timeout: CONTROL_TIMEOUT, maxBuffer: MAX_OUTPUT,
    });
    socket = DOCKER_CONTEXT ? context.stdout.trim() : (DOCKER_HOST ?? context.stdout.trim());
  } catch {
    throw new Error("Builder needs a local Docker Engine. Install and start Docker, then try again.");
  }
  if (!/^unix:\/\/\/[^\r\n\0]+$/.test(socket)) {
    throw new Error("Select a local Docker context with a Unix socket before running Builder.");
  }

  // A fresh client config prevents Docker from injecting host proxy credentials.
  const config = join(root, "docker");
  mkdirSync(config, { mode: 0o700 });
  const call = (args: string[], timeout = CONTROL_TIMEOUT, signal?: AbortSignal) => docker(
    "docker", ["--config", config, "--host", socket, ...args],
    { cwd: root, env: { PATH }, timeout, signal, maxBuffer: MAX_OUTPUT, killSignal: "SIGKILL" },
  );
  try {
    await call(["info", "--format", "{{.OSType}}"]).then(({ stdout }) => {
      if (stdout.trim() !== "linux") throw new Error();
    });
  } catch {
    throw new Error("Start a local Docker Engine in Linux container mode before running Builder.");
  }
  try {
    await call(["image", "inspect", EVALUATOR_IMAGE]);
  } catch {
    throw new Error(`Prepare the Builder evaluator first: docker pull ${EVALUATOR_IMAGE}`);
  }

  return async (archive: Buffer, command: string) => {
    const name = `synthe-builder-${randomUUID()}`;
    const abort = new AbortController();
    const interrupt = () => abort.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      await call([
        "create", "--name", name, "--pull", "never", "--interactive", "--init",
        "--network", "none", "--ipc", "none", "--read-only", "--user", "1000:1000",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "128", "--cpus", "1", "--memory", "512m", "--memory-swap", "512m",
        "--log-driver", "none", "--workdir", "/workspace", "--env", "HOME=/tmp",
        "--tmpfs", "/workspace:rw,nosuid,nodev,mode=1777,size=128m",
        "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=64m",
        "--entrypoint", "/bin/sh", EVALUATOR_IMAGE,
        "-c", 'tar -xf - --no-same-owner --no-same-permissions && exec timeout -k 2s 55s /bin/sh -c "$1"',
        "synthe-evaluator", command,
      ]);
      abort.signal.throwIfAborted();
      const run = call(["start", "--attach", "--interactive", name], COMMAND_TIMEOUT, abort.signal);
      run.child.stdin?.on("error", () => {}); // The evaluator may exit before reading all input.
      run.child.stdin?.end(archive);
      const { stdout } = await run;
      return { ok: true, stdout };
    } catch {
      if (abort.signal.aborted) throw new EvaluationInterrupted();
      return { ok: false, stdout: "" };
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      await call(["rm", "--force", name]).catch(() => {});
    }
  };
}
