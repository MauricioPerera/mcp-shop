// Mirrors Stripe's test-card conventions (https://stripe.com/docs/testing) so
// swapping in a real gateway later only means replacing this module's
// implementation — the call sites keep the same shapes a real
// createCheckoutSession()/webhook payload would have.
const DECLINE_CARDS: Record<string, string> = {
  "4000000000000002": "generic_decline",
  "4000000000009995": "insufficient_funds",
  "4000000000000069": "expired_card",
};

export interface ChargeDecision {
  approved: boolean;
  transactionId: string;
  last4: string;
  declineReason?: string;
}

export function decideCharge(cardNumber?: string): ChargeDecision {
  const normalized = String(cardNumber ?? "").replace(/\s+/g, "");
  const last4 = normalized.slice(-4).padStart(4, "0");
  const declineReason = DECLINE_CARDS[normalized];
  const transactionId = `mock_txn_${crypto.randomUUID()}`;
  if (declineReason) return { approved: false, transactionId, last4, declineReason };
  return { approved: true, transactionId, last4 };
}

export function newCheckoutToken(): string {
  return `mock_chk_${crypto.randomUUID()}`;
}

export function mockRefund(transactionId: string) {
  return { ok: true, refundId: `mock_refund_${crypto.randomUUID()}`, transactionId };
}

export interface WebhookPayloadFields {
  checkout_token: string;
  status: string;
  transaction_id: string;
}

// Web Crypto (not node:crypto) — matches auth.ts's existing pattern in this
// codebase and avoids depending on Node type declarations that aren't
// available here even with the nodejs_compat runtime flag.
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Signs {checkout_token, status, transaction_id} with HMAC-SHA256. This is a
 * simplification: real providers (Stripe, MercadoPago) sign the raw request
 * body bytes, which requires capturing them before any JSON body parser
 * touches the request. We sign a canonical string of known fields instead —
 * still a real signature that rejects forged/tampered calls, just not
 * byte-for-byte what a real provider's SDK verification helper expects. Swap
 * in the provider's official verify-webhook helper for a real integration.
 */
export async function signWebhookPayload(
  secret: string,
  { checkout_token, status, transaction_id }: WebhookPayloadFields
): Promise<string> {
  return hmacSha256Hex(secret, `${checkout_token}.${status}.${transaction_id}`);
}

export async function verifyWebhookSignature(
  secret: string,
  payload: WebhookPayloadFields,
  signature: string | null
): Promise<boolean> {
  if (!signature) return false;
  const expected = await signWebhookPayload(secret, payload);
  // Constant-time-ish: compare digests of both values instead of the raw
  // strings, same trick auth.ts uses for the bearer token check.
  const [a, b] = await Promise.all([hmacSha256Hex(secret, signature), hmacSha256Hex(secret, expected)]);
  return a === b;
}
