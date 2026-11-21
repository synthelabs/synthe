// A loopback gate between `solve` and the model API. It does two things that the score needs and that the scorer
// cannot leave to the code under test:
//
// 1. It enforces the cost cap. Before each call it reserves the worst case (each request byte as an input token, and
//    max_tokens as output). If the money spent, the calls in flight and this reserve would pass the cap, it refuses
//    the call and sends nothing. After the reply it replaces the reserve with the cost from the reported usage.
// 2. It holds the real key. `solve` gets a placeholder; the gate puts the real key on the outgoing request. So the
//    key is never in the environment of the code under test.
import { createServer } from "node:http";

const REFUSED = { type: "error", error: { type: "invalid_request_error", message: "The score run reached its cost cap. This call was not sent." } };
const DEFAULT_MAX_OUTPUT = 32_000;
const TIMEOUT_MS = 15 * 60_000;

// Token usage from a reply body: Messages API JSON, Messages API event stream, or chat completions JSON.
// Cache writes count double and cache reads count in full, so the cost is never below the true cost.
export function usageOf(text, contentType = "") {
  const fromUsage = (u, into) => {
    if (!u || typeof u !== "object") return into;
    const input = (u.input_tokens ?? u.prompt_tokens ?? 0) + 2 * (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const output = u.output_tokens ?? u.completion_tokens ?? 0;
    return { input: Math.max(into?.input ?? 0, input), output: Math.max(into?.output ?? 0, output) };
  };
  let found = null;
  if (contentType.includes("event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { const e = JSON.parse(line.slice(5)); found = fromUsage(e.usage, fromUsage(e.message?.usage, found)); } catch { /* not JSON */ }
    }
    return found;
  }
  try { return fromUsage(JSON.parse(text).usage, null); } catch { return null; }
}

/**
 * Starts the gate. `upstream` is the API's base URL (no path). `prices` maps each model id to its
 * { input, output } prices in USD per million tokens. A call with the header `x-score-role: judge`
 * (scripts/score/judge.mjs) is also counted apart, because its cost is not in any result.json.
 * Returns { url, spent(), judgeSpent(), calls(), refused(), close() }.
 */
export async function startMeter({ upstream, realKey, prices, capUsd }) {
  const base = upstream.replace(/\/+$/, "");
  // The dearest pair prices a call whose model the gate does not know, so the cap still holds.
  const pairs = Object.values(prices);
  const dearest = { input: Math.max(...pairs.map((p) => p.input)), output: Math.max(...pairs.map((p) => p.output)) };
  const priceOf = (model) => (typeof model === "string" && Object.hasOwn(prices, model) ? prices[model] : dearest);
  const usd = (price, input, output) => (input * price.input + output * price.output) / 1e6;
  let spent = 0, judgeSpent = 0, reserved = 0, calls = 0, refused = 0;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const send = (status, type, body, extra = {}) => { res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), ...extra }); res.end(body); };
      if (req.method !== "POST") return send(404, "application/json", "{}");
      const body = Buffer.concat(chunks);
      let maxOutput = DEFAULT_MAX_OUTPUT, price = dearest;
      try {
        const j = JSON.parse(body.toString("utf8"));
        maxOutput = Number(j.max_tokens ?? j.max_completion_tokens) || DEFAULT_MAX_OUTPUT;
        price = priceOf(j.model);
      } catch { /* the API will refuse it */ }
      const judge = req.headers["x-score-role"] === "judge";
      const reserve = usd(price, body.length, maxOutput);
      if (spent + reserved + reserve > capUsd) { refused++; return send(400, "application/json", JSON.stringify(REFUSED)); }
      reserved += reserve;
      calls++;
      let cost = reserve; // an answer with no readable usage costs the worst case
      try {
        const headers = { "content-type": req.headers["content-type"] ?? "application/json", "accept-encoding": "identity" };
        for (const h of ["anthropic-version", "anthropic-beta", "accept"]) if (req.headers[h]) headers[h] = req.headers[h];
        if (req.headers["x-api-key"]) headers["x-api-key"] = realKey;
        if (req.headers.authorization) headers.authorization = `Bearer ${realKey}`;
        const up = await fetch(base + req.url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
        const text = Buffer.from(await up.arrayBuffer());
        const type = up.headers.get("content-type") ?? "application/json";
        if (up.status >= 400) cost = 0;
        else { const u = usageOf(text.toString("utf8"), type); if (u) cost = usd(price, u.input, u.output); }
        const extra = {};
        for (const h of ["retry-after", "request-id"]) if (up.headers.get(h)) extra[h] = up.headers.get(h);
        send(up.status, type, text, extra);
      } catch {
        // The request may have reached the API, so the reserve stays as its cost.
        send(502, "application/json", JSON.stringify({ type: "error", error: { type: "api_error", message: "The score gate could not reach the model API." } }));
      } finally {
        reserved -= reserve;
        spent += cost;
        if (judge) judgeSpent += cost;
      }
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    spent: () => spent,
    judgeSpent: () => judgeSpent,
    calls: () => calls,
    refused: () => refused,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}
