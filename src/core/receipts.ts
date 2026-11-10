import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { oidcToken, requireOidc } from "./share.ts";

const ENDPOINT = "https://synthe-crimson.vercel.app/api/collect/receipt";
const AUDIENCE = "synthe-receipts";
const EVENT_ENDS = Date.parse("2026-11-08T23:59:00Z");
const CONCLUSIONS = new Set(["success", "failure", "cancelled", "skipped", "timed_out", "neutral", "action_required", "stale", "startup_failure"]);
// The workflow's own finish job runs at most 40 minutes (the job timeouts) after a round starts.
const OWN_FINISH_ENDS = EVENT_ENDS + 3600_000;
const OWN_CONCLUSIONS = new Set(["success", "failure", "cancelled"]);

interface FinishReceipt {
  kind: "finish";
  run_id: string;
  attempt: string;
  conclusion: string;
}
// Sent by the Synthe workflow's last job about its own run. The proxy takes the run ID and attempt from the signed
// token, so a workflow can only finish its own run.
interface OwnFinishReceipt {
  kind: "finish";
  conclusion: string;
}
interface DeliveryOptions {
  conclusion?: string;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function finishReceipt(eventPath: string | undefined, repositoryId: string | undefined): FinishReceipt | null {
  let event;
  try {
    if (!eventPath) throw new Error();
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    throw new Error("GitHub did not provide the completed Synthe run. Rerun this collector from Actions.");
  }
  const run = event?.workflow_run;
  // GitHub can append @ref to the path. The file and both repository IDs still have to match.
  if (event?.action !== "completed" || run?.status !== "completed" || !repositoryId || String(event.repository?.id) !== repositoryId
    || String(run?.repository?.id) !== repositoryId || String(run?.head_repository?.id) !== repositoryId
    || typeof run?.path !== "string" || run.path.split("@", 1)[0] !== ".github/workflows/synthe.yml") return null;

  const startedAt = Date.parse(run.run_started_at ?? run.created_at ?? "");
  if (startedAt >= EVENT_ENDS) return null;
  if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || run.run_attempt > 9999
    || !CONCLUSIONS.has(run.conclusion)) {
    throw new Error("GitHub did not provide a run ID, attempt and conclusion. Rerun this collector from Actions.");
  }
  return { kind: "finish", run_id: String(run.id), attempt: String(run.run_attempt), conclusion: run.conclusion };
}

export async function deliverReceipt(step: "receipt-start" | "receipt-finish", eventCode: string, teamCode: string, options: DeliveryOptions = {}): Promise<boolean> {
  const { env = process.env, fetcher = fetch, sleep = delay, now = Date.now } = options;
  if (step === "receipt-start" && now() >= EVENT_ENDS) return false;
  // GitHub never starts the completion workflow for runs started with GITHUB_TOKEN (every chained round), so the
  // Synthe workflow's last job reports its own outcome. The completion workflow still covers runs that never got there.
  const own = step === "receipt-finish" && env.GITHUB_EVENT_NAME !== "workflow_run";
  if (own && now() >= OWN_FINISH_ENDS) return false;
  if (own && !OWN_CONCLUSIONS.has(options.conclusion ?? "")) {
    throw new Error("Crimson tracking couldn't tell how this run ended. Commit the files from `npx synthe upgrade --event` and rerun.");
  }
  const receipt: { kind: "start" } | FinishReceipt | OwnFinishReceipt | null = step === "receipt-start" ? { kind: "start" }
    : own ? { kind: "finish", conclusion: options.conclusion! } : finishReceipt(env.GITHUB_EVENT_PATH, env.GITHUB_REPOSITORY_ID);
  if (!receipt) return false;
  if (!eventCode.trim() || !teamCode.trim()) {
    throw new Error("Crimson tracking needs both repository secrets, SYNTHE_EVENT_CODE and SYNTHE_TEAM_CODE. Add them in GitHub Actions settings, then rerun.");
  }
  requireOidc(env);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(attempt * 1000);
    let status: number | undefined;
    try {
      const signal = AbortSignal.timeout(10_000);
      const token = await oidcToken(AUDIENCE, env, fetcher, signal);
      const response = await fetcher(ENDPOINT, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "x-synthe-event": eventCode.trim(), "x-synthe-team": teamCode.trim() },
        body: JSON.stringify(receipt),
      });
      if (response.ok) {
        const ack: unknown = await response.json();
        if (ack && typeof ack === "object" && "ok" in ack && ack.ok === true) return true;
      } else {
        status = response.status;
        await response.body?.cancel();
      }
    } catch { /* Retry transport failures. Keep response bodies and credential-bearing errors out of logs. */ }
    if (status === 401) throw new Error("Crimson tracking couldn't verify this GitHub workflow. Commit the files from `npx synthe upgrade --event` and rerun.");
    if (status === 403) throw new Error("Crimson tracking refused this team or repository. Check the event and team codes with the organizer, then rerun.");
    if (status !== undefined && status !== 409 && status !== 429 && status < 500) {
      throw new Error(`Crimson tracking refused this receipt (HTTP ${status}). Ask the organizer before rerunning.`);
    }
  }
  throw new Error("Crimson tracking didn't acknowledge this run after three attempts. Rerun from Actions or ask the organizer.");
}
