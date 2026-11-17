export declare const CALL_LOG_VERSION = 1;
export declare const MAX_FIELD = 200;
export declare const MAX_METRICS = 50;
export declare const METRIC_NAME: RegExp;
export declare const PROBLEM_KINDS: readonly ["invalid_call", "invalid_outcome", "write_failed"];
export type ProblemKind = (typeof PROBLEM_KINDS)[number];
export interface PilotCall {
    promptVersion: string;
    conversationId: string;
    unitId?: string;
    segment?: string;
    modelId?: string;
    startedAt?: Date | string;
}
interface PilotRecorderBase {
    logDir: string;
    agent: string;
    now?: () => Date;
    onProblem?: (problem: {
        kind: string;
    }) => void;
}
export type PilotRecorderOptions = (PilotRecorderBase & {
    idKey: string;
    rawIds?: undefined;
}) | (PilotRecorderBase & {
    rawIds: true;
    idKey?: undefined;
});
export interface PilotRecorder {
    call<T>(ctx: PilotCall, fn: () => T | Promise<T>): Promise<T>;
    record(ctx: PilotCall): void;
    outcome(conversationId: string, values: Record<string, number | null>): void;
    problems(): number;
}
export declare const TOKEN_SHAPE: RegExp;
export declare const MIN_ID_KEY_LENGTH = 16;
export declare function pilotRecorder(options: PilotRecorderOptions): PilotRecorder;
export declare const ASSIGN_RULE = "sha256-v1";
export interface Arm {
    id: string;
    weight: number;
}
export declare function bucket(unitId: string, salt: string): number;
export declare function pickArm(arms: Arm[], unitId: string, salt: string): string;
export declare function pickVersion(input: {
    key: string;
    salt: string;
    baseline: string;
    candidate: string;
    candidateShareBp: number;
}): string;
export {};
