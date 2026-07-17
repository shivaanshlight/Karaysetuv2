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
async function understandMessage(message, memberName, orgMembers, today, recentTasks = []) {
  try {
    const taskList = (recentTasks || []).length
      ? recentTasks.map((t) => `  ${t.task_id}: ${t.title}`).join("\n")
      : "  (none)";
    const prompt = `You are the AI brain of KaryaSetu — a WhatsApp task management bot for small Indian teams.

A team member named "${memberName}" sent this message:
"${message}"

Today's date is: ${today}
Other members in this organization: ${orgMembers.join(", ")}

Existing OPEN tasks (use these to resolve references — when the user mentions a task by its
words, e.g. "the banner one", "finding nemo", "mark the invoice done", set task_reference to
the EXACT matching task id below; if nothing matches, use the words they typed):
${taskList}

Understand what this person wants — even if they type casually — and extract structured data.
Return ONLY a valid JSON object. No explanation. No extra text. Just JSON.

JSON structure:
{
  "intent": "one of: create_task, list_my_tasks, list_assigned_tasks, list_all_tasks, list_overdue_tasks, complete_task, delete_task, update_task, reassign_task, unassign_task, transfer_ownership, add_member, remove_member, update_member_name, list_members, help, tasks_assigned_to, nudge, time_report, unknown",
  "confidence": 0.0 to 1.0,
  "task_title": "the FULL task text (for create) or the NEW text (for update) — keep ALL of it, even multiple sentences; else null",
  "assignee_name": "the name of who to assign to, exactly as written (keep initials and full names like 'M Achyuth'), else null",
  "due_date": "YYYY-MM-DD or null",
  "due_time": "24-hour time HH:MM if the user gave a time (e.g. '5pm'->'17:00', '9:30 am'->'09:30'), else null",
  "recurrence": "daily|weekly|monthly if the task repeats (e.g. 'every monday'->weekly, 'daily'->daily, 'every month'->monthly), else null",
  "remind_before_minutes": "integer minutes before the due time to remind (e.g. '1 hour before'->60, '30 min before'->30, '1 day before'->1440), else null",
  "remind_at": "absolute reminder time 'YYYY-MM-DD HH:MM' if user says 'remind me at <time> <day>' (resolve the day against today), else null",
  "report_type": "for time_report: 'created' or 'closed', else null",
  "report_window": "for time_report: how far back as a number + unit — minutes/hours/days/weeks/months (e.g. 'last 20 days'->'20 days', 'last 1 hour'->'1 hour', 'past 2 weeks'->'2 weeks'), else null",
  "priority": "high or normal or low or null",
  "task_reference": "a task id or partial task name the user is referring to, else null",
  "member_name": "name of member for add/remove/rename (the CURRENT name), exactly as written, else null",
  "new_name": "the NEW name for a rename command, else null",
  "phone_number": "phone number — for add member, OR to identify a specific person when names clash in remove/assign/transfer/rename; else null",
  "clarification_needed": true or false,
  "clarification_question": "a question or null"
}

BE TOLERANT OF CASUAL / MESSY INPUT:
- Fix typos and shorthand: "tmrw/tom/tmro"=tomorrow, "eod"=today, "asap"=high priority,
  "fri"=Friday, "mon"=Monday, "nxt week"=next week, "plz/pls" ignore, "u"=you, "taks/tsk"=task.
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
- CAPTURE THE FULL TASK: if the task spans several sentences or has extra detail
  ("call the vendor, confirm the price, and email me the quote by friday"), put the
  ENTIRE description in task_title — do NOT cut it down to the first few words.
  Only pull out the due date and assignee; everything else stays in task_title.
- KEEP NAMES WHOLE: preserve names exactly as typed, including initials and surnames
  (e.g. "M Achyuth" stays "M Achyuth", not "Achyuth"; "Dr Rao" stays "Dr Rao").
- TITLE MUST EXCLUDE THE ASSIGNEE: when you set assignee_name, REMOVE that person and the
  word assigning them ("for"/"to"/"remind") from task_title. The title is ONLY the thing to do.
  "dance for harita tomorrow" (Harita is a member) -> task_title:"dance", assignee_name:"Harita"
  "remind rahul to send the invoice" -> task_title:"send the invoice", assignee_name:"Rahul"
  BUT if the name is NOT in the member list, keep it in the title (it's part of the task):
  "buy a gift for the client" -> task_title:"buy a gift for the client", assignee_name:null
- IDENTIFY BY NUMBER: if the user includes a phone number to point at a specific person
  ("assign ks3 to Amit 9876543210", "remove member 9876543210"), put it in phone_number.
- BARE "ADD TASK": if the message is only "add task" / "create task" / "new task" with NO
  actual task described, set intent to create_task and task_title to null (do NOT use the
  words "add task" as the title) — the bot will then ask what the task is.
- DUE TIME: if the user mentions a time of day ("by 5pm", "tomorrow 9:30am", "due fri 6 pm"),
  put the date in due_date AND the time in due_time as 24-hour HH:MM. If no time is given,
  leave due_time null.
- RENAME: "rename/change name of [current] to [new]" -> intent update_member_name, with
  member_name = current name (or phone_number if given) and new_name = the new name.

TIME WINDOW -> ALWAYS time_report (this is important):
- If the user asks to LIST / SHOW / SEE tasks WITHIN A TIME WINDOW — any of "last N ...",
  "past N ...", "in the last week", "for the past 2 days", "over the last month",
  "from the last 30 days", "recent N days" — the intent is "time_report", NOT
  list_all_tasks or list_my_tasks. This holds EVEN IF they say "all tasks" — a time
  window ALWAYS wins and makes it a time_report.
- Set report_window to "<number> <unit>" (units: minute/hour/day/week/month), e.g. "2 days",
  "30 days", "1 week", "1 hour".
- Set report_type to "closed" when they mention closed / completed / done / finished; otherwise
  default to "created".
- Only use list_all_tasks / list_my_tasks / list_overdue_tasks when there is NO time window.

Examples:
"pls add task call the client tmrw" -> {"intent":"create_task","task_title":"call the client","due_date":"<tomorrow>","priority":null,"confidence":0.95}
"remind rahul to send invoice by fri, urgent" -> {"intent":"create_task","task_title":"send invoice","assignee_name":"Rahul","due_date":"<this friday>","priority":"high","confidence":0.93}
"done with venue booking" -> {"intent":"complete_task","task_reference":"venue booking","confidence":0.9}
"give ks3 to amit" -> {"intent":"reassign_task","task_reference":"KS-003","assignee_name":"Amit","confidence":0.92}
"chnge due of ks5 to mon" -> {"intent":"update_task","task_reference":"KS-005","due_date":"<next monday>","confidence":0.9}
"kal tak banner bana do" -> {"intent":"create_task","task_title":"banner","due_date":"<tomorrow>","confidence":0.9}
"add task call the vendor, confirm pricing and email me the quote by fri" -> {"intent":"create_task","task_title":"call the vendor, confirm pricing and email me the quote","due_date":"<this friday>","confidence":0.92}
"assign ks3 to M Achyuth 9876543210" -> {"intent":"reassign_task","task_reference":"KS-003","assignee_name":"M Achyuth","phone_number":"9876543210","confidence":0.92}
"add task" -> {"intent":"create_task","task_title":null,"confidence":0.9}
"every monday post the weekly report" -> {"intent":"create_task","task_title":"post the weekly report","recurrence":"weekly","due_date":"<next monday>","confidence":0.9}
"add task call vendor friday, remind me 1 hour before" -> {"intent":"create_task","task_title":"call vendor","due_date":"<friday>","remind_before_minutes":60,"confidence":0.9}
"remind me to submit report at 5pm thursday" -> {"intent":"create_task","task_title":"submit report","remind_at":"<thursday> 17:00","confidence":0.9}
"nudge santosh for all open tasks" -> {"intent":"nudge","member_name":"Santosh","confidence":0.93}
"show all tasks created during last 20 days" -> {"intent":"time_report","report_type":"created","report_window":"20 days","confidence":0.92}
"tasks closed in the last 1 hour" -> {"intent":"time_report","report_type":"closed","report_window":"1 hour","confidence":0.92}
"tasks created in the past 2 weeks" -> {"intent":"time_report","report_type":"created","report_window":"2 weeks","confidence":0.9}
"list tasks for the past 2 days" -> {"intent":"time_report","report_type":"created","report_window":"2 days","confidence":0.9}
"list taks for the past 2 days" -> {"intent":"time_report","report_type":"created","report_window":"2 days","confidence":0.9}
"list all tasks from last 30 days" -> {"intent":"time_report","report_type":"created","report_window":"30 days","confidence":0.92}
"show me the tasks from the last week" -> {"intent":"time_report","report_type":"created","report_window":"1 week","confidence":0.9}
"tasks done in the last 3 days" -> {"intent":"time_report","report_type":"closed","report_window":"3 days","confidence":0.9}
"what got completed this past week" -> {"intent":"time_report","report_type":"closed","report_window":"1 week","confidence":0.88}
"add task submit report by tomorrow 5pm" -> {"intent":"create_task","task_title":"submit report","due_date":"<tomorrow>","due_time":"17:00","confidence":0.93}
"rename Achyuth to Achyuth Kumar" -> {"intent":"update_member_name","member_name":"Achyuth","new_name":"Achyuth Kumar","confidence":0.95}
"change name of 9740070902 to Priya Sharma" -> {"intent":"update_member_name","phone_number":"9740070902","new_name":"Priya Sharma","confidence":0.93}
"dance for harita tomorrow" -> {"intent":"create_task","task_title":"dance","assignee_name":"Harita","due_date":"<tomorrow>","confidence":0.92}
"mark the banner one done" -> {"intent":"complete_task","task_reference":"<exact id of the banner task from the list>","confidence":0.9}
"delete finding nemo" -> {"intent":"delete_task","task_reference":"<exact id of finding nemo from the list>","confidence":0.9}
"who has what" -> {"intent":"list_all_tasks","confidence":0.6}
"all tasks" -> {"intent":"list_all_tasks","confidence":0.9}
"my tasks" -> {"intent":"list_my_tasks","confidence":0.97}

Rules:
- If confidence is below 0.55 set clarification_needed to true and ask a short question.
- Never invent an assignee if no name is given.
- ALWAYS resolve a task the user refers to (by words) to its EXACT id from the open-tasks list above.
- A time window ("last/past N days/weeks/…") ALWAYS means intent time_report, never a plain list.
- Output MUST be valid JSON only.`;

    const response = await getGroq().chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" },
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
