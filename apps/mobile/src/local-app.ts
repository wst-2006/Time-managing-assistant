/**
 * A stand-in for the small part of Fastify the API routes use (get / post /
 * put / patch / delete, params, query, body, reply.status().send()). The
 * phone app registers the same route plugins on it and answers the web
 * app's fetch calls without any network or Node process.
 */
type Handler = (request: LocalRequest, reply: LocalReply) => unknown;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

export type LocalRequest = {
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  rawBody?: string;
  headers: Record<string, string>;
};

class LocalReply {
  statusCode = 200;
  payload: unknown = undefined;
  sent = false;
  status(code: number) { this.statusCode = code; return this; }
  code(code: number) { return this.status(code); }
  send(payload?: unknown) { this.payload = payload; this.sent = true; return this; }
  header() { return this; }
}
export type { LocalReply };

function compile(path: string) {
  const keys: string[] = [];
  const source = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => { keys.push(key); return "([^/]+)"; });
  return { pattern: new RegExp(`^${source}/?$`), keys };
}

export class LocalApp {
  private routes: Route[] = [];
  constructor(private prefix = "") {}

  private add(method: string, path: string, a: unknown, b?: unknown) {
    const handler = (typeof a === "function" ? a : b) as Handler;
    const { pattern, keys } = compile(this.prefix + path);
    this.routes.push({ method, pattern, keys, handler });
  }
  get(path: string, a: unknown, b?: unknown) { this.add("GET", path, a, b); }
  post(path: string, a: unknown, b?: unknown) { this.add("POST", path, a, b); }
  put(path: string, a: unknown, b?: unknown) { this.add("PUT", path, a, b); }
  patch(path: string, a: unknown, b?: unknown) { this.add("PATCH", path, a, b); }
  delete(path: string, a: unknown, b?: unknown) { this.add("DELETE", path, a, b); }
  addHook() { /* not needed in the phone app */ }
  decorate() { /* not needed in the phone app */ }
  log = { info: () => undefined, warn: console.warn, error: console.error };

  /** Registers a Fastify route plugin under a prefix, as `app.register` would. */
  async register(plugin: (app: any, options: any) => unknown, options: { prefix?: string } & Record<string, unknown>) {
    const child = new LocalApp(this.prefix + (options.prefix ?? ""));
    await plugin(child, options);
    this.routes.push(...child.routes);
  }

  async handle(method: string, url: URL, bodyText: string | null, headers: Record<string, string>): Promise<Response> {
    const path = url.pathname;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => { params[key] = decodeURIComponent(match[index + 1]!); });
      const query: Record<string, string | string[]> = {};
      url.searchParams.forEach((value, key) => {
        const existing = query[key];
        query[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
      });
      let body: unknown = undefined;
      if (bodyText) {
        try { body = JSON.parse(bodyText); }
        catch { return json(400, { statusCode: 400, error: "Bad Request", message: "Body is not valid JSON" }); }
      }
      const reply = new LocalReply();
      try {
        const returned = await route.handler({ params, query, body, rawBody: bodyText ?? undefined, headers }, reply);
        const payload = reply.sent ? reply.payload : returned instanceof LocalReply ? returned.payload : returned;
        return json(reply.statusCode, payload);
      } catch (error: any) {
        const status = Number(error?.statusCode) || 500;
        console.error("Local API error", method, path, error);
        return json(status, { statusCode: status, error: status === 500 ? "Internal Server Error" : "Error", message: String(error?.message ?? error) });
      }
    }
    return json(404, { statusCode: 404, error: "Not Found", message: `Route ${method}:${path} not found` });
  }
}

function json(status: number, payload: unknown): Response {
  if (status === 204 || payload === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
