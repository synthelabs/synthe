import { createInterface, type Interface } from "node:readline";

// One reader for piped (non-terminal) stdin, shared by every question. A readline interface per question buffers all
// of a pipe on the first question and throws the rest away when it closes, so later questions would get nothing.
let rl: Interface | null = null;
let ended = false;
const queued: string[] = [];
const waiting: ((line: string) => void)[] = [];

function start() {
  rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => { const w = waiting.shift(); if (w) w(line); else queued.push(line); });
  // Input ended before the answer: that question, and every later one, gets an empty answer.
  rl.on("close", () => { ended = true; for (const w of waiting.splice(0)) w(""); });
}

export function nextLine(): Promise<string> {
  if (!rl) start();
  if (queued.length) return Promise.resolve(queued.shift()!);
  if (ended) return Promise.resolve("");
  return new Promise((resolve) => waiting.push(resolve));
}

// The question, then the next line as the answer. Nothing echoes a piped answer, so a newline keeps the next
// question off the same line in the output.
export async function askPiped(question: string): Promise<string> {
  process.stdout.write(question);
  const answer = await nextLine();
  process.stdout.write("\n");
  return answer;
}

// An open stdin pipe must not keep the process alive once the command is done.
export function closeStdinLines() {
  rl?.close();
  (process.stdin as { unref?: () => void }).unref?.();
}
