import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";

// Mirrors Stripe's test-card conventions (https://stripe.com/docs/testing) so
// swapping in a real gateway later only means replacing this module's
// implementation — the call sites keep the same shapes a real
// createCheckoutSession()/webhook payload would have.
const DECLINE_CARDS = {
  "4000000000000002": "generic_decline",
  "4000000000009995": "insufficient_funds",
  "4000000000000069": "expired_card",
};

export function decideCharge(cardNumber) {
  const normalized = String(cardNumber ?? "").replace(/\s+/g, "");
  const last4 = normalized.slice(-4).padStart(4, "0");
  const declineReason = DECLINE_CARDS[normalized];
  const transactionId = `mock_txn_${randomUUID()}`;
  if (declineReason) return { approved: false, transactionId, last4, declineReason };
  return { approved: true, transactionId, last4 };
}

export function newCheckoutToken() {
  return `mock_chk_${randomUUID()}`;
}

export function mockRefund(transactionId) {
  return { ok: true, refundId: `mock_refund_${randomUUID()}`, transactionId };
}

/**
 * Signs {checkout_token, status, transaction_id} with HMAC-SHA256. This is a
 * simplification: real providers (Stripe, MercadoPago) sign the raw request
 * body bytes, which requires capturing them before any JSON body parser
 * touches the request. Our Express app parses JSON globally before routes
 * run, so we sign a canonical string of known fields instead — still a real
 * signature that rejects forged/tampered calls, just not byte-for-byte what
 * a real provider's SDK verification helper expects. Swap in the provider's
 * official verify-webhook helper when this becomes a real integration.
 */
export function signWebhookPayload(secret, { checkout_token, status, transaction_id }) {
  return createHmac("sha256", secret).update(`${checkout_token}.${status}.${transaction_id}`).digest("hex");
}

export function verifyWebhookSignature(secret, payload, signature) {
  const expected = signWebhookPayload(secret, payload);
  const a = Buffer.from(signature ?? "", "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
