import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { analyze, frozen, openExperiments, report, verify, type Flags, type PilotDeps } from "./commands.ts";
import { PilotError } from "./errors.ts";
import { EARLY_STOP_LEVEL } from "./experiment.ts";
import { contentId, DAY_MS, ms, shortId } from "./ids.ts";
import { inside, printable, readBounded } from "./io.ts";
import type { PilotStore } from "./store.ts";
import { importTelemetry } from "./telemetry.ts";
import type { ExperimentSpec, IsoTime, Sha256, TelemetryImport } from "./types.ts";

// `watch` is one tick of a schedule an operator runs on their own machine (cron). It decides whether a look at the
// experiment is allowed, runs the unchanged `analyze` when it is, writes reports/WATCH.md and exits. It adds no way
// to import telemetry, no journal step and no state file: the frozen specification, the journal's analyses and the
// clock are all it needs. It never publishes, never changes traffic and never uses the network.

// ---------------------------------------------------------------------------------------------------------------
// The look gate.
// ---------------------------------------------------------------------------------------------------------------

export interface Look { at: IsoTime; final: boolean; recommendation: "keep" | "hold" | "revert" }
export type Gate =
  | { action: "done"; why: string }
  | { action: "wait"; why: string; next: IsoTime | null }
  | { action: "interim"; used: number; allowed: number }
  | { action: "final"; used: number; allowed: number };

// Before the cutoff an analysis can only hold, or revert through a critical guard's early stop, which is a fixed 99.9%
// check at every analysis. Each analysis is one more chance of a false stop, so their number is capped; the bound
// per look and per critical guard is this.
export const FALSE_STOP_PER_LOOK = 1 - EARLY_STOP_LEVEL;

const iso = (t: number): IsoTime => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const dayStart = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

function whole(interimDays: number): number {
  if (!Number.isInteger(interimDays) || interimDays < 1) throw new PilotError("usage", "--interim-days must be a whole number of 1 or more.");
  return interimDays;
}

export function interimLooksAllowed(spec: ExperimentSpec, interimDays: number): number {
  return Math.ceil((ms(spec.analysis_cutoff) - ms(spec.window.start)) / (whole(interimDays) * DAY_MS));
}

export function lookGate(input: { spec: ExperimentSpec; looks: Look[]; now: Date; interimDays?: number }): Gate {
  const { spec, looks } = input;
  const interimDays = whole(input.interimDays ?? 1);
  const decided = looks.find((l) => l.recommendation === "keep" || l.recommendation === "revert");
  if (decided) return { action: "done", why: `The experiment already ended with ${decided.recommendation}.` };
  if (looks.some((l) => l.final)) return { action: "done", why: "The final analysis is recorded. It stands and is never redone." };
  const now = input.now.getTime();
  const cutoff = ms(spec.analysis_cutoff);
  const start = ms(spec.window.start);
  // The cap counts journal entries, not dates: a clock that steps backwards cannot buy extra looks.
  const used = looks.filter((l) => !l.final).length;
  const allowed = interimLooksAllowed(spec, interimDays);
  if (now >= cutoff) return { action: "final", used, allowed };
  if (now < start) return { action: "wait", why: "The experiment window has not started.", next: spec.window.start };
  if (used >= allowed) return { action: "wait", why: `All ${allowed} interim looks are used.`, next: spec.analysis_cutoff };
  if (looks.length > 0) {
    const newest = Math.max(...looks.map((l) => ms(l.at)));
    const today = dayStart(now);
    const sameDay = looks.some((l) => dayStart(ms(l.at)) === today);
    const days = (today - dayStart(newest)) / DAY_MS;
    if (sameDay || days < interimDays) {
      const next = Math.min(dayStart(newest) + interimDays * DAY_MS, cutoff);
      return { action: "wait", why: sameDay ? "A look was already made today (UTC)." : `Fewer than ${interimDays} whole UTC days have passed since the last look.`, next: iso(next) };
    }
  }
  return { action: "interim", used, allowed };
}

// ---------------------------------------------------------------------------------------------------------------
// One tick.
// ---------------------------------------------------------------------------------------------------------------

// Writes one export now from a log directory. Another module supplies the real one; `watch` only calls it.
export type LogExporter = (input: { store: PilotStore; experimentId: Sha256; logDir: string; assignment: string; now: Date }) => { path: string };

// The start of the message the evidence lock and the watch lock refuse with when another command holds them.
export const BUSY_PREFIX = "Another pilot command";
const isBusy = (e: unknown): boolean => e instanceof PilotError && e.code === "conflict" && e.message.startsWith(BUSY_PREFIX);

const WATCH_LOCK = "watch";
const WATCH_LOCK_STALE_MS = 10 * 60_000;
const MAX_INBOX_FILES = 500;
const SHOWN_FILES = 20;

type FileState = "imported" | "pending" | "superseded" | "invalid";
export interface WatchFile { name: string; state: FileState; exported_at?: IsoTime; code?: string; message?: string }
export interface WatchLook extends Look { analysis: Sha256 }

export interface WatchView {
  pilot_id: string;
  experiment: { id: Sha256; spec: ExperimentSpec } | null;
  now: IsoTime;
  // What this tick did, one plain sentence each.
  did: string[];
  // What may happen next, judged after the tick.
  gate: Gate | null;
  looks: WatchLook[];
  interim_days: number;
  // null: the files were not read in this tick (no look was allowed).
  files: WatchFile[] | null;
  refusal: { code: string; message: string } | null;
  verify: string[] | null;
  head: { seq: number; hash: string } | null;
}

const flagText = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);

export function renderWatch(v: WatchView): string {
  const last = v.looks.at(-1);
  const label = last ? last.recommendation.toUpperCase() : "WAITING";
  const who = v.experiment ? `pilot ${printable(v.pilot_id, 60)}, experiment ${shortId(v.experiment.id)}` : `pilot ${printable(v.pilot_id, 60)}`;
  const L: string[] = [`# ${label} (${who})`, ""];
  if (last) L.push(last.final || last.recommendation !== "hold" ? `Latest analysis: ${last.recommendation}${last.final ? ", final" : ", before the cutoff"}.` : "Latest analysis: hold, before the cutoff. The experiment is still running.", "");
  else L.push(v.experiment ? "No analysis yet." : "No approved experiment is open. Watch waits for an approval: record one with `approve` after the review, and it starts to look.", "");
  L.push("## This tick", "", `Run at ${v.now}.`, ...v.did.map((d) => `- ${d}`), "");
  if (v.refusal) L.push(`Refused (${v.refusal.code}): ${printable(v.refusal.message, 400)}`, "");
  if (v.experiment) {
    const spec = v.experiment.spec;
    L.push("## Experiment", "", `- Window: ${spec.window.start} to ${spec.window.end}.`, `- Analysis cutoff: ${spec.analysis_cutoff}. Only an export made at or after it gives the final result.`, "");
    L.push("## Looks", "");
    if (v.looks.length === 0) L.push("None yet.", "");
    else {
      L.push("| Time | Kind | Recommendation | Analysis |", "| --- | --- | --- | --- |", ...v.looks.map((l) => `| ${l.at} | ${l.final ? "final" : "interim"} | ${l.recommendation} | ${shortId(l.analysis)} |`), "");
    }
    const allowed = interimLooksAllowed(spec, v.interim_days);
    const used = v.looks.filter((l) => !l.final).length;
    const critical = spec.guards.some((g) => g.critical && g.early_stop);
    const chance = Math.min(100, Number((allowed * FALSE_STOP_PER_LOOK * 100).toFixed(2)));
    L.push(`Interim looks: ${used} used of ${allowed} allowed. ${critical
      ? `Each interim look checks critical guards at ${Number((EARLY_STOP_LEVEL * 100).toFixed(2))}%, so the chance of a false early stop is at most ${allowed} x ${Number((FALSE_STOP_PER_LOOK * 100).toFixed(2))}% = ${chance}% per critical guard.`
      : "This experiment has no critical guard with an early stop, so interim looks cannot end it."}`, "");
    L.push("## Next look", "", v.gate ? gateLine(v.gate) : "Not known.", "");
    if (v.looks.length) L.push(`Decision file: reports/decision-${shortId(v.experiment.id)}.md`, "");
  }
  L.push("## Files", "");
  if (v.files === null) L.push("The files were not read in this tick: no look was allowed, or the experiment is decided.", "");
  else {
    for (const state of ["imported", "pending", "superseded", "invalid"] as const) {
      const of = v.files.filter((f) => f.state === state);
      L.push(`${state}: ${of.length}`);
      for (const f of of.slice(0, SHOWN_FILES)) L.push(`- ${printable(f.name, 80)}${f.exported_at ? ` (exported ${f.exported_at})` : ""}${state === "invalid" ? `: ${f.code}: ${printable(f.message ?? "", 300)}` : ""}`);
      if (of.length > SHOWN_FILES) L.push(`- ... and ${of.length - SHOWN_FILES} more`);
    }
    L.push("");
  }
  if (v.verify) L.push("## Verify failed", "", ...v.verify.map((l) => `- ${printable(l, 400)}`), "");
  if (v.head) L.push("## Journal", "", `Head: entry ${v.head.seq}, ${v.head.hash}. Note it outside this directory: \`verify --head ${v.head.hash}\` then shows that nothing up to it was removed or rewritten.`, "");
  L.push("Nothing was published. This command never opens a pull request and never changes traffic. Publishing a review needs a person: `review --publish … --confirm <full candidate id>`.", "");
  return L.join("\n");
}

function gateLine(g: Gate): string {
  switch (g.action) {
    case "done": return `No more looks. ${g.why}`;
    case "wait": return `${g.why}${g.next ? ` The next look may run from ${g.next}.` : ""}`;
    case "interim": return `An interim look may run now (${g.used} of ${g.allowed} used). It needs an export newer than the last one and made before the cutoff.`;
    case "final": return "The final look may run now. It needs an export made at or after the cutoff.";
  }
}

const looksOf = (store: PilotStore, experiment: Sha256): WatchLook[] =>
  store.find("analysis.decided").filter((e) => e.refs.experiment === experiment).map((e) => ({ at: e.at, final: e.refs.final === "true", recommendation: e.refs.recommendation as Look["recommendation"], analysis: e.refs.analysis }));

// Every *.json file directly in the inbox, read the way `analyze` reads one.
function scanInbox(store: PilotStore, inbox: string, experimentId: Sha256, spec: ExperimentSpec): { files: (WatchFile & { path: string })[]; importedKeys: Set<string> } {
  let names: string[];
  try {
    names = readdirSync(inbox, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".json")).map((d) => d.name).sort();
  } catch { throw new PilotError("not_found", `${printable(inbox, 120)} is not a directory that can be read.`); }
  if (names.length > MAX_INBOX_FILES) throw new PilotError("usage", `${names.length} .json files are in the inbox; the limit is ${MAX_INBOX_FILES}. Move the ones that are done out of it.`);
  const f = frozen(store);
  const imports = store.find("telemetry.imported").filter((e) => e.refs.scope === experimentId);
  const importedKeys = new Set(imports.map((e) => e.key));
  const newest = Math.max(-Infinity, ...imports.map((e) => ms(store.get<TelemetryImport>("telemetry", e.refs.telemetry).exported_at)));
  const files = names.map((name): WatchFile & { path: string } => {
    const path = join(inbox, name);
    try {
      const imported = importTelemetry({
        text: readBounded(path), readSibling: (n) => readBounded(inside(dirname(path), n)),
        purpose: "experiment", scope_id: experimentId, contract: f.config.metric, tags: [spec.arms.baseline.tag, spec.arms.candidate.tag], window: spec.window,
      });
      const state: FileState = importedKeys.has(contentId(imported)) ? "imported" : ms(imported.exported_at) <= newest ? "superseded" : "pending";
      return { name, path, state, exported_at: imported.exported_at };
    } catch (e) {
      if (!(e instanceof PilotError)) throw e;
      return { name, path, state: "invalid", code: e.code, message: e.message };
    }
  });
  return { files, importedKeys };
}

export async function watch(store: PilotStore, flags: Flags, deps: PilotDeps, logExport?: LogExporter): Promise<number> {
  const inbox = flagText(flags, "inbox");
  const logDir = flagText(flags, "log");
  const assignment = flagText(flags, "assignment");
  if ((inbox === undefined) === (logDir === undefined) || flags.inbox === true || flags.log === true) throw new PilotError("usage", "Give exactly one source: --inbox <dir> or --log <dir> (with --assignment).");
  if (logDir !== undefined && !assignment) throw new PilotError("usage", "--log needs --assignment: how conversations were assigned to the two prompts.");
  if (inbox !== undefined && assignment !== undefined) throw new PilotError("usage", "--assignment goes with --log only.");
  if (logDir !== undefined && !logExport) throw new PilotError("usage", "--log is not available in this build");
  const rawDays = flagText(flags, "interim-days");
  if (flags["interim-days"] === true || (rawDays !== undefined && !/^\d+$/.test(rawDays))) throw new PilotError("usage", "--interim-days must be a whole number of 1 or more.");
  const interimDays = whole(rawDays === undefined ? 1 : Number(rawDays));
  let started = false;
  try {
    return await store.exclusive(WATCH_LOCK, WATCH_LOCK_STALE_MS, () => { started = true; return tick(store, flags, deps, { inbox, logDir, assignment, interimDays, logExport }); });
  } catch (e) {
    // A busy lock means another tick is running: this one does nothing, which is not an error.
    if (!started && isBusy(e)) { deps.say("Another watch is running; this tick did nothing."); return 0; }
    throw e;
  }
}

interface Source { inbox?: string; logDir?: string; assignment?: string; interimDays: number; logExport?: LogExporter }

async function tick(store: PilotStore, flags: Flags, deps: PilotDeps, src: Source): Promise<number> {
  const f = frozen(store);
  const now = deps.now();
  // Nothing from the caller's environment reaches the commands a tick runs: no GitHub token, no provider key, and
  // no github or network function either.
  const quiet = (sink: string[]): PilotDeps => ({ say: (l) => { sink.push(l); }, env: {}, now: deps.now, fault: deps.fault });
  const view: WatchView = { pilot_id: f.config.pilot_id, experiment: null, now: iso(now.getTime()), did: [], gate: null, looks: [], interim_days: src.interimDays, files: null, refusal: null, verify: null, head: null };
  const finish = async (code: number): Promise<number> => {
    view.head = store.journal().at(-1) ? { seq: store.journal().at(-1)!.seq, hash: store.journal().at(-1)!.hash } : null;
    const path = store.report("WATCH.md", renderWatch(view));
    await report(store, {}, quiet([]));
    const last = view.looks.at(-1);
    deps.say(`Watch tick at ${view.now}: ${view.did[0] ?? "nothing to do."}`);
    deps.say(last ? `Recommendation: ${last.recommendation.toUpperCase()} (${last.final ? "final" : "before the cutoff"}).` : view.experiment ? "No analysis yet." : "No approved experiment is open.");
    if (view.gate) deps.say(gateLine(view.gate));
    if (view.refusal) deps.say(`Refused (${view.refusal.code}): ${printable(view.refusal.message, 200)}`);
    if (view.verify) deps.say("Verification failed; the lines are in WATCH.md.");
    deps.say(`Report: ${path}`);
    return code;
  };

  const open = openExperiments(store);
  const given = flagText(flags, "experiment");
  let target: { id: Sha256; spec: ExperimentSpec } | null = null;
  if (given !== undefined) {
    const id = store.resolve("experiment", given);
    const settled = store.find("analysis.decided").some((e) => e.refs.experiment === id && (e.refs.recommendation === "keep" || e.refs.recommendation === "revert"));
    if (settled || open.some((o) => o.id === id)) target = { id, spec: store.get<ExperimentSpec>("experiment", id) };
  } else if (open.length > 1) throw new PilotError("usage", "More than one experiment is open; name one with --experiment.");
  else if (open[0]) target = { id: open[0].id, spec: open[0].value };
  else {
    // Nothing is open: if the last experiment ended, keep showing its result, so the report does not turn back
    // into "waiting" after a keep or a revert.
    const ended = store.find("analysis.decided").filter((e) => e.refs.recommendation === "keep" || e.refs.recommendation === "revert").at(-1);
    if (ended) target = { id: ended.refs.experiment, spec: store.get<ExperimentSpec>("experiment", ended.refs.experiment) };
  }
  if (!target) {
    view.did.push(given !== undefined ? `Experiment ${printable(given, 20)} has no approval. Nothing was imported or analysed; watch waits for an approval.` : "No approved experiment is open. Nothing was imported or analysed; watch waits for an approval.");
    return finish(0);
  }
  view.experiment = target;
  view.looks = looksOf(store, target.id);
  const gate = lookGate({ spec: target.spec, looks: view.looks, now, interimDays: src.interimDays });
  let code = 0;
  let analyzed = false;
  if (gate.action === "done" || gate.action === "wait") {
    view.did.push(`No look was allowed: ${gate.why} Nothing was imported or analysed.`);
    view.gate = gate;
    return finish(0);
  }

  const before = view.looks.length;
  let path: string | null = null;
  const nowMs = now.getTime();
  const cutoff = ms(target.spec.analysis_cutoff);
  let scanned: WatchFile[] | null = null;
  try {
    if (src.inbox !== undefined) {
      const { files } = scanInbox(store, src.inbox, target.id, target.spec);
      scanned = files;
      const pending = files.filter((x) => x.state === "pending" && ms(x.exported_at!) <= nowMs);
      // The first export made at or after the cutoff gives the final result, so watch cannot pick a later, better one.
      // Before the cutoff the newest export is the most complete look.
      const pick = gate.action === "final"
        ? pending.filter((x) => ms(x.exported_at!) >= cutoff).sort((a, b) => ms(a.exported_at!) - ms(b.exported_at!) || (a.name < b.name ? -1 : 1))[0]
        : pending.filter((x) => ms(x.exported_at!) < cutoff).sort((a, b) => ms(b.exported_at!) - ms(a.exported_at!) || (a.name < b.name ? -1 : 1))[0];
      path = pick ? pick.path : null;
      if (!pick) view.did.push(gate.action === "final" ? `Waiting for an export made at or after ${target.spec.analysis_cutoff}.` : "Waiting for an export newer than the last one and made before the cutoff.");
    } else {
      path = src.logExport!({ store, experimentId: target.id, logDir: src.logDir!, assignment: src.assignment!, now }).path;
    }
    if (path !== null) {
      const lines: string[] = [];
      try {
        await analyze(store, { experiment: target.id, telemetry: path }, quiet(lines));
      } catch (e) {
        if (isBusy(e)) { view.did.push("Another pilot command holds the evidence lock; this tick did nothing."); path = null; } else throw e;
      }
    }
  } catch (e) {
    if (!(e instanceof PilotError)) throw e;
    view.refusal = { code: e.code, message: e.message };
    code = 1;
  }
  view.looks = looksOf(store, target.id);
  analyzed = view.looks.length > before;
  if (analyzed) {
    const l = view.looks.at(-1)!;
    view.did.unshift(`Ran the ${l.final ? "final" : "interim"} analysis: ${l.recommendation.toUpperCase()}.${l.final ? " The final result stands; watch never redoes it." : ""}`);
  } else if (path !== null && !view.refusal) view.did.push("The analysis added no new look.");
  if (view.refusal && !analyzed) view.did.unshift("A file or export was refused; no analysis was recorded.");

  if (scanned) {
    const imported = new Set(store.find("telemetry.imported").filter((e) => e.refs.scope === target!.id).map((e) => e.key));
    const newest = Math.max(-Infinity, ...[...imported].map((k) => ms(store.get<TelemetryImport>("telemetry", k).exported_at)));
    const decided = view.looks.some((l) => l.final || l.recommendation !== "hold");
    // Re-judged after the analysis: what it imported is imported, and what is older than it, or came after a final
    // result, is superseded and never imported.
    view.files = scanned.map((x): WatchFile => {
      const { path: file, ...rest } = x as WatchFile & { path: string };
      if (rest.state === "invalid") return rest;
      if (file === path && analyzed) return { ...rest, state: "imported" };
      if (rest.state === "pending" && (ms(rest.exported_at!) <= newest || decided)) return { ...rest, state: "superseded" };
      return rest;
    });
    if (view.files.some((x) => x.state === "invalid")) code = 1;
  }
  view.gate = lookGate({ spec: target.spec, looks: view.looks, now, interimDays: src.interimDays });
  if (analyzed) {
    const lines: string[] = [];
    if (await verify(store, {}, quiet(lines)) !== 0) { view.verify = lines; code = 1; }
  }
  return finish(code);
}
