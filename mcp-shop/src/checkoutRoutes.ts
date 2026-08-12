import { findPaymentByCheckoutToken, confirmPaymentWebhook } from "./db";
import { decideCharge, signWebhookPayload, verifyWebhookSignature } from "./payments";

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 16px}
input{width:100%;padding:8px;margin:6px 0;box-sizing:border-box}
button{padding:8px 16px;cursor:pointer}</style></head><body>${body}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function checkoutForm(token: string, amountCents: number, currency: string): Response {
  return page(
    "Checkout (mock)",
    `<h2>Pagar pedido</h2>
     <p>Total: <strong>${(amountCents / 100).toFixed(2)} ${currency}</strong></p>
     <p style="color:#666;font-size:14px">Esto es un checkout MOCK, no hay cobro real. Usa una tarjeta de prueba:
     <code>4242424242424242</code> (aprueba) o <code>4000000000000002</code> (rechaza).</p>
     <form method="POST" action="/mock-checkout/${token}">
       <label>Numero de tarjeta</label>
       <input name="card_number" value="4242424242424242" autocomplete="off">
       <button type="submit">Pagar</button>
     </form>`
  );
}

function resultPage(status: string): Response {
  const messages: Record<string, [string, string]> = {
    succeeded: ["Pago aprobado", "El pedido fue confirmado."],
    declined: ["Pago rechazado", "La tarjeta fue rechazada."],
    refunded: ["Pedido cancelado", "El link de pago ya no es valido."],
  };
  const [title, detail] = messages[status] ?? ["Estado desconocido", ""];
  return page(title, `<h2>${title}</h2><p>${detail}</p>`);
}

export async function handleMockCheckoutGet(env: Env, token: string): Promise<Response> {
  const payment = await findPaymentByCheckoutToken(env.DB, token);
  if (!payment) return page("No encontrado", "<p>Este link de pago no existe.</p>");
  if (payment.status !== "pending") return resultPage(payment.status);
  return checkoutForm(token, payment.amount_cents, payment.currency);
}

/**
 * Handles the mock checkout's payment form submission. Decides the charge,
 * then applies it via the exact same signature-verify + confirm path the
 * real /webhooks/payment route uses — but calls it in-process instead of
 * doing a real HTTP self-fetch. A Worker fetching its own public URL would
 * route back out through Cloudflare's edge for a same-isolate call, which is
 * unnecessary latency/fragility for zero benefit; the verification logic
 * exercised is identical either way.
 */
export async function handleMockCheckoutPost(request: Request, env: Env, token: string): Promise<Response> {
  const payment = await findPaymentByCheckoutToken(env.DB, token);
  if (!payment) return page("No encontrado", "<p>Este link de pago no existe.</p>");
  if (payment.status !== "pending") return resultPage(payment.status);

  const form = await request.formData();
  const charge = decideCharge(String(form.get("card_number") ?? ""));

  const payload = {
    checkout_token: token,
    status: charge.approved ? "approved" : "declined",
    transaction_id: charge.transactionId,
  };
  const signature = await signWebhookPayload(env.WEBHOOK_SECRET, payload);
  if (!(await verifyWebhookSignature(env.WEBHOOK_SECRET, payload, signature))) {
    return page("Error", "<p>No se pudo confirmar el pago. Intenta de nuevo.</p>");
  }

  await confirmPaymentWebhook(env.DB, {
    checkoutToken: token,
    approved: charge.approved,
    transactionId: charge.transactionId,
    cardLast4: charge.last4,
    declineReason: charge.declineReason ?? null,
  });

  return resultPage(charge.approved ? "succeeded" : "declined");
}

export async function handleWebhookRequest(request: Request, env: Env): Promise<Response> {
  let body: { checkout_token?: string; status?: string; transaction_id?: string; card_last4?: string; decline_reason?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { checkout_token, status, transaction_id, card_last4, decline_reason } = body;
  if (!checkout_token || !status || !transaction_id) {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const signature = request.headers.get("X-Signature");
  if (!(await verifyWebhookSignature(env.WEBHOOK_SECRET, { checkout_token, status, transaction_id }, signature))) {
    return new Response(JSON.stringify({ error: "invalid_signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = await confirmPaymentWebhook(env.DB, {
    checkoutToken: checkout_token,
    approved: status === "approved",
    transactionId: transaction_id,
    cardLast4: card_last4 ?? null,
    declineReason: decline_reason ?? null,
  });

  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.reason }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Ack with 200 even on a duplicate/retried webhook — idempotent, and acking
  // stops the (mock) provider from retrying a call we've already applied.
  return new Response(JSON.stringify({ ok: true, already_processed: result.alreadyProcessed }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
