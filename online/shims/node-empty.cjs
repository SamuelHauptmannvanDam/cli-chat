// Empty stand-in for node:* builtins when bundling for the browser. The
// Anthropic SDK statically imports node:fs/node:path for its credential-chain
// code, but never runs it in a browser (we always pass an explicit apiKey with
// dangerouslyAllowBrowser). CJS on purpose: esbuild lets ESM named imports of a
// CJS module resolve to undefined at runtime instead of failing the build.
module.exports = {};
