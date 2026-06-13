require("dotenv").config();
const { Pool } = require("pg");

// TLS config:
// - If DATABASE_CA is provided, verify the server cert against it (secure).
// - Else if PGSSL_NO_VERIFY=true, connect without verification (managed PG
//   providers with self-signed certs) — convenient but vulnerable to MITM.
// - Else require TLS with default verification.
function buildSslConfig() {
  if (process.env.DATABASE_CA) {
    return { rejectUnauthorized: true, ca: process.env.DATABASE_CA };
  }
  if (process.env.PGSSL_NO_VERIFY === "true") {
    console.log(
      "⚠️  DB TLS certificate verification is DISABLED (PGSSL_NO_VERIFY=true).",
    );
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSslConfig(),
  // Keep connections warm so we don't pay a fresh TLS handshake (slow,
  // especially across regions) on the first query after an idle period.
  max: 10,
  idleTimeoutMillis: 0, // never close idle clients — keep the warm socket open
  connectionTimeoutMillis: 10000,
  keepAlive: true, // TCP keep-alive so the socket isn't dropped while idle
  keepAliveInitialDelayMillis: 5000,
});

pool.connect((err, client, release) => {
  if (err) {
    console.log("Database connection FAILED:", err.message);
  } else {
    console.log("Database connected successfully");
    release();
  }
});

// Keep-warm ping every 30s: a cheap SELECT keeps a pooled connection genuinely
// warm so user messages never hit a cold reconnect (a fresh cross-region TLS
// handshake costs ~1.5s). Frequent enough to stay ahead of any server-side
// idle disconnect. Costs almost nothing.
setInterval(() => {
  pool
    .query("SELECT 1")
    .catch((e) => console.log("DB keep-warm ping failed:", e.message));
}, 30 * 1000);

// Prime a connection immediately at boot so the very first user message is warm.
pool.query("SELECT 1").catch(() => {});

module.exports = pool;
