// ─────────────────────────────────────────
// ADMIN CONSOLE API — platform operator only
// PRD Reference: Section 11
// Auth: a single shared secret (ADMIN_SECRET) sent as the x-admin-secret header.
// ─────────────────────────────────────────
const express = require("express");
const router = express.Router();
const pool = require("./database");
const twilio = require("twilio");
const { formatWhatsAppNumber } = require("./utils");

const twClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);
const BOT_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// Tell a newly-created organizer (over WhatsApp) that their org is ready.
// Uses an approved template when ORG_WELCOME_CONTENT_SID is set (needed for
// proactive messages on production); otherwise sends plain text.
async function sendOrganizerWelcome(to, orgName) {
  try {
    const sid = process.env.ORG_WELCOME_CONTENT_SID;
    if (sid) {
      await twClient.messages.create({
        from: BOT_NUMBER,
        to,
        contentSid: sid,
        contentVariables: JSON.stringify({ "1": orgName }),
      });
    } else {
      await twClient.messages.create({
        from: BOT_NUMBER,
        to,
        body:
          `Welcome to KaryaSetu! 🎉 You're now the Organizer for ${orgName}.\n\n` +
          `Add your first member: *add member [Name] [Number]*\nSend *Help* anytime.`,
      });
    }
    console.log("✅ Organizer welcome sent to:", to);
  } catch (error) {
    console.log("Organizer welcome failed:", error.message);
  }
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_SECRET) {
    return res
      .status(500)
      .json({ error: "ADMIN_SECRET is not configured on the server" });
  }
  if (req.headers["x-admin-secret"] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Wrong admin password" });
  }
  next();
}

// ── PLATFORM METRICS ──
router.get("/metrics", requireAdmin, async (req, res) => {
  try {
    const orgs = await pool.query(`SELECT COUNT(*) FROM organizations`);
    const members = await pool.query(
      `SELECT COUNT(*) FROM members WHERE status = 'active'`,
    );
    const tasks = await pool.query(
      `SELECT COUNT(*) FROM tasks WHERE status NOT IN ('deleted')`,
    );
    res.json({
      total_orgs: parseInt(orgs.rows[0].count),
      total_members: parseInt(members.rows[0].count),
      total_tasks: parseInt(tasks.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LIST ALL ORGANIZATIONS ──
router.get("/orgs", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.org_id, o.org_name, o.timezone, o.status, o.created_at,
        (SELECT name FROM members m
           WHERE m.org_id = o.org_id AND m.role = 'organizer' AND m.status = 'active'
           ORDER BY m.created_at ASC LIMIT 1) AS organizer_name,
        (SELECT COUNT(*) FROM members m
           WHERE m.org_id = o.org_id AND m.status = 'active') AS member_count,
        (SELECT COUNT(*) FROM tasks t
           WHERE t.org_id = o.org_id AND t.status NOT IN ('completed','deleted'))
           AS active_task_count
       FROM organizations o
       ORDER BY o.created_at DESC`,
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CREATE A NEW ORGANIZATION (+ its organizer) ──
router.post("/orgs", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      org_name,
      organizer_name,
      organizer_whatsapp,
      organizer_email,
      timezone,
    } = req.body;

    if (!org_name || !organizer_name || !organizer_whatsapp) {
      return res.status(400).json({
        error: "Org name, organizer name, and organizer WhatsApp are required",
      });
    }

    const formatted = formatWhatsAppNumber(organizer_whatsapp);
    if (!formatted) {
      return res
        .status(400)
        .json({ error: "Invalid organizer WhatsApp number" });
    }

    await client.query("BEGIN");
    const orgRes = await client.query(
      `INSERT INTO organizations (org_name, timezone)
       VALUES ($1, $2) RETURNING org_id`,
      [org_name, timezone || "Asia/Kolkata"],
    );
    const orgId = orgRes.rows[0].org_id;

    await client.query(
      `INSERT INTO members (org_id, name, whatsapp_number, role, status, email)
       VALUES ($1, $2, $3, 'organizer', 'active', $4)`,
      [orgId, organizer_name, formatted, organizer_email || null],
    );
    await client.query("COMMIT");

    // Notify the new organizer over WhatsApp (best-effort; won't block creation).
    sendOrganizerWelcome(formatted, org_name);

    res.json({ success: true, org_id: orgId });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── SUSPEND / REACTIVATE AN ORGANIZATION ──
// Suspending sets status='suspended'; the bot already ignores suspended orgs
// (findMember only matches active orgs).
router.patch("/orgs/:id/status", requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "suspended"].includes(status)) {
      return res.status(400).json({ error: "Status must be active or suspended" });
    }
    await pool.query(
      `UPDATE organizations SET status = $1, updated_at = NOW() WHERE org_id = $2`,
      [status, req.params.id],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
