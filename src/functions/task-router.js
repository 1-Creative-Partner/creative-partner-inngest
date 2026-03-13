import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";
const DRAFT_MODEL = "claude-sonnet-4-6";

// ── Helpers ────────────────────────────────────────────────────────────────

async function callClaude(model, prompt, systemPrompt, maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt || undefined,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || "";
}

async function getClientContext(customerId, contactIdentifier) {
  if (!customerId && !contactIdentifier) return null;

  // Load customer + knowledge graph
  const query = customerId
    ? supabase.from("customer").select("id, company_name, primary_contact_name, primary_contact_email, primary_contact_phone, city, state, status").eq("id", customerId).limit(1)
    : supabase.from("customer").select("id, company_name, primary_contact_name, primary_contact_email, primary_contact_phone, city, state, status").eq("ghl_contact_id", contactIdentifier).limit(1);

  const { data: custRows } = await query;
  const customer = custRows?.[0] || null;

  let kgSummary = null;
  if (customer?.id) {
    const { data: kgRows } = await supabase
      .from("client_knowledge_graph")
      .select("business_overview, call_intelligence")
      .eq("customer_id", customer.id)
      .limit(1);
    kgSummary = kgRows?.[0] || null;
  }

  return { customer, kgSummary };
}

async function extractAndClassifyTasks(intake, context) {
  const { source_channel, raw_content, key_entities, sentiment, intent_tags } = intake;
  const isCall = source_channel === "call";

  // For calls: GPT extraction already happened in Phase 0 — parse next_steps directly
  if (isCall && key_entities?.gpt_extraction) {
    const gpt = key_entities.gpt_extraction;
    const tasks = [];

    // next_steps → follow-up tasks
    const nextSteps = Array.isArray(gpt.next_steps) ? gpt.next_steps : [];
    for (const step of nextSteps) {
      if (!step || typeof step !== "string" || step.trim().length < 5) continue;
      const stepLower = step.toLowerCase();
      let workflow = "follow_up_sms";
      if (stepLower.includes("email") || stepLower.includes("send over") || stepLower.includes("proposal")) {
        workflow = "follow_up_email";
      } else if (stepLower.includes("quote") || stepLower.includes("price") || stepLower.includes("cost")) {
        workflow = "get_quote";
      } else if (stepLower.includes("schedule") || stepLower.includes("meeting") || stepLower.includes("call back")) {
        workflow = "schedule_call";
      } else if (stepLower.includes("send") || stepLower.includes("share") || stepLower.includes("info")) {
        workflow = "send_info";
      }
      tasks.push({
        workflow,
        title: step.length > 80 ? step.slice(0, 80) + "\u2026" : step,
        priority: gpt.sentiment === "positive" ? 1 : 2,
        context_hint: `From call with ${context?.customer?.company_name || gpt.client_name || "Unknown"}. Intent: ${gpt.intent || "unknown"}. Services mentioned: ${(gpt.services_mentioned || []).join(", ") || "none"}.`,
      });
    }

    // services_mentioned with budget signals → quote task
    const services = Array.isArray(gpt.services_mentioned) ? gpt.services_mentioned : [];
    const hasBudget = gpt.budget_signals && gpt.budget_signals !== "none";
    if (services.length > 0 && hasBudget && tasks.length === 0) {
      tasks.push({
        workflow: "get_quote",
        title: `Prepare quote: ${services.slice(0, 2).join(", ")} for ${context?.customer?.company_name || gpt.client_name || "this contact"}`,
        priority: 1,
        context_hint: `Budget signal: ${gpt.budget_signals}. Services: ${services.join(", ")}.`,
      });
    }

    // If nothing extracted but call happened, create generic follow-up
    if (tasks.length === 0 && gpt.summary) {
      tasks.push({
        workflow: "follow_up_sms",
        title: `Follow up after call \u2014 ${context?.customer?.company_name || "contact"}`,
        priority: 3,
        context_hint: gpt.summary,
      });
    }

    return tasks;
  }

  // For messages: use AI to extract tasks
  if (!raw_content || raw_content.trim().length === 0) return [];

  const customerName = context?.customer?.company_name || context?.customer?.primary_contact_name || "Unknown contact";
  const kgOverview = context?.kgSummary?.business_overview ? JSON.stringify(context.kgSummary.business_overview).slice(0, 400) : "No prior context";

  const prompt = `You are analyzing an inbound business communication to extract action items for Chad Morgan, a marketing agency owner.

Contact: ${customerName}
Channel: ${source_channel}
Message: "${raw_content.slice(0, 800)}"
Client context: ${kgOverview}

Extract 0-3 concrete action items Chad needs to take. Return ONLY valid JSON array:
[
  {
    "workflow": "follow_up_sms|follow_up_email|get_quote|send_info|schedule_call|content_work|admin",
    "title": "Specific action in 10 words or less",
    "priority": 1-3,
    "context_hint": "One sentence of context"
  }
]

Rules:
- follow_up_sms: needs a quick reply by text
- follow_up_email: needs a detailed reply by email
- get_quote: they asked about pricing
- send_info: they need information sent
- schedule_call: need to schedule a call or meeting
- content_work: website/content/design work needed
- admin: internal admin task
- If no action needed (spam, automated, one-word reply), return []`;

  try {
    const raw = await callClaude(CLASSIFY_MODEL, prompt, null, 512);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter(t => t.workflow && t.title) : [];
  } catch {
    return [];
  }
}

async function draftMessage(task, intake, context) {
  if (!["follow_up_sms", "follow_up_email", "send_info"].includes(task.workflow)) return null;

  const customer = context?.customer;
  const kg = context?.kgSummary;
  const firstName = customer?.primary_contact_name?.split(" ")[0] || "there";
  const company = customer?.company_name || "";

  const kgContext = kg?.business_overview
    ? `Business context: ${JSON.stringify(kg.business_overview).slice(0, 600)}`
    : "";

  const recentCalls = Array.isArray(kg?.call_intelligence)
    ? kg.call_intelligence.slice(-2).map(c => `- ${c.date?.slice(0, 10)}: ${c.summary || c.intent || "call"}`).join("\n")
    : "";

  const isSms = task.workflow === "follow_up_sms";
  const channelInstruction = isSms
    ? "Write a SHORT SMS reply (2-3 sentences max, casual, friendly, no fluff). NO signature."
    : "Write a professional email reply (3-5 sentences, warm but direct). Include a subject line on the first line as 'Subject: ...' then a blank line, then the body.";

  const prompt = `You are drafting a reply for Chad Morgan, owner of Creative Partner (marketing agency, Lansing MI).

${channelInstruction}

Contact: ${firstName}${company ? `, ${company}` : ""}
Their message: "${(intake.raw_content || "").slice(0, 500)}"
Task to address: ${task.title}
${kgContext}
${recentCalls ? `Recent call history:\n${recentCalls}` : ""}

Chad's style: direct, genuine, no corporate speak, gets to the point fast.
Draft the reply now. Do not include any explanation — just the message.`;

  try {
    const draft = await callClaude(DRAFT_MODEL, prompt, null, 400);
    return draft.trim();
  } catch {
    return null;
  }
}

async function writeTask(task, intake, draftMessage, context) {
  const customer = context?.customer;
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("task").insert({
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    tenant_id: "creative-partner",
    workflow: task.workflow,
    name: task.title,
    status: "pending",
    priority: task.priority || 2,
    retry_count: 0,
    max_retries: 3,
    created_at: now,
    updated_at: now,
    input: {
      intake_id: intake.id,
      source_channel: intake.source_channel,
      source_system: intake.source_system,
      contact_identifier: intake.contact_identifier,
      contact_name: intake.contact_name || customer?.primary_contact_name || "Unknown",
      company_name: customer?.company_name || null,
      customer_id: intake.customer_id || customer?.id || null,
      raw_content: (intake.raw_content || "").slice(0, 1000),
      context_hint: task.context_hint || null,
      sentiment: intake.sentiment || null,
      draft_message: draftMessage || null,
      created_from: "task-router",
    },
  });

  if (error) throw new Error(`task insert failed: ${error.message}`);
  return data;
}

// ── Main processor ─────────────────────────────────────────────────────────

async function processIntakeRow(intake) {
  const context = await getClientContext(intake.customer_id, intake.contact_identifier);
  const tasks = await extractAndClassifyTasks(intake, context);

  if (tasks.length === 0) {
    // Mark routed even with no tasks (spam, no action needed)
    await supabase.from("communication_intake")
      .update({ action_routed: true, action_routed_at: new Date().toISOString(), tasks_created: [] })
      .eq("id", intake.id);
    return { intake_id: intake.id, tasks_created: 0 };
  }

  // Draft messages for follow-up tasks (parallel)
  const drafts = await Promise.all(
    tasks.map(t => draftMessage(t, intake, context).catch(() => null))
  );

  // Write all tasks
  const written = [];
  for (let i = 0; i < tasks.length; i++) {
    try {
      await writeTask(tasks[i], intake, drafts[i], context);
      written.push(tasks[i]);
    } catch (e) {
      console.warn(`Failed to write task ${i}:`, e.message);
    }
  }

  // Mark intake as routed
  await supabase.from("communication_intake")
    .update({
      action_routed: true,
      action_routed_at: new Date().toISOString(),
      tasks_created: written.map(t => ({ workflow: t.workflow, title: t.title })),
    })
    .eq("id", intake.id);

  return { intake_id: intake.id, tasks_created: written.length, tasks: written.map(t => t.workflow) };
}

// ── Function 1: Immediate trigger on new intake row ────────────────────────

export const taskRouterImmediate = inngest.createFunction(
  {
    id: "task-router-immediate",
    name: "Task Router: Process New Intake Row",
    retries: 2,
    concurrency: { limit: 3 },
  },
  { event: "communication/intake.received" },
  async ({ event, step }) => {
    const { intake_id } = event.data;
    if (!intake_id) return { skipped: true, reason: "No intake_id" };

    const intake = await step.run("load-intake", async () => {
      const { data } = await supabase
        .from("communication_intake")
        .select("*")
        .eq("id", intake_id)
        .limit(1);
      return data?.[0] || null;
    });

    if (!intake) return { skipped: true, reason: "Intake row not found" };
    if (intake.action_routed) return { skipped: true, reason: "Already routed" };

    const result = await step.run("route-and-draft", async () => {
      return processIntakeRow(intake);
    });

    await step.run("log-cia", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "observation",
        source_system: "task-router",
        actor: "task-router-immediate",
        content: `Task router: ${result.tasks_created} task(s) created from ${intake.source_channel} intake. Contact: ${intake.contact_name || intake.contact_identifier}. Types: ${(result.tasks || []).join(", ") || "none"}.`,
        metadata: result,
        timestamp_event: new Date().toISOString(),
      });
    });

    return result;
  }
);

// ── Function 2: Scheduled catch-all (every 30 min) ─────────────────────────

export const taskRouterScheduled = inngest.createFunction(
  {
    id: "task-router-scheduled",
    name: "Task Router: Scheduled Catch-All",
    retries: 1,
    concurrency: { limit: 1 },
  },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    const unrouted = await step.run("fetch-unrouted", async () => {
      const { data } = await supabase
        .from("communication_intake")
        .select("*")
        .neq("action_routed", true)
        .not("raw_content", "is", null)
        .order("created_at", { ascending: true })
        .limit(20);
      return data || [];
    });

    if (unrouted.length === 0) return { processed: 0 };

    const results = await step.run("route-all", async () => {
      const out = [];
      for (const intake of unrouted) {
        try {
          const r = await processIntakeRow(intake);
          out.push(r);
        } catch (e) {
          console.warn(`Failed to route intake ${intake.id}:`, e.message);
          out.push({ intake_id: intake.id, error: e.message });
        }
      }
      return out;
    });

    const totalTasks = results.reduce((sum, r) => sum + (r.tasks_created || 0), 0);

    await step.run("log-cia", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "measurement",
        source_system: "task-router",
        actor: "task-router-scheduled",
        content: `Scheduled task router: processed ${unrouted.length} intake rows, created ${totalTasks} tasks.`,
        metadata: { rows_processed: unrouted.length, tasks_created: totalTasks },
        timestamp_event: new Date().toISOString(),
      });
    });

    return { processed: unrouted.length, tasks_created: totalTasks };
  }
);
