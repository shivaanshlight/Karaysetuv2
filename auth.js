// ─────────────────────────────────────────
// AUTH TOKENS
// Stateless HMAC-signed tokens (no external dependency).
// Format: base64url(payloadJSON).base64url(HMAC-SHA256)
// ─────────────────────────────────────────
const crypto = require("crypto");

const SECRET = process.env.AUTH_SECRET;
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

if (!SECRET) {
  console.log(
    "⚠️  AUTH_SECRET is not set. Web-panel auth tokens cannot be issued or verified. Set AUTH_SECRET in your environment.",
  );
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sign(payloadBase64) {
  return b64url(
    crypto.createHmac("sha256", SECRET).update(payloadBase64).digest(),
  );
}

// Create a signed token. `payload` is an object (e.g. { org_id, member_id }).
function createToken(payload, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!SECRET) throw new Error("AUTH_SECRET not configured");
  const body = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadB64 = b64url(JSON.stringify(body));
  return `${payloadB64}.${sign(payloadB64)}`;
}

// Verify a token. Returns the payload object, or null if invalid/expired.
function verifyToken(token) {
  if (!SECRET || !token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, providedSig] = parts;
  const expectedSig = sign(payloadB64);

  // constant-time comparison
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    );
  } catch {
    return null;
  }

  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

module.exports = { createToken, verifyToken };
