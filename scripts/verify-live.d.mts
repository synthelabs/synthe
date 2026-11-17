export const TASK_FILES: Record<string, string[]>;
export function findCountProblem(fileText: string, find: string, name: string): string | null;
export function scopeProblem(changed: string[], allowed: string[]): string | null;
export function testRunProblem(output: string, testFiles: string[]): string | null;
export function statusPaths(lines: string[]): string[];
export function staleDistProblem(before: Record<string, string>, after: Record<string, string>): string | null;
