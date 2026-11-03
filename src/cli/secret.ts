import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

// Reads a key without showing it. readline draws nothing to a muted stream, and in a terminal it switches off echo
// before the question is printed, so a pasted key never appears on screen (or in a screen share).
export async function askSecret(question: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input, output: muted, terminal: true });
  output.write(question);
  const answer = await rl.question("");
  rl.close();
  output.write("\n");
  return answer;
}
