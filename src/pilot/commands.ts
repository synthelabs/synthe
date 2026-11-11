import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "../core/evidence.ts";
import { githubRepo, type Repo } from "../github/repo.ts";
import { makeApproval, requireApproval } from "./approval.ts";
import { CONFIG_FILE, GITHUB_API, parsePilotConfig } from "./config.ts";
import { discoverFailures, makeCandidate, proposerContext, renderFindings } from "./discover.ts";
import { assertEgressSafe, sensitiveIndex } from "./egress.ts";
import { PilotError } from "./errors.ts";
import { analyzeExperiment, buildExperimentSpec, renderDecision, renderExperimentSpec } from "./experiment.ts";
import { candidateTag, contentId, isSha256, ms, shortId } from "./ids.ts";
import { inside, readBounded, writeOnce } from "./io.ts";
import { liveModel, type LiveOptIn } from "./live.ts";
import { modelProposer, parseModelScript, parseProposerScript, scriptedModel, scriptedProposer } from "./model.ts";
import { packSummary, parsePack } from "./pack.ts";
import { eligibleFailures, promote, renderPromotion } from "./promote.ts";
import { publishReview } from "./publish.ts";
import { pairArms, renderReplay, replayArm } from "./replay.ts";
import { renderPilotReport } from "./report.ts";
import { buildReviewBundle, renderReview } from "./review.ts";
import { PilotStore } from "./store.ts";
import { baselineReport, importTelemetry, renderBaseline } from "./telemetry.ts";
import type {
  Approval, ArmRun, BaselineReport, Candidate, ChatModel, ExperimentAnalysis, ExperimentSpec, FailureFinding, IsoTime, Pack, PilotConfig,
  PromotionRecord, PromotionRequest, Proposer, ReplayReport, ReviewBundle, Sha256, Stored, TelemetryImport,
} from "./types.ts";

// Everything the commands touch outside their arguments, so tests and the demo can stand in for each piece.
export interface PilotDeps {
  say(line: string): void;
  env: Record<string, string | undefined>;
  now(): Date;
  // GitHub access for a publication. Default: the real API through src/github/repo.ts.
  github?(slug: string, token: string, api: string): Repo;
  // Runs git in a checkout and returns stdout. Default: the git on PATH.
  git?(args: string[], cwd: string): string;
  // Transport for a live model provider (tests point it at a loopback server).
  fetch?: typeof fetch;
  // Test hook: called at named points so a crash can be injected there.
  fault?(point: string): void;
}

// The one variable a publication reads its GitHub token from. There is no fallback to GITHUB_TOKEN or GH_TOKEN:
// an ambient token must not be enough to publish.
export const GITHUB_TOKEN_ENV = "SYNTHE_PILOT_GITHUB_TOKEN";

// How many reasons a command prints before pointing at the report file.
const SHOWN = 4;

export type Flags = Record<string, string | boolean | undefined>;
const need = (flags: Flags, name: string, hint: string): string => {
  const v = flags[name];
  if (typeof v !== "string" || !v.trim()) throw new PilotError("usage", `--${name} is required: ${hint}`);
  return v;
};
const opt = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
const iso = (d: Date): IsoTime => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function defaultGit(args: string[], cwd: string): string {
  // SYNTHE_* settings stay out of child processes, as in src/cli/main.ts.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SYNTHE_")));
  return execFileSync("git", args, { cwd, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

// ---------------------------------------------------------------------------------------------------------------
// What the journal says about the pilot so far.
// ---------------------------------------------------------------------------------------------------------------

export interface Frozen { config_id: Sha256; config: PilotConfig; baseline_prompt_id: Sha256; commit: string }

export function frozen(store: PilotStore): Frozen {
  const entry = store.last("config.frozen");
  if (!entry) throw new PilotError("not_found", `No pilot is set up in ${store.dir}. Run \`init\` first.`);
  return { config_id: entry.refs.config, config: store.get<PilotConfig>("config", entry.refs.config), baseline_prompt_id: entry.refs.baseline_prompt, commit: entry.refs.commit };
}

export function activePack(store: PilotStore): Stored<Pack> {
  const entry = store.journal().filter((e) => e.step === "pack.frozen" || e.step === "pack.promoted").at(-1);
  if (!entry) throw new PilotError("not_found", "No conversation pack is frozen yet. Run `pack --file <pack.json>` first.");
  return store.stored<Pack>("pack", entry.refs.pack);
}

const allPacks = (store: PilotStore): Stored<Pack>[] => store.list("pack").map((id) => store.stored<Pack>("pack", id));

function candidateOf(store: PilotStore, idOrPrefix: string): Stored<Candidate> {
  const entries = store.find("candidate.created");
  const matches = entries.filter((e) => e.key === idOrPrefix || (/^[0-9a-f]{8,63}$/.test(idOrPrefix) && e.key.startsWith(idOrPrefix)));
  if (matches.length === 0) throw new PilotError("not_found", `No candidate ${idOrPrefix.slice(0, 80)}. Run \`propose\` first, or check the id.`);
  if (matches.length > 1) throw new PilotError("usage", `${matches.length} candidates start with ${idOrPrefix}; give more characters.`);
  return { id: matches[0].key, value: store.get<Candidate>("candidate", matches[0].refs.candidate) };
}

const replaysFor = (store: PilotStore, candidateId: Sha256, packId: Sha256): Stored<ReplayReport>[] =>
  store.find("replay.paired").filter((e) => e.refs.candidate === candidateId && e.refs.pack === packId).map((e) => store.stored<ReplayReport>("replay", e.refs.replay));

const importsFor = (store: PilotStore, scope: Sha256): Stored<TelemetryImport>[] =>
  store.find("telemetry.imported").filter((e) => e.refs.scope === scope).map((e) => store.stored<TelemetryImport>("telemetry", e.refs.telemetry));

const approvals = (store: PilotStore): Stored<Approval>[] => store.find("approval.recorded").map((e) => store.stored<Approval>("approval", e.refs.approval));

// A case that was ever held out stays held out: no pack may show it to a proposer.
function assertNoHoldoutLeak(store: PilotStore, pack: Pack): void {
  const held = new Set(allPacks(store).flatMap((p) => p.value.cases.filter((c) => c.split === "heldout").map((c) => c.id)));
  const leaked = pack.cases.filter((c) => c.split === "discovery" && held.has(c.id)).map((c) => c.id);
  if (leaked.length) {
    throw new PilotError("holdout_leak", `${leaked.length} case(s) in this pack are marked discovery but were held out in an earlier pack (${leaked.slice(0, 5).join(", ")}). A held-out case must stay held out, or the proposer would see it.`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Models. Nothing runs unless the operator names it.
// ---------------------------------------------------------------------------------------------------------------

function liveOptIn(flags: Flags): LiveOptIn {
  return { live: flags.live === true, endpoint: opt(flags, "confirm-endpoint"), data_class: opt(flags, "confirm-data") };
}

function chatModel(flags: Flags, config: PilotConfig, deps: PilotDeps): ChatModel {
  const spec = opt(flags, "model");
  if (flags.live === true) {
    if (spec) throw new PilotError("usage", "Give --model scripted:<file> or --live, not both.");
    return liveModel(config.provider, liveOptIn(flags), deps.env, deps.say, deps.fetch);
  }
  if (!spec) throw new PilotError("usage", "Name the model for this command: --model scripted:<file> (local, sends nothing), or --live with --confirm-endpoint and --confirm-data (needs the provider approval in pilot.json).");
  if (!spec.startsWith("scripted:")) throw new PilotError("usage", "--model must be scripted:<file>. A provider model runs only with --live.");
  return scriptedModel(parseModelScript(readBounded(spec.slice("scripted:".length), 4 * 1024 * 1024)));
}

function proposerFor(flags: Flags, config: PilotConfig, deps: PilotDeps): Proposer {
  const spec = opt(flags, "proposer");
  if (flags.live === true) {
    if (spec) throw new PilotError("usage", "Give --proposer scripted:<file> or --live, not both.");
    const model = liveModel(config.provider, liveOptIn(flags), deps.env, deps.say, deps.fetch);
    return modelProposer(model, config.provider!.model, 8000);
  }
  if (!spec?.startsWith("scripted:")) throw new PilotError("usage", "Name where the candidate comes from: --file <prompt> with --author and --rationale (a person wrote it), --proposer scripted:<file>, or --live.");
  return scriptedProposer(parseProposerScript(readBounded(spec.slice("scripted:".length), 4 * 1024 * 1024)));
}

async function armFor(store: PilotStore, pack: Stored<Pack>, promptId: Sha256, config: PilotConfig, model: ChatModel, at: IsoTime): Promise<Stored<ArmRun>> {
  const settings = { model: config.replay.model, max_tokens: config.replay.max_tokens, temperature: config.replay.temperature, max_steps_per_turn: config.replay.max_steps_per_turn };
  // The same prompt on the same pack with the same settings and model is replayed once and reused, so the
  // baseline every candidate is compared with is one fixed run, and a retry costs no further model calls.
  const key = contentId({ pack: pack.id, prompt: promptId, settings, destination: model.destination });
  const done = store.find("arm.replayed", key)[0];
  if (done) return store.stored<ArmRun>("arm", done.refs.arm);
  const arm = await replayArm({ pack: pack.value, pack_id: pack.id, prompt: store.getPrompt(promptId), settings, model });
  const id = store.put("arm", arm);
  store.record("arm.replayed", key, { arm: id, pack: pack.id, prompt: promptId }, at);
  return { id, value: arm };
}

// ---------------------------------------------------------------------------------------------------------------
// Commands. Each returns the process exit code, and can be run again safely.
// ---------------------------------------------------------------------------------------------------------------

export async function init(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const configPath = need(flags, "config", `the path to ${CONFIG_FILE}`);
  const repoDir = need(flags, "repo-dir", "a local checkout of the customer's repo, so the baseline prompt is read at an exact commit");
  const config = parsePilotConfig(readBounded(configPath, 1024 * 1024));
  const git = deps.git ?? defaultGit;
  let commit: string;
  let prompt: string;
  try {
    commit = git(["rev-parse", "--verify", `${opt(flags, "rev") ?? "HEAD"}^{commit}`], repoDir).trim();
  } catch {
    throw new PilotError("wrong_revision", `${repoDir} is not a git checkout, or it has no commit ${opt(flags, "rev") ?? "HEAD"}.`);
  }
  try {
    prompt = git(["show", `${commit}:${config.agent.prompt_path}`], repoDir);
  } catch {
    throw new PilotError("wrong_revision", `${config.agent.prompt_path} is not in commit ${commit.slice(0, 12)} of ${repoDir}. Check agent.prompt_path and the revision.`);
  }
  let origin = "";
  try { origin = git(["remote", "get-url", "origin"], repoDir).trim(); } catch { /* a checkout with no remote: nothing to compare */ }
  if (origin && !new RegExp(`[:/]${config.repo.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.git)?/?$`).test(origin)) {
    throw new PilotError("wrong_repo", `${repoDir} is a checkout of a different repo than repo.slug (${config.repo.slug}). Point --repo-dir at the right checkout, or fix repo.slug.`);
  }
  if (!prompt.trim()) throw new PilotError("wrong_revision", `${config.agent.prompt_path} is empty at commit ${commit.slice(0, 12)}.`);

  const configId = contentId(config);
  const earlier = store.last("config.frozen");
  const promptId = store.putPrompt(prompt);
  if (earlier && (earlier.refs.config !== configId || earlier.refs.baseline_prompt !== promptId || earlier.refs.commit !== commit)) {
    throw new PilotError("conflict", `This pilot was already frozen with a different contract, prompt or commit (config ${shortId(earlier.refs.config)}). A frozen contract is never edited in place: start a new pilot directory for a new contract.`);
  }
  store.put("config", config);
  store.record("config.frozen", configId, { config: configId, baseline_prompt: promptId, commit }, iso(deps.now()));
  // The directory holds customer data (packs, telemetry rows). Keep all of it out of any surrounding git repo.
  if (!existsSync(join(store.dir, ".gitignore"))) writeOnce(join(store.dir, ".gitignore"), "*\n");

  const m = config.metric;
  deps.say(`Pilot ${config.pilot_id} frozen. Contract ${configId}`);
  deps.say(`Primary metric: ${m.primary.name} (${m.primary.kind}, ${m.primary.unit}), ${m.primary.direction.replaceAll("_", " ")}, minimum effect ${m.primary.min_effect}.`);
  for (const g of m.guards) deps.say(`Guard: ${g.name} (${g.kind}), tolerated harm ${g.max_harm}${g.critical ? ", critical" : ""}${g.early_stop ? `, early stop from ${g.early_stop.min_per_arm} per arm` : ""}.`);
  deps.say(`Window ${m.analysis_window_days} days, outcome lag ${m.outcome_lag_days} days, at least ${m.min_samples_per_arm} per arm. Signed off by ${m.signed_off.by} on ${m.signed_off.at}.`);
  deps.say(`Baseline prompt ${promptId} at commit ${commit} (${config.agent.prompt_path}).`);
  deps.say("Next: `baseline --telemetry <export.json>` and `pack --file <pack.json>`.");
  return 0;
}

export async function baseline(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const file = need(flags, "telemetry", "the customer's baseline export (JSON)");
  const imported = importTelemetry({
    text: readBounded(file), readSibling: (name) => readBounded(inside(dirname(file), name)),
    purpose: "baseline", scope_id: f.config_id, contract: f.config.metric, tags: [f.config.agent.baseline_tag],
  });
  const at = iso(deps.now());
  const id = store.put("telemetry", imported);
  const before = store.find("telemetry.imported", id).length;
  store.record("telemetry.imported", id, { telemetry: id, purpose: "baseline", scope: f.config_id }, at);
  if (before) deps.say(`This export was already imported (${shortId(id)}); nothing is counted twice.`);
  const report = baselineReport({ config_id: f.config_id, contract: f.config.metric, tag: f.config.agent.baseline_tag, imports: importsFor(store, f.config_id) });
  const reportId = store.put("baseline", report);
  store.record("baseline.reported", reportId, { baseline: reportId }, at);
  const path = store.report("baseline.md", renderBaseline(report, f.config.metric, reportId));
  const primary = report.metrics.find((x) => x.role === "primary");
  deps.say(`Baseline ${reportId}`);
  deps.say(`${primary?.name}: ${primary?.estimate.value ?? "unknown"} over ${primary?.n ?? 0} conversations (${primary?.estimate.method}; source ${primary?.estimate.source}).`);
  deps.say(`Needed per arm: ${report.required_per_arm.value ?? "unknown"} (${report.required_per_arm.method}). About ${report.days_to_required.value ?? "unknown"} days at the measured volume.`);
  if (report.flags.length) deps.say(`Flags: ${report.flags.join(", ")}.`);
  deps.say(`Report: ${path}`);
  return 0;
}

export async function pack(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  frozen(store);
  const parsed = parsePack(readBounded(need(flags, "file", "the redacted conversation pack (JSON)")));
  const id = contentId(parsed);
  const current = store.journal().filter((e) => e.step === "pack.frozen" || e.step === "pack.promoted").at(-1);
  if (current && current.refs.pack !== id) {
    const active = store.get<Pack>("pack", current.refs.pack);
    if (parsed.parent_pack_id !== current.refs.pack || parsed.pack_version !== active.pack_version + 1) {
      throw new PilotError("conflict", `Pack ${shortId(current.refs.pack)} (version ${active.pack_version}) is already frozen. A newer pack must name it as parent_pack_id and be version ${active.pack_version + 1}; the frozen pack itself is never replaced.`);
    }
  } else if (!current && (parsed.pack_version !== 1 || parsed.parent_pack_id !== null)) {
    throw new PilotError("conflict", "The first pack of a pilot must be version 1 with no parent.");
  }
  assertNoHoldoutLeak(store, parsed);
  store.put("pack", parsed);
  store.record("pack.frozen", id, { pack: id }, iso(deps.now()));
  const s = packSummary(parsed, id);
  deps.say(`Pack ${id} frozen: ${s.name} version ${s.pack_version}.`);
  deps.say(`${s.cases} cases (${s.by_split.discovery} discovery, ${s.by_split.heldout} held out), ${s.assistant_turns} assistant turns, ${s.checks} checks, ${s.regression_cases} regression cases.`);
  deps.say("Next: `discover --model scripted:<file>` (or --live) to find recurring failures on the discovery cases.");
  return 0;
}

export async function discover(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const active = activePack(store);
  const at = iso(deps.now());
  const arm = await armFor(store, active, f.baseline_prompt_id, f.config, chatModel(flags, f.config, deps), at);
  const findings = discoverFailures({ pack: active.value, baseline: arm.value, min_recurring_cases: f.config.replay.min_recurring_cases });
  for (const finding of findings) {
    const id = store.put("finding", finding);
    store.record("finding.found", id, { finding: id, check: finding.check_id, pack: active.id }, at);
  }
  const path = store.report(`findings-pack-v${active.value.pack_version}.md`, renderFindings(findings, active.value));
  deps.say(`Baseline replayed on pack ${shortId(active.id)} with ${arm.value.model_destination}: ${arm.value.cases.length} cases, ${arm.value.model_calls} model calls.`);
  if (!findings.length) deps.say(`No check fails in ${f.config.replay.min_recurring_cases} or more discovery cases. Nothing to propose from this pack.`);
  for (const finding of findings) deps.say(`Finding ${contentId(finding)}: ${finding.check_id} fails in ${finding.failing.length} of ${finding.discovery_cases_with_check} discovery cases. ${finding.description}`);
  deps.say(`Report: ${path}`);
  if (findings.length) deps.say("Next: `propose --finding <id>` with --proposer scripted:<file>, --live, or --file <prompt> --author <name> --rationale <why>.");
  return 0;
}

export async function propose(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const active = activePack(store);
  const baselinePrompt = store.getPrompt(f.baseline_prompt_id);
  const findingFlag = opt(flags, "finding");
  const finding: Stored<FailureFinding> | null = findingFlag ? store.stored<FailureFinding>("finding", store.resolve("finding", findingFlag)) : null;
  if (finding && finding.value.pack_id !== active.id) {
    throw new PilotError("conflict", `Finding ${shortId(finding.id)} is from pack ${shortId(finding.value.pack_id)}, not the active pack ${shortId(active.id)}. Run \`discover\` on the active pack and use its finding.`);
  }
  let made: Candidate;
  let prompt: string;
  const file = opt(flags, "file");
  if (file) {
    prompt = readBounded(file, 1024 * 1024);
    made = makeCandidate({
      pilot_id: f.config.pilot_id, baseline_prompt: baselinePrompt, prompt, origin: "human", author: need(flags, "author", "who wrote the candidate"),
      rationale: need(flags, "rationale", "one sentence on why this change"), finding_id: finding?.id ?? null, target_check_id: finding?.value.check_id ?? null,
      max_changed_lines: f.config.replay.max_changed_lines,
    });
  } else {
    if (!finding) throw new PilotError("usage", "--finding is required for a proposed candidate: a proposal must be tied to one recurring failure.");
    const earlier = store.find("candidate.created").filter((e) => e.refs.finding === finding.id);
    const feedback = earlier.flatMap((e) => replaysFor(store, e.key, active.id).at(-1)?.value.gate.proposer_feedback ?? []);
    const context = proposerContext({ pack: active.value, baseline_prompt: baselinePrompt, finding: finding.value, attempt: earlier.length, feedback, max_changed_lines: f.config.replay.max_changed_lines });
    const proposer = proposerFor(flags, f.config, deps);
    const proposal = await proposer.propose(context);
    prompt = proposal.prompt;
    made = makeCandidate({
      pilot_id: f.config.pilot_id, baseline_prompt: baselinePrompt, prompt, origin: "proposer", author: proposer.destination, rationale: proposal.rationale,
      finding_id: finding.id, target_check_id: finding.value.check_id, max_changed_lines: f.config.replay.max_changed_lines,
    });
  }
  store.putPrompt(prompt);
  const objectId = store.put("candidate", made);
  store.record("candidate.created", made.prompt_id, { candidate: objectId, prompt: made.prompt_id, finding: made.finding_id ?? "" }, iso(deps.now()));
  deps.say(`Candidate ${made.prompt_id}`);
  deps.say(`${made.origin === "human" ? "Written by" : "Proposed by"} ${made.author}; ${made.changed_lines} changed line(s)${made.target_check_id ? `; targets ${made.target_check_id}` : ""}.`);
  deps.say(`Next: \`replay --candidate ${shortId(made.prompt_id)}\` with the same --model as discover.`);
  return 0;
}

export async function replay(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const active = activePack(store);
  const candidate = candidateOf(store, need(flags, "candidate", "the candidate id from `propose`"));
  const model = chatModel(flags, f.config, deps);
  const at = iso(deps.now());
  const base = await armFor(store, active, f.baseline_prompt_id, f.config, model, at);
  const cand = await armFor(store, active, candidate.id, f.config, model, at);
  const report = pairArms({ pack: active.value, baseline: base.value, candidate: cand.value, target_check_id: candidate.value.target_check_id, gate: f.config.replay.gate });
  const id = store.put("replay", report);
  store.record("replay.paired", id, { replay: id, candidate: candidate.id, pack: active.id, eligible: String(report.gate.eligible) }, at);
  const path = store.report(`replay-${shortId(candidate.id)}-pack-v${active.value.pack_version}.md`, renderReplay(report, active.value, id));
  const t = report.tally.all;
  deps.say(`Replay ${id}`);
  deps.say(`${t.cases} cases: ${t.paired} paired (${t.wins} better, ${t.losses} worse, ${t.ties} the same), ${t.excluded} excluded. Held out: ${report.tally.heldout.wins} better, ${report.tally.heldout.losses} worse.`);
  deps.say(`Coverage: ${Math.round(report.coverage.paired_cases * 100)}% of cases paired, ${Math.round(report.coverage.common_turns * 100)}% of turns scored on both prompts.`);
  deps.say(report.gate.eligible ? "Gate: passed. This candidate may go to review." : "Gate: not passed. This candidate stays out of review.");
  // The report file lists every reason; the terminal shows the first few, so a long list does not bury the verdict.
  for (const reason of report.gate.reasons.slice(0, SHOWN)) deps.say(`- ${reason}`);
  if (report.gate.reasons.length > SHOWN) deps.say(`- ... and ${report.gate.reasons.length - SHOWN} more reasons in the report.`);
  deps.say("Replay shows checks on recorded conversations. It is not an estimate of business impact.");
  deps.say(`Report: ${path}`);
  if (report.gate.eligible) deps.say(`Next: \`experiment --candidate ${shortId(candidate.id)} --start <UTC time>\`, then \`review --candidate ${shortId(candidate.id)}\`.`);
  return 0;
}

const eligibleReplay = (store: PilotStore, candidateId: Sha256, packId: Sha256): Stored<ReplayReport> => {
  const latest = replaysFor(store, candidateId, packId).at(-1);
  if (!latest) throw new PilotError("replay_gate_failed", `Candidate ${shortId(candidateId)} has no replay on the active pack ${shortId(packId)}. Run \`replay --candidate ${shortId(candidateId)}\` first.`);
  if (!latest.value.gate.eligible) {
    const reasons = latest.value.gate.reasons;
    throw new PilotError("replay_gate_failed", `Candidate ${shortId(candidateId)} did not pass the replay gate, so it stays out of review. ${reasons.slice(0, SHOWN).join(" ")}${reasons.length > SHOWN ? ` (and ${reasons.length - SHOWN} more reasons in the replay report)` : ""}`);
  }
  return latest;
};

// A decision that ends an experiment: after it, the next change may start.
const settled = (store: PilotStore, experimentId: Sha256): boolean =>
  store.find("analysis.decided").some((e) => e.refs.experiment === experimentId && (e.refs.recommendation === "keep" || e.refs.recommendation === "revert"));

export async function experiment(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const active = activePack(store);
  const candidate = candidateOf(store, need(flags, "candidate", "the candidate id"));
  eligibleReplay(store, candidate.id, active.id);
  const start = need(flags, "start", "when the customer will start the split, as a UTC time like 2026-11-16T00:00:00Z");
  if (Number.isNaN(ms(start))) throw new PilotError("usage", "--start must be a UTC time like 2026-11-16T00:00:00Z.");
  const baselineEntry = store.last("baseline.reported");
  if (!baselineEntry) throw new PilotError("not_found", "No baseline report yet. Run `baseline --telemetry <export.json>` first: the experiment is sized from it.");
  // One change in flight per agent: two live changes at once cannot be told apart in the telemetry.
  const approved = approvals(store);
  for (const e of store.find("experiment.specified")) {
    if (e.refs.candidate === candidate.id || settled(store, e.key)) continue;
    const latest = approved.filter((a) => a.value.experiment_id === e.key).at(-1);
    if (latest?.value.decision === "approved") {
      throw new PilotError("experiment_in_flight", `Experiment ${shortId(e.key)} is approved and has no keep or revert decision yet. Only one change may be in flight for an agent; finish it with \`analyze\` first.`);
    }
  }
  const baselineReported = store.get<BaselineReport>("baseline", baselineEntry.refs.baseline);
  // The experiment's baseline arm must be the prompt the baseline was measured on.
  if (baselineReported.tag !== f.config.agent.baseline_tag || baselineReported.config_id !== f.config_id) {
    throw new PilotError("conflict", "The baseline report was made for a different contract or telemetry tag than this pilot. Run `baseline` again for this pilot.");
  }
  const share = opt(flags, "share");
  const spec = buildExperimentSpec({
    pilot_id: f.config.pilot_id, config_id: f.config_id, contract: f.config.metric,
    baseline: { prompt_id: f.baseline_prompt_id, tag: f.config.agent.baseline_tag },
    candidate: { prompt_id: candidate.id, tag: candidateTag(candidate.id) },
    baseline_report: baselineReported, start,
    ...(share !== undefined ? { candidate_share: Number(share) } : {}),
  });
  const id = store.put("experiment", spec);
  store.record("experiment.specified", id, { experiment: id, candidate: candidate.id }, iso(deps.now()));
  const path = store.report(`experiment-${shortId(id)}.md`, renderExperimentSpec(spec, id));
  deps.say(`Experiment ${id}`);
  deps.say(`Arms: ${spec.arms.baseline.tag} (baseline) and ${spec.arms.candidate.tag} (candidate), ${Math.round(spec.allocation.candidate * 100)}% to the candidate.`);
  deps.say(`Window ${spec.window.start} to ${spec.window.end}; final analysis from ${spec.analysis_cutoff}; ${spec.required_per_arm} conversations needed per arm.`);
  deps.say("The customer's rollout owner runs the split. Synthe does not change traffic.");
  deps.say(`Specification: ${path}`);
  deps.say(`Next: \`review --candidate ${shortId(candidate.id)}\`.`);
  return 0;
}

const experimentFor = (store: PilotStore, candidateId: Sha256): Stored<ExperimentSpec> => {
  const entry = store.find("experiment.specified").filter((e) => e.refs.candidate === candidateId).at(-1);
  if (!entry) throw new PilotError("not_found", `Candidate ${shortId(candidateId)} has no experiment specification. Run \`experiment --candidate ${shortId(candidateId)} --start <UTC time>\` first: the review shows the plan a person approves.`);
  return store.stored<ExperimentSpec>("experiment", entry.key);
};

export async function review(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const active = activePack(store);
  const candidate = candidateOf(store, need(flags, "candidate", "the candidate id"));
  const candidatePrompt = store.getPrompt(candidate.id);
  const baselinePrompt = store.getPrompt(f.baseline_prompt_id);
  const replayed = eligibleReplay(store, candidate.id, active.id);
  const bundle = buildReviewBundle({
    config: f.config, config_id: f.config_id, candidate: candidate.value, baseline_prompt: baselinePrompt, candidate_prompt: candidatePrompt,
    replay: replayed, experiment: experimentFor(store, candidate.id),
  });
  const id = contentId(bundle);
  const body = renderReview(bundle, id, active.value, replayed.value.target_check_id);
  // Checked even for the local bundle: a review file is written to be shared.
  const sensitive = sensitiveIndex(allPacks(store).map((p) => p.value), [baselinePrompt]);
  assertEgressSafe(body, sensitive, "review bundle");
  store.put("review", bundle);
  store.record("review.bundled", id, { review: id, candidate: candidate.id, experiment: bundle.experiment_id }, iso(deps.now()));
  const folder = `review-${shortId(candidate.id)}`;
  const path = store.report(`${folder}/REVIEW.md`, body);
  store.report(`${folder}/bundle.json`, `${JSON.stringify({ review_id: id, ...bundle }, null, 2)}\n`);
  store.report(`${folder}/candidate.diff`, bundle.diff);
  deps.say(`Review ${id}`);
  deps.say(`Bundle: ${path}`);

  if (flags.publish !== true) {
    deps.say("Local bundle only. Nothing was published.");
    deps.say(`To open the pull request: \`review --candidate ${candidate.id} --publish --repo ${f.config.repo.slug} --base ${f.config.repo.base} --confirm ${candidate.id}\` with ${GITHUB_TOKEN_ENV} set.`);
    return 0;
  }
  const published = store.find("review.published", id)[0];
  if (published) {
    deps.say(`Already published as pull request #${published.refs.pr} on ${published.refs.branch}. No second pull request was opened.`);
    return 0;
  }
  const token = deps.env[GITHUB_TOKEN_ENV]?.trim();
  if (!token) throw new PilotError("unauthorized_publish", `Nothing was published. Put a GitHub token for ${f.config.repo.slug} in ${GITHUB_TOKEN_ENV}; no other variable is read.`);
  const repo = (deps.github ?? githubRepo)(f.config.repo.slug, token, f.config.repo.api ?? GITHUB_API);
  const result = await publishReview(repo, {
    config: f.config, bundle: { id, value: bundle }, body, candidate_prompt: candidatePrompt, sensitive, fault: deps.fault,
    operator: { publish: true, repo: need(flags, "repo", "repeat the destination repo, owner/name"), base: need(flags, "base", "repeat the base branch"), confirm: need(flags, "confirm", "repeat the full candidate id") },
  });
  store.record("review.published", id, { review: id, pr: String(result.pr), branch: result.branch }, iso(deps.now()));
  deps.say(`${result.adopted ? "Found the existing" : "Opened"} pull request #${result.pr} on ${f.config.repo.slug}, branch ${result.branch} into ${f.config.repo.base}.`);
  deps.say("Merging it, and starting the experiment, are a person's decisions. Record the approval with `approve`.");
  return 0;
}

export async function approve(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const candidateId = need(flags, "candidate", "the full candidate id from the review");
  const experimentId = need(flags, "experiment", "the full experiment id from the review");
  // An approval names exactly what was reviewed, so a short id is not enough.
  if (!isSha256(candidateId) || !isSha256(experimentId)) throw new PilotError("unknown_approval", "An approval must name the full 64-character candidate and experiment ids, as printed in the review bundle.");
  const approver = need(flags, "approver", "the name of the person approving");
  const entry = store.find("review.bundled").filter((e) => e.refs.candidate === candidateId && e.refs.experiment === experimentId).at(-1);
  if (!entry) throw new PilotError("unknown_approval", "There is no review bundle for that candidate and experiment, so there is nothing to approve. Check both ids against REVIEW.md.");
  const decision = flags.reject === true ? "rejected" : "approved";
  const same = approvals(store).filter((a) => a.value.candidate_id === candidateId && a.value.experiment_id === experimentId).at(-1);
  if (same && same.value.decision === decision && same.value.approver === approver) {
    deps.say(`Already recorded: ${approver} ${decision} candidate ${shortId(candidateId)} for experiment ${shortId(experimentId)} (${same.id}).`);
    return 0;
  }
  const approval = makeApproval({ pilot_id: f.config.pilot_id, bundle: store.stored<ReviewBundle>("review", entry.key), candidate_id: candidateId, experiment_id: experimentId, approver, decision, at: iso(deps.now()) });
  const id = store.put("approval", approval);
  store.record("approval.recorded", id, { approval: id, candidate: candidateId, experiment: experimentId, decision }, approval.at);
  deps.say(`Approval ${id}: ${approver} ${decision} candidate ${shortId(candidateId)} for experiment ${shortId(experimentId)}.`);
  if (decision === "approved") deps.say(`The customer's rollout owner may now start the split. When they export outcomes: \`analyze --experiment ${shortId(experimentId)} --telemetry <export.json>\`.`);
  return 0;
}

export async function analyze(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const experimentId = store.resolve("experiment", need(flags, "experiment", "the experiment id"));
  const spec = store.get<ExperimentSpec>("experiment", experimentId);
  const approval = requireApproval(approvals(store), spec.arms.candidate.prompt_id, experimentId);
  const at = iso(deps.now());
  const file = opt(flags, "telemetry");
  if (file) {
    const imported = importTelemetry({
      text: readBounded(file), readSibling: (name) => readBounded(inside(dirname(file), name)),
      purpose: "experiment", scope_id: experimentId, contract: f.config.metric, tags: [spec.arms.baseline.tag, spec.arms.candidate.tag], window: spec.window,
    });
    const id = store.put("telemetry", imported);
    const before = store.find("telemetry.imported", id).length;
    store.record("telemetry.imported", id, { telemetry: id, purpose: "experiment", scope: experimentId }, at);
    deps.say(before ? `This export was already imported (${shortId(id)}); nothing is counted twice.` : `Imported export ${imported.export_id} as ${id}.`);
  }
  const imports = importsFor(store, experimentId);
  if (!imports.length) throw new PilotError("telemetry_incomplete", `Experiment ${shortId(experimentId)} has no outcome export yet. Give one with --telemetry <export.json>.`);
  const analysis = analyzeExperiment({ spec, experiment_id: experimentId, imports, approval_id: approval.id });
  const id = store.put("analysis", analysis);
  store.record("analysis.decided", id, { analysis: id, experiment: experimentId, recommendation: analysis.recommendation, final: String(analysis.final) }, at);
  const text = renderDecision(analysis, spec, id);
  store.report(`decision-${shortId(experimentId)}-${shortId(id)}.md`, text);
  const path = store.report(`decision-${shortId(experimentId)}.md`, text);
  deps.say(`Analysis ${id} as of ${analysis.as_of} (${analysis.final ? "final" : "before the cutoff"}).`);
  deps.say(`Conversations: ${analysis.arms.baseline.mature} mature in ${analysis.arms.baseline.tag}, ${analysis.arms.candidate.mature} in ${analysis.arms.candidate.tag}; ${analysis.coverage.immature} immature, ${analysis.coverage.unattributed} unattributed, ${analysis.coverage.duplicates_dropped} duplicates dropped.`);
  deps.say(`RECOMMENDATION: ${analysis.recommendation.toUpperCase()}${analysis.stopped_by === "early_stop" ? " (predeclared early stop)" : ""}`);
  for (const reason of analysis.reasons) deps.say(`- ${reason}`);
  if (analysis.flags.length) deps.say(`Flags: ${analysis.flags.join(", ")}.`);
  if (analysis.recommendation === "revert") deps.say(`Rollback target: tag ${analysis.rollback.tag}, prompt ${analysis.rollback.prompt_id}. ${analysis.rollback.instructions}`);
  deps.say("This is a recommendation for the rollout owner. Synthe does not change traffic.");
  deps.say(`Decision: ${path}`);
  return 0;
}

function parsePromotionRequest(source: string): PromotionRequest {
  let v: unknown;
  try { v = JSON.parse(source); } catch { throw new PilotError("invalid_promotion", "The promotion request is not valid JSON."); }
  const r = v as Partial<PromotionRequest> | null;
  if (r === null || typeof r !== "object" || r.version !== 1 || typeof r.base_pack_id !== "string" || typeof r.approver !== "string" || typeof r.at !== "string" || !Array.isArray(r.existing) || !Array.isArray(r.added)) {
    throw new PilotError("invalid_promotion", "The promotion request needs version 1, base_pack_id, approver, at, and the lists `existing` and `added`.");
  }
  return r as PromotionRequest;
}

export async function promotePack(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  frozen(store);
  const active = activePack(store);
  const replays = store.find("replay.paired").filter((e) => e.refs.pack === active.id).map((e) => store.stored<ReplayReport>("replay", e.refs.replay));
  if (flags.list === true) {
    const failures = eligibleFailures(replays);
    deps.say(`${failures.length} failure(s) on pack ${shortId(active.id)} that a reviewer may approve as regression cases:`);
    for (const x of failures) deps.say(`- case ${x.case_id} (${x.split}) turn ${x.turn}, check ${x.check_id}, ${x.arm} prompt, replay ${x.replay_id}`);
    return 0;
  }
  const request = parsePromotionRequest(readBounded(need(flags, "request", "the reviewer's promotion request (JSON)"), 8 * 1024 * 1024));
  const requestId = store.put("promotion-request", request);
  const next = promote({ pack: active, request: { id: requestId, value: request }, replays, experiment_ids: store.find("experiment.specified").map((e) => e.key) });
  // The new version goes through the same validation as an imported pack, including redaction of added cases.
  const validated = parsePack(JSON.stringify(next));
  assertNoHoldoutLeak(store, validated);
  const newId = store.put("pack", validated);
  const added = new Set(request.added.map((a) => a.case.id));
  const promotedIds = new Set([...request.existing.map((x) => x.case_id), ...added]);
  const record: PromotionRecord = {
    version: 1, request_id: requestId, base_pack_id: active.id, new_pack_id: newId, approver: request.approver, at: request.at,
    promoted: validated.cases.filter((c) => promotedIds.has(c.id)).map((c) => ({ case_id: c.id, split: c.split, kind: added.has(c.id) ? "added" as const : "existing" as const })),
  };
  const recordId = store.put("promotion", record);
  store.record("pack.promoted", newId, { pack: newId, parent: active.id, promotion: recordId }, iso(deps.now()));
  // Reading the old pack back proves it still matches its id: promotion wrote a new record and changed nothing.
  store.get<Pack>("pack", active.id);
  const path = store.report(`promotion-${shortId(newId)}.md`, renderPromotion(record, packSummary(active.value, active.id), packSummary(validated, newId)));
  deps.say(`Pack ${newId} (version ${validated.pack_version}) promoted from ${active.id}.`);
  deps.say(`${record.promoted.length} regression case(s) approved by ${request.approver}: ${record.promoted.map((p) => `${p.case_id} (${p.split}, ${p.kind})`).join(", ")}.`);
  deps.say("The previous pack and every record that cites it are unchanged. Held-out cases stay held out.");
  deps.say(`Report: ${path}`);
  return 0;
}

// Rebuilds every report from the stored records, and the pilot summary that cites each one.
export async function report(store: PilotStore, _flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const path = store.report("PILOT.md", renderPilotReport(store, f));
  deps.say(`Pilot report: ${path}`);
  return 0;
}

// Checks that nothing stored was changed and that every decision still follows from its evidence.
export async function verify(store: PilotStore, _flags: Flags, deps: PilotDeps): Promise<number> {
  const problems: string[] = [];
  const attempt = (what: string, fn: () => void) => { try { fn(); } catch (e) { problems.push(`${what}: ${(e as Error).message}`); } };
  let entries = 0;
  attempt("journal", () => { entries = store.journal().length; });
  let records = 0;
  for (const kind of ["config", "pack", "arm", "finding", "candidate", "replay", "telemetry", "baseline", "experiment", "review", "approval", "analysis", "promotion-request", "promotion"] as const) {
    for (const id of store.list(kind)) { records++; attempt(`${kind} ${shortId(id)}`, () => { store.get(kind, id); }); }
  }
  for (const id of store.list("prompt")) { records++; attempt(`prompt ${shortId(id)}`, () => { store.getPrompt(id); }); }
  let recomputed = 0;
  if (!problems.length) {
    const f = frozen(store);
    const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
    for (const e of store.find("replay.paired")) {
      attempt(`replay ${shortId(e.key)}`, () => {
        const stored = store.get<ReplayReport>("replay", e.key);
        const again = pairArms({ pack: store.get<Pack>("pack", stored.pack_id), baseline: stored.baseline, candidate: stored.candidate, target_check_id: stored.target_check_id, gate: f.config.replay.gate });
        if (!same(stored, again)) throw new Error("the stored replay report does not follow from its own arm runs");
        recomputed++;
      });
    }
    for (const e of store.find("baseline.reported")) {
      attempt(`baseline ${shortId(e.key)}`, () => {
        const stored = store.get<BaselineReport>("baseline", e.key);
        const again = baselineReport({ config_id: f.config_id, contract: f.config.metric, tag: f.config.agent.baseline_tag, imports: stored.telemetry_ids.map((id) => store.stored<TelemetryImport>("telemetry", id)) });
        if (!same(stored, again)) throw new Error("the stored baseline report does not follow from its telemetry imports");
        recomputed++;
      });
    }
    for (const e of store.find("analysis.decided")) {
      attempt(`analysis ${shortId(e.key)}`, () => {
        const stored = store.get<ExperimentAnalysis>("analysis", e.key);
        const spec = store.get<ExperimentSpec>("experiment", stored.experiment_id);
        const approval = store.get<Approval>("approval", stored.approval_id);
        if (approval.decision !== "approved" || approval.experiment_id !== stored.experiment_id || approval.candidate_id !== spec.arms.candidate.prompt_id) throw new Error("the approval it cites is not an approval of this candidate and experiment");
        const again = analyzeExperiment({ spec, experiment_id: stored.experiment_id, imports: stored.telemetry_ids.map((id) => store.stored<TelemetryImport>("telemetry", id)), approval_id: stored.approval_id });
        if (!same(stored, again)) throw new Error(`the stored recommendation (${stored.recommendation}) does not follow from its telemetry imports (recomputed: ${again.recommendation})`);
        if (e.refs.recommendation !== stored.recommendation) throw new Error("the journal names a different recommendation than the stored analysis");
        recomputed++;
      });
    }
  }
  if (problems.length) {
    deps.say(`Verification failed: ${problems.length} problem(s).`);
    for (const p of problems) deps.say(`- ${p}`);
    return 1;
  }
  deps.say(`Verified: ${entries} journal entries in order, ${records} records match their ids, ${recomputed} reports and decisions recomputed from their evidence with the same result.`);
  return 0;
}

export async function status(store: PilotStore, _flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const journal = store.journal();
  deps.say(`Pilot ${f.config.pilot_id}: contract ${f.config_id}, baseline prompt ${f.baseline_prompt_id}.`);
  const packEntry = journal.filter((e) => e.step === "pack.frozen" || e.step === "pack.promoted").at(-1);
  deps.say(packEntry ? `Active pack: ${packEntry.refs.pack}.` : "No pack yet: run `pack --file <pack.json>`.");
  if (!store.last("baseline.reported")) deps.say("No baseline yet: run `baseline --telemetry <export.json>`.");
  for (const e of store.find("candidate.created")) {
    const last = journal.filter((x) => x.step === "replay.paired" && x.refs.candidate === e.key).at(-1);
    const exp = journal.filter((x) => x.step === "experiment.specified" && x.refs.candidate === e.key).at(-1);
    const decision = exp ? journal.filter((x) => x.step === "analysis.decided" && x.refs.experiment === exp.key).at(-1) : undefined;
    const pr = journal.find((x) => x.step === "review.published" && journal.some((b) => b.step === "review.bundled" && b.key === x.key && b.refs.candidate === e.key));
    deps.say(`Candidate ${shortId(e.key)}: ${!last ? "not replayed" : last.refs.eligible === "true" ? "passed replay" : "rejected in replay"}${pr ? `, pull request #${pr.refs.pr}` : ""}${exp ? `, experiment ${shortId(exp.key)}` : ""}${decision ? `, latest recommendation ${decision.refs.recommendation}` : ""}.`);
  }
  deps.say(`${journal.length} journal entries. Run \`report\` for the full evidence summary, \`verify\` to recheck it.`);
  return 0;
}
