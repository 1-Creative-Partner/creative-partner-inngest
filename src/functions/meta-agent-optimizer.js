import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
import { routeModel } from "../model-router.js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const SLACK_WEBHOOK_AGENT_HEALTH = process.env.SLACK_WEBHOOK_AGENT_HEALTH || process.env.SLACK_WEBHOOK_PROPOSALS || "https://hooks.slack.com/services/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";
async function collectAgentStats() {
  const now = /* @__PURE__ */ new Date();
  const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1e3).toISOString();
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1e3).toISOString();
  const knownAgents = [
    "transcript-intelligence-agent",
    "ghl-transcript-processor",
    "ghl-inbound-message-processor",
    "ghl-communication-extraction",
    "ghl-form-processor",
    "basecamp-nightly-sync",
    "proposal-notify",
    "prompt-autoscorer",
    "basecamp-token-refresh",
    "ghl-oauth-refresh",
    "client-onboarding",
    "daily-health-monitor"
  ];
  const stats = [];
  for (const agentId of knownAgents) {
    const { data: episodes24h } = await supabase.from("cia_episode").select("id, content, timestamp_event").eq("actor", agentId).gte("timestamp_event", h24);
    const { data: episodes7d } = await supabase.from("cia_episode").select("id").eq("actor", agentId).gte("timestamp_event", d7);
    const { data: lastEpisode } = await supabase.from("cia_episode").select("timestamp_event").eq("actor", agentId).order("timestamp_event", { ascending: false }).limit(1).single();
    const errorCount = (episodes24h || []).filter(
      (e) => e.content?.toLowerCase().includes("error") || e.content?.toLowerCase().includes("failed") || e.content?.toLowerCase().includes("warning")
    ).length;
    stats.push({
      agentId,
      episodeCount24h: (episodes24h || []).length,
      episodeCount7d: (episodes7d || []).length,
      lastSeen: lastEpisode?.timestamp_event || null,
      errorCount24h: errorCount,
      avgConfidence: null
      // future: pull from client_facts.confidence
    });
  }
  return stats;
}
async function collectSystemHealthMetrics() {
  const h24 = new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString();
  const { count: totalIntake } = await supabase.from("communication_intake").select("*", { count: "exact", head: true }).gte("received_at", h24);
  const { count: processedIntake } = await supabase.from("communication_intake").select("*", { count: "exact", head: true }).eq("processed", true).gte("received_at", h24);
  const { count: factsExtracted } = await supabase.from("client_facts").select("*", { count: "exact", head: true }).gte("created_at", h24);
  const { count: highValueFacts } = await supabase.from("client_facts").select("*", { count: "exact", head: true }).eq("is_high_value", true).gte("created_at", h24);
  const { data: recentScores } = await supabase.from("prompt_result_log").select("auto_score, promoted_to_training").not("auto_score", "is", null).gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1e3).toISOString());
  const avgScore = recentScores && recentScores.length > 0 ? recentScores.reduce((sum, r) => sum + (r.auto_score || 0), 0) / recentScores.length : null;
  const promotedCount = (recentScores || []).filter((r) => r.promoted_to_training).length;
  const { data: ghlOAuthState } = await supabase.from("system_awareness").select("structured_data").eq("awareness_key", "ghl_oauth_token_creative_partner").single();
  const oauthExpiry = ghlOAuthState?.structured_data?.expires_at;
  const oauthHoursLeft = oauthExpiry ? Math.round((new Date(oauthExpiry).getTime() - Date.now()) / 36e5) : null;
  return {
    intake_total_24h: totalIntake || 0,
    intake_processed_24h: processedIntake || 0,
    intake_processing_rate: totalIntake ? Math.round((processedIntake || 0) / totalIntake * 100) : null,
    client_facts_extracted_24h: factsExtracted || 0,
    high_value_facts_24h: highValueFacts || 0,
    prompt_avg_score_7d: avgScore ? Math.round(avgScore * 100) / 100 : null,
    prompts_promoted_7d: promotedCount,
    ghl_oauth_hours_remaining: oauthHoursLeft,
    collected_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function analyzeAgentPerformance(agentStats, systemHealth) {
  const inactiveAgents = agentStats.filter((a) => a.episodeCount24h === 0);
  const errorProne = agentStats.filter((a) => a.errorCount24h > 0);
  const prompt = `You are a meta-agent analyzing the health of an AI agent system for Creative Partner, a marketing agency.

AGENT ACTIVITY (last 24h):
${agentStats.map(
    (a) => `- ${a.agentId}: ${a.episodeCount24h} episodes (${a.errorCount24h} errors), last seen: ${a.lastSeen ? new Date(a.lastSeen).toLocaleDateString() : "NEVER"}`
  ).join("\n")}

SYSTEM HEALTH METRICS:
- Communication intake (24h): ${systemHealth.intake_total_24h} received, ${systemHealth.intake_processed_24h} processed (${systemHealth.intake_processing_rate ?? "N/A"}% rate)
- Client facts extracted (24h): ${systemHealth.client_facts_extracted_24h} (${systemHealth.high_value_facts_24h} high-value)
- Prompt quality score (7d avg): ${systemHealth.prompt_avg_score_7d ?? "no data"} | Promoted to training: ${systemHealth.prompts_promoted_7d}
- GHL OAuth token: ${systemHealth.ghl_oauth_hours_remaining !== null ? `${systemHealth.ghl_oauth_hours_remaining}h remaining` : "unknown"}

INACTIVE AGENTS (0 episodes in 24h): ${inactiveAgents.map((a) => a.agentId).join(", ") || "none"}
AGENTS WITH ERRORS: ${errorProne.map((a) => `${a.agentId} (${a.errorCount24h} errors)`).join(", ") || "none"}

Provide:
1. Overall health assessment (2-3 sentences)
2. List of 2-5 specific recommendations (what Chad should know or do)
3. Health score 1-10 (10=everything working perfectly)

Return ONLY valid JSON:
{
  "analysis": "2-3 sentence health summary",
  "recommendations": ["rec 1", "rec 2", "rec 3"],
  "health_score": 8
}`;
  let content;
  try {
    const result = await routeModel({
      task: "analysis",
      prompt,
      caller: "meta-agent-optimizer",
      maxTokens: 1024,
    });
    content = result.text || "{}";
  } catch {
    return {
      analysis: "Meta-agent analysis failed — model router error.",
      recommendations: ["Check OpenRouter API key and model matrix"],
      healthScore: 5
    };
  }
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
      throw new Error("No JSON found");
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      analysis: parsed.analysis || "No analysis generated",
      recommendations: parsed.recommendations || [],
      healthScore: parsed.health_score || 5
    };
  } catch {
    return {
      analysis: content.substring(0, 200),
      recommendations: [],
      healthScore: 5
    };
  }
}
const metaAgentOptimizer = inngest.createFunction(
  {
    id: "meta-agent-optimizer",
    name: "Meta-Agent: Daily Agent Health Optimizer",
    retries: 1,
    concurrency: { limit: 1 }
    // only one health check at a time
  },
  { cron: "0 11 * * *" },
  // 6am EST = 11am UTC
  async ({ step }) => {
    const agentStats = await step.run("collect-agent-stats", async () => {
      return await collectAgentStats();
    });
    const systemHealth = await step.run("collect-system-health", async () => {
      return await collectSystemHealthMetrics();
    });
    const analysis = await step.run("analyze-performance", async () => {
      return await analyzeAgentPerformance(agentStats, systemHealth);
    });
    await step.run("post-slack-report", async () => {
      const score = analysis.healthScore;
      const scoreEmoji = score >= 8 ? "\u2705" : score >= 6 ? "\u26A0\uFE0F" : "\u{1F534}";
      const blocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `${scoreEmoji} Agent Health Report \u2014 Score: ${score}/10`,
            emoji: true
          }
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: analysis.analysis }
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Intake Processing Rate:*
${systemHealth.intake_processing_rate ?? "N/A"}%` },
            { type: "mrkdwn", text: `*Client Facts (24h):*
${systemHealth.client_facts_extracted_24h} (${systemHealth.high_value_facts_24h} high-value)` },
            { type: "mrkdwn", text: `*Prompt Quality (7d):*
${systemHealth.prompt_avg_score_7d ?? "no data"} avg` },
            { type: "mrkdwn", text: `*GHL OAuth:*
${systemHealth.ghl_oauth_hours_remaining !== null ? `${systemHealth.ghl_oauth_hours_remaining}h remaining` : "unknown"}` }
          ]
        }
      ];
      if (analysis.recommendations.length > 0) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Recommendations:*
${analysis.recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}`
          }
        });
      }
      const inactive = agentStats.filter((a) => a.episodeCount7d === 0 && a.lastSeen === null);
      if (inactive.length > 0) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*\u26A0\uFE0F Agents never seen (no Inngest deployment yet):*
${inactive.map((a) => `\u2022 ${a.agentId}`).join("\n")}`
          }
        });
      }
      await fetch(SLACK_WEBHOOK_AGENT_HEALTH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `Agent Health Report \u2014 ${score}/10`,
          blocks
        })
      });
    });
    await step.run("persist-health-snapshot", async () => {
      await supabase.from("system_awareness").upsert({
        awareness_key: "agent_health_snapshot",
        category: "monitoring",
        content: `Daily agent health report. Score: ${analysis.healthScore}/10. ${analysis.analysis}`,
        structured_data: {
          health_score: analysis.healthScore,
          analysis: analysis.analysis,
          recommendations: analysis.recommendations,
          agent_stats: agentStats,
          system_health: systemHealth,
          generated_at: (/* @__PURE__ */ new Date()).toISOString(),
          routing: "model-router"
        },
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      }, { onConflict: "awareness_key" });
    });
    await step.run("log-cia-episode", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "measurement",
        source_system: "claude",
        actor: "meta-agent-optimizer",
        content: `Daily agent health check complete. Health score: ${analysis.healthScore}/10. ${agentStats.filter((a) => a.episodeCount24h > 0).length}/${agentStats.length} agents active in last 24h. ${analysis.recommendations.length} recommendations generated.`,
        metadata: {
          health_score: analysis.healthScore,
          agents_active_24h: agentStats.filter((a) => a.episodeCount24h > 0).length,
          agents_total: agentStats.length,
          system_health: systemHealth,
          recommendations: analysis.recommendations
        },
        timestamp_event: (/* @__PURE__ */ new Date()).toISOString()
      });
    });
    return {
      success: true,
      healthScore: analysis.healthScore,
      agentsMonitored: agentStats.length,
      agentsActive24h: agentStats.filter((a) => a.episodeCount24h > 0).length,
      recommendations: analysis.recommendations.length,
      analysis: analysis.analysis
    };
  }
);
export {
  metaAgentOptimizer
};
