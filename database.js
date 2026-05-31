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
});

pool.connect((err, client, release) => {
  if (err) {
    console.log("Database connection FAILED:", err.message);
  } else {
    console.log("Database connected successfully");
    release();
  }
});

module.exports = pool;
