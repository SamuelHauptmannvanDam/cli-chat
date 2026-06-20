// Runs the hosted mailbox locally on Node, backed by node:sqlite. This is the
// dev/test target. The Cloudflare Workers + D1 deploy uses the same app.ts via
// worker.ts. Run:  node server-mailbox/node.ts   (PORT / MAILBOX_DB optional)

import { serve } from "@hono/node-server";
import { join, resolve } from "node:path";
import { createApp } from "./app.ts";
import { nodeSqliteStore } from "./store.ts";

const ROOT = resolve(import.meta.dirname, "..");
const port = Number(process.env.MAILBOX_PORT ?? 8787);
const dbPath = process.env.MAILBOX_DB ?? join(ROOT, "mailbox-server.db");

const app = createApp({ store: nodeSqliteStore(dbPath), now: () => Date.now() });

serve({ fetch: app.fetch, port }, (info) => {
  console.error(`mailbox listening on http://localhost:${info.port} (db: ${dbPath})`);
});
