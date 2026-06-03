require("dotenv").config();
const pool = require("./database");
const twilio = require("twilio");
const { understandMessage } = require("./ai");
const { formatWhatsAppNumber, todayInTimezone, toYMD } = require("./utils");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

const BOT_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// ─────────────────────────────────────────
// SEND MESSAGE HELPER
// ─────────────────────────────────────────
async function sendMessage(to, message) {
  try {
    await client.messages.create({ from: BOT_NUMBER, to: to, body: message });
    console.log("✅ Message sent to:", to);
  } catch (error) {
    console.log("❌ Failed to send message:", error.message);
  }
}

// ─────────────────────────────────────────
// FIND MEMBER
// ─────────────────────────────────────────
async function findMember(whatsappNumber) {
  try {
    const result = await pool.query(
      `SELECT m.*, o.org_name, o.timezone, o.org_id, o.task_counter
       FROM members m
       JOIN organizations o ON m.org_id = o.org_id
       WHERE m.whatsapp_number = $1 AND m.status = 'active' AND o.status = 'active'
       LIMIT 1`,
      [whatsappNumber],
    );
    return result.rows[0] || null;
  } catch (error) {
    console.log("Error finding member:", error.message);
    return null;
  }
}

async function getOrgMembers(orgId) {
  const result = await pool.query(
    `SELECT name FROM members WHERE org_id = $1 AND status = 'active'`,
    [orgId],
  );
  return result.rows.map((r) => r.name);
}

async function findMemberByName(name, orgId) {
  const result = await pool.query(
    `SELECT * FROM members
     WHERE org_id = $1 AND LOWER(name) LIKE LOWER($2) AND status = 'active'`,
    [orgId, `${name}%`],
  );
  return result.rows;
}

async function findTaskByReference(orgId, reference) {
  const words = reference.toLowerCase().split(" ").filter((w) => w.length > 2);
  const wordConditions = words
    .map((_, i) => `LOWER(t.title) LIKE LOWER($${i + 4})`)
    .join(" OR ");
  const queryParams = [orgId, reference, `%${reference}%`, ...words.map((w) => `%${w}%`)];

  const result = await pool.query(
    `SELECT t.*,
        own.whatsapp_number as owner_number, own.name as owner_name,
        asn.whatsapp_number as assignee_number, asn.name as assignee_name
     FROM tasks t
     LEFT JOIN members own ON t.owner_id = own.member_id
     LEFT JOIN members asn ON t.assignee_id = asn.member_id
     WHERE t.org_id = $1
     AND (
       LOWER(t.task_id) = LOWER($2)
       OR LOWER(t.title) LIKE LOWER($3)
       ${wordConditions ? `OR ${wordConditions}` : ""}
     )
     AND t.status NOT IN ('completed', 'deleted')
     ORDER BY
       (LOWER(t.task_id) = LOWER($2)) DESC,
       (LOWER(t.title) = LOWER($2)) DESC,
       t.created_at DESC
     LIMIT 1`,
    queryParams,
  );
  return result.rows[0] || null;
}

// ─────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────
async function handleMessage(incomingMessage, senderNumber) {
  console.log("─────────────────────────────");
  console.log("From:", senderNumber, "| Message:", incomingMessage);

  const message = incomingMessage.trim();
  const member = await findMember(senderNumber);

  if (!member) {
    await sendMessage(
      senderNumber,
      "Hi! You're not registered with a KaryaSetu organization. Ask your Organizer to add you.",
    );
    return;
  }

  console.log("Member:", member.name, "| Role:", member.role);
  const lower = message.toLowerCase();

  // ── CONFIG: "Remind before [n] [unit]" ──
  const rb = lower.match(/remind\s+before\s+(\d+)\s*(week|weeks|day|days|hour|hours|minute|minutes|min|mins)/);
  if (rb) {
    const n = parseInt(rb[1], 10);
    const unit = rb[2];
    if (unit.startsWith("week") || unit.startsWith("day")) {
      const days = unit.startsWith("week") ? n * 7 : n;
      await pool.query(
        `UPDATE members SET reminder_lead_days = $1, updated_at = NOW() WHERE member_id = $2`,
        [days, member.member_id],
      );
      await sendMessage(
        senderNumber,
        `Done ✅ I'll remind you ${n} ${unit} before a task's due date (at 9 AM).`,
      );
    } else {
      await sendMessage(
        senderNumber,
        "Right now I can remind you a number of *days* or *weeks* before the due date (tasks don't have a time-of-day yet). Try: remind before 1 day.",
      );
    }
    return;
  }

  // ── CONFIG: Enable / Disable reminders ──
  if (lower.includes("reminder")) {
    if (/\b(disable|stop|off|no|cancel)\b/.test(lower)) {
      await pool.query(
        `UPDATE members SET reminders_enabled = false, updated_at = NOW() WHERE member_id = $1`,
        [member.member_id],
      );
      await sendMessage(senderNumber, "Reminders disabled. Send 'Enable reminders' to turn them back on.");
      return;
    }
    if (/\b(enable|start|on|yes)\b/.test(lower)) {
      await pool.query(
        `UPDATE members SET reminders_enabled = true, updated_at = NOW() WHERE member_id = $1`,
        [member.member_id],
      );
      await sendMessage(senderNumber, "Reminders enabled ✅");
      return;
    }
  }

  // ── Remove assignment / unassign (handled before AI) ──
  if (/(remove\s+assignment|unassign)/i.test(lower)) {
    const ref = message
      .replace(/remove\s+assignment/gi, "")
      .replace(/unassign/gi, "")
      .replace(/\bfrom\b.*$/i, "")
      .trim();
    await handleUnassignTask(senderNumber, member, ref);
    return;
  }

  const orgMembers = await getOrgMembers(member.org_id);
  const today = todayInTimezone(member.timezone);
  const ai = await understandMessage(message, member.name, orgMembers, today);
  console.log("AI intent:", ai.intent, "| Confidence:", ai.confidence);

  if (ai.clarification_needed && ai.clarification_question) {
    await sendMessage(senderNumber, ai.clarification_question);
    return;
  }

  switch (ai.intent) {
    case "help":
      await handleHelp(senderNumber, member);
      break;
    case "list_my_tasks":
      await handleMyTasks(senderNumber, member);
      break;
    case "list_assigned_tasks":
      await handleDelegatedTasks(senderNumber, member);
      break;
    case "tasks_assigned_to":
      if (member.role !== "organizer")
        await sendMessage(senderNumber, "Sorry, only the Organizer can view another member's tasks.");
      else await handleTasksAssignedTo(senderNumber, member, ai);
      break;
    case "list_all_tasks":
      if (member.role !== "organizer")
        await sendMessage(senderNumber, "Sorry, only the Organizer can view all tasks.");
      else await handleAllTasks(senderNumber, member);
      break;
    case "list_overdue_tasks":
      await handleOverdueTasks(senderNumber, member);
      break;
    case "list_members":
      if (member.role !== "organizer")
        await sendMessage(senderNumber, "Sorry, only the Organizer can list users.");
      else await handleListMembers(senderNumber, member);
      break;
    case "create_task":
      await handleCreateTask(senderNumber, member, ai);
      break;
    case "complete_task":
      await handleCompleteTask(senderNumber, member, ai);
      break;
    case "delete_task":
      await handleDeleteTask(senderNumber, member, ai);
      break;
    case "update_task":
      await handleUpdateTask(senderNumber, member, ai);
      break;
    case "reassign_task":
      await handleReassignTask(senderNumber, member, ai);
      break;
    case "unassign_task":
      await handleUnassignTask(senderNumber, member, ai.task_reference);
      break;
    case "transfer_ownership":
      await handleTransferOwnership(senderNumber, member, ai);
      break;
    case "add_member":
      if (member.role !== "organizer")
        await sendMessage(senderNumber, "Sorry, only the Organizer can add users.");
      else await handleAddMember(senderNumber, member, ai);
      break;
    case "remove_member":
      if (member.role !== "organizer")
        await sendMessage(senderNumber, "Sorry, only the Organizer can remove users.");
      else await handleRemoveMember(senderNumber, member, ai);
      break;
    default:
      await sendMessage(
        senderNumber,
        `Hi ${member.name}! I didn't understand that.\n\nSend *Help* to see all available commands.`,
      );
  }
}

// ─────────────────────────────────────────
// HELP
// ─────────────────────────────────────────
async function handleHelp(senderNumber, member) {
  let t = `*KaryaSetu Commands* 📋\n\n`;
  t += `*Tasks related:*\n`;
  t += `• List tasks\n`;
  t += `• Delegated tasks\n`;
  t += `• Overdue tasks\n`;
  t += `• Add task [description]\n`;
  t += `• Update [task] [new description]\n`;
  t += `• Complete [task name or id]\n`;
  t += `• Delete [task id]\n`;
  t += `• Assign task [task] to [user]\n`;
  t += `• Remove assignment [task]\n\n`;
  t += `*Configuration:*\n`;
  t += `• Enable reminders\n`;
  t += `• Disable reminders\n`;
  t += `• Remind before [n days / weeks]\n`;
  if (member.role === "organizer") {
    t += `\n*Organizer only:*\n`;
    t += `• All tasks\n`;
    t += `• Tasks assigned to [name]\n`;
    t += `• List users\n`;
    t += `• Add member [name] [number]\n`;
    t += `• Remove member [name]\n`;
  }
  await sendMessage(senderNumber, t);
}

// ─────────────────────────────────────────
// CREATE TASK (instant — no confirmation, default assign to self)
// ─────────────────────────────────────────
async function handleCreateTask(senderNumber, member, ai) {
  const c = await pool.connect();
  try {
    if (!ai.task_title) {
      await sendMessage(senderNumber, "What should I call this task?");
      c.release();
      return;
    }

    let assigneeId = member.member_id;
    let assigneeName = member.name;
    let assigneeNumber = member.whatsapp_number;

    if (ai.assignee_name) {
      const matches = await findMemberByName(ai.assignee_name, member.org_id);
      if (matches.length === 0) {
        await sendMessage(
          senderNumber,
          `${ai.assignee_name} is not a user of ${member.org_name}. Assigning to you instead.`,
        );
      } else if (matches.length > 1) {
        let msg = `Multiple users named ${ai.assignee_name}. Which one?\n\n`;
        matches.forEach((m, i) => { msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`; });
        await sendMessage(senderNumber, msg);
        c.release();
        return;
      } else {
        assigneeId = matches[0].member_id;
        assigneeName = matches[0].name;
        assigneeNumber = matches[0].whatsapp_number;
      }
    }

    await c.query("BEGIN");
    const cr = await c.query(
      `UPDATE organizations SET task_counter = task_counter + 1 WHERE org_id = $1 RETURNING task_counter`,
      [member.org_id],
    );
    const taskId = `KS-${String(cr.rows[0].task_counter).padStart(3, "0")}`;
    await c.query(
      `INSERT INTO tasks (task_id, org_id, title, owner_id, creator_id, assignee_id, due_date, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [taskId, member.org_id, ai.task_title, member.member_id, member.member_id,
       assigneeId, ai.due_date || null, ai.priority || "normal"],
    );
    await c.query("COMMIT");

    const dueTxt = ai.due_date ? new Date(ai.due_date).toDateString() : "No due date";
    await sendMessage(
      senderNumber,
      `Added ✅ ${taskId}\n📋 ${ai.task_title}\n👤 Assigned to: ${assigneeName}\n📅 Due: ${dueTxt}`,
    );

    if (assigneeId !== member.member_id && assigneeNumber) {
      await sendMessage(
        assigneeNumber,
        `📋 New task assigned by ${member.name}:\n${taskId} — ${ai.task_title}${ai.due_date ? `\n📅 Due: ${dueTxt}` : ""}`,
      );
    }
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    console.log("Error creating task:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  } finally {
    c.release();
  }
}

// ─────────────────────────────────────────
// COMPLETE TASK (instant)
// ─────────────────────────────────────────
async function handleCompleteTask(senderNumber, member, ai) {
  try {
    if (!ai.task_reference) {
      await sendMessage(senderNumber, "Which task do you want to complete? Mention the task name or id.");
      return;
    }
    const task = await findTaskByReference(member.org_id, ai.task_reference);
    if (!task) {
      await sendMessage(senderNumber, `I couldn't find a task matching "${ai.task_reference}".`);
      return;
    }
    if (task.assignee_id !== member.member_id && task.owner_id !== member.member_id && member.role !== "organizer") {
      await sendMessage(senderNumber, `${task.task_id} isn't yours, so you can't complete it.`);
      return;
    }
    await pool.query(
      `UPDATE tasks SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE task_id = $1 AND org_id = $2`,
      [task.task_id, member.org_id],
    );
    await sendMessage(senderNumber, `Great work! ✅ ${task.task_id} marked complete.`);
    if (task.owner_id !== member.member_id && task.owner_number) {
      await sendMessage(task.owner_number, `✅ ${task.task_id} — ${task.title} has been completed by ${member.name}.`);
    }
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// UPDATE TASK (instant — due date / priority / description)
// ─────────────────────────────────────────
async function handleUpdateTask(senderNumber, member, ai) {
  try {
    if (!ai.task_reference) {
      await sendMessage(senderNumber, "Which task do you want to update? Example: Update KS-001 new description");
      return;
    }
    const task = await findTaskByReference(member.org_id, ai.task_reference);
    if (!task) {
      await sendMessage(senderNumber, `I couldn't find that task.`);
      return;
    }
    if (task.owner_id !== member.member_id && member.role !== "organizer") {
      await sendMessage(senderNumber, "Only the task owner or an Organizer can update a task.");
      return;
    }

    const newTitle = ai.task_title && ai.task_title.toLowerCase() !== String(task.task_id).toLowerCase()
      ? ai.task_title : null;
    const newDue = ai.due_date || null;
    const newPriority = ["high", "normal", "low"].includes(ai.priority) ? ai.priority : null;

    if (!newTitle && !newDue && !newPriority) {
      await sendMessage(senderNumber, `What should I change on ${task.task_id}? You can update the description, due date, or priority.`);
      return;
    }

    const parts = [];
    if (newTitle) { await pool.query(`UPDATE tasks SET title = $1, updated_at = NOW() WHERE task_id = $2 AND org_id = $3`, [newTitle, task.task_id, member.org_id]); parts.push(`description → "${newTitle}"`); }
    if (newDue) { await pool.query(`UPDATE tasks SET due_date = $1, updated_at = NOW() WHERE task_id = $2 AND org_id = $3`, [newDue, task.task_id, member.org_id]); parts.push(`due date → ${new Date(newDue).toDateString()}`); }
    if (newPriority) { await pool.query(`UPDATE tasks SET priority = $1, updated_at = NOW() WHERE task_id = $2 AND org_id = $3`, [newPriority, task.task_id, member.org_id]); parts.push(`priority → ${newPriority}`); }

    await sendMessage(senderNumber, `Updated ✅ ${task.task_id} — ${parts.join(", ")}.`);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// REASSIGN / ASSIGN TASK (instant)
// ─────────────────────────────────────────
async function handleReassignTask(senderNumber, member, ai) {
  try {
    if (!ai.task_reference) {
      await sendMessage(senderNumber, "Which task? Example: Assign task KS-001 to Amit");
      return;
    }
    const newName = ai.assignee_name || ai.member_name;
    if (!newName) {
      await sendMessage(senderNumber, "Who should I assign it to? Example: Assign task KS-001 to Amit");
      return;
    }
    const task = await findTaskByReference(member.org_id, ai.task_reference);
    if (!task) { await sendMessage(senderNumber, `I couldn't find that task.`); return; }
    if (task.owner_id !== member.member_id && member.role !== "organizer") {
      await sendMessage(senderNumber, "Only the task owner or an Organizer can assign a task.");
      return;
    }
    const matches = await findMemberByName(newName, member.org_id);
    if (matches.length === 0) { await sendMessage(senderNumber, `${newName} is not a user of ${member.org_name}.`); return; }
    if (matches.length > 1) {
      let msg = `Multiple users named ${newName}. Which one?\n\n`;
      matches.forEach((m, i) => { msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`; });
      await sendMessage(senderNumber, msg);
      return;
    }
    const na = matches[0];
    await pool.query(`UPDATE tasks SET assignee_id = $1, updated_at = NOW() WHERE task_id = $2 AND org_id = $3`, [na.member_id, task.task_id, member.org_id]);
    await sendMessage(senderNumber, `Done ✅ ${task.task_id} assigned to ${na.name}.`);
    if (na.whatsapp_number) {
      await sendMessage(na.whatsapp_number, `📋 New task assigned by ${member.name}:\n${task.task_id} — ${task.title}`);
    }
    if (task.assignee_id && task.assignee_id !== na.member_id && task.assignee_number) {
      await sendMessage(task.assignee_number, `${task.task_id} — ${task.title} has been reassigned to ${na.name}.`);
    }
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// REMOVE ASSIGNMENT (unassign — instant)
// ─────────────────────────────────────────
async function handleUnassignTask(senderNumber, member, reference) {
  try {
    if (!reference) {
      await sendMessage(senderNumber, "Which task? Example: Remove assignment KS-001");
      return;
    }
    const task = await findTaskByReference(member.org_id, reference);
    if (!task) { await sendMessage(senderNumber, `I couldn't find that task.`); return; }
    if (task.owner_id !== member.member_id && member.role !== "organizer") {
      await sendMessage(senderNumber, "Only the task owner or an Organizer can change the assignment.");
      return;
    }
    await pool.query(`UPDATE tasks SET assignee_id = NULL, updated_at = NOW() WHERE task_id = $1 AND org_id = $2`, [task.task_id, member.org_id]);
    await sendMessage(senderNumber, `Done ✅ ${task.task_id} is now unassigned.`);
    if (task.assignee_id && task.assignee_id !== member.member_id && task.assignee_number) {
      await sendMessage(task.assignee_number, `${task.task_id} — ${task.title} has been unassigned from you.`);
    }
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// TRANSFER OWNERSHIP (instant)
// ─────────────────────────────────────────
async function handleTransferOwnership(senderNumber, member, ai) {
  try {
    if (!ai.task_reference) { await sendMessage(senderNumber, "Which task? Example: Transfer KS-001 to Priya"); return; }
    const newName = ai.assignee_name || ai.member_name;
    if (!newName) { await sendMessage(senderNumber, "Who should become the owner? Example: Transfer KS-001 to Priya"); return; }
    const task = await findTaskByReference(member.org_id, ai.task_reference);
    if (!task) { await sendMessage(senderNumber, `I couldn't find that task.`); return; }
    if (task.owner_id !== member.member_id && member.role !== "organizer") {
      await sendMessage(senderNumber, "Only the current owner or an Organizer can transfer ownership.");
      return;
    }
    const matches = await findMemberByName(newName, member.org_id);
    if (matches.length === 0) { await sendMessage(senderNumber, `${newName} is not a user of ${member.org_name}.`); return; }
    if (matches.length > 1) {
      let msg = `Multiple users named ${newName}. Which one?\n\n`;
      matches.forEach((m, i) => { msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`; });
      await sendMessage(senderNumber, msg);
      return;
    }
    const no = matches[0];
    await pool.query(`UPDATE tasks SET owner_id = $1, updated_at = NOW() WHERE task_id = $2 AND org_id = $3`, [no.member_id, task.task_id, member.org_id]);
    await sendMessage(senderNumber, `Done ✅ ${no.name} is now the owner of ${task.task_id}.`);
    if (no.whatsapp_number) {
      await sendMessage(no.whatsapp_number, `📋 ${member.name} has transferred ownership of ${task.task_id} — ${task.title} to you.`);
    }
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// DELETE TASK (kept with confirmation — destructive)
// ─────────────────────────────────────────
async function handleDeleteTask(senderNumber, member, ai) {
  try {
    if (!ai.task_reference) { await sendMessage(senderNumber, "Which task do you want to delete? Mention the task id."); return; }
    const task = await findTaskByReference(member.org_id, ai.task_reference);
    if (!task) { await sendMessage(senderNumber, `I couldn't find that task.`); return; }
    if (task.owner_id !== member.member_id && member.role !== "organizer") {
      await sendMessage(senderNumber, "You can only delete tasks you own.");
      return;
    }
    await sendMessage(senderNumber, `⚠️ Delete ${task.task_id} (${task.title})? This cannot be undone. Reply 'yes' to confirm.`);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO pending_actions (org_id, member_id, action_type, action_data, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [member.org_id, member.member_id, "delete_task", JSON.stringify({
        task_id: task.task_id, task_title: task.title,
        assignee_id: task.assignee_id, assignee_number: task.assignee_number,
      }), expiresAt],
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// CONFIRMATIONS — only delete + remove member now
// ─────────────────────────────────────────
async function handleConfirmation(senderNumber, member, message) {
  const confirmed = ["yes", "confirm", "1"].includes(message.toLowerCase());
  const denied = ["no", "cancel", "2"].includes(message.toLowerCase());
  if (!confirmed && !denied) return false;

  const result = await pool.query(
    `SELECT * FROM pending_actions WHERE member_id = $1 AND status = 'pending'
     AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
    [member.member_id],
  );
  if (result.rows.length === 0) return false;
  const action = result.rows[0];

  if (denied) {
    await pool.query(`UPDATE pending_actions SET status = 'cancelled' WHERE action_id = $1`, [action.action_id]);
    await sendMessage(senderNumber, "Action cancelled.");
    return true;
  }
  if (action.action_type === "delete_task") {
    await executeDeleteTask(senderNumber, member, action);
  } else if (action.action_type === "remove_member") {
    await executeRemoveMember(senderNumber, member, action);
  }
  return true;
}

async function executeDeleteTask(senderNumber, member, action) {
  try {
    const data = action.action_data;
    await pool.query(`UPDATE tasks SET status = 'deleted', updated_at = NOW() WHERE task_id = $1 AND org_id = $2`, [data.task_id, member.org_id]);
    await pool.query(`UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`, [action.action_id]);
    await sendMessage(senderNumber, `${data.task_id} has been deleted.`);
    if (data.assignee_id && data.assignee_id !== member.member_id && data.assignee_number) {
      await sendMessage(data.assignee_number, `${data.task_id} — ${data.task_title} has been deleted by ${member.name}.`);
    }
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// ADD MEMBER (instant)
// ─────────────────────────────────────────
async function handleAddMember(senderNumber, member, ai) {
  try {
    if (!ai.member_name || !ai.phone_number) {
      await sendMessage(senderNumber, "Please use: Add member [name] [number]\nExample: Add member Priya +919876543210");
      return;
    }
    const formattedNumber = formatWhatsAppNumber(ai.phone_number);
    if (!formattedNumber) {
      await sendMessage(senderNumber, `That doesn't look like a valid phone number. Example: Add member Priya +919876543210`);
      return;
    }
    const existing = await pool.query(
      `SELECT * FROM members WHERE org_id = $1 AND whatsapp_number = $2`,
      [member.org_id, formattedNumber],
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0].status === "active") {
        await sendMessage(senderNumber, `${ai.member_name} is already a user of ${member.org_name}.`);
        return;
      }
      await pool.query(
        `UPDATE members SET status = 'active', name = $1, role = 'member', updated_at = NOW() WHERE member_id = $2`,
        [ai.member_name, existing.rows[0].member_id],
      );
    } else {
      await pool.query(
        `INSERT INTO members (org_id, name, whatsapp_number, role) VALUES ($1, $2, $3, 'member')`,
        [member.org_id, ai.member_name, formattedNumber],
      );
    }
    await sendMessage(senderNumber, `Added ✅ ${ai.member_name} is now a user of ${member.org_name}.`);
    await sendMessage(
      formattedNumber,
      `Hi ${ai.member_name}! You've been added to ${member.org_name} on KaryaSetu.\n\nSend *Help* to see what you can do.`,
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// REMOVE MEMBER (kept with confirmation)
// ─────────────────────────────────────────
async function handleRemoveMember(senderNumber, member, ai) {
  try {
    if (!ai.member_name) { await sendMessage(senderNumber, "Who do you want to remove? Example: Remove member Priya"); return; }
    const matches = await findMemberByName(ai.member_name, member.org_id);
    if (matches.length === 0) { await sendMessage(senderNumber, `${ai.member_name} is not a user of ${member.org_name}.`); return; }
    if (matches.length > 1) {
      let msg = `Multiple users named ${ai.member_name}. Reply with the full number to remove:\n\n`;
      matches.forEach((m, i) => { msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`; });
      await sendMessage(senderNumber, msg);
      return;
    }
    const tm = matches[0];
    const tc = await pool.query(
      `SELECT COUNT(*) FROM tasks WHERE owner_id = $1 AND status NOT IN ('completed', 'deleted')`,
      [tm.member_id],
    );
    const count = parseInt(tc.rows[0].count);
    await sendMessage(senderNumber, `Remove ${tm.name} from ${member.org_name}? Their ${count} owned tasks will be transferred to you. (yes/no)`);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO pending_actions (org_id, member_id, action_type, action_data, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [member.org_id, member.member_id, "remove_member", JSON.stringify({
        target_member_id: tm.member_id, target_member_name: tm.name,
        target_member_number: tm.whatsapp_number, task_count: count,
      }), expiresAt],
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

async function executeRemoveMember(senderNumber, member, action) {
  try {
    const data = action.action_data;
    await pool.query(`UPDATE tasks SET owner_id = $1, updated_at = NOW() WHERE owner_id = $2 AND status NOT IN ('completed', 'deleted')`, [member.member_id, data.target_member_id]);
    await pool.query(`UPDATE tasks SET assignee_id = $1, updated_at = NOW() WHERE assignee_id = $2 AND status NOT IN ('completed', 'deleted')`, [member.member_id, data.target_member_id]);
    await pool.query(`UPDATE members SET status = 'inactive', updated_at = NOW() WHERE member_id = $1`, [data.target_member_id]);
    await pool.query(`UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`, [action.action_id]);
    await sendMessage(senderNumber, `${data.target_member_name} has been removed. ${data.task_count} tasks transferred to you.`);
    await sendMessage(data.target_member_number, `You have been removed from ${member.org_name} on KaryaSetu.`);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// LIST: "List tasks" = tasks I OWN (per CTO)
// ─────────────────────────────────────────
async function handleMyTasks(senderNumber, member) {
  try {
    const result = await pool.query(
      `SELECT t.*, asn.name as assignee_name FROM tasks t
       LEFT JOIN members asn ON t.assignee_id = asn.member_id
       WHERE t.owner_id = $1 AND t.status NOT IN ('completed', 'deleted')
       ORDER BY t.due_date ASC NULLS LAST LIMIT 5`,
      [member.member_id],
    );
    if (result.rows.length === 0) {
      await sendMessage(senderNumber, `${member.name}, you own no open tasks 🎉`);
      return;
    }
    const today = todayInTimezone(member.timezone);
    let response = `*Your tasks (${result.rows.length}):*\n\n`;
    for (const task of result.rows) {
      const due = task.due_date ? new Date(task.due_date).toDateString() : "No due date";
      const overdue = task.due_date && toYMD(task.due_date) < today ? "⚠️ Overdue" : "● Open";
      response += `${task.task_id} | ${task.title} | ${task.assignee_name || "Unassigned"} | Due: ${due} | ${overdue}\n`;
    }
    await sendMessage(senderNumber, response);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// "Delegated tasks" = I own, assigned to someone else
async function handleDelegatedTasks(senderNumber, member) {
  try {
    const result = await pool.query(
      `SELECT t.*, m.name as assignee_name FROM tasks t
       LEFT JOIN members m ON t.assignee_id = m.member_id
       WHERE t.owner_id = $1 AND t.assignee_id IS NOT NULL AND t.assignee_id != $1
       AND t.status NOT IN ('completed', 'deleted')
       ORDER BY t.due_date ASC NULLS LAST LIMIT 5`,
      [member.member_id],
    );
    if (result.rows.length === 0) {
      await sendMessage(senderNumber, `You haven't delegated any open tasks.`);
      return;
    }
    let response = `*Delegated tasks (${result.rows.length}):*\n\n`;
    for (const task of result.rows) {
      const due = task.due_date ? new Date(task.due_date).toDateString() : "No due date";
      response += `${task.task_id} | ${task.title} | ${task.assignee_name} | Due: ${due}\n`;
    }
    await sendMessage(senderNumber, response);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

async function handleAllTasks(senderNumber, member) {
  try {
    const result = await pool.query(
      `SELECT t.*, m.name as assignee_name FROM tasks t
       LEFT JOIN members m ON t.assignee_id = m.member_id
       WHERE t.org_id = $1 AND t.status NOT IN ('completed', 'deleted')
       ORDER BY t.due_date ASC NULLS LAST LIMIT 5`,
      [member.org_id],
    );
    if (result.rows.length === 0) { await sendMessage(senderNumber, `No open tasks in ${member.org_name}.`); return; }
    let response = `*All open tasks in ${member.org_name} (${result.rows.length}):*\n\n`;
    for (const task of result.rows) {
      const due = task.due_date ? new Date(task.due_date).toDateString() : "No due date";
      response += `${task.task_id} | ${task.title} | ${task.assignee_name || "Unassigned"} | Due: ${due}\n`;
    }
    await sendMessage(senderNumber, response);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

async function handleOverdueTasks(senderNumber, member) {
  try {
    const today = todayInTimezone(member.timezone);
    let query, params;
    if (member.role === "organizer") {
      query = `SELECT t.*, m.name as assignee_name FROM tasks t
               LEFT JOIN members m ON t.assignee_id = m.member_id
               WHERE t.org_id = $1 AND t.due_date < $2 AND t.status NOT IN ('completed', 'deleted')
               ORDER BY t.due_date ASC LIMIT 5`;
      params = [member.org_id, today];
    } else {
      query = `SELECT * FROM tasks WHERE owner_id = $1 AND due_date < $2
               AND status NOT IN ('completed', 'deleted') ORDER BY due_date ASC LIMIT 5`;
      params = [member.member_id, today];
    }
    const result = await pool.query(query, params);
    if (result.rows.length === 0) { await sendMessage(senderNumber, `No overdue tasks. Great work! 🎉`); return; }
    let response = `*Overdue tasks (${result.rows.length}):*\n\n`;
    for (const task of result.rows) {
      response += `⚠️ ${task.task_id} | ${task.title} | Due: ${new Date(task.due_date).toDateString()}\n`;
    }
    await sendMessage(senderNumber, response);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

async function handleListMembers(senderNumber, member) {
  try {
    const result = await pool.query(
      `SELECT m.*, COUNT(t.task_id) as open_task_count FROM members m
       LEFT JOIN tasks t ON t.assignee_id = m.member_id AND t.status NOT IN ('completed', 'deleted')
       WHERE m.org_id = $1 AND m.status = 'active'
       GROUP BY m.member_id ORDER BY m.created_at ASC`,
      [member.org_id],
    );
    let response = `*${member.org_name} users (${result.rows.length}):*\n\n`;
    result.rows.forEach((m, i) => {
      response += `${i + 1}. ${m.name} — ${m.role} — ${m.open_task_count} open tasks\n`;
    });
    await sendMessage(senderNumber, response);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

async function handleTasksAssignedTo(senderNumber, member, ai) {
  try {
    const targetName = ai.member_name || ai.assignee_name;
    if (!targetName) { await sendMessage(senderNumber, "Whose tasks? Example: Tasks assigned to Priya"); return; }
    const matches = await findMemberByName(targetName, member.org_id);
    if (matches.length === 0) { await sendMessage(senderNumber, `${targetName} is not a user of ${member.org_name}.`); return; }
    if (matches.length > 1) {
      let msg = `Multiple users named ${targetName}. Which one?\n\n`;
      matches.forEach((m, i) => { msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`; });
      await sendMessage(senderNumber, msg);
      return;
    }
    const target = matches[0];
    const result = await pool.query(
      `SELECT * FROM tasks WHERE assignee_id = $1 AND status NOT IN ('completed', 'deleted')
       ORDER BY due_date ASC NULLS LAST LIMIT 5`,
      [target.member_id],
    );
    if (result.rows.length === 0) { await sendMessage(senderNumber, `${target.name} has no open tasks.`); return; }
    let response = `*Tasks assigned to ${target.name} (${result.rows.length}):*\n\n`;
    for (const task of result.rows) {
      const due = task.due_date ? new Date(task.due_date).toDateString() : "No due date";
      response += `${task.task_id} | ${task.title} | Due: ${due}\n`;
    }
    await sendMessage(senderNumber, response);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

module.exports = { handleMessage, handleConfirmation, findMember };
