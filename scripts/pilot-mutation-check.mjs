// Breaks each rule of the enterprise pilot (src/pilot/) on purpose and checks that a pilot test fails.
// Same layout as scripts/mutation-check.mjs, kept separate so the two never edit the same list: this one runs only
// the pilot's tests, so it is quick, and it never touches files outside src/pilot/.
//
//   node scripts/pilot-mutation-check.mjs                      every mutation
//   node scripts/pilot-mutation-check.mjs src/pilot/experiment.ts   only that file's
//   MUTATION_MATCH='keep|revert' node scripts/pilot-mutation-check.mjs
//   MUTATION_STALE=1 node scripts/pilot-mutation-check.mjs     list mutations that no longer match the source
//
// Run it in its own worktree and never two at once: each mutation rewrites a source file for a moment.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const EXPERIMENT = "src/pilot/experiment.ts";
const TELEMETRY = "src/pilot/telemetry.ts";
const REPLAY = "src/pilot/replay.ts";
const DISCOVER = "src/pilot/discover.ts";
const PACK = "src/pilot/pack.ts";
const EGRESS = "src/pilot/egress.ts";
const PUBLISH = "src/pilot/publish.ts";
const REVIEW = "src/pilot/review.ts";
const APPROVAL = "src/pilot/approval.ts";
const PROMOTE = "src/pilot/promote.ts";
const STORE = "src/pilot/store.ts";
const IO = "src/pilot/io.ts";
const LIVE = "src/pilot/live.ts";
const MODEL = "src/pilot/model.ts";
const COMMANDS = "src/pilot/commands.ts";
const CONFIG = "src/pilot/config.ts";

const TESTS = readdirSync("test").filter((f) => /^pilot-.*\.test\.ts$/.test(f)).map((f) => `test/${f}`);

// The test files closest to each source file. A mutation is tried against these first, because they are quick and
// usually enough; only a mutation they do not catch is run against every pilot test. So a mutation counts as
// killed if any pilot test fails, exactly as before, but most are settled in a second or two.
const NEAR = {
  [EXPERIMENT]: ["test/pilot-experiment.test.ts"],
  [TELEMETRY]: ["test/pilot-telemetry.test.ts", "test/pilot-experiment.test.ts"],
  [REPLAY]: ["test/pilot-replay.test.ts"],
  [DISCOVER]: ["test/pilot-discover.test.ts"],
  [PACK]: ["test/pilot-pack.test.ts"],
  [EGRESS]: ["test/pilot-egress.test.ts", "test/pilot-publish.test.ts"],
  [PUBLISH]: ["test/pilot-publish.test.ts"],
  [REVIEW]: ["test/pilot-review.test.ts"],
  [APPROVAL]: ["test/pilot-approval.test.ts"],
  [PROMOTE]: ["test/pilot-promote.test.ts"],
  [STORE]: ["test/pilot-store.test.ts"],
  [IO]: ["test/pilot-store.test.ts"],
  [LIVE]: ["test/pilot-live.test.ts"],
  [MODEL]: ["test/pilot-model.test.ts"],
  [CONFIG]: ["test/pilot-config.test.ts"],
};

const allMutations = [
  // Decision boundaries: keep, hold, revert.
  ["keep: an effect below the minimum is kept", EXPERIMENT, "benefit >= p.min_effect - EPS && bCi.lo > EPS", "bCi.lo > EPS"],
  ["keep: an effect that may be zero is kept", EXPERIMENT, "benefit >= p.min_effect - EPS && bCi.lo > EPS", "benefit >= p.min_effect - EPS"],
  ["keep: guards need not pass", EXPERIMENT, 'guards.every((g) => g.readout.status === "pass")', "true"],
  ["keep: allowed before the cutoff", EXPERIMENT, "} else if (!final || holdFlags.length > 0) {", "} else if (holdFlags.length > 0) {"],
  ["keep: allowed with data problems", EXPERIMENT, "} else if (!final || holdFlags.length > 0) {", "} else if (!final) {"],
  ["keep: the cutoff is ignored", EXPERIMENT, "const final = ms(asOf) >= ms(spec.analysis_cutoff);", "const final = true;"],
  ["revert: the early stop never fires", EXPERIMENT, "if (!final && earlyStops.length > 0) {", "if (false) {"],
  ["revert: a final guard breach is ignored", EXPERIMENT, '} else if (final && (finalBreaches.length > 0 || primary.status === "breach")) {', "} else if (false) {"],
  ["revert: a significantly worse primary is ignored", EXPERIMENT, '(finalBreaches.length > 0 || primary.status === "breach")', "(finalBreaches.length > 0)"],
  ["revert: any guard stops early at the nominal level", EXPERIMENT, "if (g.critical && g.early_stop && base.n >= g.early_stop.min_per_arm && cand.n >= g.early_stop.min_per_arm && diff !== null) {", "if (diff !== null) {"],
  ["guard: harm inside the tolerated margin counts as a breach", EXPERIMENT, 'if (hCi !== null && hCi.lo > g.max_harm + EPS) status = "breach";', 'if (hCi !== null && hCi.lo > EPS) status = "breach";'],
  ["guard: an early stop fires on harm inside the margin", EXPERIMENT, "earlyBreach = e !== null && e.lo > g.max_harm + EPS;", "earlyBreach = e !== null && e.lo > EPS;"],
  ["hold: missing outcomes piled up in one arm are not flagged", EXPERIMENT, 'if (missingGap !== null) flags.push("missing_imbalance");', ""],
  ["hold: segments reported for one arm only pass as balanced", EXPERIMENT, '|| oneSided) flags.push("cohort_imbalance");', ') flags.push("cohort_imbalance");'],
  ["hold: a final result from part of the window", EXPERIMENT, 'if (final && !covered) flags.push("window_not_covered");', ""],
  ["hold: too few samples are not flagged", EXPERIMENT, 'if (pm.base.n < spec.required_per_arm || pm.cand.n < spec.required_per_arm) flags.push("insufficient_samples");', ""],
  ["hold: a sample ratio mismatch is not flagged", EXPERIMENT, 'if (srmP !== null && srmP < spec.integrity_alpha) flags.push("sample_ratio_mismatch");', ""],
  ["hold: a cohort imbalance is not flagged", EXPERIMENT, "if ((cohortP !== null && cohortP < spec.integrity_alpha) || oneSided)", "if (oneSided)"],
  ["hold: missing events are not flagged", EXPERIMENT, 'if (missingRates.some((r) => r.rate > spec.max_missing_rate + EPS)) flags.push("missing_events");', ""],
  ["hold: ambiguous attribution is not flagged", EXPERIMENT, 'if (unattributedRate > spec.max_unattributed_rate + EPS) flags.push("attribution_ambiguous");', ""],
  ["hold: observational data is not flagged", EXPERIMENT, 'if (merged.observational) flags.push("observational");', ""],
  ["hold: a runtime change is not flagged", EXPERIMENT, 'if (models > 1) flags.push("runtime_changed");', ""],
  ["analysis accepts another experiment's telemetry", EXPERIMENT, "if (imp.value.scope_id !== input.experiment_id) fail(", "if (false) fail("],

  // Telemetry: tags, windows, units, denominators, duplicates, completeness.
  ["telemetry: the same import counts twice", TELEMETRY, "for (const imp of imports) if (!unique.has(imp.id)) unique.set(imp.id, imp);", "imports.forEach((imp, i) => unique.set(`${imp.id}${i}`, imp));"],
  ["telemetry: a later export may change a recorded value", TELEMETRY, "if (old === null && v !== null) values[k] = v; else ok = false;", "values[k] = v;"],
  ["telemetry: rows and aggregates are combined", TELEMETRY, 'if (forms.size > 1) fail("telemetry_conflict"', 'if (false) fail("telemetry_conflict"'],
  ["telemetry: a unit mismatch is accepted", TELEMETRY, "if (units[m.name] !== m.unit) fail(", "if (false) fail("],
  ["telemetry: a truncated export is accepted", TELEMETRY, 'if (x.expected_rows === undefined) fail("telemetry_incomplete"', 'if (false) fail("telemetry_incomplete"'],
  ["telemetry: a repeated conversation with other values is accepted", TELEMETRY, 'if (conflicting > 0) fail("telemetry_duplicate"', 'if (false) fail("telemetry_duplicate"'],
  ["telemetry: rows outside the export window are accepted", TELEMETRY, 'if (outside > 0) fail("telemetry_window_mismatch"', 'if (false) fail("telemetry_window_mismatch"'],
  ["telemetry: a value exported inside the lag is kept as final", TELEMETRY, 'if (classes[i] !== "immature" || Object.values(r.values).every((v) => v === null)) return r;', "if (true) return r;"],
  ["telemetry: a later export of other rows makes old rows final", TELEMETRY, "(rowAsOf?.[i] ?? asOfMs)", "asOfMs"],
  ["telemetry: the same conversations under new ids are counted twice", TELEMETRY, "      if (gone > 0) {\n", "      if (false) {\n"],
  ["telemetry: a smaller newer aggregate replaces a larger one", TELEMETRY, 'if (shrunk) fail("telemetry_conflict"', 'if (false) fail("telemetry_conflict"'],
  ["telemetry: exports made with different queries are merged", TELEMETRY, 'if (new Set(all.map((i) => i.value.query_hash ?? "none")).size > 1) {', "if (false) {"],
  ["telemetry: a made-up column name is echoed", TELEMETRY, "const shown = (name: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(name) ?", "const shown = (name: string): string => (true ?"],

  // Replay gate, coverage and held-out hygiene.
  ["replay: a new blocking guard failure does not block", REPLAY, "  for (const f of newBlocking) {\n    reasons.push(", "  for (const f of newBlocking) {\n    if (false) reasons.push("],
  ["replay: an unknown baseline excuses the candidate", REPLAY, 'kr.pass === false && br.pass !== false) newBlocking.push(ref);', 'kr.pass === false && br.pass === true) newBlocking.push(ref);'],
  ["replay: low coverage does not block", REPLAY, "const lowCoverage = coverage.paired_cases < gate.min_paired_coverage;", "const lowCoverage = false;"],
  ["replay: too few paired cases do not block", REPLAY, "const fewCases = tally.all.paired < gate.min_paired_cases;", "const fewCases = false;"],
  ["replay: held-out losses do not block", REPLAY, "if (tally.heldout.wins < tally.heldout.losses) {", "if (false) {"],
  ["replay: a pack with no held-out case compared passes", REPLAY, "if (tally.heldout.paired === 0) {", "if (false) {"],
  ["replay: a guard that could not be checked counts as a pass", REPLAY, "if (j.unchecked.length > gate.max_unchecked_blocking_guards) {", "if (false) {"],
  ["replay: guards on turns after a change are not compared", REPLAY, 'if (!both && kr.role !== "guard") return;', "if (!both) return;"],
  ["replay: a missing recorded result is invented", REPLAY, 'if (!hit) { problem = { why: "unsupported"', 'if (false) { problem = { why: "unsupported"'],
  ["replay: turns after a divergence are still scored", REPLAY, 'if (diverged && n < userAt.length) stopped = { turn: n, why: "diverged", detail: diverged };', ""],
  ["replay: arms on different models are compared", REPLAY, "if (baseline.model_destination !== candidate.model_destination) conflict(", "if (false) conflict("],
  ["replay: held-out cases are named to the proposer", REPLAY, "    if (disc(f)) feedback.push(`Blocking guard check ${f.check_id} newly fails on case ${f.case_id} at turn ${f.turn}. Do not weaken that behaviour.`);\n    else hidden = true;", "    feedback.push(`Blocking guard check ${f.check_id} newly fails on case ${f.case_id} at turn ${f.turn}. Do not weaken that behaviour.`);"],
  ["discover: held-out failures become findings", DISCOVER, "    if (!discovery.has(pc.id)) continue;\n", ""],
  ["discover: a held-out case reaches the proposer", DISCOVER, 'if (!allowed.has(f.case_id)) throw new PilotError("holdout_leak"', 'if (false) throw new PilotError("holdout_leak"'],
  ["pack: unredacted text is accepted", PACK, 'if (kinds.length > 0) throw new PilotError("pack_not_redacted"', 'if (false) throw new PilotError("pack_not_redacted"'],
  ["pack: an export not approved for replay is accepted", PACK, '!source.approved_uses.includes("replay")', "false"],
  ["pack: a field named __proto__ is accepted", PACK, "if (unsafeKey(raw) !== null) bad(", "if (false) bad("],

  // Egress, review authority and approvals.
  ["egress: copied conversation wording passes", EGRESS, "for (const run of runsOf(w)) if (index.phrases.has(run)) copied.add(run);", ""],
  ["egress: a single word or identifier from a conversation passes", EGRESS, "for (const word of w) if (index.phrases.has(word)) single.add(word);", ""],
  ["egress: a name that is in many conversations passes", EGRESS, "for (const word of capital) if (!lower.has(word) && !allowed.has(word)) { phrases.add(word); names.add(word); }", ""],
  ["egress: markup that renders into a name passes", EGRESS, "for (const form of new Set([part, rendered(part)])) {", "for (const form of [part]) {"],
  ["egress: a name cut into pieces passes", EGRESS, "if (joined.length >= JOIN_MIN && index.names.has(joined)) single.add(joined);", ""],
  ["egress: an order token that is in many conversations passes", EGRESS, "for (const word of always) if (!allowed.has(word)) phrases.add(word);", ""],
  ["egress: look-alike letters are not read as Latin ones", EGRESS, ".replace(/[^\\x00-\\x7f]/g, (ch) => LOOKALIKES.get(ch) ?? ch)", ""],
  ["egress: a word that mixes alphabets passes", EGRESS, 'if (MIXED.test(rendered(text).normalize("NFKD").replace(/\\p{Cf}/gu, ""))) problems.push', "if (false) problems.push"],
  ["egress: a word inside a case id or catalog sentence is allowed everywhere", EGRESS, "const w = words(withoutIdentifiers(t, identifiers));", "const w = words(t);"],
  ["egress: an identifier the reports print is refused in free text", EGRESS, "const rest = withoutIdentifiers(text, index.identifiers);", "const rest = text;"],
  ["egress: the first word of a sentence is read as a name", EGRESS, "else if ((!isProse || !tok.starts) && tok.lower.length >= NAME_MIN) capital.add(tok.lower);", "else if (tok.lower.length >= NAME_MIN) capital.add(tok.lower);"],
  ["egress: a name at the start of a tool input is not read as a name", EGRESS, "else if ((!isProse || !tok.starts) && tok.lower.length >= NAME_MIN) capital.add(tok.lower);", "else if (!tok.starts && tok.lower.length >= NAME_MIN) capital.add(tok.lower);"],
  ["egress: a redaction placeholder is read as a name", EGRESS, 'const toks = tokens(t.replace(PLACEHOLDER, " "));', "const toks = tokens(t);"],
  ["egress: hidden characters and accents break the match", EGRESS, '.replace(/[\\p{M}\\p{Cf}]/gu, "")', ""],
  ["egress: only runs of six words are matched", EGRESS, "const RUN = 3;", "const RUN = 6;"],
  ["egress: nothing particular to a conversation is indexed", EGRESS, "if (count <= few && !allowed.has(item)) phrases.add(item);", "if (count <= 0 && !allowed.has(item)) phrases.add(item);"],
  ["egress: tool input field names are not indexed", EGRESS, "for (const [k, v] of Object.entries(value)) { out.push(k); stringsIn(v, out); }", "for (const v of Object.values(value)) stringsIn(v, out);"],
  ["publish: no explicit --publish needed", PUBLISH, "if (operator.publish !== true) {", "if (false) {"],
  ["publish: any confirmation is accepted", PUBLISH, "if (operator.confirm !== b.candidate_id) {", "if (false) {"],
  ["publish: another repo is accepted", PUBLISH, "if (slugs.some((s) => s !== config.repo.slug)) {", "if (false) {"],
  ["publish: a failed replay gate is published", PUBLISH, "if (b.replay.gate.eligible !== true) {", "if (false) {"],
  ["publish: the body is not checked before it leaves", PUBLISH, 'assertEgressSafe(input.body, input.sensitive, "pull request body");', ""],
  ["publish: the candidate prompt is not checked before it leaves", PUBLISH, 'assertEgressSafe(input.candidate_prompt, input.sensitive, "candidate prompt");', ""],
  ["publish: a changed base prompt is overwritten", PUBLISH, "if (promptId(current) !== b.baseline_prompt_id) {", "if (false) {"],
  ["publish: a retry opens a second pull request", PUBLISH, "if (existing !== null) return { pr: existing.number, branch, adopted: true };", ""],
  ["publish: an ambient GitHub token is used", COMMANDS, "const token = deps.env[GITHUB_TOKEN_ENV]?.trim();", "const token = (deps.env[GITHUB_TOKEN_ENV] ?? deps.env.GITHUB_TOKEN)?.trim();"],
  ["review: a local bundle is written without the egress check", COMMANDS, 'assertEgressSafe(body, sensitive, "review bundle");', ""],
  ["review: a published review is published again", COMMANDS, "  if (published) {\n", "  if (false) {\n"],
  ["approval: a rejection counts as approval", APPROVAL, 'if (latest.value.decision === "rejected") throw', "if (false) throw"],
  ["approval: a record that answers no review counts", COMMANDS, "\n    && reviews.some((r) => r.key === a.value.review_id && r.refs.candidate === a.value.candidate_id && r.refs.experiment === a.value.experiment_id));", ");"],
  ["analysis: a decided experiment takes another export", COMMANDS, "      if (decided) {\n", "      if (false) {\n"],
  ["analysis: an export dated in the future is accepted", COMMANDS, "if (ms(imported.exported_at) > now.getTime() + CLOCK_SKEW_MS) {", "if (false) {"],
  ["analysis: the experiment may use another query than the baseline", COMMANDS, "if (importsFor(store, f.config_id).length && baselineHash !== (imported.query_hash ?? null)) {", "if (false) {"],
  ["pack: a hand-made successor replaces the frozen pack", COMMANDS, "  if (current && current.refs.pack !== id) {", "  if (false) {"],
  ["pack: a held-out conversation copied under a new id becomes discovery", COMMANDS, "heldIds.has(c.id) || conversationKeys(c).some((k) => heldConversations.has(k))\n", "heldIds.has(c.id)\n"],
  ["pack: a held-out conversation with a word added becomes discovery", COMMANDS, "    || (added.has(c.id) && heldRuns.some((runs) => nearCopy(customerRuns(c), runs)))\n", ""],
  ["init: git follows the shell's GIT_DIR", COMMANDS, ' && !k.startsWith("GIT_")', ""],
  ["init: a repo on another host passes the origin check", COMMANDS, " || (api === GITHUB_API && !GITHUB_HOSTS.has(remote.host.toLowerCase()))", ""],
  ["verify: a replay built from unrecorded arm runs passes", COMMANDS, "if (!armRecorded(stored.baseline) || !armRecorded(stored.candidate)) throw", "if (false) throw"],
  ["approval: a short id is accepted", COMMANDS, "if (!isSha256(candidateId) || !isSha256(experimentId)) throw", "if (false) throw"],
  ["analysis: runs without an approval", COMMANDS, "const approval = requireApproval(approvals(store), spec.arms.candidate.prompt_id, experimentId);", "const approval = approvals(store)[0] ?? { id: '0'.repeat(64) };"],
  ["experiment: a rejected candidate gets a specification", COMMANDS, "  eligibleReplay(store, candidate.id, active.id);\n  const start", "  const start"],
  ["experiment: two changes in flight", COMMANDS, 'if (approved.filter((a) => a.value.experiment_id === e.key).at(-1)?.value.decision === "approved") {\n      throw new PilotError("experiment_in_flight"', 'if (false) {\n      throw new PilotError("experiment_in_flight"'],
  ["experiment: a second experiment for the same candidate is allowed", COMMANDS, "    if (e.key === experimentId) continue;\n    const ended = settledBy(store, e.key);", "    if (e.key === experimentId || e.refs.candidate === candidateId) continue;\n    const ended = settledBy(store, e.key);"],
  ["experiment: a decided candidate is measured again", COMMANDS, '      if (e.refs.candidate === candidateId) {\n        throw new PilotError("conflict", `Candidate', '      if (false) {\n        throw new PilotError("conflict", `Candidate'],
  ["approval: an experiment that already ended can be approved", COMMANDS, 'if (ended) throw new PilotError("conflict", `Experiment ${shortId(experimentId)} already ended with ${ended.refs.recommendation}. There is nothing left to approve.`);', ""],
  ["approval: a replaced specification can be approved", COMMANDS, "if (newest && newest.key !== experimentId) {", "if (false) {"],
  ["approval: a second experiment can be approved while one is in flight", COMMANDS, "    assertMayRun(store, candidateId, experimentId);\n  }\n  const approval = makeApproval(", "  }\n  const approval = makeApproval("],
  ["verify: an import whose summary does not follow from its rows passes", COMMANDS, "if (problem) throw new Error(`${problem}, so it was not written by an import`);", ""],
  ["verify: an export imported after the decision passes", COMMANDS, '} else if (e.step === "telemetry.imported" && ended.has(e.refs.scope)) {', "} else if (false) {"],
  ["verify: a decision recorded after the experiment ended passes", COMMANDS, "if (ended.has(e.refs.experiment)) problems.push(", "if (false) problems.push("],
  ["verify: a noted journal head that is gone passes", COMMANDS, "if (!store.journal().some((e) => e.hash === noted)) problems.push(", "if (false) problems.push("],
  ["pack: a reformatted copy of a held-out conversation becomes discovery", COMMANDS, 'return said.length >= COPY_MIN_WORDS ? [`said:${said.join(" ")}`, all] : [all];', "return [all];"],
  ["publish: two publications of one candidate run at once", STORE, "    const release = this.acquire(`${name}.lock`, staleMs);\n    try { return await fn(); } finally { release(); }", "    return await fn();"],
  ["promote: a held-out case can be re-added as discovery", PROMOTE, 'if (heldOutIds.has(id)) throw new PilotError("holdout_leak"', 'if (false) throw new PilotError("holdout_leak"'],
  ["pack: a later pack may move a held-out case to discovery", COMMANDS, "  if (leaked.length) {\n", "  if (false) {\n"],
  ["init: a frozen contract can be replaced", COMMANDS, "if (earlier && (earlier.refs.config !== configId || earlier.refs.baseline_prompt !== promptId || earlier.refs.commit !== commit)) {", "if (false) {"],

  // Records and retries.
  ["store: a stored record can be replaced", IO, 'if (readFileSync(path, "utf8") === content) return "already there";\n    throw new PilotError("conflict"', 'return "already there";\n    throw new PilotError("conflict"'],
  ["store: an edited record is used", STORE, "if (contentId(value) !== id) throw new PilotError(\"tampered\"", "if (false) throw new PilotError(\"tampered\""],
  ["store: an edited journal is accepted", STORE, "if (e.seq !== entries.length + 1 || e.prev !== prev || entryHash(rest) !== hash) {", "if (false) {"],
  ["store: a retried step is recorded twice", STORE, "      if (same) {\n", "      if (false) {\n"],
  ["store: entries cut off the end of the journal pass", STORE, "if (head && (entries.length < head.seq || entries[head.seq - 1].hash !== head.hash)) {", "if (false) {"],
  ["store: a missing journal head passes", STORE, 'if (!head && entries.length > 1) throw', "if (false) throw"],
  ["store: a damaged record blocks every retry", STORE, 'if (!(e instanceof PilotError) || e.code !== "conflict") throw e;', "throw e;"],
  ["store: an old lock blocks for ever", STORE, "try { if (Date.now() - statSync(lock).mtimeMs > staleMs) alive = false; } catch { alive = false; }", ""],
  ["main: an unexpected error prints its message", "src/pilot/main.ts", 'if (deps.env.SYNTHE_PILOT_DEBUG === "1")', "if (true)"],
  ["io: a file name can leave its directory", IO, 'if (isAbsolute(name) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw', "if (false) throw"],
  ["io: an input of any size is read", IO, "if (size > maxBytes) throw", "if (false) throw"],
  ["verify: a decision that does not follow from its evidence passes", COMMANDS, "if (!same(stored, again)) throw new Error(`the stored recommendation", "if (false) throw new Error(`the stored recommendation"],

  // Model providers.
  ["live: runs without the opt-in flag", LIVE, 'if (!optIn.live) return refuse("A live model runs only with --live.");', ""],
  ["live: runs without a recorded approval", LIVE, "if (approval === null) return refuse(", "if (approval === null && false) return refuse("],
  ["live: any endpoint confirmation is accepted", LIVE, "if (optIn.endpoint !== approval.endpoint) return refuse(", "if (false) return refuse("],
  ["live: any data class confirmation is accepted", LIVE, "if (optIn.data_class !== approval.data_class) return refuse(", "if (false) return refuse("],
  ["live: falls back to another key variable", LIVE, "const key = env[approval.key_env]?.trim();", "const key = (env[approval.key_env] ?? env.ANTHROPIC_API_KEY)?.trim();"],
  ["live: the destination is not announced", LIVE, '  say(`Sending "${approval.data_class}" to ${approval.provider} at ${approval.endpoint} (model ${approval.model}).`);\n', ""],
  ["live: the assistant turn is rebuilt instead of repeated", LIVE, "if (kept) { out.push({ role: \"assistant\", content: kept }); continue; }", ""],
  ["live: another model than the approved one runs", LIVE, "if (request.model !== approval.model) return refuse(", "if (false) return refuse("],
  ["live: the SDK resends behind the call limit", LIVE, "maxRetries: 0,", "maxRetries: 2,"],
  ["live: the shell can add request headers", LIVE, "  delete process.env.ANTHROPIC_CUSTOM_HEADERS;\n", ""],
  ["live: a provider error is passed on whole", LIVE, 'throw new Error(`The provider request failed (${status}, ${e instanceof Error ? e.name : "error"}).`);', "throw e;"],
  ["model: two scripts with one name share replays", MODEL, "destination: `scripted:${script.name}@${shortId(contentId(script))}`,\n    async chat", "destination: `scripted:${script.name}`,\n    async chat"],
  ["model: tool definitions are not counted in the limit", MODEL, "r.system.length + JSON.stringify(r.tools).length + r.messages.reduce(", "r.system.length + r.messages.reduce("],
  ["model: the call limit is not enforced", MODEL, "if (calls + 1 > limits.max_calls) throw", "if (false) throw"],
  ["model: the character limit is not enforced", MODEL, "if (chars + size > limits.max_input_chars) throw", "if (false) throw"],
  ["config: a review may go to any host", CONFIG, "if (api !== GITHUB_API && !isLoopback(api)) bad(", "if (false) bad("],
  ["config: a provider endpoint may be plain http", CONFIG, 'if (url.protocol !== "https:" && !isLoopback(endpoint)) bad(', "if (false) bad("],
  ["config: unknown fields are ignored", CONFIG, "if (extra !== undefined) bad(", "if (false) bad("],
  // Added after the second review.
  ["telemetry: one conversation under two ids is counted twice", TELEMETRY, 'if (twins > 0) fail("telemetry_duplicate"', 'if (false) fail("telemetry_duplicate"'],
  ["telemetry: an aggregate count may fall by any amount", TELEMETRY, "const moved = Math.max(0, n.unattributed - o.unattributed);", "const moved = Infinity;"],
  ["telemetry: conversations moved to unattributed refuse an honest update", TELEMETRY, "const moved = Math.max(0, n.unattributed - o.unattributed);", "const moved = 0;"],
  ["telemetry: a conversation an earlier export missed is not noticed", TELEMETRY, "if (started >= span.from && started < span.to && started <= span.at) missed = span.at;", ""],
  ["report: conversations that turn up late are not reported", EXPERIMENT, 'if (lateRows > Math.max(LATE_ROWS_MIN, LATE_ROWS_SHARE * onTime)) flags.push("late_rows");', ""],
  ["report: a conversation that was inside the lag counts as late", EXPERIMENT, "return missed !== null && ms(r.started_at) + lag <= missed;", "return missed !== null;"],
  ["hold: late conversations hold an honest result for good", EXPERIMENT, '  "observational", "runtime_changed", "inside_lag_window", "window_not_covered",', '  "late_rows", "observational", "runtime_changed", "inside_lag_window", "window_not_covered",'],
  ["telemetry: an export with every conversation in it twice is read", TELEMETRY, "  if (copies !== null) {\n", "  if (false) {\n"],
  ["telemetry: values that follow the clock refuse an honest export", TELEMETRY, "const share = Math.max((common.get(attributes[i]) ?? 0) / sorted.length, neighbours > 0 ? (around.get(attributes[i]) ?? 0) / neighbours : 0);", "const share = (common.get(attributes[i]) ?? 0) / sorted.length;"],
  ["telemetry: twins that chance explains refuse an honest export", TELEMETRY, "if (excess <= Math.max(5, 0.05 * rows.length) || excess <= 7 * Math.sqrt(variance)) return null;", "if (twins === 0) return null;"],
  ["review: the rationale is rendered as markdown", REVIEW, '...(bundle.rationale.trim() === "" ? ["No rationale was recorded."] : literal(bundle.rationale.trim(), "text")),', "bundle.rationale.trim(),"],
  ["review: free text can close its own fence", REVIEW, 'const fence = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));', 'const fence = "```";'],
  ["publish: two publications in one process both run", STORE, "(owner === process.pid ? HELD.has(lock) : true)", "owner !== process.pid"],
  ["live: a call may wait for the SDK's ten minutes", LIVE, "maxRetries: 0, timeout: timeoutMs, logLevel", "maxRetries: 0, logLevel"],
];

const selectedFiles = process.argv.slice(2);
const nameFilter = process.env.MUTATION_MATCH ? new RegExp(process.env.MUTATION_MATCH) : null;
const mutations = allMutations.filter(([name, file]) => (selectedFiles.length === 0 || selectedFiles.includes(file)) && (!nameFilter || nameFilter.test(name)));
if (!mutations.length) throw new Error("No mutations match the requested files");
// MUTATION_STALE=1: only list the mutations whose text is no longer in the source, without running any test.
if (process.env.MUTATION_STALE) {
  const stale = mutations.filter(([, file, from]) => !readFileSync(file, "utf8").includes(from));
  for (const [name] of stale) console.log(`STALE     ${name}`);
  console.log(`${mutations.length} mutations, ${stale.length} stale`);
  process.exit(stale.length ? 1 : 0);
}
console.log(`Checking ${mutations.length} pilot mutations${selectedFiles.length ? ` in ${selectedFiles.join(", ")}` : ""}`);
const run = (files) => spawnSync(process.execPath, [...process.execArgv, "--test", ...files], { stdio: "ignore", timeout: 300000 }).status;
if (run(TESTS) !== 0) throw new Error("The unmutated pilot tests must pass before checking mutations");

// Every mutated file as it was before the run, restored at the end whatever happened in between.
const before = new Map([...new Set(mutations.map(([, file]) => file))].map((f) => [f, readFileSync(f, "utf8")]));

let survived = 0;
for (const [name, file, from, to] of mutations) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) { console.log(`STALE     ${name}`); survived++; continue; }
  const restore = () => writeFileSync(file, original);
  process.once("SIGINT", restore);
  try {
    writeFileSync(file, original.replace(from, to));
    const near = NEAR[file];
    let status = near ? run(near) : 0;
    if (status === 0) status = run(TESTS);
    if (status === 0 || status === null) survived++;
    console.log(`${status === null ? "TIMED OUT" : status === 0 ? "SURVIVED " : "killed   "} ${name}`);
  } finally {
    restore();
    process.removeListener("SIGINT", restore);
  }
}
const changed = [...before].filter(([f, text]) => readFileSync(f, "utf8") !== text).map(([f]) => f);
for (const f of changed) writeFileSync(f, before.get(f));
if (changed.length) console.log(`RESTORED  ${changed.join(", ")}: a file differed from before the run; check no other mutation run was going at the same time`);
console.log(survived ? `FAILED: ${survived} of ${mutations.length} not killed` : `OK: ${mutations.length} of ${mutations.length} killed`);
process.exitCode = survived || changed.length ? 1 : 0;
