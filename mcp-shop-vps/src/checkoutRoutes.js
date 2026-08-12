import express from "express";
import { findPaymentByCheckoutToken, confirmPaymentWebhook } from "./db.js";
import { decideCharge, signWebhookPayload, verifyWebhookSignature } from "./payments.js";

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 16px}
input{width:100%;padding:8px;margin:6px 0;box-sizing:border-box}
button{padding:8px 16px;cursor:pointer}</style></head><body>${body}</body></html>`;
}

function checkoutForm(token, payment) {
  return page(
    "Checkout (mock)",
    `<h2>Pagar pedido</h2>
     <p>Total: <strong>${(payment.amount_cents / 100).toFixed(2)} ${payment.currency}</strong></p>
     <p style="color:#666;font-size:14px">Esto es un checkout MOCK, no hay cobro real. Usa una tarjeta de prueba:
     <code>4242424242424242</code> (aprueba) o <code>4000000000000002</code> (rechaza).</p>
     <form method="POST" action="/mock-checkout/${token}">
       <label>Numero de tarjeta</label>
       <input name="card_number" value="4242424242424242" autocomplete="off">
       <button type="submit">Pagar</button>
     </form>`
  );
}

function resultPage(status) {
  const messages = {
    succeeded: ["Pago aprobado", "El pedido fue confirmado."],
    declined: ["Pago rechazado", "La tarjeta fue rechazada."],
    refunded: ["Pedido cancelado", "El link de pago ya no es valido."],
  };
  const [title, detail] = messages[status] ?? ["Estado desconocido", ""];
  return page(title, `<h2>${title}</h2><p>${detail}</p>`);
}

/**
 * Registers the mock checkout page and the payment webhook on the shared
 * Express app. Both are plain HTTP routes — no MCP session, no bearer auth —
 * because a real customer paying, and a real payment provider's webhook
 * caller, are never MCP clients holding our tool tokens. The webhook is
 * authenticated by HMAC signature instead (see payments.js).
 */
export function registerCheckoutRoutes(app, db, { webhookSecret, webhookUrl }) {
  app.get("/mock-checkout/:token", (req, res) => {
    const payment = findPaymentByCheckoutToken(db, req.params.token);
    if (!payment) return res.status(404).send(page("No encontrado", "<p>Este link de pago no existe.</p>"));
    if (payment.status !== "pending") return res.send(resultPage(payment.status));
    res.send(checkoutForm(req.params.token, payment));
  });

  app.post("/mock-checkout/:token", express.urlencoded({ extended: true }), async (req, res) => {
    const payment = findPaymentByCheckoutToken(db, req.params.token);
    if (!payment) return res.status(404).send(page("No encontrado", "<p>Este link de pago no existe.</p>"));
    if (payment.status !== "pending") return res.send(resultPage(payment.status));

    const charge = decideCharge(req.body.card_number);
    const payload = {
      checkout_token: req.params.token,
      status: charge.approved ? "approved" : "declined",
      transaction_id: charge.transactionId,
    };
    const signature = signWebhookPayload(webhookSecret, payload);

    try {
      // Self-call the real webhook endpoint — same network hop a real
      // provider would make, exercising the same signature-verification path.
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Signature": signature },
        body: JSON.stringify({ ...payload, card_last4: charge.last4, decline_reason: charge.declineReason }),
      });
    } catch (error) {
      console.error("mock-checkout: failed to call webhook", error);
      return res.status(502).send(page("Error", "<p>No se pudo confirmar el pago. Intenta de nuevo.</p>"));
    }

    res.send(resultPage(charge.approved ? "succeeded" : "declined"));
  });

  app.post("/webhooks/payment", (req, res) => {
    const { checkout_token, status, transaction_id, card_last4, decline_reason } = req.body ?? {};
    if (!checkout_token || !status || !transaction_id) {
      return res.status(400).json({ error: "bad_request" });
    }
    const signature = req.header("X-Signature");
    if (!verifyWebhookSignature(webhookSecret, { checkout_token, status, transaction_id }, signature)) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    const result = confirmPaymentWebhook(db, {
      checkoutToken: checkout_token,
      approved: status === "approved",
      transactionId: transaction_id,
      cardLast4: card_last4 ?? null,
      declineReason: decline_reason ?? null,
    });

    if (!result.ok) return res.status(404).json({ error: result.reason });
    // Ack with 200 even on a duplicate/retried webhook — idempotent, and acking
    // stops the (mock) provider from retrying a call we've already applied.
    res.status(200).json({ ok: true, already_processed: !!result.alreadyProcessed });
  });
}
