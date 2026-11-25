import { randomBytes } from "node:crypto";
import type { Attack, Goal, Provider, Scenario } from "../core/goal.ts";
import { costUsd, pricedCost } from "../core/cost.ts";
import { sha256 } from "../core/safety.ts";
import type { Ask, Model, Reply } from "../model/client.ts";
import { JUDGE_PROMPT_VERSION, runScore, type AttackCache, type ScoreCache } from "./score.ts";
import type { Candidate } from "./write.ts";

// The score journal (prototype; nothing in the workflow calls it yet). A score step that stops partway (a cancelled
// workflow, a runner that dies) loses every call it made, and the run's spend never hears of them. This journal keeps
// each scoring call and its reply, written to a durable store before and after the call, so a new runner can run the
// same scoring again and get every finished call back without sending it. runScore itself is unchanged: the journal
// only wraps the model, and the verdict is worked out again in full on every resume, so it can't drift from a run
// that was never stopped. Design: synthelabs/notes product/plans/2026-11-24-score-resume-prototype.md.

const VERSION = 1;
// Request size in bytes stands in for its input tokens (a token is at least one byte); this covers the message
// framing and a structured-output schema on top of that. Our estimate, not a provider's figure.
const FRAMING_TOKENS = 1024;
const WRITE_TRIES = 50;
const OPEN_TRIES = 10;

// Everything a round's scoring depends on. A checkpoint is reused only when all of it is the same.
export interface ScoreInputs {
  round: number;
  goal: Goal;
  baseline: string;
  candidates: Candidate[];
  scenarios: Scenario[];
  attacks?: Attack[];
  prior?: string | null;
  attackCache?: AttackCache | null;
  scoreCache?: ScoreCache | null;
  stopEarly?: boolean;
}

// The store holds one text. A write names the version it read, and is refused (null) when the store has moved on, so
// two writers can never overwrite each other's records.
export interface JournalStore {
  read(): Promise<{ text: string; version: string } | null>;
  write(text: string, expected: string | null): Promise<string | null>;
}

// The round's scoring spend as far as the journal knows it. knownUsd: every finished call's own cost, once (null
// when one came back with no cost). boundUsd: an upper bound for each call that was sent and never answered, since
// the provider may have billed it. unbounded: such calls with no bound (an unpriced model). chargeUsd: what the run
// must count, or null when it can't be known.
export interface Spend { knownUsd: number | null; boundUsd: number; unbounded: number; calls: number; chargeUsd: number | null }
type Carried = Omit<Spend, "chargeUsd">;
const NOTHING: Carried = { knownUsd: 0, boundUsd: 0, unbounded: 0, calls: 0 };

type Rec =
  // replaces: the earlier call this one was sent again for, because that one had no reply when it was taken.
  | { t: "ask"; id: string; key: string; model: string; bound: number | null; replaces?: string }
  | { t: "done"; id: string; key: string; reply: Reply }
  // used: the call that answered each request of the sealing run, in the order the run made its requests. A replay of
  // a sealed journal follows it exactly, so it returns what the sealed verdict used, whatever other runners recorded.
  | { t: "seal"; used: string[] }
  | { t: "settle" };
// previous: the text of a stored journal that could not be read, kept so a person can still check it.
interface Doc { v: number; id: string; binding: string; parts: Record<string, string>; seed: number; carried: Carried; records: Rec[]; previous?: string }

// Why a runner stopped writing to the journal. A sealed or settled journal is finished; a replaced one belongs to
// other inputs or lost records this runner wrote.
const STOPPED = {
  replaced: "the score journal was replaced, for other inputs or by an older copy, so this runner stops instead of writing over it",
  sealed: "another runner finished scoring this round and sealed the journal, so this runner stops; a rerun replays the sealed results for free",
  settled: "the decide step already recorded this journal's spend, so this runner stops instead of adding calls it would not count",
} as const;
export class JournalReplaced extends Error {
  constructor(why: keyof typeof STOPPED = "replaced") { super(STOPPED[why]); }
}

// Keys sorted at every level, so the same value always gives the same text and the same hash.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

// The goal as scoring reads it. Run limits are left out, so raising the budget or the round limit keeps a checkpoint.
// merge_rule.max_rounds stays in when run_alpha is set, because then it changes the held-back limit (run-alpha.ts).
function scoringGoal(goal: Goal): unknown {
  const { budget: _budget, share: _share, share_notice: _notice, merge_rule, ...rest } = goal;
  const { max_rounds, stall_rounds: _stall, mode: _mode, ...rule } = merge_rule;
  return { ...rest, merge_rule: { ...rule, ...(rule.run_alpha !== undefined ? { max_rounds } : {}) } };
}

// What each part of a binding is called in a refusal.
const PART_NAMES: Record<string, string> = {
  round: "round", prompt: "current prompt", candidates: "proposed changes", cases: "test cases", attacks: "attack set",
  prior: "replaced prompt", goal: "goal settings", caches: "saved caches", options: "scoring options",
};

export function scoreBinding(i: ScoreInputs): { hash: string; parts: Record<string, string> } {
  const h = (v: unknown) => sha256(canonical(v));
  const parts: Record<string, string> = {
    round: String(i.round),
    prompt: h(i.baseline),
    // Every field, since compose reads a change's summary and edits too (compose.ts).
    candidates: h(i.candidates),
    cases: h(i.scenarios.filter((s) => s.split === "train" || s.split === "holdout").map((s) => [s.id, s.input, s.expected, s.split])),
    attacks: h((i.attacks ?? []).map((a) => [a.id, a.input, a.must])),
    prior: h(i.prior ?? null),
    goal: h(scoringGoal(i.goal)),
    caches: h([i.attackCache ?? null, i.scoreCache ?? null]),
    options: h({ stopEarly: i.stopEarly ?? true, judgePrompt: JUDGE_PROMPT_VERSION, journal: VERSION }),
  };
  return { hash: h(parts), parts };
}

// The most one call can cost: its whole request billed as a cache write (the dearest input rate), and its reply at
// the full limit. Null when the model has no price.
export function callBoundUsd(a: Ask, provider?: Provider): number | null {
  const input = Buffer.byteLength(`${a.system ?? ""}${a.user}${a.schema ? JSON.stringify(a.schema) : ""}`, "utf8") + FRAMING_TOKENS;
  if (provider?.kind === "openai-compatible") return pricedCost(provider.prices?.[a.model], input, a.maxTokens);
  return costUsd(a.model, { input_tokens: 0, cache_creation_input_tokens: input, output_tokens: a.maxTokens });
}

// Adds in sorted order, so the same costs give the same total whatever order the calls finished in.
const total = (xs: number[]) => [...xs].sort((a, b) => a - b).reduce((s, x) => s + x, 0);

function spendOf(doc: Doc): Spend & { finished: number } {
  const done = new Map<string, Reply>();
  for (const r of doc.records) if (r.t === "done" && !done.has(r.id)) done.set(r.id, r.reply);
  let unknown = doc.carried.knownUsd === null, unbounded = doc.carried.unbounded, calls = doc.carried.calls, finished = 0;
  const known: number[] = [], bounds: number[] = [];
  for (const r of doc.records) {
    if (r.t !== "ask") continue;
    calls++;
    const reply = done.get(r.id);
    if (reply) {
      finished++;
      if (typeof reply.costUsd === "number" && Number.isFinite(reply.costUsd)) known.push(reply.costUsd); else unknown = true;
    } else if (typeof r.bound === "number" && Number.isFinite(r.bound)) bounds.push(r.bound);
    else unbounded++;
  }
  const knownUsd = unknown ? null : total(known) + (doc.carried.knownUsd ?? 0);
  const boundUsd = total(bounds) + doc.carried.boundUsd;
  return { knownUsd, boundUsd, unbounded, calls, chargeUsd: knownUsd === null || unbounded > 0 ? null : knownUsd + boundUsd, finished };
}
const carriedOf = (doc: Doc): Carried => { const { knownUsd, boundUsd, unbounded, calls } = spendOf(doc); return { knownUsd, boundUsd, unbounded, calls }; };
const isSettled = (doc: Doc) => doc.records.some((r) => r.t === "settle");
const isSealed = (doc: Doc) => doc.records.some((r) => r.t === "seal");

function parseDoc(text: string): Doc | null {
  try {
    const d = JSON.parse(text) as Doc;
    const carried = d?.carried;
    const fine = d && d.v === VERSION && typeof d.id === "string" && typeof d.binding === "string" && typeof d.seed === "number" && Array.isArray(d.records)
      && carried && (carried.knownUsd === null || typeof carried.knownUsd === "number") && typeof carried.boundUsd === "number" && typeof carried.unbounded === "number" && typeof carried.calls === "number"
      && d.records.every((r) => r && (r.t === "settle" || (r.t === "seal" && Array.isArray(r.used) && r.used.every((u) => typeof u === "string")) || ((r.t === "ask" || r.t === "done") && typeof r.id === "string" && typeof r.key === "string"
        && (r.t !== "ask" || r.replaces === undefined || typeof r.replaces === "string"))));
    return fine ? d : null;
  } catch {
    return null;
  }
}

// A seeded generator, so the reply order runScore picks at random is the same on every resume.
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const requestKey = (a: Ask) => sha256(canonical([a.model, a.system ?? null, a.user, a.maxTokens, a.schema ?? null, a.allowCutOff === true]));
const copy = (r: Reply): Reply => JSON.parse(JSON.stringify(r));

type Batch = { recs: Rec[]; done: Promise<void>; resolve: () => void; reject: (e: unknown) => void };
function batch(): Batch {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  done.catch(() => {}); // each caller awaits it; this only keeps a failed batch from counting as unhandled
  return { recs: [], done, resolve, reject };
}

export class Journal {
  readonly resumed: boolean;
  readonly refused: string | null;
  readonly random: () => number;
  private doc: Doc;
  private version: string;
  private readonly store: JournalStore;
  private readonly provider: Provider | undefined;
  private readonly writer: string;
  private seq = 0;
  // The calls sent for each request, in the order they were sent, and each one's reply when it has one. A request
  // takes the first call of its kind not yet taken: identical requests are matched in the order they were sent, not
  // the order they finished, so each gets back its own reply. A taken call with no reply was lost, and is sent again.
  // A call that was sent again is reached only through the one it replaced, so a replay follows the same choice the
  // run made, even when the first call's reply turned up later.
  private readonly calls = new Map<string, string[]>();
  private readonly replacedBy = new Map<string, string>();
  private readonly taken = new Set<string>();
  private readonly replies = new Map<string, Reply>();
  // The call that answered each request this runner made, in request order; the seal stores it.
  private readonly used: string[] = [];
  // For a journal that was sealed when this runner opened it: the calls left to replay for each request.
  private readonly plan: Map<string, string[]> | null = null;
  private readonly nonce = randomBytes(4).toString("hex");
  private replayedCount = 0;
  private sentCount = 0;
  private replaced: keyof typeof STOPPED | null = null;
  private open: Batch | null = null;
  private running = false;
  private drained: Promise<void> = Promise.resolve();
  private readonly live = new Set<Promise<unknown>>();

  constructor(store: JournalStore, doc: Doc, version: string, o: { resumed: boolean; refused: string | null; provider?: Provider; writer: string }) {
    this.store = store;
    this.doc = doc;
    this.version = version;
    this.resumed = o.resumed;
    this.refused = o.refused;
    this.provider = o.provider;
    this.writer = o.writer;
    this.random = seeded(doc.seed);
    for (const r of doc.records) this.index(r, false);
    const seal = doc.records.find((r) => r.t === "seal");
    if (seal?.t === "seal") {
      const keys = new Map(doc.records.flatMap((r) => (r.t === "ask" ? [[r.id, r.key] as const] : [])));
      this.plan = new Map();
      for (const id of seal.used) {
        const key = keys.get(id);
        if (key !== undefined) this.plan.set(key, [...(this.plan.get(key) ?? []), id]);
      }
    }
  }

  private index(r: Rec, own: boolean) {
    if (r.t === "ask") {
      if (own) this.taken.add(r.id);
      if (r.replaces !== undefined) {
        if (!this.replacedBy.has(r.replaces)) this.replacedBy.set(r.replaces, r.id);
      } else {
        const list = this.calls.get(r.key) ?? [];
        list.push(r.id);
        this.calls.set(r.key, list);
      }
    } else if (r.t === "done" && !this.replies.has(r.id)) this.replies.set(r.id, r.reply);
  }

  // The model runScore calls: a request with a recorded reply gets it back, and any other is written down, sent,
  // and its reply written down before it is returned.
  model(inner: Model): Model {
    return {
      ask: (a: Ask) => {
        const key = requestKey(a);
        if (this.plan) {
          // Sealed: give back what the sealing run got, in its order. Never send, and never add to the journal.
          const id = this.plan.get(key)?.shift();
          const reply = id === undefined ? undefined : this.replies.get(id);
          if (!reply) return Promise.reject(new Error("the score journal is sealed and has no recorded reply for this request, so this run does not match the run that sealed it"));
          this.replayedCount++;
          return Promise.resolve(copy(reply));
        }
        let at = this.calls.get(key)?.find((id) => !this.taken.has(id));
        let last: string | undefined;
        while (at !== undefined) {
          this.taken.add(at);
          last = at;
          const next = this.replacedBy.get(at);
          if (next !== undefined && !this.taken.has(next)) { at = next; continue; }
          const reply = this.replies.get(at);
          if (reply) {
            this.replayedCount++;
            this.used.push(at);
            return Promise.resolve(copy(reply));
          }
          break;
        }
        // Unique across runners and resumes, even when two runners are given the same writer name.
        const id = `${this.writer}:${this.nonce}:${this.seq++}`;
        const ask: Rec = { t: "ask", id, key, model: a.model, bound: callBoundUsd(a, this.provider), ...(last !== undefined ? { replaces: last } : {}) };
        this.index(ask, true);
        this.used.push(id);
        const run = (async () => {
          await this.append(ask);
          this.sentCount++;
          const reply = await inner.ask(a);
          const done: Rec = { t: "done", id, key, reply: copy(reply) };
          this.index(done, true);
          await this.append(done);
          return reply;
        })();
        const forget = () => { this.live.delete(run); };
        this.live.add(run);
        run.then(forget, forget);
        return run;
      },
    };
  }

  // Sealed when this runner opened it: every call is recorded, and a replay sends nothing.
  get sealed() { return this.plan !== null; }
  replayed() { return this.replayedCount; }
  sent() { return this.sentCount; }
  spend(): Spend { const { finished: _f, ...s } = spendOf(this.doc); return s; }

  // Scoring finished: a later runner replays all of it and sends nothing.
  // A journal that was already sealed stays as it is.
  async seal() { if (!this.plan) await this.append({ t: "seal", used: [...this.used] }); }

  // Waits until every call this runner has in flight is answered or failed, and every write has ended.
  async idle() {
    while (this.live.size > 0 || this.running) await Promise.allSettled([...this.live, this.drained]);
  }

  private append(rec: Rec): Promise<void> {
    if (this.replaced) return Promise.reject(new JournalReplaced(this.replaced));
    this.open ??= batch();
    this.open.recs.push(rec);
    const done = this.open.done;
    if (!this.running) {
      this.running = true;
      this.drained = this.drain();
    }
    return done;
  }

  // Writes the waiting records together, one batch at a time. Records that arrive during a write go in the next.
  private async drain() {
    try {
      while (this.open) {
        const b = this.open;
        this.open = null;
        try { await this.write(b.recs); b.resolve(); } catch (e) { b.reject(e); }
      }
    } finally {
      this.running = false;
    }
  }

  // Appends after whatever is stored now. On a conflict it reads the store again and appends after that, so it never
  // writes its own older copy over another runner's records.
  private async write(recs: Rec[]) {
    for (let i = 0; i < WRITE_TRIES; i++) {
      if (this.replaced) throw new JournalReplaced(this.replaced);
      const next: Doc = { ...this.doc, records: [...this.doc.records, ...recs] };
      const version = await this.store.write(JSON.stringify(next), this.version);
      if (version !== null) {
        this.doc = next;
        this.version = version;
        return;
      }
      const now = await this.store.read();
      const doc = now === null ? null : parseDoc(now.text);
      // Another journal, an older copy, or one the decide step has settled: this runner must not add to it.
      // A journal another runner sealed is finished too: a late reply must not change what a replay returns.
      const stop = !now || !doc || doc.id !== this.doc.id || doc.records.length < this.doc.records.length ? "replaced"
        : isSettled(doc) ? "settled" : isSealed(doc) ? "sealed" : null;
      if (stop || !now || !doc) {
        this.replaced = stop ?? "replaced";
        throw new JournalReplaced(this.replaced);
      }
      for (const r of doc.records.slice(this.doc.records.length)) this.index(r, false);
      this.doc = doc;
      this.version = now.version;
    }
    throw new Error(`the score journal changed ${WRITE_TRIES} times in a row while this runner tried to write to it`);
  }
}

// Opens the round's journal. Same inputs as the stored one: resume it. Different inputs: start a new one, and carry
// the old one's spend unless the decide step already recorded it. A stored text that can't be read is not trusted:
// the new journal carries an unknown spend, so the round pauses instead of guessing.
export async function openJournal(store: JournalStore, inputs: ScoreInputs, o: { seed?: number; writer?: string } = {}): Promise<Journal> {
  const binding = scoreBinding(inputs);
  const writer = o.writer ?? randomBytes(6).toString("hex");
  const provider = inputs.goal.provider;
  for (let i = 0; i < OPEN_TRIES; i++) {
    const now = await store.read();
    const old = now === null ? null : parseDoc(now.text);
    let carried = NOTHING, refused: string | null = null;
    if (now !== null && old === null) {
      carried = { ...NOTHING, knownUsd: null };
      refused = "the saved checkpoint could not be read, so its results are not reused and its spend is unknown";
    } else if (old && !isSettled(old)) {
      if (old.binding === binding.hash) return new Journal(store, old, now!.version, { resumed: true, refused: null, provider, writer });
      const changed = Object.keys(binding.parts).filter((k) => old.parts?.[k] !== binding.parts[k]).map((k) => PART_NAMES[k] ?? k);
      carried = carriedOf(old);
      refused = `the saved checkpoint was measured for a different ${changed.join(", ") || "set of inputs"}, so its results are not reused; its spend is kept`;
    }
    const doc: Doc = {
      v: VERSION, id: randomBytes(8).toString("hex"), binding: binding.hash, parts: binding.parts, seed: o.seed ?? randomBytes(4).readUInt32BE(0), carried, records: [],
      ...(now !== null && old === null ? { previous: now.text } : {}),
    };
    const version = await store.write(JSON.stringify(doc), now?.version ?? null);
    if (version !== null) return new Journal(store, doc, version, { resumed: false, refused, provider, writer });
  }
  throw new Error(`the score journal changed ${OPEN_TRIES} times in a row while this runner tried to open it`);
}

// What the stored journal says was spent, for a step that has no runner of its own (the decide step after a score
// step died). Null when nothing is stored.
// version: the store version these numbers were read from; settleJournal takes it back.
export async function journalSpend(store: JournalStore): Promise<(Spend & { finished: number; sealed: boolean; settled: boolean; version: string }) | null> {
  const now = await store.read();
  if (now === null) return null;
  const doc = parseDoc(now.text);
  if (!doc) return { knownUsd: null, boundUsd: 0, unbounded: 0, calls: 0, chargeUsd: null, finished: 0, sealed: false, settled: false, version: now.version };
  return { ...spendOf(doc), sealed: isSealed(doc), settled: isSettled(doc), version: now.version };
}

// The decide step has added the journal's spend to the run's: the next round starts a new journal and carries
// nothing. version is the one journalSpend gave when decide read the spend it added. If anything was written since,
// the settle fails (false), so decide reads the spend again instead of settling calls it never counted. Once
// settled, a runner still writing to the journal stops (JournalReplaced) instead of adding to it.
export async function settleJournal(store: JournalStore, version: string): Promise<boolean> {
  const now = await store.read();
  const doc = now === null ? null : parseDoc(now.text);
  if (!now || !doc) return false;
  if (isSettled(doc)) return true;
  if (now.version !== version) return false;
  return (await store.write(JSON.stringify({ ...doc, records: [...doc.records, { t: "settle" }] }), now.version)) !== null;
}

export type SpendDecision = { action: "continue" | "pause" | "stop"; why: string };

// Before a resumed round spends more. A call whose cost can't be bounded pauses the run, as an unmeasured round does
// today. Calls that may already have used the budget stop it.
export function spendDecision(spend: Spend, budgetLeftUsd: number): SpendDecision {
  if (spend.knownUsd === null || spend.unbounded > 0 || spend.chargeUsd === null) {
    return { action: "pause", why: "the cost of an earlier scoring call could not be measured, and no upper bound for it is known, so Synthe won't spend more until a person checks the provider's bill" };
  }
  if (spend.chargeUsd >= budgetLeftUsd) {
    return { action: "stop", why: `the calls already made may have cost up to $${spend.chargeUsd.toFixed(4)}, which reaches the $${budgetLeftUsd.toFixed(4)} left in the budget` };
  }
  return { action: "continue", why: "" };
}

// runScore through the journal: resumes from the store, checks the spend first, and reports the journal's spend as
// the round's, so known calls are counted once and lost ones at their upper bound.
type Scored = Awaited<ReturnType<typeof runScore>>;
type ResumeInfo = { resumed: boolean; refused: string | null; replayed: number; sent: number };
export type ResumableResult = { paused: SpendDecision; spend: Spend; resume: ResumeInfo } | { scored: Scored; spend: Spend; resume: ResumeInfo };

export async function runScoreResumable(store: JournalStore, o: ScoreInputs & { model: Model; budgetLeftUsd: number; seed?: number; writer?: string }): Promise<ResumableResult> {
  const journal = await openJournal(store, o, { seed: o.seed, writer: o.writer });
  const resume = () => ({ resumed: journal.resumed, refused: journal.refused, replayed: journal.replayed(), sent: journal.sent() });
  // A sealed journal replays for free, so only an unknown cost holds it back, not the budget.
  const decision = spendDecision(journal.spend(), journal.sealed ? Infinity : o.budgetLeftUsd);
  if (decision.action !== "continue") return { paused: decision, spend: journal.spend(), resume: resume() };
  let scored: Scored;
  try {
    scored = await runScore(o.goal, o.baseline, o.candidates, o.scenarios, journal.model(o.model), o.prior ?? null, journal.random, o.attacks ?? [], o.attackCache ?? null, o.scoreCache ?? null, o.stopEarly ?? true);
    await journal.seal();
  } catch (e) {
    await journal.idle();
    throw e;
  }
  const spend = journal.spend();
  return { scored: { ...scored, costUsd: spend.chargeUsd, calls: spend.calls }, spend, resume: resume() };
}

// A store for tests and the prototype: one text and a version number, held in a plain object a test can copy to
// stand for what a new runner would read.
export interface FakeDisk { text: string | null; version: number; conflicts: number }
export const fakeDisk = (): FakeDisk => ({ text: null, version: 0, conflicts: 0 });
export function fakeDurableStore(disk: FakeDisk): JournalStore {
  return {
    read: async () => (disk.text === null ? null : { text: disk.text, version: String(disk.version) }),
    write: async (text, expected) => {
      if ((disk.text === null ? null : String(disk.version)) !== expected) { disk.conflicts++; return null; }
      disk.text = text;
      disk.version++;
      return String(disk.version);
    },
  };
}

// What a round adds to the run's spend, from what its steps left behind (prototype for the decide step; not wired in).
// Today a failed score step adds $0, even when the write step's cost is known, because the round's total turns null
// and null is added as 0. Here each step counts on its own: the write step's known cost always counts, and a score
// step that started counts by its journal. A cost nobody can know pauses the run instead of reading as $0. A journal
// the decide step already settled adds nothing again.
export function roundSpend(o: {
  writeRan: boolean; writeUsd: number | null | undefined;
  scoreStarted: boolean; scoreFinished: boolean; scoreUsd: number | null | undefined;
  journal: (Spend & { settled?: boolean }) | null;
}): { addUsd: number | null; action: "continue" | "pause"; why: string } {
  const unknown = (why: string) => ({ addUsd: null, action: "pause" as const, why });
  const known = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  let add = 0;
  if (o.writeRan) {
    if (!known(o.writeUsd)) return unknown("the write step's cost could not be measured");
    add += o.writeUsd;
  }
  if (o.scoreStarted) {
    if (o.journal?.settled) return { addUsd: add, action: "continue", why: "" };
    if (o.journal) {
      if (o.journal.chargeUsd === null) return unknown("the cost of a scoring call could not be measured, and no upper bound for it is known");
      add += o.journal.chargeUsd;
    } else if (o.scoreFinished && known(o.scoreUsd)) {
      add += o.scoreUsd;
    } else {
      return unknown(o.scoreFinished ? "the score step's cost could not be measured" : "the score step stopped and left no record of its calls, so what it spent is unknown");
    }
  }
  return { addUsd: add, action: "continue", why: "" };
}
