// A loopback fake of the model API for the self-test, in the wire format of scripts/dev/fake-anthropic.ts
// (POST /v1/messages). It also answers POST .../chat/completions, for a `solve` that does not have the Anthropic
// provider yet. It needs no key and spends nothing.
//
// The replies come from a menu: for each demo problem, a marker text that occurs in its files and a list of
// proposals. The fake finds the problem by its marker and replies with the first proposal whose summary is not yet
// in the request (the history has the earlier summaries) and whose search text is still in the files.
import { createServer } from "node:http";

const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("") : "");

export function replyFor(menu, body) {
  const system = textOf(body.system) + (body.messages ?? []).filter((m) => m.role === "system").map((m) => textOf(m.content)).join("");
  const user = (body.messages ?? []).filter((m) => m.role !== "system").map((m) => textOf(m.content)).join("\n");
  // A judge call asks for a winner. The demo set has no judged problem, so a tie is the honest answer.
  if (/"winner"/.test(system) && !/"proposals"/.test(system)) return { winner: "tie" };
  const has = (s) => user.includes(s) || user.includes(JSON.stringify(s).slice(1, -1));
  const entry = menu.find((e) => has(e.marker));
  const next = entry?.proposals.find((p) => !has(p.summary) && p.edits.every((e) => has(e.search)));
  return { proposals: next ? [next] : [] };
}

export async function startFakeApi(menu) {
  let requests = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const messages = req.url?.endsWith("/v1/messages"), chat = req.url?.endsWith("/chat/completions");
      if (req.method !== "POST" || (!messages && !chat)) { res.statusCode = 404; res.end(); return; }
      requests++;
      const body = JSON.parse(raw);
      const text = JSON.stringify(replyFor(menu, body));
      const input = Math.ceil(raw.length / 4), output = Math.ceil(text.length / 4);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(messages
        ? { id: `msg_fake_${requests}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: input, output_tokens: output } }
        : { id: `chatcmpl_fake_${requests}`, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: () => requests,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}
