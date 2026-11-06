export const PIN_FILES: string[];
export function setPins(text: string, version: string): string;
export function pinProblems(version: string, files: Record<string, string>): string[];
export function guideSource(current: string, doc: string): string;
