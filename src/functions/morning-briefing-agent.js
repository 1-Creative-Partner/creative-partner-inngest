import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
import { routeModel } from "../model-router.js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const SLACK_WEBHOOK_BRIEFING = process.env.SLACK_WEBHOOK_BRIEFING || process.env.SLACK_WEBHOOK_AGENT_HEALTH || process.env.SLACK_WEBHOOK_PROPOSALS || "https://hooks.slack.com/services/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";
async function getNewLeads() {
  const overnight = new Date(Date.now() - 12 * 60 * 60 * 1e3).toISOString();
  const { data } = await supabase.from("customer").select("company_name, created_at, ghl_contact_id").gte("created_at", overnight).order("created_at", { ascending: false }).limit(10);
  return data || [];
}
async function getHighValueFacts() {
  const overnight = new Date(Date.now() - 12 * 60 * 60 * 1e3).toISOString();
  const { data } = await supabase.from("client_facts").select("fact_summary, fact_type, ghl_contact_id, created_at").eq("is_high_value", true).eq("slack_alerted", false).gte("created_at", overnight).order("created_at", { ascending: false }).limit(5);
  return data || [];
}
async function getBasecampActivity() {
  const { data } = await supabase.from("system_awareness").select("structured_data").eq("awareness_key", "basecamp_active_projects").single();
  return {
    projectCount: data?.structured_data?.project_count || 0,
    lastSync: data?.structured_data?.last_sync || null
  };
}
async function getHealthSnapshot() {
  const { data } = await supabase.from("system_awareness").select("structured_data, content").eq("awareness_key", "agent_health_snapshot").single();
  if (!data)
    return { score: null, summary: "No health snapshot yet" };
  return {
    score: data.structured_data?.health_score || null,
    summary: data.structured_data?.analysis || data.content || "No analysis available"
  };
}
async function getGHLTokenStatus() {
  const { data } = await supabase.from("system_awareness").select("structured_data").eq("awareness_key", "ghl_oauth_token_creative_partner").single();
  const expiresAt = data?.structured_data?.expires_at;
  const hoursLeft = expiresAt ? Math.round((new Date(expiresAt).getTime() - Date.now()) / 36e5) : null;
  return { hoursLeft, location: "Creative Partner" };
}
async function getUnresolvedAlerts() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString();
  const { data } = await supabase.from("cia_episode").select("content, timestamp_event").gte("timestamp_event", yesterday).ilike("content", "%action required%").order("timestamp_event", { ascending: false }).limit(3);
  return data || [];
}
async function generateBriefingSummary(data) {
  const prompt = `You are a morning briefing assistant for Chad Morgan at Creative Partner.

Write a 2-3 sentence morning summary. Be direct and action-oriented.
Focus on: what happened overnight, what needs attention today.

Data:
- New leads: ${data.newLeads.length} (${data.newLeads.map((l) => l.company_name).join(", ") || "none"})
- High-value signals: ${data.highValueFacts.length}
- Agent health score: ${data.healthSnapshot.score ?? "no data"}/10
- GHL OAuth token: ${data.tokenStatus.hoursLeft !== null ? `${data.tokenStatus.hoursLeft}h remaining` : "unknown"}
- Basecamp projects: ${data.basecampActivity.projectCount} active
- Unresolved action items: ${data.unresolvedAlerts.length}

Return ONLY the summary text (no JSON, no labels, just 2-3 sentences).`;
  try {
    const result = await routeModel({
      task: "basic summarization",
      prompt,
      caller: "morning-briefing-agent",
      maxTokens: 256,
    });
    return result.text || "Morning briefing — see details below.";
  } catch {
    return "Morning briefing generated — see details below.";
  }
}
const morningBriefingAgent = inngest.createFunction(
  {
    id: "morning-briefing-agent",
    name: "Morning Briefing Agent",
    retries: 1,
    concurrency: { limit: 1 }
  },
  { cron: "0 12 * * *" },
  // 7am EST = 12pm UTC
  async ({ step }) => {
    const briefingData = await step.run("collect-briefing-data", async () => {
      const [newLeads, highValueFacts, basecampActivity, healthSnapshot, tokenStatus, unresolvedAlerts] = await Promise.all([
        getNewLeads(),
        getHighValueFacts(),
        getBasecampActivity(),
        getHealthSnapshot(),
        getGHLTokenStatus(),
        getUnresolvedAlerts()
      ]);
      return { newLeads, highValueFacts, basecampActivity, healthSnapshot, tokenStatus, unresolvedAlerts };
    });
    const summary = await step.run("generate-summary", async () => {
      return await generateBriefingSummary(briefingData);
    });
    await step.run("send-slack-briefing", async () => {
      const {
        newLeads,
        highValueFacts,
        basecampActivity,
        healthSnapshot,
        tokenStatus,
        unresolvedAlerts
      } = briefingData;
      const today = (/* @__PURE__ */ new Date()).toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: "America/Detroit"
      });
      const blocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `Good morning, Chad! ${today}`,
            emoji: true
          }
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: summary }
        },
        { type: "divider" }
      ];
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: newLeads.length > 0 ? `*New Leads (overnight):*
${newLeads.map((l) => `\u2022 ${l.company_name}`).join("\n")}` : `*New Leads:* None overnight`
        }
      });
      if (highValueFacts.length > 0) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*High-Value Signals (need follow-up):*
${highValueFacts.map(
              (f) => `\u2022 *${f.fact_type.replace(/_/g, " ")}:* ${f.fact_summary}`
            ).join("\n")}`
          }
        });
      }
      const tokenWarning = tokenStatus.hoursLeft !== null && tokenStatus.hoursLeft < 6 ? ` \u26A0\uFE0F *TOKEN EXPIRING SOON (${tokenStatus.hoursLeft}h)*` : tokenStatus.hoursLeft !== null ? ` (${tokenStatus.hoursLeft}h left)` : "";
      blocks.push({
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Agent Health:*
${healthSnapshot.score !== null ? `${healthSnapshot.score}/10` : "no data"}`
          },
          {
            type: "mrkdwn",
            text: `*GHL OAuth:*
${tokenStatus.location}${tokenWarning}`
          },
          {
            type: "mrkdwn",
            text: `*Basecamp Projects:*
${basecampActivity.projectCount} active`
          },
          {
            type: "mrkdwn",
            text: `*Action Items:*
${unresolvedAlerts.length} unresolved`
          }
        ]
      });
      if (unresolvedAlerts.length > 0) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Action Required:*
${unresolvedAlerts.map(
              (a) => `\u2022 ${a.content.substring(0, 120)}`
            ).join("\n")}`
          }
        });
      }
      blocks.push({ type: "divider" });
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_Generated by Morning Briefing Agent \u2022 ${(/* @__PURE__ */ new Date()).toLocaleTimeString("en-US", { timeZone: "America/Detroit", hour12: true })}_`
          }
        ]
      });
      await fetch(SLACK_WEBHOOK_BRIEFING, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `Good morning! Daily briefing for ${today}`,
          blocks
        })
      });
    });
    await step.run("log-cia-episode", async () => {
      const { newLeads, highValueFacts, unresolvedAlerts } = briefingData;
      await supabase.from("cia_episode").insert({
        episode_type: "measurement",
        source_system: "claude",
        actor: "morning-briefing-agent",
        content: `Morning briefing sent. ${newLeads.length} new leads, ${highValueFacts.length} high-value signals, ${unresolvedAlerts.length} unresolved alerts. Health score: ${briefingData.healthSnapshot.score ?? "N/A"}/10.`,
        metadata: {
          new_leads: newLeads.length,
          high_value_signals: highValueFacts.length,
          unresolved_alerts: unresolvedAlerts.length,
          health_score: briefingData.healthSnapshot.score,
          basecamp_projects: briefingData.basecampActivity.projectCount
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    // Log briefing output for quality scoring
    await step.run("log-prompt-result", async () => {
      await supabase.from("prompt_result_log").insert({
        tenant_id: "creative-partner",
        task_type: "morning_briefing",
        model_used: "model-router",
        prompt_version: 1,
        system_prompt: "You are Chad Morgan's AI operations assistant at Creative Partner. Generate his concise daily briefing for Slack. Lead with what needs attention today.",
        user_prompt: `${briefingData.newLeads.length} new leads, ${briefingData.highValueFacts.length} high-value signals, ${briefingData.unresolvedAlerts.length} unresolved alerts`,
        output: summary,
        output_type: "slack_briefing",
        updated_at: new Date().toISOString(),
      });
      return { logged: true };
    });

    return {
      success: true,
      newLeads: briefingData.newLeads.length,
      highValueSignals: briefingData.highValueFacts.length,
      unresolvedAlerts: briefingData.unresolvedAlerts.length,
      healthScore: briefingData.healthSnapshot.score
    };
  }
);
export {
  morningBriefingAgent
};
