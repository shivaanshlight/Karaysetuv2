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
// PRD Reference: Section 6.2
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
// FIND TASK BY REFERENCE — used by complete/delete
// Matches on task ID, full title, or individual keywords.
// Results are deterministically ordered: exact ID first, then exact title,
// then most recent — so we never silently act on a random match.
// Joins both owner and assignee so callers can notify either side.
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

  // Step 1 — Check if registered
  const member = await findMember(senderNumber);

  if (!member) {
    await sendMessage(
      senderNumber,
      "Hi! You're not registered with a KaryaSetu organization. Ask your Organizer to add you.",
    );
    return;
  }

  console.log("Member:", member.name, "| Role:", member.role);

  // Step 2 — Get org members for AI context
  const orgMembers = await getOrgMembers(member.org_id);
  const today = todayInTimezone(member.timezone);

  // Step 3 — Send to AI for understanding
  const ai = await understandMessage(message, member.name, orgMembers, today);

  console.log("AI intent:", ai.intent, "| Confidence:", ai.confidence);

  // Step 4 — If AI needs clarification
  // PRD Reference: Section 6.1 — confidence threshold 0.80
  if (ai.clarification_needed && ai.clarification_question) {
    await sendMessage(senderNumber, ai.clarification_question);
    return;
  }

  // Step 5 — Route to right function
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
    case "reassign_task":
    case "transfer_ownership":
      // Recognised intents that aren't built yet — tell the user plainly
      // instead of pretending we didn't understand.
      await sendMessage(
        senderNumber,
        "That feature isn't available yet. For now you can create, list, complete, and delete tasks. Send *help* for the full list.",
      );
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
  helpText += `• delete [task ID]\n\n`;

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
// PRD Reference: Section 6.2
// ─────────────────────────────────────────
async function handleCreateTask(senderNumber, member, ai) {
  try {
    if (!ai.task_title) {
      await sendMessage(senderNumber, "What should I call this task?");
      return;
    }

    // Resolve assignee
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
        // Ambiguous — two people with same name
        // PRD Reference: Section 6.2 — disambiguation
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

    // Format due date
    const dueDisplay = ai.due_date
      ? new Date(ai.due_date).toDateString()
      : "No due date";

    // Show confirmation
    // PRD Reference: Section 6.2 — confirm before creating
    const confirmMsg =
      `Creating this task:\n\n` +
      `📋 ${ai.task_title}\n` +
      `👤 Assigned to: ${assigneeName}\n` +
      `📅 Due: ${dueDisplay}\n` +
      `⚡ Priority: ${ai.priority || "normal"}\n\n` +
      `Confirm? (yes / no)`;

    await sendMessage(senderNumber, confirmMsg);

    // Save pending action
    // PRD Reference: Section 6.1 — 10 minute confirmation timeout
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
// PRD Reference: Section 6.1
// ─────────────────────────────────────────
async function handleConfirmation(senderNumber, member, message) {
  const confirmed = ["yes", "confirm", "1"].includes(message.toLowerCase());
  const denied = ["no", "cancel", "2"].includes(message.toLowerCase());

  if (!confirmed && !denied) return false;

  // Find pending action
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

  // Execute the confirmed action
  if (action.action_type === "create_task") {
    await executeCreateTask(senderNumber, member, action);
  } else if (action.action_type === "delete_task") {
    await executeDeleteTask(senderNumber, member, action);
  } else if (action.action_type === "complete_task") {
    await executeCompleteTask(senderNumber, member, action);
  } else if (action.action_type === "remove_member") {
    await executeRemoveMember(senderNumber, member, action);
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

    // Counter increment + insert must be atomic so a failed insert never
    // burns a task number (no gaps in KS-xxx).
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

    // Mark action as confirmed
    await client.query(
      `UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`,
      [action.action_id],
    );

    await client.query("COMMIT");

    // Notify creator
    await sendMessage(
      senderNumber,
      `Done ✅ ${taskId} created.\n\n📋 ${data.title}\n👤 Assigned to: ${data.assignee_name}\n📅 Due: ${data.due_date ? new Date(data.due_date).toDateString() : "No due date"}`,
    );

    // Notify assignee if different from creator
    // PRD Reference: Section 9.1
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
// PRD Reference: Section 6.5
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

    // Find the task
    const task = await findTaskByReference(member.org_id, ai.task_reference);

    if (!task) {
      await sendMessage(
        senderNumber,
        `I couldn't find a task matching "${ai.task_reference}". Send *my tasks* to see your tasks.`,
      );
      return;
    }

    // Only the assignee, owner, or an organizer can complete a task.
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

    // Ask confirmation
    await sendMessage(
      senderNumber,
      `Mark ${task.task_id} (${task.title}) as complete? (yes/no)`,
    );

    // Save pending action
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

    // Notify owner if different from assignee
    // PRD Reference: Section 9.1
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
// PRD Reference: Section 6.6
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

    // Only owner or organizer can delete
    // PRD Reference: Section 6.6
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

    // Soft delete — PRD Reference: Section 13
    await pool.query(
      `UPDATE tasks SET status = 'deleted', updated_at = NOW() WHERE task_id = $1`,
      [data.task_id],
    );

    await pool.query(
      `UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`,
      [action.action_id],
    );

    await sendMessage(senderNumber, `${data.task_id} has been deleted.`);

    // Notify assignee if different from owner
    // PRD Reference: Section 9.1
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
// PRD Reference: Section 7.1
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

    // Check if already a member
    const existing = await pool.query(
      `SELECT * FROM members 
       WHERE org_id = $1 AND whatsapp_number = $2 AND status = 'active'`,
      [member.org_id, formattedNumber],
    );

    if (existing.rows.length > 0) {
      await sendMessage(
        senderNumber,
        `${ai.member_name} is already a member of ${member.org_name}.`,
      );
      return;
    }

    // Add member
    await pool.query(
      `INSERT INTO members (org_id, name, whatsapp_number, role)
       VALUES ($1, $2, $3, 'member')`,
      [member.org_id, ai.member_name, formattedNumber],
    );

    // Notify organizer
    await sendMessage(
      senderNumber,
      `Added ✅ ${ai.member_name} is now a member of ${member.org_name}. They have been notified.`,
    );

    // Send welcome message to new member
    // PRD Reference: Section 4.2
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
// PRD Reference: Section 7.2
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

    // Don't guess when several members share a name.
    if (matches.length > 1) {
      let msg = `Multiple members named ${ai.member_name}. Reply with the full number to remove:\n\n`;
      matches.forEach((m, i) => {
        msg += `${i + 1}) ${m.name} — ${m.whatsapp_number}\n`;
      });
      await sendMessage(senderNumber, msg);
      return;
    }

    const targetMember = matches[0];

    // Count their tasks
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

    // Transfer tasks to organizer
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

    // Set member inactive
    await pool.query(
      `UPDATE members SET status = 'inactive', updated_at = NOW()
       WHERE member_id = $1`,
      [data.target_member_id],
    );

    await pool.query(
      `UPDATE pending_actions SET status = 'confirmed' WHERE action_id = $1`,
      [action.action_id],
    );

    // Notify organizer
    await sendMessage(
      senderNumber,
      `${data.target_member_name} has been removed. ${data.task_count} tasks transferred to you.`,
    );

    // Notify removed member
    // PRD Reference: Section 9.1
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
    // Compare against "today" in the org's timezone, not the DB's.
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
// PRD Reference: Section 10.2
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
      await sendMessage(
        senderNumber,
        `${target.name} has no open tasks.`,
      );
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

module.exports = { handleMessage, handleConfirmation, findMember };
