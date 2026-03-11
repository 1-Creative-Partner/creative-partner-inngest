import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AGENT_MODEL = "claude-haiku-4-5-20251001";
const MAX_AGENT_ITERATIONS = 15;
const SLACK_WEBHOOK_AGENT_ALERTS = process.env.SLACK_WEBHOOK_AGENT_ALERTS || process.env.SLACK_WEBHOOK_PROPOSALS || // fallback to known webhook
"https://hooks.slack.com/services/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";
const AGENT_TOOLS = [
  {
    name: "write_client_fact",
    description: "Write a structured client fact extracted from the call transcript to the database. Call once per distinct signal found. Be specific and use exact quotes where available.",
    input_schema: {
      type: "object",
      properties: {
        fact_type: {
          type: "string",
          enum: [
            "pain_point",
            "budget_signal",
            "timeline_signal",
            "service_interest",
            "decision_maker_signal",
            "objection",
            "competitor_mention",
            "high_value_signal"
          ],
          description: "Category of client signal"
        },
        fact_key: {
          type: "string",
          description: "Machine-readable slug, e.g. 'needs_more_google_reviews' or 'budget_3k_monthly'"
        },
        fact_summary: {
          type: "string",
          description: "1-sentence human-readable fact about this client. Start with the client name if known."
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Confidence in this signal (0-1). Use 0.9+ for explicit statements, 0.6-0.8 for implied."
        },
        raw_quote: {
          type: "string",
          description: "Exact quote from transcript supporting this fact. Use empty string if none."
        },
        is_high_value: {
          type: "boolean",
          description: "True if this warrants immediate attention: explicit budget >$2k/mo, 'ready to move forward', urgency, or churn risk."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Relevant tags, e.g. ['budget', 'google', 'reviews', 'seo']"
        }
      },
      required: ["fact_type", "fact_key", "fact_summary", "confidence", "raw_quote", "is_high_value", "tags"]
    }
  },
  {
    name: "signal_done",
    description: "Call this ONLY when you have finished extracting ALL signals from the transcript. Summarize what was found.",
    input_schema: {
      type: "object",
      properties: {
        total_facts_extracted: {
          type: "number",
          description: "How many write_client_fact calls you made"
        },
        high_value_count: {
          type: "number",
          description: "How many had is_high_value=true"
        },
        primary_signal: {
          type: "string",
          description: "The single most important finding from this call in 1 sentence"
        },
        recommended_action: {
          type: "string",
          description: "What Chad should do next based on this call. Can be empty string if no action needed."
        }
      },
      required: ["total_facts_extracted", "high_value_count", "primary_signal", "recommended_action"]
    }
  }
];
async function generateEmbedding(text) {
  if (!OPENAI_API_KEY)
    return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text.substring(0, 8192)
        // OpenAI max
      })
    });
    if (!res.ok)
      return null;
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
}
async function handleWriteClientFact(input, context) {
  const embeddingText = `${input.fact_type}: ${input.fact_summary}`;
  const embedding = await generateEmbedding(embeddingText);
  const record = {
    customer_id: context.contactId,
    // TEXT column — store GHL contact ID
    ghl_contact_id: context.contactId,
    tenant_id: "creative-partner",
    fact_category: "call_intelligence",
    fact_type: input.fact_type,
    fact_key: input.fact_key,
    fact_value: input.fact_summary,
    // TEXT column
    fact_summary: input.fact_summary,
    fact_value_structured: {
      raw_quote: input.raw_quote || null,
      confidence_reason: `Agent confidence: ${input.confidence}`,
      call_direction: context.callDirection,
      call_duration: context.callDuration,
      extracted_at: (/* @__PURE__ */ new Date()).toISOString(),
      model: AGENT_MODEL,
      initial_gpt_extraction: context.initialExtraction
    },
    confidence: input.confidence,
    source: "transcript-agent",
    source_type: "agent_extracted",
    client_data_source: "ghl_call_transcript",
    is_high_value: input.is_high_value,
    slack_alerted: false,
    tags: input.tags || [],
    source_intake_id: context.intakeId || null,
    extracted_from_call_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (embedding) {
    record.embedding = `[${embedding.join(",")}]`;
  }
  const { data, error } = await supabase.from("client_facts").insert(record).select("id").single();
  if (error) {
    console.error("Failed to write client fact:", error.message);
    return { success: false, error: error.message };
  }
  return { success: true, id: data.id };
}
async function runAgentLoop(transcript, contactId, locationId, callDirection, callDuration, intakeId, initialExtraction) {
  const context = { contactId, locationId, callDirection, callDuration, intakeId, initialExtraction };
  const factsWritten = [];
  const highValueFacts = [];
  let summary = {};
  const messages = [
    {
      role: "user",
      content: `Analyze this GHL call transcript and extract ALL distinct client intelligence signals.

CONTACT ID: ${contactId}
CALL DIRECTION: ${callDirection || "unknown"}
CALL DURATION: ${callDuration ? `${Math.round(Number(callDuration) / 60)} minutes` : "unknown"}

INITIAL GPT EXTRACTION (Phase 0 GHL workflow already ran):
${JSON.stringify(initialExtraction, null, 2)}

FULL TRANSCRIPT:
${transcript.substring(0, 6e3)}

Instructions:
1. Call write_client_fact for EACH distinct signal you find (pain points, budget mentions, timeline, services wanted, decision maker signals, objections, competitors, high-value buy signals)
2. Be specific \u2014 use exact quotes where possible
3. Mark is_high_value=true for: explicit budget >$2k/mo, "ready to move forward" signals, urgency, or churn risk
4. After extracting ALL signals, call signal_done with a summary
5. Do not stop early \u2014 extract every signal you can find`
    }
  ];
  const systemPrompt = `You are a client intelligence analyst for Creative Partner, a full-service marketing agency in Lansing, MI.

Your job is to extract structured client signals from GHL call transcripts using the tools provided.
For each distinct signal in the transcript, call write_client_fact.
When finished extracting ALL signals, call signal_done.

Signal types:
- pain_point: Business problems, frustrations, current failures they mentioned
- budget_signal: Any mention of money, pricing, investment capacity
- timeline_signal: Urgency, deadlines, "we need this by X"
- service_interest: Specific services they want (SEO, ads, website, social media, Google Business Profile)
- decision_maker_signal: Whether this person can approve contracts
- objection: Hesitations, concerns, "but what about...", price pushback
- competitor_mention: Other agencies or tools they use/are considering
- high_value_signal: Explicit buy signal, urgent need, or churn risk

High-value signals (is_high_value=true) include:
- Explicit budget mention of $2,000+/month
- "Ready to move forward" or "let's get started"
- Urgency: "we need this ASAP", time-sensitive deadline
- Expressed frustration with current provider (churn risk)`;
  let iteration = 0;
  let agentDone = false;
  while (!agentDone && iteration < MAX_AGENT_ITERATIONS) {
    iteration++;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: AGENT_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: AGENT_TOOLS,
        messages
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Agent API call failed (iter ${iteration}): ${res.status} ${err}`);
    }
    const response = await res.json();
    const stopReason = response.stop_reason;
    const content = response.content || [];
    messages.push({ role: "assistant", content });
    const toolUses = content.filter((c) => c.type === "tool_use");
    const toolResults = [];
    for (const toolUse of toolUses) {
      const toolInput = toolUse.input || {};
      if (toolUse.name === "signal_done") {
        summary = toolInput;
        agentDone = true;
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({ acknowledged: true, agent_loop_ending: true })
        });
        continue;
      }
      if (toolUse.name === "write_client_fact") {
        const result = await handleWriteClientFact(toolInput, context);
        if (result.success && result.id) {
          const fact = {
            id: result.id,
            fact_type: toolInput.fact_type,
            fact_key: toolInput.fact_key,
            fact_summary: toolInput.fact_summary,
            is_high_value: toolInput.is_high_value,
            raw_quote: toolInput.raw_quote || ""
          };
          factsWritten.push(fact);
          if (toolInput.is_high_value)
            highValueFacts.push(fact);
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      }
    }
    if (toolUses.length > 0 && !agentDone) {
      messages.push({ role: "user", content: toolResults });
    }
    if (stopReason === "end_turn" && toolUses.length === 0) {
      agentDone = true;
    }
  }
  return { factsWritten, highValueFacts, summary };
}
const transcriptIntelligenceAgent = inngest.createFunction(
  {
    id: "transcript-intelligence-agent",
    name: "Transcript Intelligence Agent",
    retries: 1,
    concurrency: { limit: 3 }
  },
  { event: "ghl/transcript.processed" },
  async ({ event, step }) => {
    const {
      contactId,
      locationId,
      call_transcript,
      gpt_extraction,
      call_duration,
      call_direction
    } = event.data;
    if (!call_transcript || call_transcript.trim().length < 100) {
      return { skipped: true, reason: "Transcript too short for intelligence extraction" };
    }
    const initialExtraction = await step.run("parse-phase0-extraction", async () => {
      if (!gpt_extraction)
        return {};
      try {
        const clean = typeof gpt_extraction === "string" ? gpt_extraction.replace(/```json?/g, "").replace(/```/g, "").trim() : gpt_extraction;
        return typeof clean === "string" ? JSON.parse(clean) : clean;
      } catch {
        return {};
      }
    });
    const intakeId = await step.run("find-intake-record", async () => {
      const { data } = await supabase.from("communication_intake").select("id").eq("ghl_contact_id", contactId).eq("communication_type", "call_transcript").order("created_at", { ascending: false }).limit(1).single();
      return data?.id || null;
    });
    const agentResults = await step.run("run-intelligence-agent", async () => {
      return await runAgentLoop(
        call_transcript,
        contactId,
        locationId,
        call_direction || "unknown",
        call_duration,
        intakeId,
        initialExtraction
      );
    });
    if (agentResults.highValueFacts.length > 0) {
      await step.run("alert-slack-high-value", async () => {
        const facts = agentResults.highValueFacts;
        const summary = agentResults.summary;
        const blocks = [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `High-Value Client Signal \u2014 ${facts.length} signal(s) detected`,
              emoji: true
            }
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*GHL Contact:*
${contactId}` },
              { type: "mrkdwn", text: `*Call Direction:*
${call_direction || "unknown"}` },
              { type: "mrkdwn", text: `*Primary Signal:*
${summary.primary_signal || "See below"}` },
              { type: "mrkdwn", text: `*Recommended Action:*
${summary.recommended_action || "Review and follow up"}` }
            ]
          },
          ...facts.slice(0, 3).map((f) => ({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${f.fact_type.replace(/_/g, " ")}:* ${f.fact_summary}${f.raw_quote ? `
> _"${f.raw_quote.substring(0, 150)}"_` : ""}`
            }
          }))
        ];
        const res = await fetch(SLACK_WEBHOOK_AGENT_ALERTS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `High-value client signal from GHL call transcript`,
            blocks
          })
        });
        if (res.ok && facts.length > 0) {
          const highValueIds = facts.map((f) => f.id).filter(Boolean);
          await supabase.from("client_facts").update({ slack_alerted: true }).in("id", highValueIds);
        }
        return { alerted: res.ok, signalCount: facts.length };
      });
    }
    await step.run("log-cia-episode", async () => {
      const { summary } = agentResults;
      await supabase.from("cia_episode").insert({
        episode_type: "observation",
        source_system: "ghl",
        actor: "transcript-intelligence-agent",
        content: `AgentKit analysis: ${agentResults.factsWritten.length} client facts extracted for contact ${contactId} (${agentResults.highValueFacts.length} high-value). ${summary.primary_signal || ""}`,
        metadata: {
          contact_id: contactId,
          location_id: locationId,
          facts_written: agentResults.factsWritten.length,
          high_value_signals: agentResults.highValueFacts.length,
          primary_signal: agentResults.summary.primary_signal,
          recommended_action: agentResults.summary.recommended_action,
          model: AGENT_MODEL,
          agent_iterations: "see function logs",
          intake_id: intakeId
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return {
      success: true,
      contactId,
      factsWritten: agentResults.factsWritten.length,
      highValueSignals: agentResults.highValueFacts.length,
      primarySignal: agentResults.summary.primary_signal,
      recommendedAction: agentResults.summary.recommended_action
    };
  }
);
export {
  transcriptIntelligenceAgent
};
