async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish comparison: compares SHA-256 digests instead of raw strings to avoid leaking length via timing. */
export async function isAuthorized(request: Request, expectedToken: string): Promise<boolean> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length).trim();
  if (!provided) return false;
  const [providedHash, expectedHash] = await Promise.all([sha256(provided), sha256(expectedToken)]);
  return providedHash === expectedHash;
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="mcp-shop"' },
  });
}
