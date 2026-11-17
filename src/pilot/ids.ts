import { canonicalJson } from "../core/evidence.ts";
import { sha256 } from "../core/safety.ts";
import type { Sha256 } from "./types.ts";

// An object's id is the SHA-256 of its canonical JSON (keys sorted at every depth), so the same content always has
// the same id however it was written, and a changed object can never keep its id.
export const contentId = (value: unknown): Sha256 => sha256(canonicalJson(value));

// A prompt's id is the SHA-256 of its text, byte for byte.
export const promptId = (text: string): Sha256 => sha256(text);

export const shortId = (id: Sha256): string => id.slice(0, 12);

// The tag the customer puts on telemetry for a candidate prompt, and the branch its review pull request uses.
export const candidateTag = (candidateId: Sha256): string => `synthe-${shortId(candidateId)}`;
export const reviewBranch = (candidateId: Sha256): string => `synthe-pilot/${shortId(candidateId)}`;

export const isSha256 = (value: unknown): value is Sha256 => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

// Time arithmetic on UTC timestamps, used for windows, cutoffs and outcome lag. Returns NaN for a bad timestamp.
export const ms = (iso: string): number => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(iso) ? Date.parse(iso) : NaN);
export const DAY_MS = 86_400_000;
export const addDays = (iso: string, days: number): string => new Date(ms(iso) + days * DAY_MS).toISOString().replace(".000Z", "Z");
