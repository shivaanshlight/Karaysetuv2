// API ROUTES FOR ORGANIZER WEB PANEL
// Add these routes to your index.js

const express = require("express");
const router = express.Router();
const pool = require("./database");
const twilio = require("twilio");
const { verifyToken } = require("./auth");
const { formatWhatsAppNumber } = require("./utils");

const twClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);
const BOT_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// Welcome a member added from the web panel (best-effort). Uses an approved
// template when MEMBER_WELCOME_CONTENT_SID is set; otherwise plain text.
async function sendMemberWelcome(to, name, orgName) {
  try {
    const sid = process.env.MEMBER_WELCOME_CONTENT_SID;
    if (sid) {
      await twClient.messages.create({
        from: BOT_NUMBER,
        to,
        contentSid: sid,
        contentVariables: JSON.stringify({ "1": name, "2": orgName }),
      });
    } else {
      await twClient.messages.create({
        from: BOT_NUMBER,
        to,
        body: `Hi ${name}! You've been added to ${orgName} on KaryaSetu — your team's task manager. Send *Help* anytime to see what you can do.`,
      });
    }
    console.log("✅ Member welcome sent to:", to);
  } catch (error) {
    console.log("Member welcome failed:", error.message);
  }
}

// ── MIDDLEWARE — authenticate the organizer from a bearer token ──
// The token is issued by /auth/verify-otp and signed with AUTH_SECRET.
// It carries the org_id, so a caller can only ever act on their own org.
async function getOrg(req, res, next) {
  try {
    const header = req.headers["authorization"] || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const payload = verifyToken(token);
    if (!payload || !payload.org_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const r = await pool.query(
      `SELECT * FROM organizations WHERE org_id = $1`,
      [payload.org_id],
    );
    if (!r.rows[0]) return res.status(401).json({ error: "Org not found" });
    req.org = r.rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── GET ALL TASKS ──
// PRD: Section 10.2 — full org task table
router.get("/tasks", getOrg, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.*,
        own.name as owner_name,
        asn.name as assignee_name
       FROM tasks t
       LEFT JOIN members own ON t.owner_id = own.member_id
       LEFT JOIN members asn ON t.assignee_id = asn.member_id
       WHERE t.org_id = $1
       AND t.status != 'deleted'
       ORDER BY t.created_at DESC`,
      [req.org.org_id],
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET ALL MEMBERS ──
// PRD: Section 10.2 — member management
router.get("/members", getOrg, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.*,
        COUNT(t.task_id) as open_task_count
       FROM members m
       LEFT JOIN tasks t ON t.assignee_id = m.member_id
         AND t.status NOT IN ('completed','deleted')
       WHERE m.org_id = $1 AND m.status = 'active'
       GROUP BY m.member_id
       ORDER BY m.created_at ASC`,
      [req.org.org_id],
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADD MEMBER ──
// PRD: Section 7.1
router.post("/members", getOrg, async (req, res) => {
  try {
    const { name, phone_number } = req.body;
    if (!name || !phone_number)
      return res.status(400).json({ error: "Name and phone required" });

    // Format + validate phone
    const formatted = formatWhatsAppNumber(phone_number);
    if (!formatted) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    // Check existing (any status) — reactivate if previously removed
    const existing = await pool.query(
      `SELECT * FROM members WHERE org_id = $1 AND whatsapp_number = $2`,
      [req.org.org_id, formatted],
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0].status === "active") {
        return res.status(400).json({ error: "Member already exists" });
      }
      await pool.query(
        `UPDATE members SET status = 'active', name = $1, role = 'member', updated_at = NOW() WHERE member_id = $2`,
        [name, existing.rows[0].member_id],
      );
    } else {
      await pool.query(
        `INSERT INTO members (org_id, name, whatsapp_number, role) VALUES ($1, $2, $3, 'member')`,
        [req.org.org_id, name, formatted],
      );
    }

    // Notify the new member over WhatsApp (best-effort; won't block the response)
    sendMemberWelcome(formatted, name, req.org.org_name);

    res.json({ success: true, message: `${name} added successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── REMOVE MEMBER ──
// PRD: Section 7.2
router.delete("/members/:memberId", getOrg, async (req, res) => {
  try {
    const { memberId } = req.params;

    // Get organizer member_id
    const organizer = await pool.query(
      `SELECT member_id FROM members WHERE org_id = $1 AND role = 'organizer' AND status = 'active' LIMIT 1`,
      [req.org.org_id],
    );
    const organizerId = organizer.rows[0]?.member_id;

    // Transfer tasks
    await pool.query(
      `UPDATE tasks SET owner_id = $1, updated_at = NOW()
       WHERE owner_id = $2 AND status NOT IN ('completed','deleted')`,
      [organizerId, memberId],
    );
    await pool.query(
      `UPDATE tasks SET assignee_id = $1, updated_at = NOW()
       WHERE assignee_id = $2 AND status NOT IN ('completed','deleted')`,
      [organizerId, memberId],
    );

    // Set inactive
    await pool.query(
      `UPDATE members SET status = 'inactive', updated_at = NOW() WHERE member_id = $1`,
      [memberId],
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── UPDATE SETTINGS ──
// PRD: Section 10.2
router.patch("/settings", getOrg, async (req, res) => {
  try {
    const { org_name, timezone } = req.body;
    await pool.query(
      `UPDATE organizations SET org_name = $1, timezone = $2, updated_at = NOW() WHERE org_id = $3`,
      [org_name, timezone, req.org.org_id],
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const { createToken } = require("./auth");
const { Resend } = require("resend");

// Lazily create the Resend client so the app can still boot (and the WhatsApp
// bot can run) before email/OTP is configured. Only the OTP login needs it.
let _resend = null;
function getResend() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error(
      "Email login is not configured yet (RESEND_API_KEY is missing).",
    );
  }
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

const OTP_FROM = process.env.RESEND_FROM || "KaryaSetu <noreply@yourdomain.com>";
const MAX_OTP_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between sends

// Store OTPs temporarily.
// NOTE: in-memory — fine for a single instance, but OTPs are lost on restart
// and not shared across instances. Move to Redis/DB for multi-instance deploys.
const otpStore = {};

// SEND OTP
router.post("/auth/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    // Throttle resends to slow down abuse / email flooding.
    const prev = otpStore[email];
    if (prev && Date.now() - prev.sentAt < RESEND_COOLDOWN_MS) {
      return res
        .status(429)
        .json({ error: "Please wait a minute before requesting another OTP" });
    }

    // Check if this email belongs to an organizer
    const member = await pool.query(
      `SELECT m.*, o.org_name, o.org_id FROM members m
       JOIN organizations o ON m.org_id = o.org_id
       WHERE m.email = $1 AND m.role = 'organizer' AND m.status = 'active'`,
      [email],
    );

    if (member.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "No organizer found with this email" });
    }

    // Generate 6 digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP
    otpStore[email] = {
      otp,
      expiresAt,
      orgId: member.rows[0].org_id,
      memberId: member.rows[0].member_id,
      attempts: 0,
      sentAt: Date.now(),
    };

    // Send email
    await getResend().emails.send({
      from: OTP_FROM,
      to: email,
      subject: "Your KaryaSetu login OTP",
      html: `
        <h2>KaryaSetu Organizer Panel</h2>
        <p>Your OTP is: <strong style="font-size:24px">${otp}</strong></p>
        <p>This OTP expires in 10 minutes.</p>
        <p>If you didn't request this, ignore this email.</p>
      `,
    });

    res.json({ success: true, message: "OTP sent" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VERIFY OTP
router.post("/auth/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const stored = otpStore[email];

    if (!stored)
      return res
        .status(400)
        .json({ error: "OTP not found. Request a new one." });
    if (Date.now() > stored.expiresAt) {
      delete otpStore[email];
      return res.status(400).json({ error: "OTP expired. Request a new one." });
    }

    // Limit guesses to defeat brute-forcing a 6-digit code.
    if (stored.attempts >= MAX_OTP_ATTEMPTS) {
      delete otpStore[email];
      return res
        .status(429)
        .json({ error: "Too many attempts. Request a new OTP." });
    }

    if (stored.otp !== otp) {
      stored.attempts += 1;
      return res.status(400).json({ error: "Wrong OTP" });
    }

    // Clear OTP (single use)
    delete otpStore[email];

    // Get org and member details
    const member = await pool.query(
      `SELECT m.*, o.org_name FROM members m
       JOIN organizations o ON m.org_id = o.org_id
       WHERE m.email = $1 AND m.role = 'organizer'`,
      [email],
    );

    const m = member.rows[0];
    const token = createToken({ org_id: m.org_id, member_id: m.member_id });
    res.json({
      success: true,
      token,
      org_id: m.org_id,
      org_name: m.org_name,
      user_name: m.name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;
