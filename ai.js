require("dotenv").config();
const Groq = require("groq-sdk");

// Created lazily so the app can boot even if GROQ_API_KEY isn't set yet.
let _groq = null;
function getGroq() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set");
  }
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

// ─────────────────────────────────────────
// MAIN AI FUNCTION
// Takes a message and returns structured data
// ─────────────────────────────────────────
async function understandMessage(message, memberName, orgMembers, today) {
  try {
    const prompt = `You are the AI brain of KaryaSetu — a WhatsApp task management bot for small Indian teams.

A team member named "${memberName}" sent this message:
"${message}"

Today's date is: ${today}
Other members in this organization: ${orgMembers.join(", ")}

Your job is to understand what this person wants and extract structured data.

Return ONLY a valid JSON object. No explanation. No extra text. Just JSON.

The JSON must have this exact structure:
{
  "intent": "one of: create_task, list_my_tasks, list_assigned_tasks, list_all_tasks, list_overdue_tasks, complete_task, delete_task, update_task, reassign_task, unassign_task, transfer_ownership, add_member, remove_member, list_members, help, tasks_assigned_to, unknown",
  "confidence": 0.0 to 1.0,
  "task_title": "extracted task title or null. For 'update' commands this is the NEW title/description.",
  "assignee_name": "first name of who to assign to or null",
  "due_date": "YYYY-MM-DD format or null",
  "priority": "high or normal or low or null",
  "task_reference": "task ID like KS-001 OR any partial task name mentioned. ALWAYS extract this if the user refers to an existing task.",
  "member_name": "name of member for add/remove operations or null",
  "phone_number": "phone number for add member or null",
  "clarification_needed": true or false,
  "clarification_question": "question to ask user if clarification needed or null"
}

Intent guide:
- "list tasks" / "my tasks" => list_my_tasks
- "delegated tasks" / "tasks I assigned" => list_assigned_tasks
- "overdue tasks" => list_overdue_tasks
- "add task ..." => create_task
- "update [task] [new text]" => update_task, put the new text in task_title
- "complete [task]" => complete_task
- "delete [task]" => delete_task
- "assign task [task] to [name]" / "reassign [task] to [name]" => reassign_task
- "remove assignment [task]" / "unassign [task]" => unassign_task
- "transfer [task] to [name]" => transfer_ownership
- "list users" / "list members" => list_members

Rules:
- If confidence is below 0.80 set clarification_needed to true
- Resolve relative dates: tomorrow, next monday, friday, end of week etc based on today's date
- Handle Hinglish naturally: "kal tak", "khatam karo", "assign karo" etc
- Never guess assignee if name is ambiguous`;

    const response = await getGroq().chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
    });

    const rawText = response.choices[0].message.content.trim();
    console.log("AI raw response:", rawText);

    const cleaned = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch (error) {
    console.log("AI error:", error.message);
    return { intent: "unknown", confidence: 0, clarification_needed: false };
  }
}

module.exports = { understandMessage };
