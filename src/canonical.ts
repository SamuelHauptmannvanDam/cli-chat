// The exact bytes that get signed for request auth. Shared by the client
// (libsodium signing) and the server (WebCrypto verifying), with no crypto
// dependency of its own — so the server can import it without pulling in
// libsodium (which can't run on Cloudflare Workers).

export const MAX_SKEW_MS = 5 * 60 * 1000;

export function canonical(
  method: string,
  path: string,
  timestamp: number,
  body: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`;
}
