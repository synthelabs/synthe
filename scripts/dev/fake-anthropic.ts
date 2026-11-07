// A local stand-in for the Messages API (POST /v1/messages), for running `npx synthe improve` end to end without
// spending anything: point the CLI at it with SYNTHE_PROXY_URL=<url>. Each request is recorded; the reply comes
// from `reply(kind, round)`, where kind is "pick" (the call whose schema asks for paths) or "propose", and round
// counts pick calls from 1. POST .../improve (the run record a laptop sends on event credit) is accepted too:
// each batch lands in `receipts`, so a driver can show what the organizers would receive.
import { createServer, type IncomingHttpHeaders } from "node:http";

export type FakeReply =
  | { json: unknown; usage?: { input_tokens: number; output_tokens: number } }
  | { status: number; error: { type: string; message: string } };
export interface FakeRequest { path: string; headers: IncomingHttpHeaders; body: any; kind: "pick" | "propose"; round: number }

export async function startFakeAnthropic(reply: (kind: "pick" | "propose", round: number) => FakeReply) {
  const requests: FakeRequest[] = [];
  const receipts: { headers: IncomingHttpHeaders; body: any }[] = [];
  let round = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !(req.url?.endsWith("/v1/messages") || req.url?.endsWith("/improve"))) { res.statusCode = 404; res.end(); return; }
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (req.url!.endsWith("/improve")) {
        receipts.push({ headers: req.headers, body });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, events: "stored", mirror: "done" }));
        return;
      }
      const kind = body.output_config?.format?.schema?.properties?.paths ? "pick" : "propose";
      if (kind === "pick") round++;
      requests.push({ path: req.url!, headers: req.headers, body, kind, round });
      const r = reply(kind, round);
      res.setHeader("content-type", "application/json");
      if ("status" in r) {
        res.statusCode = r.status;
        res.end(JSON.stringify({ type: "error", error: r.error }));
        return;
      }
      const usage = r.usage ?? (kind === "pick" ? { input_tokens: 3_000, output_tokens: 150 } : { input_tokens: 4_000, output_tokens: 600 });
      res.end(JSON.stringify({
        id: `msg_fake_${requests.length}`, type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: JSON.stringify(r.json) }], stop_reason: "end_turn", stop_sequence: null, usage,
      }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, requests, receipts, close: () => new Promise<void>((done) => server.close(() => done())) };
}
