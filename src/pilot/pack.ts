// Conversation pack: parse, validate, bound and summarise. Lane: replay and failure discovery.
import type { Pack, PackCase, PackSummary, Sha256 } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/pack.ts is not built yet"); };

// Hard bounds on a pack, so an unbounded trace dump can never be imported as one.
export const PACK_LIMITS = { cases: 2000, messages_per_case: 200, message_chars: 20_000, checks_per_case: 60, tools: 50 } as const;

// Parses and validates a pack file. Throws PilotError: invalid_pack, pack_not_approved, pack_not_redacted, too_large.
export function parsePack(_text: string): Pack { return todo(); }

export function packSummary(_pack: Pack, _packId: Sha256): PackSummary { return todo(); }

// Number of assistant turns in a case (one per user message).
export function turnCount(_c: PackCase): number { return todo(); }

// The only cases a proposer may ever be shown.
export function discoveryCases(_pack: Pack): PackCase[] { return todo(); }
