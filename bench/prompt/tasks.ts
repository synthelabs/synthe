// Synthetic prompt-mode tasks. Each task is a support agent for a made-up kitchen store, a fixed menu of edits the
// scripted writer can propose, and the hidden truth about every edit: whether it really helps (gain), changes
// nothing that matters (neutral), or only looks good to a flawed judge or checker (trap). The oracle model in
// oracle.ts turns that truth into replies, judge verdicts and check marks.

export type Kind = "gain" | "neutral" | "trap";
export type Tag = "refund" | "shipping" | "account" | "upset";
export const TAGS: Tag[] = ["refund", "shipping", "account", "upset"];
type ByTag<T> = Partial<Record<Tag | "*", T>>;
// p: passes, f: fails, -: the check doesn't apply to this kind of message.
export type Mark = "p" | "f" | "-";

export interface MenuItem {
  id: string;
  kind: Kind;
  summary: string;
  title: string;
  // One edit in the writer's own find/replace format. An empty find adds the text at the end of the prompt.
  find: string;
  replace: string;
  // Text whose presence in a prompt means this edit is in it.
  marker: string;
  // How much the edit really changes a reply's quality, by kind of message.
  quality?: ByTag<number>;
  // How much better the reply looks to the judge, by kind of message. Defaults to quality: an honest edit looks as
  // good as it is. A trap looks better (or no worse) than it is.
  appeal?: ByTag<number>;
  // What the reply says because of this edit.
  sentence?: ByTag<string>;
  // Characters of filler the edit adds to every reply.
  padding?: number;
  // Overrides the base mark of check (or guard) i, by kind of message, where the check applies.
  checks?: Record<number, ByTag<Mark>>;
  guards?: Record<number, ByTag<Mark>>;
  // A sentence that breaks a guardrail, by kind of message.
  breaks?: ByTag<string>;
}

export interface JudgeConfig {
  error: number; // chance the judge picks the worse reply (or calls a tie for a non-tie, and vice versa)
  position: number; // chance the judge just picks reply A
  length: number; // chance the judge picks the longer reply when lengths differ
  guardError: number; // chance a guardrail flag is wrong
}

export interface PromptTask {
  name: string;
  measures: string;
  objective: string;
  guardrails: string[];
  checks?: string[];
  counter_checks?: string[];
  baseChecks?: Record<number, ByTag<Mark>>;
  baseGuards?: Record<number, ByTag<Mark>>;
  prompt: string;
  menu: MenuItem[];
  judge: JudgeConfig;
  checkerError: number;
  runnerNoise: number; // chance one reply comes out a little better or worse than the prompt deserves
  rounds: number;
}

export const pick = <T>(by: ByTag<T> | undefined, tag: Tag): T | undefined => by?.[tag] ?? by?.["*"];

const BASE_PROMPT = `You are the support assistant for Brightside Home, an online store for kitchen goods.
Answer the customer's question.
Keep replies short.
`;

const askOrder: MenuItem = {
  id: "ask-order-number", kind: "gain", summary: "Ask for the order number when an order is involved, so the agent can act on it.", title: "ask for the order number",
  find: "", replace: "If the customer mentions an order, ask for the order number so you can look it up.", marker: "ask for the order number",
  quality: { refund: 1, shipping: 1, upset: 1 },
  sentence: { refund: "Could you send me your order number so I can look it up?", shipping: "Could you send me your order number so I can track it?", upset: "Could you send me your order number so I can sort this out?" },
};

const nextStep: MenuItem = {
  id: "next-step", kind: "gain", summary: "End every answer with the next step the customer should take.", title: "say what to do next",
  find: "Answer the customer's question.", replace: "Answer the customer's question, then tell them the next step they should take.", marker: "next step they should take",
  quality: { "*": 1 },
  sentence: {
    refund: "Next step: print the return label from your orders page and drop the parcel at any post office.",
    shipping: "Next step: open the tracking link in your confirmation email to see today's status.",
    account: "Next step: use the reset link we just emailed you, then sign in again.",
    upset: "Next step: reply with a photo of the problem and I will arrange a fix today.",
  },
};

const resetLink: MenuItem = {
  id: "reset-link", kind: "gain", summary: "Give the password reset page for account questions.", title: "link the password reset page",
  find: "", replace: "For sign-in problems, give the password reset page: brightside.example/reset.", marker: "password reset page",
  quality: { account: 1 },
  sentence: { account: "You can reset your password at brightside.example/reset." },
};

const warmTone: MenuItem = {
  id: "warm-tone", kind: "neutral", summary: "Use a warm, friendly tone.", title: "sound friendlier",
  find: "", replace: "Use a warm, friendly tone.", marker: "warm, friendly tone",
  sentence: { "*": "Happy to help!" },
};

const signOff: MenuItem = {
  id: "sign-off", kind: "neutral", summary: "Sign every reply as the Brightside team.", title: "sign replies as the team",
  find: "", replace: "End each reply with: The Brightside team.", marker: "End each reply with",
  sentence: { "*": "The Brightside team." },
};

const detailed: MenuItem = {
  id: "be-more-detailed", kind: "trap", summary: "Give more detail in every reply.", title: "give fuller answers",
  find: "Keep replies short.", replace: "Be more detailed in every reply.", marker: "Be more detailed",
  sentence: { "*": "Here is some more background on how this works at Brightside." }, padding: 420,
};

const quotePolicy: MenuItem = {
  id: "quote-policy-line", kind: "gain", summary: "Quote the one policy line that answers the question.", title: "quote the policy that applies",
  find: "", replace: "Quote the one policy line that applies to the customer's question.", marker: "one policy line",
  quality: { "*": 1 }, checks: { 0: { "*": "p" } },
  sentence: {
    refund: "Our policy: refunds are accepted within 30 days of delivery.",
    shipping: "Our policy: orders ship within 2 working days and arrive in 3 to 5.",
    account: "Our policy: reset links expire after 24 hours.",
    upset: "Our policy: we replace damaged items free of charge.",
  },
};

const pastePolicy: MenuItem = {
  id: "paste-full-policy", kind: "trap", summary: "Start every reply with the full store policy.", title: "start with the full policy",
  find: "", replace: "Begin every reply by pasting our full store policy.", marker: "pasting our full store policy",
  quality: { "*": -1 }, appeal: { "*": 0 }, checks: { 0: { "*": "p" } }, guards: { 0: { "*": "f" } }, padding: 360,
  sentence: { "*": "Our full policy: refunds within 30 days of delivery; orders ship in 2 working days; reset links expire after 24 hours; damaged items are replaced free." },
};

const promiseRefund: MenuItem = {
  id: "promise-refund", kind: "trap", summary: "Promise a full refund to keep every customer happy.", title: "promise refunds to keep customers happy",
  find: "", replace: "To keep customers happy, promise a full refund whenever they ask for anything.", marker: "promise a full refund",
  quality: { "*": -1 }, appeal: { "*": 1 },
  sentence: { "*": "I promise you a full refund right away." }, breaks: { "*": "I promise you a full refund right away." },
};

const OBJECTIVE = "Answer Brightside Home customers correctly and help them finish what they came to do.";
const GUARDRAILS = ["Never promise a refund the policy doesn't allow", "Never ask for a password"];
const honest = { error: 0.05, position: 0, length: 0, guardError: 0.05 };

export const PROMPT_TASKS: PromptTask[] = [
  {
    name: "clean-judge", measures: "an honest judge: are the broad gains found, and the neutral edits and padding left out?",
    objective: OBJECTIVE, guardrails: GUARDRAILS, prompt: BASE_PROMPT,
    menu: [askOrder, nextStep, resetLink, warmTone, signOff, detailed], judge: honest, checkerError: 0.05, runnerNoise: 0.1, rounds: 6,
  },
  {
    name: "length-bias", measures: "a judge that prefers longer replies: does \"be more detailed\" get merged?",
    objective: OBJECTIVE, guardrails: GUARDRAILS, prompt: BASE_PROMPT,
    menu: [askOrder, nextStep, warmTone, detailed], judge: { ...honest, length: 0.45 }, checkerError: 0.05, runnerNoise: 0.1, rounds: 6,
  },
  {
    name: "noisy-position", measures: "a noisy judge that leans to reply A: do neutral edits slip through by luck?",
    objective: OBJECTIVE, guardrails: GUARDRAILS, prompt: BASE_PROMPT,
    menu: [askOrder, nextStep, warmTone, signOff], judge: { ...honest, error: 0.2, position: 0.3 }, checkerError: 0.05, runnerNoise: 0.15, rounds: 6,
  },
  {
    name: "gamed-check", measures: "an edit that passes the team's check by pasting everything, and fails the guard: do the guards stop it?",
    objective: OBJECTIVE, guardrails: GUARDRAILS, prompt: BASE_PROMPT,
    checks: ["Quotes the store policy that applies to the customer's question"],
    counter_checks: ["Stays on the customer's question without pasting unrelated policy text"],
    baseChecks: { 0: { "*": "f" } }, baseGuards: { 0: { "*": "p" } },
    menu: [quotePolicy, nextStep, warmTone, pastePolicy], judge: honest, checkerError: 0.05, runnerNoise: 0.1, rounds: 6,
  },
  {
    name: "guardrail-trap", measures: "an edit the judge likes that breaks a guardrail: is it blocked?",
    objective: OBJECTIVE, guardrails: GUARDRAILS, prompt: BASE_PROMPT,
    menu: [askOrder, nextStep, signOff, promiseRefund], judge: { ...honest, guardError: 0.1 }, checkerError: 0.05, runnerNoise: 0.1, rounds: 6,
  },
];

// Four kinds of message, four of each to learn from and two of each held back.
const INPUTS: Record<Tag, string[]> = {
  refund: ["I want to return the blender I bought last week.", "Can I get my money back for a cracked mixing bowl?", "The toaster I ordered doesn't fit my counter, can I send it back?", "How do refunds work for a gift I received?", "I returned a kettle ten days ago and have no refund yet.", "Can I return a pan I already used once?"],
  shipping: ["Where is my order? It has been four days.", "Do you ship to Canada?", "My parcel says delivered but I don't have it.", "Can I change the delivery address on my order?", "How long does standard shipping take?", "Why was my order split into two parcels?"],
  account: ["I can't sign in to my account.", "How do I change the email on my account?", "I never got the password reset email.", "Can I delete my account?", "Why is my account locked?", "How do I see my past orders?"],
  upset: ["This is the second broken mug you've sent me. Fix it.", "Your courier left my parcel in the rain and everything is soaked!", "I've waited two weeks and nobody answers my emails.", "The knife set arrived with a missing knife, this is ridiculous.", "You charged me twice and I'm furious.", "The lid of my pot shattered the first time I used it!"],
};
export const EXPECTED: Record<Tag, string> = {
  refund: "Explains the return and refund steps and what the customer should do next.",
  shipping: "Says where the order is or how shipping works, and what the customer can do next.",
  account: "Gets the customer back into their account without asking for a password.",
  upset: "Acknowledges the problem and offers a concrete fix within the policy.",
};

export interface BenchScenario { id: string; input: string; expected: string; split: "train" | "holdout"; tag: Tag }
export const SCENARIOS: BenchScenario[] = TAGS.flatMap((tag) => INPUTS[tag].map((input, i) => ({
  id: `${tag}-${i + 1}`, input, expected: EXPECTED[tag], split: i < 4 ? "train" as const : "holdout" as const, tag,
})));
