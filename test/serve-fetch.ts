// Minimal node:http adapter for a Hono-style `fetch` handler — the tiny slice of
// @hono/node-server the tests actually use. Production runs on Cloudflare Workers
// (native fetch), so this lives only in the test tree. Bodies are buffered, which
// is fine for the small JSON payloads the mailbox exchanges.

import { createServer, type Server } from "node:http";

type FetchHandler = (req: Request) => Response | Promise<Response>;

export interface ServedFetch {
  url: string;
  port: number;
  close(): void;
}

// Boot `handler` on a random loopback port. Caller must close() it.
export function serveFetch(handler: FetchHandler): Promise<ServedFetch> {
  return new Promise((resolve) => {
    const server: Server = createServer((nodeReq, nodeRes) => {
      const chunks: Buffer[] = [];
      nodeReq.on("data", (c) => chunks.push(c as Buffer));
      nodeReq.on("end", async () => {
        const host = nodeReq.headers.host ?? "localhost";
        const url = `http://${host}${nodeReq.url ?? "/"}`;
        const method = nodeReq.method ?? "GET";

        const headers = new Headers();
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
          else if (v != null) headers.set(k, v);
        }

        const hasBody = method !== "GET" && method !== "HEAD" && chunks.length > 0;
        const req = new Request(url, {
          method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
        });

        const res = await handler(req);
        nodeRes.statusCode = res.status;
        res.headers.forEach((value, key) => nodeRes.setHeader(key, value));
        nodeRes.end(Buffer.from(await res.arrayBuffer()));
      });
    });
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://localhost:${port}`,
        port,
        close: () => server.close(),
      });
    });
  });
}
