import { createServer, type Server } from "node:http";

// A loopback stand-in for the few GitHub endpoints src/github/repo.ts uses to open a pull request. The demo and the
// tests publish through the real client code against this server, so the publish path is exercised end to end
// without touching GitHub. It keeps every request it receives, which is how the privacy checks read what was sent.

export interface SeenRequest { method: string; path: string; body: string; authorization: string | undefined }
export interface FakePull { number: number; head: string; base: string; title: string; body: string }

export class FakeGitHub {
  slug: string;
  url = "";
  requests: SeenRequest[] = [];
  pulls: FakePull[] = [];
  // branch -> path -> content
  branches = new Map<string, Map<string, string>>();
  heads = new Map<string, string>();
  private server: Server;

  constructor(slug: string, base: string, files: Record<string, string>, headSha: string) {
    this.slug = slug;
    this.branches.set(base, new Map(Object.entries(files)));
    this.heads.set(base, headSha);
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        this.requests.push({ method: req.method ?? "", path: req.url ?? "", body: raw, authorization: req.headers.authorization });
        const send = (code: number, value?: unknown) => {
          res.statusCode = code;
          res.end(value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));
        };
        try { this.route(req.method ?? "", req.url ?? "", raw, req.headers.accept ?? "", send); } catch { send(500, { message: "fake GitHub failed" }); }
      });
    });
  }

  private route(method: string, rawUrl: string, raw: string, accept: string, send: (code: number, value?: unknown) => void): void {
    const url = new URL(rawUrl, "http://loopback");
    const prefix = `/repos/${this.slug}`;
    if (!url.pathname.startsWith(prefix)) return send(404, { message: "Not Found" });
    const path = url.pathname.slice(prefix.length);
    const body = raw ? JSON.parse(raw) as Record<string, string> : {};
    const owner = this.slug.split("/")[0];
    if (path === "" && method === "GET") return send(200, { default_branch: [...this.branches.keys()][0] });
    if (path.startsWith("/git/ref/heads/") && method === "GET") {
      const branch = decodeURIComponent(path.slice("/git/ref/heads/".length));
      return this.heads.has(branch) ? send(200, { object: { sha: this.heads.get(branch) } }) : send(404, { message: "Not Found" });
    }
    if (path === "/git/refs" && method === "POST") {
      const branch = body.ref.replace("refs/heads/", "");
      if (this.branches.has(branch)) return send(422, { message: "Reference already exists" });
      return this.point(branch, body.sha, send, 201);
    }
    if (path.startsWith("/git/refs/heads/") && method === "PATCH") {
      return this.point(decodeURIComponent(path.slice("/git/refs/heads/".length)), body.sha, send, 200);
    }
    if (path.startsWith("/contents/")) {
      const file = decodeURIComponent(path.slice("/contents/".length));
      if (method === "PUT") {
        const files = this.branches.get(body.branch);
        if (!files) return send(404, { message: "Branch not found" });
        files.set(file, Buffer.from(body.content, "base64").toString("utf8"));
        const sha = `commit-${this.requests.length}`;
        this.heads.set(body.branch, sha);
        return send(200, { commit: { sha } });
      }
      const text = this.branches.get(url.searchParams.get("ref") ?? "")?.get(file);
      if (text === undefined) return send(404, { message: "Not Found" });
      return accept.includes("raw") ? send(200, text) : send(200, { sha: `blob-${file}`, content: Buffer.from(text, "utf8").toString("base64") });
    }
    if (path === "/pulls" && method === "GET") {
      const head = url.searchParams.get("head");
      return send(200, this.pulls.filter((p) => `${owner}:${p.head}` === head).map((p) => ({ number: p.number, state: "open", merged_at: null })));
    }
    if (path === "/pulls" && method === "POST") {
      const pull: FakePull = { number: this.pulls.length + 1, head: body.head, base: body.base, title: body.title, body: body.body };
      this.pulls.push(pull);
      return send(201, { number: pull.number });
    }
    return send(404, { message: "Not Found" });
  }

  // A branch created or moved to a commit starts from the files of the branch that commit is the head of.
  private point(branch: string, sha: string, send: (code: number, value?: unknown) => void, code: number): void {
    const from = [...this.heads].find(([, head]) => head === sha)?.[0];
    if (!from) return send(422, { message: "Object does not exist" });
    this.branches.set(branch, new Map(this.branches.get(from)));
    this.heads.set(branch, sha);
    return send(code, {});
  }

  async start(): Promise<string> {
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  // Requests that change something on the server.
  writes(): SeenRequest[] { return this.requests.filter((r) => r.method !== "GET"); }
}
