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
  max: 10,
  // Recycle idle clients after 60s. Supabase's pooler closes idle connections on
  // its side; if we held them open forever (idleTimeoutMillis: 0) those dead
  // sockets pile up and later fire errors. 60s > the 30s keep-warm ping below, so
  // the primary connection is always refreshed before it can time out.
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000,
  keepAlive: true, // TCP keep-alive so the socket isn't dropped while idle
  keepAliveInitialDelayMillis: 5000,
});

// CRITICAL: handle errors on IDLE pooled clients. Supabase's pooler drops idle
// connections; without this handler node-postgres prints the entire socket object
// (a huge log dump) and can crash the whole process. Here we just log one clean
// line — the pool transparently makes a fresh connection on the next query.
pool.on("error", (err) => {
  console.log("⚠️  Idle DB client dropped (pool will reconnect):", err.message);
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
