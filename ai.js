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
// MAIN AI FUNCTION — turns casual human text into structured data
// ─────────────────────────────────────────
async function understandMessage(message, memberName, orgMembers, today) {
  try {
    const prompt = `You are the AI brain of KaryaSetu — a WhatsApp task management bot for small Indian teams.

A team member named "${memberName}" sent this message:
"${message}"

Today's date is: ${today}
Other members in this organization: ${orgMembers.join(", ")}

Understand what this person wants — even if they type casually — and extract structured data.
Return ONLY a valid JSON object. No explanation. No extra text. Just JSON.

JSON structure:
{
  "intent": "one of: create_task, list_my_tasks, list_assigned_tasks, list_all_tasks, list_overdue_tasks, complete_task, delete_task, update_task, reassign_task, unassign_task, transfer_ownership, add_member, remove_member, list_members, help, tasks_assigned_to, unknown",
  "confidence": 0.0 to 1.0,
  "task_title": "the task text (for create) or the NEW text (for update), else null",
  "assignee_name": "first name of who to assign to, else null",
  "due_date": "YYYY-MM-DD or null",
  "priority": "high or normal or low or null",
  "task_reference": "a task id or partial task name the user is referring to, else null",
  "member_name": "name of member for add/remove, else null",
  "phone_number": "phone number for add member, else null",
  "clarification_needed": true or false,
  "clarification_question": "a question or null"
}

BE TOLERANT OF CASUAL / MESSY INPUT:
- Fix typos and shorthand: "tmrw/tom/tmro"=tomorrow, "eod"=today, "asap"=high priority,
  "fri"=Friday, "mon"=Monday, "nxt week"=next week, "plz/pls" ignore, "u"=you.
- Lowercase, no punctuation, run-on sentences are normal — still extract correctly.
- Hinglish: "kal"=tomorrow, "aaj"=today, "parso"=day after tomorrow, "khatam/done karo"=complete,
  "bana do/banao/add karo"=create, "hata do"=delete/remove, "de do/assign karo"=assign.
- Priority words: "urgent/important/asap/high prio"=high, "low/whenever"=low.
- TASK IDS: if the user refers to a task by number ("ks3", "ks 3", "ks-3", "task 3", "#3"),
  set task_reference to the padded form "KS-003" (always 3 digits). Otherwise put the partial
  task name in task_reference.
- For "update/change" commands, put any NEW description in task_title and the date in due_date.
- Resolve all relative dates against today (${today}).
- Match assignee/member names loosely to the member list above (closest first name).

Examples:
"pls add task call the client tmrw" -> {"intent":"create_task","task_title":"call the client","due_date":"<tomorrow>","priority":null,"confidence":0.95}
"remind rahul to send invoice by fri, urgent" -> {"intent":"create_task","task_title":"send invoice","assignee_name":"Rahul","due_date":"<this friday>","priority":"high","confidence":0.93}
"done with venue booking" -> {"intent":"complete_task","task_reference":"venue booking","confidence":0.9}
"give ks3 to amit" -> {"intent":"reassign_task","task_reference":"KS-003","assignee_name":"Amit","confidence":0.92}
"chnge due of ks5 to mon" -> {"intent":"update_task","task_reference":"KS-005","due_date":"<next monday>","confidence":0.9}
"kal tak banner bana do" -> {"intent":"create_task","task_title":"banner","due_date":"<tomorrow>","confidence":0.9}
"my tasks" -> {"intent":"list_my_tasks","confidence":0.97}

Rules:
- If confidence is below 0.55 set clarification_needed to true and ask a short question.
- Never invent an assignee if no name is given.`;

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
