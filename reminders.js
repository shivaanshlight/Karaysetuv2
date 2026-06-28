require("dotenv").config();
const pool = require("./database");
const twilio = require("twilio");
const { todayInTimezone } = require("./utils");

// Reminders:
//  • Morning digest (9 AM org tz): per-member summary of today's open tasks.
//  • Custom reminders: "remind me at 5pm Thursday" (remind_at) and
//    "remind 1 hour before" (remind_before_minutes) — one-shot.
//  • Snooze: duration-based (snooze_until timestamp).
//  • Due-time: ping at the task's time (for tasks with no custom reminder).
// Uses approved templates when set; otherwise plain text (24h window applies).
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const BOT_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const REMINDER_SID = process.env.TASK_REMINDER_CONTENT_SID;
const DIGEST_SID = process.env.DIGEST_CONTENT_SID;

async function send(to, body) {
  try { await client.messages.create({ from: BOT_NUMBER, to, body }); }
  catch (e) { console.log("⏰ Reminder send failed:", e.message); }
}
async function sendReminderTemplate(to, taskId, title, dueText, fallback) {
  if (REMINDER_SID) {
    try { await client.messages.create({ from: BOT_NUMBER, to, contentSid: REMINDER_SID, contentVariables: JSON.stringify({ "1": taskId, "2": title, "3": dueText }) }); return; }
    catch (e) { console.log("Reminder template failed, using text:", e.message); }
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
               AND due_date <= $3 ORDER BY due_date ASC NULLS LAST LIMIT 10`,
            [org.org_id, m.member_id, today],
          );
          if (tasks.rows.length) {
            const count = tasks.rows.length;
            if (DIGEST_SID) {
              try { await client.messages.create({ from: BOT_NUMBER, to: m.whatsapp_number, contentSid: DIGEST_SID, contentVariables: JSON.stringify({ "1": m.name, "2": String(count) }) }); }
              catch (e) { console.log("Digest template failed, using text:", e.message); }
            } else {
              let body = `🌅 Good morning, ${m.name}! You have ${count} task${count > 1 ? "s" : ""} to look at today:\n\n`;
              tasks.rows.forEach((t) => {
                const od = t.due_date && new Date(t.due_date) < new Date(today) ? " ⚠️ overdue" : "";
                body += `• ${t.task_id} — ${t.title}${od}\n`;
              });
              body += `\nReply *my tasks* for details.`;
              await send(m.whatsapp_number, body);
            }
          }
          await pool.query(`UPDATE members SET digest_on = $1 WHERE member_id = $2`, [today, m.member_id]);
        }
      }

      // ── 2) CUSTOM "remind me at <time>" (remind_at) ──
      const atDue = await pool.query(
        `SELECT t.task_id, t.title, t.due_date, t.due_time, m.whatsapp_number
         FROM tasks t JOIN members m ON t.assignee_id = m.member_id
         WHERE t.org_id = $1 AND t.remind_at IS NOT NULL AND t.remind_at <= now()
           AND t.remind_sent = false AND t.status NOT IN ('completed','deleted')
           AND m.status='active' AND COALESCE(m.reminders_enabled,true)=true`, [org.org_id]);
      for (const t of atDue.rows) {
        await sendReminderTemplate(t.whatsapp_number, t.task_id, t.title, fmtDate(t.due_date),
          `⏰ Reminder: ${t.task_id} — ${t.title}.\nReply *done ${t.task_id}* or *snooze ${t.task_id}*.`);
        await pool.query(`UPDATE tasks SET remind_sent = true WHERE task_id = $1 AND org_id = $2`, [t.task_id, org.org_id]);
      }

      // ── 3) CUSTOM "remind N before due" (remind_before_minutes) ──
      const before = await pool.query(
        `SELECT t.task_id, t.title, t.due_date, t.due_time, m.whatsapp_number
         FROM tasks t JOIN members m ON t.assignee_id = m.member_id
         WHERE t.org_id = $1 AND t.remind_before_minutes IS NOT NULL AND t.remind_sent = false
           AND t.due_date IS NOT NULL AND t.status NOT IN ('completed','deleted')
           AND ((t.due_date::timestamp + COALESCE(t.due_time,'09:00')::time) AT TIME ZONE $2)
               - (t.remind_before_minutes || ' minutes')::interval <= now()
           AND m.status='active' AND COALESCE(m.reminders_enabled,true)=true`, [org.org_id, tz]);
      for (const t of before.rows) {
        const dueText = `${fmtDate(t.due_date)}${t.due_time ? " " + t.due_time : ""}`;
        await sendReminderTemplate(t.whatsapp_number, t.task_id, t.title, dueText,
          `⏰ Reminder: ${t.task_id} — ${t.title} is coming up (due ${dueText}).\nReply *done ${t.task_id}* or *snooze ${t.task_id}*.`);
        await pool.query(`UPDATE tasks SET remind_sent = true WHERE task_id = $1 AND org_id = $2`, [t.task_id, org.org_id]);
      }

      // ── 4) SNOOZE due ──
      const snoozed = await pool.query(
        `SELECT t.task_id, t.title, t.due_date, t.due_time, m.whatsapp_number
         FROM tasks t JOIN members m ON t.assignee_id = m.member_id
         WHERE t.org_id = $1 AND t.snooze_until IS NOT NULL AND t.snooze_until <= now()
           AND t.status NOT IN ('completed','deleted')
           AND m.status='active' AND COALESCE(m.reminders_enabled,true)=true`, [org.org_id]);
      for (const t of snoozed.rows) {
        await sendReminderTemplate(t.whatsapp_number, t.task_id, t.title, fmtDate(t.due_date),
          `⏰ Snoozed reminder: ${t.task_id} — ${t.title}.\nReply *done ${t.task_id}* or *snooze ${t.task_id}*.`);
        await pool.query(`UPDATE tasks SET snooze_until = NULL WHERE task_id = $1 AND org_id = $2`, [t.task_id, org.org_id]);
      }

      // ── 5) DUE-TIME auto (only tasks with NO custom reminder) ──
      const nowMins = hour * 60 + minute;
      const timed = await pool.query(
        `SELECT t.task_id, t.title, t.due_date, t.due_time, m.whatsapp_number
         FROM tasks t JOIN members m ON t.assignee_id = m.member_id
         WHERE t.org_id = $1 AND t.due_date = $2 AND t.due_time IS NOT NULL
           AND t.remind_at IS NULL AND t.remind_before_minutes IS NULL
           AND t.status NOT IN ('completed','deleted')
           AND (t.time_reminded_on IS NULL OR t.time_reminded_on <> $2)
           AND m.status='active' AND COALESCE(m.reminders_enabled,true)=true`, [org.org_id, today]);
      for (const t of timed.rows) {
        const [hh, mm] = String(t.due_time).split(":");
        const taskMins = (parseInt(hh, 10) || 0) * 60 + (parseInt(mm, 10) || 0);
        if (nowMins >= taskMins && nowMins - taskMins < 60) {
          await sendReminderTemplate(t.whatsapp_number, t.task_id, t.title, `${fmtDate(t.due_date)} ${t.due_time}`,
            `⏰ Reminder: ${t.task_id} — ${t.title} is due now (${t.due_time}).\nReply *done ${t.task_id}* or *snooze ${t.task_id}*.`);
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
  console.log("⏰ Reminder scheduler started (digest + custom reminders + snooze + due-time)");
}

module.exports = { startReminders };
