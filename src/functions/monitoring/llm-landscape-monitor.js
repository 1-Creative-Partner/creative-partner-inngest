import { inngest } from "../../inngest-client.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * LLM Landscape Monitor
 *
 * Weekly cron (Sunday 9am UTC / 4am EST).
 * Fetches latest model info from Anthropic, OpenAI, and Google.
 * Compares against llm_model_matrix table.
 * Alerts Slack if new models detected.
 */
export const llmLandscapeMonitor = inngest.createFunction(
  {
    id: "llm-landscape-monitor",
    name: "LLM Landscape Monitor",
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: "0 9 * * 0" }, // Sunday 9am UTC
  async ({ step }) => {
    // Step 1: Get current models from our matrix
    const currentModels = await step.run("fetch-current-models", async () => {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/llm_model_matrix?select=model_id,model_name,provider,is_active&is_active=eq.true`,
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
        }
      );
      return res.json();
    });

    const knownModelIds = new Set(currentModels.map((m) => m.model_id));

    // Step 2: Check Anthropic models page
    const anthropicFindings = await step.run("check-anthropic", async () => {
      try {
        const res = await fetch("https://docs.anthropic.com/en/docs/about-claude/models", {
          headers: { "User-Agent": "CreativePartnerOS/1.0" },
        });
        const html = await res.text();

        // Extract model IDs from the page (patterns like claude-opus-4-6, claude-sonnet-4-6)
        const modelPattern = /claude-[\w.-]+/gi;
        const matches = [...new Set(html.match(modelPattern) || [])];

        const newModels = matches.filter(
          (id) => !knownModelIds.has(id) && !id.includes("instant") // Filter noise
        );

        return {
          provider: "Anthropic",
          modelsFound: matches.length,
          newModels,
          checked: new Date().toISOString(),
        };
      } catch (err) {
        return { provider: "Anthropic", error: err.message, newModels: [] };
      }
    });

    // Step 3: Check OpenAI models API
    const openaiFindings = await step.run("check-openai", async () => {
      try {
        // OpenAI models page — look for model name patterns
        const res = await fetch("https://platform.openai.com/docs/models", {
          headers: { "User-Agent": "CreativePartnerOS/1.0" },
        });
        const html = await res.text();

        // Look for GPT model patterns
        const gptPattern = /gpt-[\w.-]+/gi;
        const o3Pattern = /o[1-9]-[\w.-]*/gi;
        const gptMatches = [...new Set(html.match(gptPattern) || [])];
        const o3Matches = [...new Set(html.match(o3Pattern) || [])];
        const allMatches = [...gptMatches, ...o3Matches];

        const newModels = allMatches.filter((id) => !knownModelIds.has(id));

        return {
          provider: "OpenAI",
          modelsFound: allMatches.length,
          newModels,
          checked: new Date().toISOString(),
        };
      } catch (err) {
        return { provider: "OpenAI", error: err.message, newModels: [] };
      }
    });

    // Step 4: Check Google AI models
    const googleFindings = await step.run("check-google", async () => {
      try {
        const res = await fetch("https://ai.google.dev/gemini-api/docs/models", {
          headers: { "User-Agent": "CreativePartnerOS/1.0" },
        });
        const html = await res.text();

        const geminiPattern = /gemini-[\w.-]+/gi;
        const matches = [...new Set(html.match(geminiPattern) || [])];

        const newModels = matches.filter((id) => !knownModelIds.has(id));

        return {
          provider: "Google",
          modelsFound: matches.length,
          newModels,
          checked: new Date().toISOString(),
        };
      } catch (err) {
        return { provider: "Google", error: err.message, newModels: [] };
      }
    });

    // Step 5: Aggregate and alert
    const allFindings = [anthropicFindings, openaiFindings, googleFindings];
    const allNewModels = allFindings.flatMap((f) =>
      (f.newModels || []).map((m) => ({ provider: f.provider, model_id: m }))
    );

    // Step 6: Write monitoring event to system_awareness
    await step.run("update-system-awareness", async () => {
      const content = JSON.stringify({
        lastRun: new Date().toISOString(),
        findings: allFindings.map((f) => ({
          provider: f.provider,
          modelsFound: f.modelsFound || 0,
          newModels: f.newModels?.length || 0,
          error: f.error || null,
        })),
        newModelsDetected: allNewModels,
        knownModelCount: currentModels.length,
      });

      await fetch(
        `${SUPABASE_URL}/rest/v1/system_awareness?awareness_key=eq.llm_landscape_monitor_last_run`,
        {
          method: "DELETE",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
        }
      );

      await fetch(`${SUPABASE_URL}/rest/v1/system_awareness`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          awareness_key: "llm_landscape_monitor_last_run",
          content,
        }),
      });
    });

    // Step 7: Slack alert if new models found
    if (allNewModels.length > 0) {
      await step.run("slack-alert", async () => {
        // Get Slack webhook from system_awareness
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/system_awareness?awareness_key=eq.slack_webhook_system_alerts&select=content`,
          {
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
            },
          }
        );
        const [row] = await res.json();
        const webhookUrl = row?.content?.trim();
        if (!webhookUrl) return;

        const modelList = allNewModels
          .map((m) => `• ${m.provider}: \`${m.model_id}\``)
          .join("\n");

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `🤖 *LLM Landscape Monitor — New Models Detected*\n\n${modelList}\n\n${allNewModels.length} new model(s) not in llm_model_matrix. Review and add if relevant.`,
          }),
        });
      });
    }

    // Step 8: Write CIA episode
    await step.run("write-cia-episode", async () => {
      await fetch(`${SUPABASE_URL}/rest/v1/cia_episode`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          episode_type: "measurement",
          source_system: "claude",
          timestamp_event: new Date().toISOString(),
          actor: "inngest/llm-landscape-monitor",
          content: `Weekly LLM scan: ${allNewModels.length} new models detected across ${allFindings.length} providers. Known models: ${currentModels.length}. ${allNewModels.length > 0 ? "New: " + allNewModels.map((m) => m.model_id).join(", ") : "No changes."}`,
          tags: ["llm", "monitoring", "weekly"],
        }),
      });
    });

    return {
      status: "complete",
      knownModels: currentModels.length,
      newModelsDetected: allNewModels.length,
      findings: allFindings.map((f) => ({
        provider: f.provider,
        found: f.modelsFound || 0,
        new: f.newModels?.length || 0,
      })),
    };
  }
);
