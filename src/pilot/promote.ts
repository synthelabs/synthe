// Approved failures become regression cases in a new pack version. Lane: evidence and review workflow.
import { PilotError } from "./errors.ts";
import { contentId, ms, shortId } from "./ids.ts";
import { personalDataKinds } from "./pii.ts";
import type { Pack, PackCase, PackSummary, PromotionRecord, PromotionRequest, ReplayReport, Sha256, Split, Stored } from "./types.ts";

export interface EligibleFailure { replay_id: Sha256; arm: "baseline" | "candidate"; case_id: string; split: Split; turn: number; check_id: string }

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

// Every decided check failure in the stored replays: what a reviewer may approve as a regression case.
export function eligibleFailures(replays: Stored<ReplayReport>[]): EligibleFailure[] {
  const seen = new Map<string, EligibleFailure>();
  for (const stored of replays) {
    for (const arm of ["baseline", "candidate"] as const) {
      for (const run of stored.value[arm].cases) {
        for (const turn of run.turns) {
          for (const check of turn.checks) {
            if (check.pass !== false) continue; // null means undecided, which is not a failure
            const f: EligibleFailure = { replay_id: stored.id, arm, case_id: run.case_id, split: run.split, turn: turn.turn, check_id: check.id };
            seen.set(JSON.stringify([f.replay_id, f.arm, f.case_id, f.turn, f.check_id]), f);
          }
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => cmp(a.replay_id, b.replay_id) || cmp(a.case_id, b.case_id) || cmp(a.turn, b.turn) || cmp(a.check_id, b.check_id) || cmp(a.arm, b.arm));
}

const invalid = (message: string): never => { throw new PilotError("invalid_promotion", message); };
const nonEmpty = (s: unknown): boolean => typeof s === "string" && s.trim() !== "";

function conversationText(c: Omit<PackCase, "provenance" | "regression">): string[] {
  return c.messages.flatMap((m) => (m.role === "tool" ? [m.result] : [m.text]));
}

// The next pack version. The input pack is not changed. Throws PilotError invalid_promotion, holdout_leak.
export function promote(input: { pack: Stored<Pack>; request: Stored<PromotionRequest>; replays: Stored<ReplayReport>[]; experiment_ids: Sha256[] }): Pack {
  const { pack, request, replays } = input;
  const req = request.value;
  // Work on copies: nothing below may reach back into what the caller holds.
  const old = structuredClone(pack.value);
  if (contentId(pack.value) !== pack.id) throw new PilotError("tampered", "The pack does not match its id, so it was changed after it was frozen. Nothing was promoted.");
  if (contentId(req) !== request.id) throw new PilotError("tampered", "The promotion request does not match its id, so it was changed after it was written. Nothing was promoted.");
  for (const r of replays) if (contentId(r.value) !== r.id) throw new PilotError("tampered", "A stored replay does not match its id, so it cannot be used as evidence. Nothing was promoted.");

  if (req.base_pack_id !== pack.id) invalid("The promotion names a different base pack than the one given. Promote from the pack the approved evidence was gathered on.");
  if (!nonEmpty(req.approver)) invalid("Say who approved this promotion.");
  if (typeof req.at !== "string" || Number.isNaN(ms(req.at))) invalid("The approval time must be a UTC time like 2026-10-01T00:00:00Z.");
  if (req.existing.length === 0 && req.added.length === 0) invalid("The promotion names no cases. List at least one existing or added case.");

  const byId = new Map(old.cases.map((c) => [c.id, c]));
  const failures = eligibleFailures(replays.filter((r) => r.value.pack_id === pack.id));
  const ref = `promotion:${shortId(request.id)}`;
  const regression = (reason: string) => ({ approved_by: req.approver, approved_at: req.at, reason, promotion_ref: ref });

  const promoted = new Set<string>();
  for (const e of req.existing) {
    const c = byId.get(e.case_id);
    if (c === undefined) invalid(`Case ${e.case_id} is not in the base pack.`);
    if (promoted.has(e.case_id)) invalid(`Case ${e.case_id} is listed more than once.`);
    promoted.add(e.case_id);
    if (!nonEmpty(e.reason)) invalid(`Give a reason for promoting case ${e.case_id}.`);
    if (c!.regression !== undefined) invalid(`Case ${e.case_id} is already a regression case.`);
    const ok = failures.some((f) => f.case_id === e.case_id && f.replay_id === e.evidence.replay_id && f.turn === e.evidence.turn && f.check_id === e.evidence.check_id);
    if (!ok) invalid(`The evidence for case ${e.case_id} (replay, turn ${e.evidence.turn}, check ${e.evidence.check_id}) is not a failed check in a stored replay of this pack.`);
  }

  const heldOutIds = new Set(old.cases.filter((c) => c.split === "heldout").map((c) => c.id));
  const added = new Set<string>();
  for (const a of req.added) {
    const id = a.case.id;
    // Named on its own: a proposer must never be able to learn, or overwrite, a held-out case through promotion.
    if (heldOutIds.has(id)) throw new PilotError("holdout_leak", `Case ${id} is a held-out case of the base pack. Held-out cases cannot be replaced or re-added by a promotion.`);
    if (byId.has(id)) invalid(`Case ${id} already exists in the base pack.`);
    if (added.has(id)) invalid(`Case ${id} is added more than once.`);
    added.add(id);
    if (!nonEmpty(a.reason)) invalid(`Give a reason for adding case ${id}.`);
    if (!input.experiment_ids.includes(a.evidence.experiment_id)) invalid(`The evidence for added case ${id} names an experiment that is not one of the experiments given.`);
    if ("provenance" in a.case || "regression" in a.case) invalid(`Added case ${id} sets its own provenance or regression. The promotion sets both.`);
    if (a.case.messages.length === 0 || a.case.checks.length === 0) invalid(`Added case ${id} needs at least one message and one check.`);
    for (const check of a.case.checks) {
      if (old.check_catalog[check.id] === undefined) invalid(`Added case ${id} uses check ${check.id}, which is not in the pack's check catalog.`);
    }
    if (conversationText(a.case).some((t) => personalDataKinds(t).length > 0)) invalid(`Added case ${id} contains what looks like personal data or a secret. Redact it and try again.`);
  }

  const version = old.pack_version + 1;
  const cases: PackCase[] = old.cases.map((c) => {
    const e = req.existing.find((x) => x.case_id === c.id);
    return e === undefined ? c : { ...c, regression: regression(e.reason) };
  });
  for (const a of req.added) {
    cases.push({ ...structuredClone(a.case), provenance: { kind: "promoted", ref, added_in_pack_version: version }, regression: regression(a.reason) });
  }

  // The request cannot express a split change for an existing case; this holds the output to that.
  for (const c of old.cases) {
    if (cases.find((n) => n.id === c.id)?.split !== c.split) throw new PilotError("holdout_leak", `Case ${c.id} would change split. A promotion never moves a case between discovery and held-out.`);
  }

  return { version: 1, name: old.name, pack_version: version, parent_pack_id: pack.id, source: old.source, tools: old.tools, check_catalog: old.check_catalog, cases };
}

const by = (s: PackSummary["by_split"]) => `${s.discovery} discovery, ${s.heldout} held-out`;

export function renderPromotion(record: PromotionRecord, before: PackSummary, after: PackSummary): string {
  return [
    "# Pack promotion",
    "",
    `Approved by ${record.approver} at ${record.at}.`,
    "",
    `- Base pack: ${record.base_pack_id}`,
    `- New pack: ${record.new_pack_id}`,
    `- Promotion request: ${record.request_id}`,
    "",
    "## Promoted cases",
    "",
    ...(record.promoted.length === 0 ? ["None."] : record.promoted.map((p) => `- ${p.case_id} (${p.split}, ${p.kind})`)),
    "",
    "## Case counts",
    "",
    `- Before: ${before.cases} cases (${by(before.by_split)}), ${before.regression_cases} regression cases.`,
    `- After: ${after.cases} cases (${by(after.by_split)}), ${after.regression_cases} regression cases.`,
    "",
    "Held-out cases stay held out, and the previous pack is unchanged.",
    "",
  ].join("\n");
}
