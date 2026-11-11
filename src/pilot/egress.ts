// What may leave the operator's environment. Lane: evidence and review workflow.
import type { Pack } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/egress.ts is not built yet"); };

// Opaque index of the conversation text in one or more packs, for finding it in outgoing text.
export interface SensitiveIndex { readonly phrases: ReadonlySet<string> }

export function sensitiveIndex(_packs: Pack[]): SensitiveIndex { return todo(); }

// Why this text must not be published or logged: conversation text from a pack, a secret, or personal data.
// Each problem is a plain sentence that names the kind of match and never repeats the matched text.
export function egressProblems(_text: string, _index: SensitiveIndex | null): string[] { return todo(); }

// Throws PilotError egress_blocked naming `what` when egressProblems finds anything.
export function assertEgressSafe(_text: string, _index: SensitiveIndex | null, _what: string): void { return todo(); }
