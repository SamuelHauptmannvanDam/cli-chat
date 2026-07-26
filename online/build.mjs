// Bundles the browser client (online/src/app.ts + the reused src/ modules +
// libsodium) into one static online/public/app.js the online worker serves.
//
//   node online/build.mjs           (or: npm run build:online)
//
// Separate from the root build.mjs on purpose: that one targets Node (externals
// stay external); this one targets browsers, so EVERYTHING is bundled inline.

import { build } from "esbuild";

// The Anthropic SDK statically imports node builtins for its Node credential
// chain; in the browser we always pass an explicit apiKey, so those modules can
// resolve to an empty stub (see online/shims/node-empty.cjs).
const nodeShim = {
  name: "node-builtins-empty",
  setup(b) {
    b.onResolve({ filter: /^node:/ }, () => ({
      path: new URL("./shims/node-empty.cjs", import.meta.url).pathname,
    }));
  },
};

await build({
  plugins: [nodeShim],
  entryPoints: ["online/src/app.ts"],
  outfile: "online/public/app.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  logLevel: "info",
});
