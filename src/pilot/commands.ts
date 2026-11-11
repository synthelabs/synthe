import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "../core/evidence.ts";
import { githubRepo, type Repo } from "../github/repo.ts";
import { makeApproval, requireApproval } from "./approval.ts";
import { CONFIG_FILE, GITHUB_API, parsePilotConfig } from "./config.ts";
import { discoverFailures, makeCandidate, proposerContext, renderFindings } from "./discover.ts";
import { assertEgressSafe, sensitiveIndex, words } from "./egress.ts";
import { PilotError } from "./errors.ts";
import { analyzeExperiment, buildExperimentSpec, renderDecision, renderExperimentSpec } from "./experiment.ts";
import { candidateTag, contentId, isSha256, ms, shortId } from "./ids.ts";
import { inside, readBounded, unsafeKey, writeOnce } from "./io.ts";
import { liveModel, type LiveOptIn } from "./live.ts";
import { modelProposer, parseModelScript, parseProposerScript, scriptedModel, scriptedProposer } from "./model.ts";
import { packSummary, parsePack } from "./pack.ts";
import { eligibleFailures, promote, renderPromotion } from "./promote.ts";
import { publishMessage, publishReview } from "./publish.ts";
import { pairArms, renderReplay, replayArm } from "./replay.ts";
import { renderPilotReport } from "./report.ts";
import { buildReviewBundle, MAX_REVIEW_CHARS, renderReview } from "./review.ts";
import { OBJECT_KINDS, PilotStore, type JournalEntry } from "./store.ts";
import { baselineReport, importProblem, importTelemetry, renderBaseline } from "./telemetry.ts";
import type {
  Approval, ArmRun, BaselineReport, Candidate, ChatModel, ExperimentAnalysis, ExperimentSpec, FailureFinding, IsoTime, Pack, PackCase, PilotConfig,
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
  // SYNTHE_* settings stay out of child processes, as in src/cli/main.ts. GIT_* is dropped too: an inherited
  // GIT_DIR (set inside a git hook, for one) would make git read a different repository than --repo-dir names.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SYNTHE_") && !k.startsWith("GIT_")));
  return execFileSync("git", args, { cwd, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

// ---------------------------------------------------------------------------------------------------------------
// What the journal says about the pilot so far.
// ---------------------------------------------------------------------------------------------------------------

// The host and owner/name of a git remote URL, in its https, ssh or scp-like form.
function originOf(url: string): { host: string; slug: string } | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)[:/](?:\d+\/)?(.+?)(?:\.git)?\/?$/i.exec(url);
  if (!m) return null;
  const parts = m[2].split("/");
  return parts.length >= 2 ? { host: m[1], slug: parts.slice(-2).join("/") } : null;
}

const GITHUB_HOSTS = new Set(["github.com", "ssh.github.com"]);

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

// An approval counts only if it answers a review bundle this pilot wrote for the same candidate and experiment, and
// names who approved. A record that merely sits in the store with the right ids is not one.
function approvals(store: PilotStore): Stored<Approval>[] {
  const reviews = store.find("review.bundled");
  return store.find("approval.recorded").map((e) => store.stored<Approval>("approval", e.refs.approval)).filter((a) =>
    typeof a.value.approver === "string" && a.value.approver.trim() !== ""
    && reviews.some((r) => r.key === a.value.review_id && r.refs.candidate === a.value.candidate_id && r.refs.experiment === a.value.experiment_id));
}

// A case that was ever held out stays held out: no pack may show it to a proposer, under its own id or as a copy
// of its conversation under another id.
// What makes two cases the same conversation, with case, spacing, punctuation and accents removed. When the
// customer said enough to identify the conversation, their words alone decide: a copy that reformats the text or
// changes the agent's side is still that conversation. A few words ("where is my order") are said by many
// customers, so a short conversation is a copy only when every message is the same.
const COPY_MIN_WORDS = 8;
function conversationKeys(c: PackCase): string[] {
  const said = words(c.messages.flatMap((m) => (m.role === "user" ? [m.text] : [])).join(" "));
  const all = `all:${words(c.messages.map((m) => (m.role === "tool" ? m.result : m.text)).join(" ")).join(" ")}`;
  return said.length >= COPY_MIN_WORDS ? [`said:${said.join(" ")}`, all] : [all];
}

function assertNoHoldoutLeak(store: PilotStore, pack: Pack): void {
  const heldIds = new Set<string>();
  const heldConversations = new Set<string>();
  for (const p of [...allPacks(store).map((x) => x.value), pack]) {
    for (const c of p.cases) if (c.split === "heldout") { heldIds.add(c.id); for (const k of conversationKeys(c)) heldConversations.add(k); }
  }
  const leaked = pack.cases.filter((c) => c.split === "discovery" && (heldIds.has(c.id) || conversationKeys(c).some((k) => heldConversations.has(k)))).map((c) => c.id);
  if (leaked.length) {
    throw new PilotError("holdout_leak", `${leaked.length} discovery case(s) in this pack are held-out cases, or copies of a held-out conversation (${leaked.slice(0, 5).join(", ")}). A held-out conversation must stay held out, or the proposer would see it.`);
  }
}

// An export cannot have been made after it is imported. Its own date decides what counts as final, so a date in
// the future would let an unfinished experiment read as finished.
const CLOCK_SKEW_MS = 5 * 60_000;
function assertNotFromTheFuture(imported: TelemetryImport, now: Date): void {
  if (ms(imported.exported_at) > now.getTime() + CLOCK_SKEW_MS) {
    throw new PilotError("invalid_telemetry", `The export says it was made at ${imported.exported_at}, which is later than now (${iso(now)}). Check the export's clock and time zone (times must be UTC), then export again.`);
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
  if (origin) {
    const remote = originOf(origin);
    const api = config.repo.api ?? GITHUB_API;
    // The checkout must be the repo the review will go to: same owner and name, on github.com (ssh.github.com is
    // its SSH-over-443 name) unless the config points the API at a loopback stand-in.
    if (!remote || remote.slug.toLowerCase() !== config.repo.slug.toLowerCase() || (api === GITHUB_API && !GITHUB_HOSTS.has(remote.host.toLowerCase()))) {
      throw new PilotError("wrong_repo", `${repoDir} is a checkout of a different repo than repo.slug (${config.repo.slug}). Point --repo-dir at the right checkout, or fix repo.slug.`);
    }
  } else {
    deps.say(`Note: ${repoDir} has no origin remote, so it could not be checked against repo.slug (${config.repo.slug}).`);
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
  assertNotFromTheFuture(imported, deps.now());
  const at = iso(deps.now());
  const id = contentId(imported);
  const existing = importsFor(store, f.config_id);
  const known = existing.some((i) => i.id === id);
  // The report is worked out before anything is recorded: an export that contradicts an earlier one is refused
  // here and leaves no trace, so the next correct export still imports.
  const report = baselineReport({ config_id: f.config_id, contract: f.config.metric, tag: f.config.agent.baseline_tag, imports: known ? existing : [...existing, { id, value: imported }] });
  if (known) deps.say(`This export was already imported (${shortId(id)}); nothing is counted twice.`);
  else {
    store.put("telemetry", imported);
    store.record("telemetry.imported", id, { telemetry: id, purpose: "baseline", scope: f.config_id }, at);
    if (imported.provisional_values_dropped) deps.say(`${imported.provisional_values_dropped} conversations were younger than the outcome lag when exported; their values are treated as not known yet.`);
  }
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
    // Only `promote` makes a new version: it keeps every earlier case as it was, records who approved each
    // change, and cannot move a conversation out of the held-out split. A hand-made successor could do all three.
    throw new PilotError("conflict", `Pack ${shortId(current.refs.pack)} is already frozen and is never replaced. To add approved failures, use \`promote --request <file>\`; for a different pack, start a new pilot directory.`);
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

// A publication is a handful of GitHub calls. A lock older than this was left by a run that died.
const PUBLISH_LOCK_STALE_MS = 10 * 60_000;

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
const settledBy = (store: PilotStore, experimentId: Sha256): JournalEntry | undefined =>
  store.find("analysis.decided").find((e) => e.refs.experiment === experimentId && (e.refs.recommendation === "keep" || e.refs.recommendation === "revert"));
const settled = (store: PilotStore, experimentId: Sha256): boolean => settledBy(store, experimentId) !== undefined;

// One change in flight per agent: two live changes at once cannot be told apart in the telemetry. That holds for
// two experiments on the same candidate too, because both would read the same tagged conversations, and a
// candidate that already has a keep or a revert is not measured again under a second experiment.
function assertMayRun(store: PilotStore, candidateId: Sha256, experimentId: Sha256): void {
  const approved = approvals(store);
  for (const e of store.find("experiment.specified")) {
    if (e.key === experimentId) continue;
    const ended = settledBy(store, e.key);
    if (ended) {
      if (e.refs.candidate === candidateId) {
        throw new PilotError("conflict", `Candidate ${shortId(candidateId)} already has a ${ended.refs.recommendation} decision (experiment ${shortId(e.key)}). A decided candidate is not measured again: its exports would feed both experiments. Propose a new candidate.`);
      }
      continue;
    }
    if (approved.filter((a) => a.value.experiment_id === e.key).at(-1)?.value.decision === "approved") {
      throw new PilotError("experiment_in_flight", `Experiment ${shortId(e.key)} is approved and has no keep or revert decision yet. Only one change may be in flight for an agent; finish it with \`analyze\` first, or record \`approve --reject\` for it if it will not run.`);
    }
  }
}

export async function experiment(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const f = frozen(store);
  const active = activePack(store);
  const candidate = candidateOf(store, need(flags, "candidate", "the candidate id"));
  eligibleReplay(store, candidate.id, active.id);
  const start = need(flags, "start", "when the customer will start the split, as a UTC time like 2026-11-16T00:00:00Z");
  if (Number.isNaN(ms(start))) throw new PilotError("usage", "--start must be a UTC time like 2026-11-16T00:00:00Z.");
  const baselineEntry = store.last("baseline.reported");
  if (!baselineEntry) throw new PilotError("not_found", "No baseline report yet. Run `baseline --telemetry <export.json>` first: the experiment is sized from it.");
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
  assertMayRun(store, candidate.id, contentId(spec));
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
  if (body.length > MAX_REVIEW_CHARS) throw new PilotError("too_large", `The review bundle is ${body.length} characters; the limit is ${MAX_REVIEW_CHARS}, so it fits in a pull request. Shorten the rationale or make a smaller change.`);
  // Checked even for the local bundle: a review file is written to be shared. What may appear in it is the
  // baseline prompt (already in the customer's repo) and the review's own generated wording, which is the same
  // review rendered with its two free-text parts, the rationale and the prompt change, left out. Anything those
  // two parts add is checked against the conversations.
  const frame = renderReview({ ...bundle, rationale: "", diff: "" }, id, active.value, replayed.value.target_check_id);
  const sensitive = sensitiveIndex(allPacks(store).map((p) => p.value), [baselinePrompt, frame, publishMessage(bundle)]);
  // The two free-text parts first, so a refusal names the part and the line to change.
  assertEgressSafe(candidate.value.rationale, sensitive, "candidate's rationale");
  assertEgressSafe(candidatePrompt, sensitive, "candidate prompt");
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
  const operator = { publish: true, repo: need(flags, "repo", "repeat the destination repo, owner/name"), base: need(flags, "base", "repeat the base branch"), confirm: need(flags, "confirm", "repeat the full candidate id") };
  // One publication of a candidate at a time: two runs at once could both find no pull request and both commit.
  const result = await store.exclusive(`publish-${shortId(candidate.id)}`, PUBLISH_LOCK_STALE_MS, async () => {
    const r = await publishReview(repo, { config: f.config, bundle: { id, value: bundle }, body, candidate_prompt: candidatePrompt, sensitive, fault: deps.fault, operator });
    store.record("review.published", id, { review: id, pr: String(r.pr), branch: r.branch }, iso(deps.now()));
    return r;
  });
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
  if (decision === "approved") {
    // An approval starts traffic, so it must name the experiment that will run: not one that already ended, not
    // one a newer specification replaced, and not a second one while another is in flight.
    const ended = settledBy(store, experimentId);
    if (ended) throw new PilotError("conflict", `Experiment ${shortId(experimentId)} already ended with ${ended.refs.recommendation}. There is nothing left to approve.`);
    const newest = store.find("experiment.specified").filter((e) => e.refs.candidate === candidateId).at(-1);
    if (newest && newest.key !== experimentId) {
      throw new PilotError("conflict", `Experiment ${shortId(experimentId)} was replaced by a newer specification for this candidate (${shortId(newest.key)}). Run \`review\` again and approve the experiment that review names.`);
    }
    assertMayRun(store, candidateId, experimentId);
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
  const existing = importsFor(store, experimentId);
  let imports = existing;
  let fresh: Stored<TelemetryImport> | null = null;
  if (file) {
    const imported = importTelemetry({
      text: readBounded(file), readSibling: (name) => readBounded(inside(dirname(file), name)),
      purpose: "experiment", scope_id: experimentId, contract: f.config.metric, tags: [spec.arms.baseline.tag, spec.arms.candidate.tag], window: spec.window,
    });
    assertNotFromTheFuture(imported, deps.now());
    const id = contentId(imported);
    if (existing.some((i) => i.id === id)) deps.say(`This export was already imported (${shortId(id)}); nothing is counted twice.`);
    else {
      // A keep or a revert ends the experiment. After a revert the traffic went back to the baseline, so later
      // numbers are not a continuation of it, and a stopped experiment must not come back as a keep.
      const decided = settledBy(store, experimentId);
      if (decided) {
        throw new PilotError("conflict", `Experiment ${shortId(experimentId)} already ended with ${decided.refs.recommendation} (analysis ${shortId(decided.key)}). A decided experiment takes no more exports. Run \`analyze --experiment ${shortId(experimentId)}\` without --telemetry to see that decision again, or start a new experiment.`);
      }
      // The baseline and the experiment must be counted by the same query, or the two numbers are not comparable.
      const baselineHash = importsFor(store, f.config_id)[0]?.value.query_hash ?? null;
      if (importsFor(store, f.config_id).length && baselineHash !== (imported.query_hash ?? null)) {
        throw new PilotError("telemetry_denominator_mismatch", "This export's query_hash is not the one the baseline export carried, so the metric was not computed by the same query as the baseline. Export with the baseline's query.");
      }
      fresh = { id, value: imported };
      imports = [...existing, fresh];
    }
  }
  if (!imports.length) throw new PilotError("telemetry_incomplete", `Experiment ${shortId(experimentId)} has no outcome export yet. Give one with --telemetry <export.json>.`);
  // Analysed before anything is recorded: an export that contradicts an earlier one is refused here and leaves
  // no trace, so the experiment can still be analysed with a correct export.
  const analysis = analyzeExperiment({ spec, experiment_id: experimentId, imports, approval_id: approval.id });
  if (fresh) {
    store.put("telemetry", fresh.value);
    store.record("telemetry.imported", fresh.id, { telemetry: fresh.id, purpose: "experiment", scope: experimentId }, at);
    deps.say(`Imported export ${fresh.value.export_id} as ${fresh.id}.`);
    if (fresh.value.provisional_values_dropped) deps.say(`${fresh.value.provisional_values_dropped} conversations were younger than the outcome lag when exported; their values are treated as not known yet.`);
  }
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
  const head = store.journal().at(-1);
  if (head) deps.say(`Journal head: entry ${head.seq}, ${head.hash} (note it outside this directory; \`verify --head\` checks against it).`);
  return 0;
}

function parsePromotionRequest(source: string): PromotionRequest {
  let v: unknown;
  try { v = JSON.parse(source); } catch { throw new PilotError("invalid_promotion", "The promotion request is not valid JSON."); }
  if (unsafeKey(v) !== null) throw new PilotError("invalid_promotion", "The promotion request has a field named __proto__, constructor or prototype, which is not allowed.");
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
  const requestId = contentId(request);
  const next = promote({ pack: active, request: { id: requestId, value: request }, replays, experiment_ids: store.find("experiment.specified").map((e) => e.key) });
  // The new version goes through the same validation as an imported pack, including redaction of added cases.
  const validated = parsePack(JSON.stringify(next));
  assertNoHoldoutLeak(store, validated);
  // Stored only now: a refused request may hold exactly the content it was refused for.
  store.put("promotion-request", request);
  const newId = store.put("pack", validated);
  const added = new Set(request.added.map((a) => a.case.id));
  const promotedIds = new Set([...request.existing.map((x) => x.case_id), ...added]);
  const record: PromotionRecord = {
    version: 1, request_id: requestId, base_pack_id: active.id, new_pack_id: newId, approver: request.approver, at: request.at,
    promoted: validated.cases.filter((c) => promotedIds.has(c.id)).map((c) => ({ case_id: c.id, split: c.split, kind: added.has(c.id) ? "added" as const : "existing" as const })),
  };
  const recordId = store.put("promotion", record);
  store.record("pack.promoted", newId, { pack: newId, parent: active.id, promotion: recordId, request: requestId }, iso(deps.now()));
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
export async function verify(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const problems: string[] = [];
  const attempt = (what: string, fn: () => void) => { try { fn(); } catch (e) { problems.push(`${what}: ${(e as Error).message}`); } };
  let entries = 0;
  attempt("journal", () => { entries = store.journal().length; });
  // The journal's own head file sits beside it, so someone who cuts entries off the end can rewrite both. A head
  // noted outside the directory cannot be rewritten with them.
  const noted = opt(flags, "head");
  if (noted !== undefined && !problems.length) {
    if (!isSha256(noted)) throw new PilotError("usage", "--head must be the 64-character journal head that `verify` or `analyze` printed earlier.");
    if (!store.journal().some((e) => e.hash === noted)) problems.push(`journal: no entry has the hash given with --head (${shortId(noted)}), so entries were removed or rewritten after that head was noted`);
  }
  let records = 0;
  for (const kind of OBJECT_KINDS) {
    for (const id of store.list(kind)) { records++; attempt(`${kind} ${shortId(id)}`, () => { store.get(kind, id); }); }
  }
  for (const id of store.list("prompt")) { records++; attempt(`prompt ${shortId(id)}`, () => { store.getPrompt(id); }); }
  let recomputed = 0;
  if (!problems.length) {
    const f = frozen(store);
    const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
    // What a step was computed from: every import for its scope that the journal recorded before it. (The ids a
    // report lists are only the imports it used; an older aggregate export it set aside was still an input.)
    const journal = store.journal();
    const importsBefore = (scope: Sha256, seq: number) =>
      journal.filter((x) => x.step === "telemetry.imported" && x.refs.scope === scope && x.seq < seq).map((x) => store.stored<TelemetryImport>("telemetry", x.refs.telemetry));
    const armRecorded = (arm: ArmRun) => journal.some((x) => x.step === "arm.replayed" && x.refs.arm === contentId(arm) && x.refs.prompt === arm.prompt_id && x.refs.pack === arm.pack_id);
    const validApprovals = new Set(approvals(store).map((a) => a.id));
    // Every import the journal names must be one an import could have written: its summary follows from its rows.
    for (const e of journal.filter((x) => x.step === "telemetry.imported")) {
      attempt(`telemetry ${shortId(e.key)}`, () => {
        const imported = store.get<TelemetryImport>("telemetry", e.refs.telemetry);
        if (e.key !== e.refs.telemetry || imported.purpose !== e.refs.purpose || imported.scope_id !== e.refs.scope) throw new Error("the journal describes a different import than the stored one");
        const problem = importProblem(imported, f.config.metric.outcome_lag_days);
        if (problem) throw new Error(`${problem}, so it was not written by an import`);
      });
    }
    // The journal must be in an order the commands can produce. A keep or a revert ends an experiment: nothing is
    // imported or decided for it afterwards, and its candidate gets no second experiment.
    const ended = new Map<string, string>();
    const candidateOfExperiment = new Map<string, string>();
    const endedCandidates = new Set<string>();
    for (const e of journal) {
      if (e.step === "experiment.specified") {
        if (endedCandidates.has(e.refs.candidate)) problems.push(`experiment ${shortId(e.key)}: specified after its candidate ${shortId(e.refs.candidate)} already had a keep or revert decision`);
        candidateOfExperiment.set(e.key, e.refs.candidate);
      } else if (e.step === "telemetry.imported" && ended.has(e.refs.scope)) {
        problems.push(`telemetry ${shortId(e.key)}: imported after experiment ${shortId(e.refs.scope)} had ended with ${ended.get(e.refs.scope)}`);
      } else if (e.step === "analysis.decided") {
        if (ended.has(e.refs.experiment)) problems.push(`analysis ${shortId(e.key)}: recorded after experiment ${shortId(e.refs.experiment)} had ended with ${ended.get(e.refs.experiment)}`);
        else if (e.refs.recommendation === "keep" || e.refs.recommendation === "revert") {
          ended.set(e.refs.experiment, e.refs.recommendation);
          const candidate = candidateOfExperiment.get(e.refs.experiment);
          if (candidate) endedCandidates.add(candidate);
        }
      }
    }
    for (const e of store.find("replay.paired")) {
      attempt(`replay ${shortId(e.key)}`, () => {
        const stored = store.get<ReplayReport>("replay", e.key);
        // The arm runs inside a replay report must be the ones this pilot recorded for those prompts on that
        // pack, and the journal must describe the report it names.
        if (!armRecorded(stored.baseline) || !armRecorded(stored.candidate)) throw new Error("its arm runs are not the ones recorded for these prompts on this pack");
        if (e.refs.candidate !== stored.candidate_id || e.refs.pack !== stored.pack_id || e.refs.eligible !== String(stored.gate.eligible)) throw new Error("the journal describes a different candidate, pack or gate verdict than the stored report");
        const again = pairArms({ pack: store.get<Pack>("pack", stored.pack_id), baseline: stored.baseline, candidate: stored.candidate, target_check_id: stored.target_check_id, gate: f.config.replay.gate });
        if (!same(stored, again)) throw new Error("the stored replay report does not follow from its own arm runs");
        recomputed++;
      });
    }
    for (const e of store.find("baseline.reported")) {
      attempt(`baseline ${shortId(e.key)}`, () => {
        const stored = store.get<BaselineReport>("baseline", e.key);
        const again = baselineReport({ config_id: f.config_id, contract: f.config.metric, tag: f.config.agent.baseline_tag, imports: importsBefore(f.config_id, e.seq) });
        if (!same(stored, again)) throw new Error("the stored baseline report does not follow from its telemetry imports");
        recomputed++;
      });
    }
    for (const e of store.find("analysis.decided")) {
      attempt(`analysis ${shortId(e.key)}`, () => {
        const stored = store.get<ExperimentAnalysis>("analysis", e.key);
        const spec = store.get<ExperimentSpec>("experiment", stored.experiment_id);
        const approval = store.get<Approval>("approval", stored.approval_id);
        if (approval.decision !== "approved" || approval.experiment_id !== stored.experiment_id || approval.candidate_id !== spec.arms.candidate.prompt_id || !validApprovals.has(stored.approval_id)) throw new Error("the approval it cites is not a recorded approval of this candidate and experiment, answering one of this pilot's review bundles");
        const before = new Set(importsBefore(stored.experiment_id, e.seq).map((i) => i.id));
        if (stored.telemetry_ids.some((id) => !before.has(id))) throw new Error("it cites telemetry that was not imported for this experiment before the decision");
        const again = analyzeExperiment({ spec, experiment_id: stored.experiment_id, imports: importsBefore(stored.experiment_id, e.seq), approval_id: stored.approval_id });
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
  // Records no journal entry names. An interrupted step leaves one behind, and so does cutting entries off the
  // end of the journal, so they are listed by kind: a decision or an import nobody recorded deserves a look.
  const journal = store.journal();
  const named = new Set(journal.flatMap((e) => [e.key, ...Object.values(e.refs)]));
  const orphans = OBJECT_KINDS.map((kind) => ({ kind, n: store.list(kind).filter((id) => !named.has(id)).length })).filter((x) => x.n > 0);
  if (orphans.length) {
    deps.say(`Note: ${orphans.reduce((sum, x) => sum + x.n, 0)} stored record(s) are not named by any journal entry: ${orphans.map((x) => `${x.n} ${x.kind}`).join(", ")}. They are not part of the evidence. An interrupted step leaves such records; so does a journal that was cut back. If no step was interrupted, check the journal against a head you noted earlier (\`verify --head <hash>\`).`);
  }
  const head = journal.at(-1);
  if (head) {
    deps.say(`Journal head: entry ${head.seq}, ${head.hash}`);
    deps.say(noted !== undefined
      ? "The journal still holds the entry given with --head, so nothing recorded up to it was removed or rewritten."
      : "Note this head outside the directory (for example in the pull request). `verify --head <hash>` then shows that nothing recorded up to it was removed or rewritten.");
    deps.say("This check shows the records agree with each other and follow from their evidence. It cannot show that an export is truthful. Someone who can write to this directory can add a made-up export and its decision, or cut entries off the end and rewrite journal.head; only a head noted elsewhere shows the second.");
  }
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
