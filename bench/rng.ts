import { createHash } from "node:crypto";

// Every random draw in the bench comes from a hash of the seed and what the draw is about (the task, the case,
// the two replies, how many times this exact question was asked before), never from call order. So a lane that
// rewords a judge prompt or reorders its calls gets the same coin flips for the same question, and only a real
// change in what the loop asks, or decides, moves the numbers.
export function draw(...key: (string | number)[]): number {
  const h = createHash("sha256").update(key.join("\u0000")).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

// Counts how often each key has been asked, so a repeated identical question gets a fresh, still seeded, draw.
export class Draws {
  private seen = new Map<string, number>();
  private seed: string;
  constructor(seed: string) { this.seed = seed; }
  next(...key: (string | number)[]): number {
    const k = key.join("\u0000");
    const n = this.seen.get(k) ?? 0;
    this.seen.set(k, n + 1);
    return draw(this.seed, k, n);
  }
}

// A seeded shuffle, for the order the scripted writer proposes its menu in.
export function shuffle<T>(items: T[], ...key: (string | number)[]): T[] {
  return items.map((item, i) => ({ item, r: draw(...key, i) })).sort((a, b) => a.r - b.r).map((x) => x.item);
}

// A seeded stand-in for Math.random, for the scorer's reply-order flip.
export function stream(...key: (string | number)[]): () => number {
  let n = 0;
  return () => draw(...key, "stream", n++);
}
