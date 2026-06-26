require("dotenv").config();
const pool = require("./database");
const twilio = require("twilio");
const { todayInTimezone } = require("./utils");

// QoL reminders:
//  • Morning digest (9 AM org tz): one message per member listing their tasks
//    due today + overdue (+ snoozed-to-today).
//  • Due-time reminders: for tasks with a specific time, ping when that time
//    arrives.
// Uses an approved template (TASK_REMINDER_CONTENT_SID) when set; otherwise
// plain text (which only reaches people inside the 24h window).
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const BOT_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const REMINDER_SID = process.env.TASK_REMINDER_CONTENT_SID;

async function send(to, body) {
  try { await client.messages.create({ from: BOT_NUMBER, to, body }); }
  catch (e) { console.log("⏰ Reminder send failed:", e.message); }
}
// Template send (positional {{1}} id, {{2}} title, {{3}} due text) with text fallback.
async function sendReminderTemplate(to, taskId, title, dueText, fallback) {
  if (REMINDER_SID) {
    try {
      await client.messages.create({ from: BOT_NUMBER, to, contentSid: REMINDER_SID, contentVariables: JSON.stringify({ "1": taskId, "2": title, "3": dueText }) });
      return;
    } catch (e) { console.log("Reminder template failed, using text:", e.message); }
  }
  await send(to, fallback);
}

function nowInTz(tz) {
  try {
    const hh = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date());
    const mm = new Intl.DateTimeFormat("en-US", { timeZone: tz, minute: "2-digit" }).format(new Date());
    return { hour: parseInt(hh, 10), minute: parseInt(mm, 10) };
  } catch { const d = new Date(); return { hour: d.getUTCHours(), minute: d.getUTCMinutes() }; }
}
function fmtDate(d) { try { return new Date(d).toDateString(); } catch { return String(d); } }

async function runReminderCheck() {
  try {
    const orgs = await pool.query(`SELECT org_id, timezone FROM organizations WHERE status = 'active'`);
    for (const org of orgs.rows) {
      const tz = org.timezone || "Asia/Kolkata";
      const { hour, minute } = nowInTz(tz);
      const today = todayInTimezone(tz);

      // ── 1) MORNING DIGEST (9 AM, once/day per member) ──
      if (hour === 9) {
        const members = await pool.query(
          `SELECT member_id, whatsapp_number, name FROM members
           WHERE org_id = $1 AND status = 'active' AND COALESCE(reminders_enabled, true) = true
             AND (digest_on IS NULL OR digest_on <> $2)`,
          [org.org_id, today],
        );
        for (const m of members.rows) {
          const tasks = await pool.query(
            `SELECT task_id, title, due_date FROM tasks
             WHERE org_id = $1 AND assignee_id = $2 AND status NOT IN ('completed','deleted')
               AND (due_date <= $3 OR snooze_until = $3) ORDER BY due_date ASC NULLS LAST LIMIT 10`,
            [org.org_id, m.member_id, today],
          );
          if (tasks.rows.length) {
            let body = `🌅 Good morning, ${m.name}! You have ${tasks.rows.length} task${tasks.rows.length > 1 ? "s" : ""} to look at today:\n\n`;
            tasks.rows.forEach((t) => {
              const od = t.due_date && new Date(t.due_date) < new Date(today) ? " ⚠️ overdue" : "";
              body += `• ${t.task_id} — ${t.title}${od}\n`;
            });
            body += `\nReply *my tasks* for details.`;
            await send(m.whatsapp_number, body);
          }
          await pool.query(`UPDATE members SET digest_on = $1 WHERE member_id = $2`, [today, m.member_id]);
        }
      }

      // ── 2) DUE-TIME REMINDERS (when a task's time arrives) ──
      // due_time is 'HH:MM'. Fire once when current time is at/after it (same day).
      const nowMins = hour * 60 + minute;
      const timed = await pool.query(
        `SELECT t.task_id, t.title, t.due_date, t.due_time, m.whatsapp_number
         FROM tasks t JOIN members m ON t.assignee_id = m.member_id
         WHERE t.org_id = $1 AND t.due_date = $2 AND t.due_time IS NOT NULL
           AND t.status NOT IN ('completed','deleted')
           AND (t.time_reminded_on IS NULL OR t.time_reminded_on <> $2)
           AND m.status = 'active' AND COALESCE(m.reminders_enabled, true) = true`,
        [org.org_id, today],
      );
      for (const t of timed.rows) {
        const [hh, mm] = String(t.due_time).split(":");
        const taskMins = (parseInt(hh, 10) || 0) * 60 + (parseInt(mm, 10) || 0);
        if (nowMins >= taskMins && nowMins - taskMins < 60) {
          const dueText = `${fmtDate(t.due_date)} ${t.due_time}`;
          await sendReminderTemplate(t.whatsapp_number, t.task_id, t.title, dueText, `⏰ Reminder: ${t.task_id} — ${t.title} is due now (${t.due_time}).\nReply *done ${t.task_id}* or *snooze ${t.task_id}*.`);
          await pool.query(`UPDATE tasks SET time_reminded_on = $1 WHERE task_id = $2 AND org_id = $3`, [today, t.task_id, org.org_id]);
        }
      }
    }
  } catch (error) {
    console.log("Reminder check error:", error.message);
  }
}

function startReminders() {
  setInterval(runReminderCheck, 15 * 60 * 1000);
  console.log("⏰ Reminder scheduler started (morning digest + due-time reminders)");
}

module.exports = { startReminders };
