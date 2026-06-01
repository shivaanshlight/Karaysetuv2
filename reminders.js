require("dotenv").config();
const pool = require("./database");
const twilio = require("twilio");
const { todayInTimezone } = require("./utils");

// Due-date reminders — sent at 9:00 AM in the org's timezone on the due date.
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);
const BOT_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

async function send(to, body) {
  try {
    await client.messages.create({ from: BOT_NUMBER, to, body });
    console.log("⏰ Reminder sent to:", to);
  } catch (error) {
    console.log("⏰ Reminder send failed:", error.message);
  }
}

function currentHourInTz(timezone) {
  try {
    return parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        hour12: false,
      }).format(new Date()),
      10,
    );
  } catch {
    return new Date().getUTCHours();
  }
}

async function runReminderCheck() {
  try {
    const orgs = await pool.query(
      `SELECT org_id, timezone FROM organizations WHERE status = 'active'`,
    );

    for (const org of orgs.rows) {
      const tz = org.timezone || "Asia/Kolkata";
      if (currentHourInTz(tz) !== 9) continue;

      const today = todayInTimezone(tz);

      const tasks = await pool.query(
        `SELECT t.task_id, t.title, m.whatsapp_number
         FROM tasks t
         JOIN members m ON t.assignee_id = m.member_id
         WHERE t.org_id = $1
           AND t.status NOT IN ('completed', 'deleted')
           AND t.due_date = $2
           AND (t.reminded_on IS NULL OR t.reminded_on <> $2)
           AND m.status = 'active'
           AND COALESCE(m.reminders_enabled, true) = true`,
        [org.org_id, today],
      );

      for (const task of tasks.rows) {
        await send(
          task.whatsapp_number,
          `⏰ Reminder: ${task.task_id} — ${task.title} is due today.`,
        );
        await pool.query(
          `UPDATE tasks SET reminded_on = $1 WHERE task_id = $2`,
          [today, task.task_id],
        );
      }
    }
  } catch (error) {
    console.log("Reminder check error:", error.message);
  }
}

function startReminders() {
  setInterval(runReminderCheck, 15 * 60 * 1000);
  console.log("⏰ Reminder scheduler started");
}

module.exports = { startReminders };
