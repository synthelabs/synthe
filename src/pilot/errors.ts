import type { PilotErrorCode } from "./types.ts";

// A refusal the pilot made on purpose. The CLI prints the message and exits 1; anything else is a crash.
export class PilotError extends Error {
  code: PilotErrorCode;
  constructor(code: PilotErrorCode, message: string) {
    super(message);
    this.name = "PilotError";
    this.code = code;
  }
}

export const refuse = (code: PilotErrorCode, message: string): never => { throw new PilotError(code, message); };
