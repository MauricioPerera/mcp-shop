import { createHash, timingSafeEqual } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

export function requireBearerToken(expectedToken) {
  const expectedHash = sha256(expectedToken);
  return (req, res, next) => {
    const header = req.headers["authorization"];
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const provided = header.slice("Bearer ".length).trim();
    const providedHash = sha256(provided || " ");
    if (providedHash.length !== expectedHash.length || !timingSafeEqual(providedHash, expectedHash)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
