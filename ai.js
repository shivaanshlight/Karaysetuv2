require("dotenv").config();
const Groq = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ─────────────────────────────────────────
// MAIN AI FUNCTION
// Takes a message and returns structured data
// PRD Reference: Section 6.1 — NLP intent engine
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
  "intent": "one of: create_task, list_my_tasks, list_assigned_tasks, list_all_tasks, list_overdue_tasks, complete_task, delete_task, update_task, add_member, remove_member, list_members, transfer_ownership, reassign_task, help, tasks_assigned_to, unknown",
  "confidence": 0.0 to 1.0,
  "task_title": "extracted task title or null",
  "assignee_name": "first name of who to assign to or null",
  "due_date": "YYYY-MM-DD format or null",
  "priority": "high or normal or low or null",
  "task_reference": "task ID like KS-001 OR any partial task name mentioned. Example: 'done with venue booking' = 'venue booking'. 'complete the banner task' = 'banner'. ALWAYS extract this if the user mentions a task name.",
  "member_name": "name of member for add/remove operations or null",
  "phone_number": "phone number for add member or null",
  "clarification_needed": true or false,
  "clarification_question": "question to ask user if clarification needed or null"
}

Rules:
- If confidence is below 0.80 set clarification_needed to true
- Resolve relative dates: tomorrow, next monday, friday, end of week etc based on today's date
- Handle Hinglish naturally: "kal tak", "khatam karo", "assign karo" etc
- If task title is unclear set clarification_needed to true
- Never guess assignee if name is ambiguous`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 500,
    });

    const rawText = response.choices[0].message.content.trim();
    console.log("AI raw response:", rawText);

    // Remove backticks if AI wrapped response in them
    const cleaned = rawText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    // Parse the JSON response
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch (error) {
    console.log("AI error:", error.message);
    // If AI fails return unknown intent
    return {
      intent: "unknown",
      confidence: 0,
      clarification_needed: false,
    };
  }
}

module.exports = { understandMessage };
