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
    await client.messages.create({
      from: BOT_NUMBER,
      to: to,
      body: message,
    });
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
       WHERE m.whatsapp_number = $1
       AND m.status = 'active'
       AND o.status = 'active'
       LIMIT 1`,
      [whatsappNumber],
    );
    return result.rows[0] || null;
  } catch (error) {
    console.log("Error finding member:", error.message);
    return null;
  }
}

// ─────────────────────────────────────────
// GET ALL ORG MEMBERS — for AI context
// ─────────────────────────────────────────
async function getOrgMembers(orgId) {
  const result = await pool.query(
    `SELECT name FROM members 
     WHERE org_id = $1 AND status = 'active'`,
    [orgId],
  );
  return result.rows.map((r) => r.name);
}

// ─────────────────────────────────────────
// FIND MEMBER BY NAME — for assignee resolution
// ─────────────────────────────────────────
async function findMemberByName(name, orgId) {
  const result = await pool.query(
    `SELECT * FROM members 
     WHERE org_id = $1 
     AND LOWER(name) LIKE LOWER($2)
     AND status = 'active'`,
    [orgId, `${name}%`],
  );
  return result.rows;
}

// ─────────────────────────────────────────
// FIND TASK BY REFERENCE — used by complete/delete/update/reassign/transfer
// ─────────────────────────────────────────
async function findTaskByReference(orgId, reference) {
  const words = reference
    .toLowerCase()
    .split(" ")
    .filter((w) => w.length > 2);

  const wordConditions = words
    .map((_, i) => `LOWER(t.title) LIKE LOWER($${i + 4})`)
    .join(" OR ");

  const queryParams = [
    orgId,
    reference,
    `%${reference}%`,
    ...words.map((w) => `%${w}%`),
  ];

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
  console.log("From:", senderNumber);
  console.log("Message:", incomingMessage);

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

  // ── Reminder opt-out / opt-in (handled before the AI) ──
  const lower = message.toLowerCase();
  if (lower.includes("reminder") && /\b(stop|off|disable|no)\b/.test(lower)) {
    await pool.query(
      `UPDATE members SET reminders_enabled = false, updated_at = NOW() WHERE member_id = $1`,
      [member.member_id],
    );
    await sendMessage(
      senderNumber,
      "Okay, I won't send you due-date reminders anymore. Send 'start reminders' to turn them back on.",
    );
    return;
  }
  if (lower.includes("reminder") && /\b(start|on|enable)\b/.test(lower)) {
    await pool.query(
      `UPDATE members SET reminders_enabled = true, updated_at = NOW() WHERE member_id = $1`,
      [member.member_id],
    );
    await sendMessage(
      senderNumber,
      "Done — I'll send you due-date reminders again.",
    );
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
      await handleTasksIAssigned(senderNumber, member);
      break;

    case "tasks_assigned_to":
      if (member.role !== "organizer") {
        await sendMessage(
          senderNumber,
          "Sorry, only the Organizer can view another member's tasks.",
        );
      } else {
        await handleTasksAssignedTo(senderNumber, member, ai);
      }
      break;

    case "list_all_tasks":
      if (member.role !== "organizer") {
        await sendMessage(
          senderNumber,
          "Sorry, only the Organizer can view all tasks.",
        );
      } else {
        await handleAllTasks(senderNumber, member);
      }
      break;

    case "list_overdue_tasks":
      await handleOverdueTasks(senderNumber, member);
      break;

    case "list_members":
      if (member.role !== "organizer") {
        await sendMessage(
          senderNumber,
          "Sorry, only the Organizer can list members.",
        );
      } else {
        await handleListMembers(senderNumber, member);
      }
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

    case "add_member":
      if (member.role !== "organizer") {
        await sendMessage(
          senderNumber,
          "Sorry, only the Organizer can add members.",
        );
      } else {
        await handleAddMember(senderNumber, member, ai);
      }
      break;

    case "remove_member":
      if (member.role !== "organizer") {
        await sendMessage(
          senderNumber,
          "Sorry, only the Organizer can remove members.",
        );
      } else {
        await handleRemoveMember(senderNumber, member, ai);
      }
      break;

    case "update_task":
      await handleUpdateTask(senderNumber, member, ai);
      break;

    case "reassign_task":
      await handleReassignTask(senderNumber, member, ai);
      break;

    case "transfer_ownership":
      await handleTransferOwnership(senderNumber, member, ai);
      break;

    default:
      await sendMessage(
        senderNumber,
        `Hi ${member.name}! I didn't understand that.\n\nSend *help* to see all available commands.`,
      );
  }
}

// ─────────────────────────────────────────
// HELP
// ─────────────────────────────────────────
async function handleHelp(senderNumber, member) {
  let helpText = `*KaryaSetu Commands* 📋\n\n`;
  helpText += `*Tasks:*\n`;
  helpText += `• my tasks\n`;
  helpText += `• tasks i assigned\n`;
  helpText += `• overdue tasks\n`;
  helpText += `• add task [description]\n`;
  helpText += `• complete [task name or ID]\n`;
  helpText += `• delete [task ID]\n`;
  helpText += `• change due date of [task] to [date]\n`;
  helpText += `• reassign [task] to [name]\n`;
  helpText += `• transfer [task] to [name]\n`;
  helpText += `• stop reminders / start reminders\n\n`;

  if (member.role === "organizer") {
    helpText += `*Organizer only:*\n`;
    helpText += `• all tasks\n`;
    helpText += `• tasks assigned to [name]\n`;
    helpText += `• list members\n`;
    helpText += `• add member [name] [number]\n`;
    helpText += `• remove member [name]\n`;
  }

  await sendMessage(senderNumber, helpText);
}

// ─────────────────────────────────────────
// CREATE TASK
// ─────────────────────────────────────────
async function handleCreateTask(senderNumber, member, ai) {
  try {
    if (!ai.task_title) {
      await sendMessage(senderNumber, "What should I call this task?");
      return;
    }

    let assigneeId = member.member_id;
    let assigneeName = member.name;

    if (ai.assignee_name) {
      const matches = await findMemberByName(ai.assignee_name, member.org_id);

      if (matches.length === 0) {
        await sendMessage(
          senderNumber,
          `${ai.assignee_name} is not a member of ${member.org_name}. Task will be assigned to you instead.`,
        );
      } else if (matches.length > 1) {
        let msg = `Multiple members named ${ai.assignee_name}. Which one?\n\n`;
        matches.forEach((m, i) => {
          msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`;
        });
        await sendMessage(senderNumber, msg);
        return;
      } else {
        assigneeId = matches[0].member_id;
        assigneeName = matches[0].name;
      }
    }

    const dueDisplay = ai.due_date
      ? new Date(ai.due_date).toDateString()
      : "No due date";

    const confirmMsg =
      `Creating this task:\n\n` +
      `📋 ${ai.task_title}\n` +
      `👤 Assigned to: ${assigneeName}\n` +
      `📅 Due: ${dueDisplay}\n` +
      `⚡ Priority: ${ai.priority || "normal"}\n\n` +
      `Confirm? (yes / no)`;

    await sendMessage(senderNumber, confirmMsg);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO pending_actions 
       (org_id, member_id, action_type, action_data, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        member.org_id,
        member.member_id,
        "create_task",
        JSON.stringify({
          title: ai.task_title,
          assignee_id: assigneeId,
          assignee_name: assigneeName,
          due_date: ai.due_date,
          priority: ai.priority || "normal",
        }),
        expiresAt,
      ],
    );
  } catch (error) {
    console.log("Error creating task:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// HANDLE YES/NO CONFIRMATIONS
// ─────────────────────────────────────────
async function handleConfirmation(senderNumber, member, message) {
  const confirmed = ["yes", "confirm", "1"].includes(message.toLowerCase());
  const denied = ["no", "cancel", "2"].includes(message.toLowerCase());

  if (!confirmed && !denied) return false;

  const result = await pool.query(
    `SELECT * FROM pending_actions
     WHERE member_id = $1
     AND status = 'pending'
     AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [member.member_id],
  );

  if (result.rows.length === 0) return false;

  const action = result.rows[0];

  if (denied) {
    await pool.query(
      `UPDATE pending_actions SET status = 'cancelled' WHERE action_id = $1`,
      [action.action_id],
    );
    await sendMessage(senderNumber, "Action cancelled.");
    return true;
  }

  if (action.action_type === "create_task") {
    await executeCreateTask(senderNumber, member, action);
  } else if (action.action_type === "delete_task") {
    await executeDeleteTask(senderNumber, member, action);
  } else if (action.action_type === "complete_task") {
    await executeCompleteTask(senderNumber, member, action);
  } else if (action.action_type === "remove_member") {
    await executeRemoveMember(senderNumber, member, action);
  } else if (action.action_type === "update_task") {
    await executeUpdateTask(senderNumber, member, action);
  } else if (action.action_type === "reassign_task") {
    await executeReassignTask(senderNumber, member, action);
  } else if (action.action_type === "transfer_ownership") {
    await executeTransferOwnership(senderNumber, member, action);
  }

  return true;
}

// ─────────────────────────────────────────
// EXECUTE CREATE TASK — after confirmation
// ─────────────────────────────────────────
async function executeCreateTask(senderNumber, member, action) {
  const client = await pool.connect();
  try {
    const data = action.action_data;

    await client.query("BEGIN");

    const counterResult = await client.query(
      `UPDATE organizations SET task_counter = task_counter + 1
       WHERE org_id = $1 RETURNING task_counter`,
      [member.org_id],
    );
    const taskId = `KS-${String(counterResult.rows[0].task_counter).padStart(3, "0")}`;

    await client.query(
      `INSERT INTO tasks
       (task_id, org_id, title, owner_id, creator_id, assignee_id, due_date, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        taskId,
        member.org_id,
        data.title,
        member.member_id,
        member.member_id,
        data.assignee_id,
        data.due_date || null,
        data.priority,
      ],
    );

    await client.query(
      `UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`,
      [action.action_id],
    );

    await client.query("COMMIT");

    await sendMessage(
      senderNumber,
      `Done ✅ ${taskId} created.\n\n📋 ${data.title}\n👤 Assigned to: ${data.assignee_name}\n📅 Due: ${data.due_date ? new Date(data.due_date).toDateString() : "No due date"}`,
    );

    if (data.assignee_id !== member.member_id) {
      const assigneeResult = await pool.query(
        `SELECT whatsapp_number FROM members WHERE member_id = $1`,
        [data.assignee_id],
      );
      if (assigneeResult.rows.length > 0) {
        await sendMessage(
          assigneeResult.rows[0].whatsapp_number,
          `📋 New task assigned by ${member.name}:\n${taskId} — ${data.title}${data.due_date ? `\n📅 Due: ${new Date(data.due_date).toDateString()}` : ""}`,
        );
      }
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.log("Error executing create task:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────
// COMPLETE TASK
// ─────────────────────────────────────────
async function handleCompleteTask(senderNumber, member, ai) {
  try {
    if (!ai.task_reference) {
      await sendMessage(
        senderNumber,
        "Which task do you want to complete? Please mention the task name or ID.",
      );
      return;
    }

    const task = await findTaskByReference(member.org_id, ai.task_reference);

    if (!task) {
      await sendMessage(
        senderNumber,
        `I couldn't find a task matching "${ai.task_reference}". Send *my tasks* to see your tasks.`,
      );
      return;
    }

    if (
      task.assignee_id !== member.member_id &&
      task.owner_id !== member.member_id &&
      member.role !== "organizer"
    ) {
      await sendMessage(
        senderNumber,
        `${task.task_id} isn't assigned to you, so you can't mark it complete.`,
      );
      return;
    }

    await sendMessage(
      senderNumber,
      `Mark ${task.task_id} (${task.title}) as complete? (yes/no)`,
    );

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO pending_actions
       (org_id, member_id, action_type, action_data, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        member.org_id,
        member.member_id,
        "complete_task",
        JSON.stringify({
          task_id: task.task_id,
          task_title: task.title,
          owner_id: task.owner_id,
          owner_number: task.owner_number,
          owner_name: task.owner_name,
        }),
        expiresAt,
      ],
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// EXECUTE COMPLETE TASK
// ─────────────────────────────────────────
async function executeCompleteTask(senderNumber, member, action) {
  try {
    const data = action.action_data;

    await pool.query(
      `UPDATE tasks SET 
       status = 'completed',
       completed_at = NOW(),
       updated_at = NOW()
       WHERE task_id = $1`,
      [data.task_id],
    );

    await pool.query(
      `UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`,
      [action.action_id],
    );

    await sendMessage(
      senderNumber,
      `Great work! ✅ ${data.task_id} marked complete.`,
    );

    if (data.owner_id !== member.member_id && data.owner_number) {
      await sendMessage(
        data.owner_number,
        `✅ ${data.task_id} — ${data.task_title} has been completed by ${member.name}.`,
      );
    }
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// DELETE TASK
// ─────────────────────────────────────────
async function handleDeleteTask(senderNumber, member, ai) {
  try {
    if (!ai.task_reference) {
      await sendMessage(
        senderNumber,
        "Which task do you want to delete? Please mention the task ID.",
      );
      return;
    }

    const task = await findTaskByReference(member.org_id, ai.task_reference);
    if (!task) {
      await sendMessage(senderNumber, `I couldn't find that task.`);
      return;
    }

    if (task.owner_id !== member.member_id && member.role !== "organizer") {
      await sendMessage(senderNumber, "You can only delete tasks you own.");
      return;
    }

    await sendMessage(
      senderNumber,
      `⚠️ Delete ${task.task_id} (${task.title})? This cannot be undone. Reply 'yes' to confirm.`,
    );

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO pending_actions
       (org_id, member_id, action_type, action_data, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        member.org_id,
        member.member_id,
        "delete_task",
        JSON.stringify({
          task_id: task.task_id,
          task_title: task.title,
          assignee_id: task.assignee_id,
          assignee_number: task.assignee_number,
          assignee_name: task.assignee_name,
        }),
        expiresAt,
      ],
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// EXECUTE DELETE TASK
// ─────────────────────────────────────────
async function executeDeleteTask(senderNumber, member, action) {
  try {
    const data = action.action_data;

    await pool.query(
      `UPDATE tasks SET status = 'deleted', updated_at = NOW() WHERE task_id = $1`,
      [data.task_id],
    );

    await pool.query(
      `UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`,
      [action.action_id],
    );

    await sendMessage(senderNumber, `${data.task_id} has been deleted.`);

    if (data.assignee_id !== member.member_id && data.assignee_number) {
      await sendMessage(
        data.assignee_number,
        `${data.task_id} — ${data.task_title} has been deleted by ${member.name}.`,
      );
    }
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// ADD MEMBER
// ─────────────────────────────────────────
async function handleAddMember(senderNumber, member, ai) {
  try {
    if (!ai.member_name || !ai.phone_number) {
      await sendMessage(
        senderNumber,
        "Please use the format: add member [name] [number]\nExample: add member Priya +919876543210",
      );
      return;
    }

    const formattedNumber = formatWhatsAppNumber(ai.phone_number);
    if (!formattedNumber) {
      await sendMessage(
        senderNumber,
        `That doesn't look like a valid phone number. Example: add member Priya +919876543210`,
      );
      return;
    }

    const existing = await pool.query(
      `SELECT * FROM members WHERE org_id = $1 AND whatsapp_number = $2`,
      [member.org_id, formattedNumber],
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0].status === "active") {
        await sendMessage(
          senderNumber,
          `${ai.member_name} is already a member of ${member.org_name}.`,
        );
        return;
      }
      await pool.query(
        `UPDATE members SET status = 'active', name = $1, role = 'member', updated_at = NOW()
         WHERE member_id = $2`,
        [ai.member_name, existing.rows[0].member_id],
      );
    } else {
      await pool.query(
        `INSERT INTO members (org_id, name, whatsapp_number, role)
         VALUES ($1, $2, $3, 'member')`,
        [member.org_id, ai.member_name, formattedNumber],
      );
    }

    await sendMessage(
      senderNumber,
      `Added ✅ ${ai.member_name} is now a member of ${member.org_name}. They have been notified.`,
    );

    await sendMessage(
      formattedNumber,
      `Hi ${ai.member_name}! You've been added to ${member.org_name} on KaryaSetu.\n\nI'm your team's task manager. Here's what you can do:\n• See your tasks: *my tasks*\n• Mark done: *complete [task name]*\n• Get help: *help*\n\nSave this number and send *help* anytime.`,
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// REMOVE MEMBER
// ─────────────────────────────────────────
async function handleRemoveMember(senderNumber, member, ai) {
  try {
    if (!ai.member_name) {
      await sendMessage(
        senderNumber,
        "Who do you want to remove? Example: remove member Priya",
      );
      return;
    }

    const matches = await findMemberByName(ai.member_name, member.org_id);

    if (matches.length === 0) {
      await sendMessage(
        senderNumber,
        `${ai.member_name} is not a member of ${member.org_name}.`,
      );
      return;
    }

    if (matches.length > 1) {
      let msg = `Multiple members named ${ai.member_name}. Reply with the full number to remove:\n\n`;
      matches.forEach((m, i) => {
        msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`;
      });
      await sendMessage(senderNumber, msg);
      return;
    }

    const targetMember = matches[0];

    const taskCount = await pool.query(
      `SELECT COUNT(*) FROM tasks 
       WHERE owner_id = $1 AND status NOT IN ('completed', 'deleted')`,
      [targetMember.member_id],
    );

    const count = parseInt(taskCount.rows[0].count);

    await sendMessage(
      senderNumber,
      `Remove ${targetMember.name} from ${member.org_name}? Their ${count} owned tasks will be transferred to you. (yes/no)`,
    );

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO pending_actions
       (org_id, member_id, action_type, action_data, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        member.org_id,
        member.member_id,
        "remove_member",
        JSON.stringify({
          target_member_id: targetMember.member_id,
          target_member_name: targetMember.name,
          target_member_number: targetMember.whatsapp_number,
          task_count: count,
        }),
        expiresAt,
      ],
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// EXECUTE REMOVE MEMBER
// ─────────────────────────────────────────
async function executeRemoveMember(senderNumber, member, action) {
  try {
    const data = action.action_data;

    await pool.query(
      `UPDATE tasks SET owner_id = $1, updated_at = NOW()
       WHERE owner_id = $2 AND status NOT IN ('completed', 'deleted')`,
      [member.member_id, data.target_member_id],
    );

    await pool.query(
      `UPDATE tasks SET assignee_id = $1, updated_at = NOW()
       WHERE assignee_id = $2 AND status NOT IN ('completed', 'deleted')`,
      [member.member_id, data.target_member_id],
    );

    await pool.query(
      `UPDATE members SET status = 'inactive', updated_at = NOW()
       WHERE member_id = $1`,
      [data.target_member_id],
    );

    await pool.query(
      `UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`,
      [action.action_id],
    );

    await sendMessage(
      senderNumber,
      `${data.target_member_name} has been removed. ${data.task_count} tasks transferred to you.`,
    );

    await sendMessage(
      data.target_member_number,
      `You have been removed from ${member.org_name} on KaryaSetu.`,
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// LIST TASKS FUNCTIONS
// ─────────────────────────────────────────
async function handleMyTasks(senderNumber, member) {
  try {
    const result = await pool.query(
      `SELECT * FROM tasks
       WHERE assignee_id = $1
       AND status NOT IN ('completed', 'deleted')
       ORDER BY due_date ASC NULLS LAST
       LIMIT 5`,
      [member.member_id],
    );

    if (result.rows.length === 0) {
      await sendMessage(
        senderNumber,
        `${member.name}, you have no open tasks 🎉`,
      );
      return;
    }

    const today = todayInTimezone(member.timezone);
    let response = `*Your open tasks (${result.rows.length}):*\n\n`;
    for (const task of result.rows) {
      const due = task.due_date
        ? new Date(task.due_date).toDateString()
        : "No due date";
      const overdue =
        task.due_date && toYMD(task.due_date) < today
          ? "⚠️ Overdue"
          : "● Open";
      response += `${task.task_id} | ${task.title} | Due: ${due} | ${overdue}\n`;
    }
    response += `\nReply with a task ID for details.`;
    await sendMessage(senderNumber, response);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

async function handleTasksIAssigned(senderNumber, member) {
  try {
    const result = await pool.query(
      `SELECT t.*, m.name as assignee_name FROM tasks t
       LEFT JOIN members m ON t.assignee_id = m.member_id
       WHERE t.owner_id = $1
       AND t.assignee_id != $1
       AND t.status NOT IN ('completed', 'deleted')
       ORDER BY t.due_date ASC NULLS LAST
       LIMIT 5`,
      [member.member_id],
    );

    if (result.rows.length === 0) {
      await sendMessage(
        senderNumber,
        `You haven't assigned any open tasks to others.`,
      );
      return;
    }

    let response = `*Tasks you assigned (${result.rows.length}):*\n\n`;
    for (const task of result.rows) {
      const due = task.due_date
        ? new Date(task.due_date).toDateString()
        : "No due date";
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
       WHERE t.org_id = $1
       AND t.status NOT IN ('completed', 'deleted')
       ORDER BY t.due_date ASC NULLS LAST
       LIMIT 5`,
      [member.org_id],
    );

    if (result.rows.length === 0) {
      await sendMessage(senderNumber, `No open tasks in ${member.org_name}.`);
      return;
    }

    let response = `*All open tasks in ${member.org_name} (${result.rows.length}):*\n\n`;
    for (const task of result.rows) {
      const due = task.due_date
        ? new Date(task.due_date).toDateString()
        : "No due date";
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
               WHERE t.org_id = $1 AND t.due_date < $2
               AND t.status NOT IN ('completed', 'deleted')
               ORDER BY t.due_date ASC LIMIT 5`;
      params = [member.org_id, today];
    } else {
      query = `SELECT * FROM tasks
               WHERE assignee_id = $1 AND due_date < $2
               AND status NOT IN ('completed', 'deleted')
               ORDER BY due_date ASC LIMIT 5`;
      params = [member.member_id, today];
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      await sendMessage(senderNumber, `No overdue tasks. Great work! 🎉`);
      return;
    }

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
      `SELECT m.*, COUNT(t.task_id) as open_task_count
       FROM members m
       LEFT JOIN tasks t ON t.assignee_id = m.member_id
         AND t.status NOT IN ('completed', 'deleted')
       WHERE m.org_id = $1 AND m.status = 'active'
       GROUP BY m.member_id
       ORDER BY m.created_at ASC`,
      [member.org_id],
    );

    let response = `*${member.org_name} members (${result.rows.length}):*\n\n`;
    result.rows.forEach((m, i) => {
      response += `${i + 1}. ${m.name} — ${m.role} — ${m.open_task_count} open tasks\n`;
    });
    await sendMessage(senderNumber, response);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// TASKS ASSIGNED TO A SPECIFIC MEMBER — organizer only
// ─────────────────────────────────────────
async function handleTasksAssignedTo(senderNumber, member, ai) {
  try {
    const targetName = ai.member_name || ai.assignee_name;
    if (!targetName) {
      await sendMessage(
        senderNumber,
        "Whose tasks do you want to see? Example: tasks assigned to Priya",
      );
      return;
    }

    const matches = await findMemberByName(targetName, member.org_id);
    if (matches.length === 0) {
      await sendMessage(
        senderNumber,
        `${targetName} is not a member of ${member.org_name}.`,
      );
      return;
    }
    if (matches.length > 1) {
      let msg = `Multiple members named ${targetName}. Which one?\n\n`;
      matches.forEach((m, i) => {
        msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`;
      });
      await sendMessage(senderNumber, msg);
      return;
    }

    const target = matches[0];
    const result = await pool.query(
      `SELECT * FROM tasks
       WHERE assignee_id = $1
       AND status NOT IN ('completed', 'deleted')
       ORDER BY due_date ASC NULLS LAST
       LIMIT 5`,
      [target.member_id],
    );

    if (result.rows.length === 0) {
      await sendMessage(senderNumber, `${target.name} has no open tasks.`);
      return;
    }

    let response = `*Tasks assigned to ${target.name} (${result.rows.length}):*\n\n`;
    for (const task of result.rows) {
      const due = task.due_date
        ? new Date(task.due_date).toDateString()
        : "No due date";
      response += `${task.task_id} | ${task.title} | Due: ${due}\n`;
    }
    await sendMessage(senderNumber, response);
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// UPDATE TASK — change due date / priority
// ─────────────────────────────────────────
async function handleUpdateTask(senderNumber, member, ai) {
  try {
    if (!ai.task_reference) {
      await sendMessage(
        senderNumber,
        "Which task do you want to update? Example: change due date of KS-019 to Monday",
      );
      return;
    }

    const task = await findTaskByReference(member.org_id, ai.task_reference);
    if (!task) {
      await sendMessage(senderNumber, `I couldn't find that task.`);
      return;
    }

    if (task.owner_id !== member.member_id && member.role !== "organizer") {
      await sendMessage(
        senderNumber,
        "Only the task owner or an Organizer can update a task.",
      );
      return;
    }

    const newDue = ai.due_date || null;
    const newPriority = ["high", "normal", "low"].includes(ai.priority)
      ? ai.priority
      : null;

    if (!newDue && !newPriority) {
      await sendMessage(
        senderNumber,
        `What should I change on ${task.task_id}? You can update the due date or priority.\nExample: change due date of ${task.task_id} to Monday`,
      );
      return;
    }

    const changes = [];
    if (newDue) changes.push(`due date → ${new Date(newDue).toDateString()}`);
    if (newPriority) changes.push(`priority → ${newPriority}`);

    await sendMessage(
      senderNumber,
      `Update ${task.task_id} (${task.title}): ${changes.join(", ")}. Confirm? (yes/no)`,
    );

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO pending_actions
       (org_id, member_id, action_type, action_data, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        member.org_id,
        member.member_id,
        "update_task",
        JSON.stringify({
          task_id: task.task_id,
          task_title: task.title,
          new_due_date: newDue,
          new_priority: newPriority,
        }),
        expiresAt,
      ],
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

async function executeUpdateTask(senderNumber, member, action) {
  try {
    const data = action.action_data;

    if (data.new_due_date) {
      await pool.query(
        `UPDATE tasks SET due_date = $1, updated_at = NOW() WHERE task_id = $2`,
        [data.new_due_date, data.task_id],
      );
    }
    if (data.new_priority) {
      await pool.query(
        `UPDATE tasks SET priority = $1, updated_at = NOW() WHERE task_id = $2`,
        [data.new_priority, data.task_id],
      );
    }

    await pool.query(
      `UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`,
      [action.action_id],
    );

    const parts = [];
    if (data.new_due_date)
      parts.push(`due date is now ${new Date(data.new_due_date).toDateString()}`);
    if (data.new_priority) parts.push(`priority is now ${data.new_priority}`);

    await sendMessage(
      senderNumber,
      `Updated ✅ ${data.task_id} — ${parts.join(", ")}.`,
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// REASSIGN TASK — change who it's assigned to
// ─────────────────────────────────────────
async function handleReassignTask(senderNumber, member, ai) {
  try {
    if (!ai.task_reference) {
      await sendMessage(
        senderNumber,
        "Which task do you want to reassign? Example: reassign KS-019 to Amit",
      );
      return;
    }
    const newName = ai.assignee_name || ai.member_name;
    if (!newName) {
      await sendMessage(
        senderNumber,
        "Who should I reassign it to? Example: reassign KS-019 to Amit",
      );
      return;
    }

    const task = await findTaskByReference(member.org_id, ai.task_reference);
    if (!task) {
      await sendMessage(senderNumber, `I couldn't find that task.`);
      return;
    }

    if (task.owner_id !== member.member_id && member.role !== "organizer") {
      await sendMessage(
        senderNumber,
        "Only the task owner or an Organizer can reassign a task.",
      );
      return;
    }

    const matches = await findMemberByName(newName, member.org_id);
    if (matches.length === 0) {
      await sendMessage(
        senderNumber,
        `${newName} is not a member of ${member.org_name}.`,
      );
      return;
    }
    if (matches.length > 1) {
      let msg = `Multiple members named ${newName}. Which one?\n\n`;
      matches.forEach((m, i) => {
        msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`;
      });
      await sendMessage(senderNumber, msg);
      return;
    }

    const newAssignee = matches[0];
    await sendMessage(
      senderNumber,
      `Reassign ${task.task_id} (${task.title}) to ${newAssignee.name}? (yes/no)`,
    );

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO pending_actions
       (org_id, member_id, action_type, action_data, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        member.org_id,
        member.member_id,
        "reassign_task",
        JSON.stringify({
          task_id: task.task_id,
          task_title: task.title,
          new_assignee_id: newAssignee.member_id,
          new_assignee_name: newAssignee.name,
          new_assignee_number: newAssignee.whatsapp_number,
          old_assignee_id: task.assignee_id,
          old_assignee_number: task.assignee_number,
        }),
        expiresAt,
      ],
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

async function executeReassignTask(senderNumber, member, action) {
  try {
    const data = action.action_data;

    await pool.query(
      `UPDATE tasks SET assignee_id = $1, updated_at = NOW() WHERE task_id = $2`,
      [data.new_assignee_id, data.task_id],
    );
    await pool.query(
      `UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`,
      [action.action_id],
    );

    await sendMessage(
      senderNumber,
      `Done ✅ ${data.task_id} reassigned to ${data.new_assignee_name}.`,
    );

    if (data.new_assignee_number) {
      await sendMessage(
        data.new_assignee_number,
        `📋 New task assigned by ${member.name}:\n${data.task_id} — ${data.task_title}`,
      );
    }

    if (
      data.old_assignee_id &&
      data.old_assignee_id !== data.new_assignee_id &&
      data.old_assignee_number
    ) {
      await sendMessage(
        data.old_assignee_number,
        `${data.task_id} — ${data.task_title} has been reassigned to ${data.new_assignee_name}.`,
      );
    }
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

// ─────────────────────────────────────────
// TRANSFER OWNERSHIP
// ─────────────────────────────────────────
async function handleTransferOwnership(senderNumber, member, ai) {
  try {
    if (!ai.task_reference) {
      await sendMessage(
        senderNumber,
        "Which task's ownership do you want to transfer? Example: transfer KS-020 to Priya",
      );
      return;
    }
    const newName = ai.assignee_name || ai.member_name;
    if (!newName) {
      await sendMessage(
        senderNumber,
        "Who should become the owner? Example: transfer KS-020 to Priya",
      );
      return;
    }

    const task = await findTaskByReference(member.org_id, ai.task_reference);
    if (!task) {
      await sendMessage(senderNumber, `I couldn't find that task.`);
      return;
    }

    if (task.owner_id !== member.member_id && member.role !== "organizer") {
      await sendMessage(
        senderNumber,
        "Only the current owner or an Organizer can transfer ownership.",
      );
      return;
    }

    const matches = await findMemberByName(newName, member.org_id);
    if (matches.length === 0) {
      await sendMessage(
        senderNumber,
        `${newName} is not a member of ${member.org_name}.`,
      );
      return;
    }
    if (matches.length > 1) {
      let msg = `Multiple members named ${newName}. Which one?\n\n`;
      matches.forEach((m, i) => {
        msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`;
      });
      await sendMessage(senderNumber, msg);
      return;
    }

    const newOwner = matches[0];
    await sendMessage(
      senderNumber,
      `Transfer ownership of ${task.task_id} (${task.title}) to ${newOwner.name}? You will no longer be the owner. (yes/no)`,
    );

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO pending_actions
       (org_id, member_id, action_type, action_data, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        member.org_id,
        member.member_id,
        "transfer_ownership",
        JSON.stringify({
          task_id: task.task_id,
          task_title: task.title,
          new_owner_id: newOwner.member_id,
          new_owner_name: newOwner.name,
          new_owner_number: newOwner.whatsapp_number,
        }),
        expiresAt,
      ],
    );
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

async function executeTransferOwnership(senderNumber, member, action) {
  try {
    const data = action.action_data;

    await pool.query(
      `UPDATE tasks SET owner_id = $1, updated_at = NOW() WHERE task_id = $2`,
      [data.new_owner_id, data.task_id],
    );
    await pool.query(
      `UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`,
      [action.action_id],
    );

    await sendMessage(
      senderNumber,
      `Done ✅ ${data.new_owner_name} is now the owner of ${data.task_id}.`,
    );

    if (data.new_owner_number) {
      await sendMessage(
        data.new_owner_number,
        `📋 ${member.name} has transferred ownership of ${data.task_id} — ${data.task_title} to you.`,
      );
    }
  } catch (error) {
    console.log("Error:", error.message);
    await sendMessage(senderNumber, "Something went wrong. Please try again.");
  }
}

module.exports = { handleMessage, handleConfirmation, findMember };
