// Stripe webhook verification without the Stripe SDK. The SDK's sync
// constructEvent uses Node crypto that isn't available on Workers; rather than
// pull the async variant + its deps, we verify the signature directly with
// WebCrypto (HMAC-SHA256), which runs on both Workers and Node 22+.
//
// Stripe signs `${timestamp}.${rawBody}` with the endpoint's signing secret and
// sends it as `Stripe-Signature: t=<ts>,v1=<hexmac>` (possibly several v1=). We
// recompute the MAC and constant-time compare. On success we pull the paid
// account id from the Checkout Session's client_reference_id.

const enc = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Verify a Stripe webhook and, if it's a completed checkout, return the account
// id we stamped as client_reference_id. Returns null on any failure so the route
// can 400 without trusting the payload. `toleranceMs` guards against replay.
export function makeStripeVerifier(
  webhookSecret: string,
  now: () => number = () => Date.now(),
  toleranceMs = 5 * 60 * 1000,
) {
  return async (rawBody: string, signature: string | null): Promise<{ accountId: string } | null> => {
    if (!signature) return null;
    const parts = Object.fromEntries(
      signature.split(",").map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
      }),
    ) as { t?: string; v1?: string };
    if (!parts.t || !parts.v1) return null;
    const ts = Number(parts.t) * 1000;
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > toleranceMs) return null;
    const expected = await hmacHex(webhookSecret, `${parts.t}.${rawBody}`);
    if (!timingSafeEqual(expected, parts.v1)) return null;

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (event?.type !== "checkout.session.completed") return null;
    const accountId =
      event?.data?.object?.client_reference_id ?? event?.data?.object?.metadata?.account_id;
    return accountId ? { accountId: String(accountId) } : null;
  };
}
