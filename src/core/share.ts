import type { Goal } from "./goal.ts";
import type { RoundRecord, State } from "./state.ts";

const ENDPOINT = "https://synthe-share.vercel.app/api/round";
const SECRETS: [RegExp, string][] = [
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, "[key removed]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[token removed]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email removed]"],
  [/(?<![\w.])\+?\d[\d ().-]{8,}\d(?![\w.])/g, "[phone removed]"],
];
export const scrub = (text: string): string => SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
const limited = (text: string, max: number) => scrub(text).slice(0, max);
const measure = (value: number | null | undefined, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;

export function stopCode(stopped: string | null): string | null {
  if (!stopped) return null;
  if (/^budget of .* is used$/.test(stopped)) return "budget";
  if (/^reached \d+ rounds$/.test(stopped)) return "max rounds";
  if (/^\d+ rounds in a row found no winner$/.test(stopped)) return "stalled";
  if (/^stopped by (the )?team/i.test(stopped)) return "stopped by team";
  if (stopped === "spend could not be measured") return "spend unknown";
  return "other";
}

export function sharePayload(goal: Goal, state: State, record: RoundRecord, version: string) {
  const payload = {
    round: record.round,
    outcome: record.outcome,
    mode: goal.merge_rule.mode,
    checksBefore: measure(record.checks?.before, 100),
    checksAfter: measure(record.checks?.after, 100),
    costUsd: measure(record.costUsd, 100),
    spentUsd: state.spendUnknown ? null : measure(state.spendUsd, 1000),
    stop: stopCode(state.stopped),
    version,
  };
  if (goal.share !== "detail") return payload;
  const edits = record.edits?.slice(0, 2).map((edit) => ({ find: limited(edit.find, 1500), replace: limited(edit.replace, 1500) }));
  return {
    ...payload,
    detail: {
      objective: limited(goal.objective, 2000),
      checks: (goal.checks ?? []).slice(0, 5).map((check) => limited(check, 300)),
      change: edits?.length ? {
        title: limited(record.title ?? record.changed ?? "Prompt change", 120),
        summary: limited(record.changed ?? record.plain ?? "", 1000),
        edits,
      } : null,
      example: record.example ? {
        input: limited(record.example.input, 2000),
        before: limited(record.example.before, 2000),
        after: limited(record.example.after, 2000),
      } : null,
    },
  };
}

type OidcEnv = Partial<Pick<NodeJS.ProcessEnv, "ACTIONS_ID_TOKEN_REQUEST_URL" | "ACTIONS_ID_TOKEN_REQUEST_TOKEN">>;
export async function shareRound(payload: ReturnType<typeof sharePayload>, env: OidcEnv, fetcher: typeof fetch = fetch): Promise<string> {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return "Sharing skipped: this workflow needs OIDC permission. Run `npx synthe upgrade`.";
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timed out")); }, 10_000);
    });
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    url.searchParams.set("audience", "synthe-share");
    const tokenResponse = await Promise.race([fetcher(url, {
      headers: { Authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: controller.signal,
    }), timeout]);
    if (!tokenResponse.ok) return `Sharing skipped: GitHub OIDC returned ${tokenResponse.status}.`;
    const token = (await Promise.race([tokenResponse.json(), timeout]) as { value?: unknown }).value;
    if (typeof token !== "string" || !token) return "Sharing skipped: GitHub OIDC returned no token.";
    const response = await Promise.race([fetcher(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }), timeout]);
    return response.ok ? `Shared round ${payload.round} with Synthe.` : `Sharing skipped: endpoint returned ${response.status}.`;
  } catch (error) {
    return `Sharing skipped: ${error instanceof Error && error.message === "timed out" ? "request timed out" : "request failed"}.`;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
