import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
async function checkAnthropicHealth(apiKey) {
  const startTime = Date.now();
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "ok" }]
      })
    });
    const responseTime = Date.now() - startTime;
    if (response.ok) {
      return {
        service: "anthropic",
        status: "healthy",
        response_time_ms: responseTime
      };
    } else {
      const errorData = await response.json();
      return {
        service: "anthropic",
        status: "down",
        response_time_ms: responseTime,
        error_message: `HTTP ${response.status}: ${errorData.error?.message || "Unknown error"}`
      };
    }
  } catch (error) {
    return {
      service: "anthropic",
      status: "down",
      response_time_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
async function checkSupabaseHealth(url, apiKey) {
  const startTime = Date.now();
  try {
    const response = await fetch(`${url}/rest/v1/api_credential?select=count&limit=1`, {
      headers: {
        "apikey": apiKey,
        "Authorization": `Bearer ${apiKey}`
      }
    });
    const responseTime = Date.now() - startTime;
    if (response.ok) {
      return {
        service: "supabase",
        status: "healthy",
        response_time_ms: responseTime
      };
    } else {
      return {
        service: "supabase",
        status: "down",
        response_time_ms: responseTime,
        error_message: `HTTP ${response.status}`
      };
    }
  } catch (error) {
    return {
      service: "supabase",
      status: "down",
      response_time_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
async function checkBasecampHealth(accessToken, expiresAt) {
  const startTime = Date.now();
  try {
    const response = await fetch("https://launchpad.37signals.com/authorization.json", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": "Creative Partner OS (claude@creativepartner.com)"
      }
    });
    const responseTime = Date.now() - startTime;
    if (response.ok) {
      const data = await response.json();
      let daysUntilExpiry;
      if (expiresAt) {
        const expiry = new Date(expiresAt);
        const now = /* @__PURE__ */ new Date();
        daysUntilExpiry = Math.floor((expiry.getTime() - now.getTime()) / (1e3 * 60 * 60 * 24));
      }
      return {
        service: "basecamp",
        status: "healthy",
        credential_expires_at: expiresAt,
        days_until_expiry: daysUntilExpiry,
        response_time_ms: responseTime,
        metadata: {
          accounts: data.accounts?.length || 0
        }
      };
    } else {
      return {
        service: "basecamp",
        status: "down",
        response_time_ms: responseTime,
        error_message: `HTTP ${response.status}`
      };
    }
  } catch (error) {
    return {
      service: "basecamp",
      status: "down",
      response_time_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
async function checkSlackHealth(token) {
  const startTime = Date.now();
  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
    const responseTime = Date.now() - startTime;
    const data = await response.json();
    if (data.ok) {
      return {
        service: "slack",
        status: "healthy",
        response_time_ms: responseTime,
        metadata: {
          team: data.team,
          user: data.user
        }
      };
    } else {
      return {
        service: "slack",
        status: "down",
        response_time_ms: responseTime,
        error_message: data.error || "Unknown error"
      };
    }
  } catch (error) {
    return {
      service: "slack",
      status: "down",
      response_time_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
async function checkGHLHealth(apiKey) {
  const startTime = Date.now();
  try {
    const response = await fetch("https://rest.gohighlevel.com/v1/contacts/?limit=1", {
      headers: {
        "Authorization": `Bearer ${apiKey}`
      }
    });
    const responseTime = Date.now() - startTime;
    if (response.ok) {
      return {
        service: "ghl",
        status: "healthy",
        response_time_ms: responseTime
      };
    } else {
      return {
        service: "ghl",
        status: "down",
        response_time_ms: responseTime,
        error_message: `HTTP ${response.status}`
      };
    }
  } catch (error) {
    return {
      service: "ghl",
      status: "down",
      response_time_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
async function checkN8NHealth(apiKey, instanceURL) {
  const startTime = Date.now();
  try {
    const response = await fetch(`${instanceURL}/api/v1/workflows?limit=1`, {
      headers: {
        "X-N8N-API-KEY": apiKey
      }
    });
    const responseTime = Date.now() - startTime;
    if (response.ok) {
      return {
        service: "n8n",
        status: "healthy",
        response_time_ms: responseTime
      };
    } else {
      return {
        service: "n8n",
        status: "down",
        response_time_ms: responseTime,
        error_message: `HTTP ${response.status}`
      };
    }
  } catch (error) {
    return {
      service: "n8n",
      status: "down",
      response_time_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
async function checkGitHubHealth(token) {
  const startTime = Date.now();
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        "Authorization": `token ${token}`,
        "Accept": "application/vnd.github.v3+json"
      }
    });
    const responseTime = Date.now() - startTime;
    if (response.ok) {
      const data = await response.json();
      return {
        service: "GitHub",
        status: "healthy",
        response_time_ms: responseTime,
        metadata: {
          user: data.login
        }
      };
    } else {
      return {
        service: "GitHub",
        status: "down",
        response_time_ms: responseTime,
        error_message: `HTTP ${response.status}`
      };
    }
  } catch (error) {
    return {
      service: "GitHub",
      status: "down",
      response_time_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
async function checkMetaAdsHealth(accessToken, expiresAt) {
  const startTime = Date.now();
  try {
    const response = await fetch(`https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${accessToken}`);
    const responseTime = Date.now() - startTime;
    if (response.ok) {
      const data = await response.json();
      let daysUntilExpiry;
      if (data.data?.expires_at) {
        const expiry = new Date(data.data.expires_at * 1e3);
        const now = /* @__PURE__ */ new Date();
        daysUntilExpiry = Math.floor((expiry.getTime() - now.getTime()) / (1e3 * 60 * 60 * 24));
      } else if (expiresAt) {
        const expiry = new Date(expiresAt);
        const now = /* @__PURE__ */ new Date();
        daysUntilExpiry = Math.floor((expiry.getTime() - now.getTime()) / (1e3 * 60 * 60 * 24));
      }
      const status = data.data?.is_valid ? "healthy" : "down";
      return {
        service: "facebook_ads",
        status,
        credential_expires_at: expiresAt,
        days_until_expiry: daysUntilExpiry,
        response_time_ms: responseTime,
        error_message: !data.data?.is_valid ? "Token is invalid" : void 0
      };
    } else {
      return {
        service: "facebook_ads",
        status: "down",
        response_time_ms: responseTime,
        error_message: `HTTP ${response.status}`
      };
    }
  } catch (error) {
    return {
      service: "facebook_ads",
      status: "down",
      response_time_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
async function sendSlackAlert(failures) {
  const webhookURL = process.env.SLACK_WEBHOOK_SYSTEM_ALERTS;
  if (!webhookURL)
    return;
  const message = {
    text: `:warning: *Daily Health Check - ${failures.length} Service(s) Down*`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:warning: *Daily Health Check Failures*
${(/* @__PURE__ */ new Date()).toISOString()}`
        }
      },
      {
        type: "divider"
      },
      ...failures.map((f) => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${f.service}*: ${f.status}
\`\`\`${f.error_message || "Unknown error"}\`\`\``
        }
      }))
    ]
  };
  await fetch(webhookURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message)
  });
}
var daily_health_monitor_default = inngest.createFunction(
  {
    id: "daily-health-monitor",
    name: "Daily Health Monitor - All Integrations",
    // Run every day at 8 AM Eastern (12 PM UTC)
    cron: "0 12 * * *"
  },
  { event: "inngest/scheduled.timer" },
  async ({ event, step }) => {
    const { data: credentials, error: credError } = await supabase.from("api_credential").select("*").eq("is_active", true);
    if (credError) {
      throw new Error(`Failed to fetch credentials: ${credError.message}`);
    }
    const results = [];
    const anthropicCred = credentials?.find((c) => c.service === "anthropic");
    if (anthropicCred) {
      const result = await step.run(
        "check-anthropic",
        async () => checkAnthropicHealth(anthropicCred.credential_value)
      );
      results.push(result);
    }
    const supabaseCred = credentials?.find((c) => c.service === "supabase" && c.credential_key === "supabase_service_role");
    if (supabaseCred) {
      const result = await step.run(
        "check-supabase",
        async () => checkSupabaseHealth(process.env.SUPABASE_URL, supabaseCred.credential_value)
      );
      results.push(result);
    }
    const basecampCred = credentials?.find((c) => c.service === "basecamp" && c.credential_type === "oauth2_access_token");
    if (basecampCred) {
      const result = await step.run(
        "check-basecamp",
        async () => checkBasecampHealth(basecampCred.credential_value, basecampCred.expires_at)
      );
      results.push(result);
    }
    const slackCred = credentials?.find((c) => c.service === "slack" && c.credential_type === "webhook_url");
    if (slackCred) {
      results.push({
        service: "slack",
        status: slackCred.credential_value.startsWith("https://hooks.slack.com/") ? "healthy" : "down",
        response_time_ms: 0,
        error_message: !slackCred.credential_value.startsWith("https://hooks.slack.com/") ? "Invalid webhook URL format" : void 0
      });
    }
    const ghlCred = credentials?.find((c) => c.service === "ghl" && c.credential_key === "private_integration_token");
    if (ghlCred) {
      const result = await step.run(
        "check-ghl",
        async () => checkGHLHealth(ghlCred.credential_value)
      );
      results.push(result);
    }
    const n8nCred = credentials?.find((c) => c.service === "n8n" && c.credential_key === "n8n_rest_api_key");
    if (n8nCred) {
      const result = await step.run(
        "check-n8n",
        async () => checkN8NHealth(n8nCred.credential_value, "https://creativepartneros.app.n8n.cloud")
      );
      results.push(result);
    }
    const githubCred = credentials?.find((c) => c.service === "GitHub");
    if (githubCred) {
      const result = await step.run(
        "check-github",
        async () => checkGitHubHealth(githubCred.credential_value)
      );
      results.push(result);
    }
    const metaCred = credentials?.find((c) => c.service === "facebook_ads" && c.credential_key === "meta_business_manager");
    if (metaCred) {
      const result = await step.run(
        "check-meta-ads",
        async () => checkMetaAdsHealth(metaCred.credential_value, metaCred.expires_at)
      );
      results.push(result);
    }
    await step.run("write-results", async () => {
      const { error: insertError } = await supabase.from("health_check_results").insert(
        results.map((r) => ({
          check_timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          service: r.service,
          status: r.status,
          credential_expires_at: r.credential_expires_at,
          days_until_expiry: r.days_until_expiry,
          error_message: r.error_message,
          response_time_ms: r.response_time_ms,
          metadata: r.metadata
        }))
      );
      if (insertError) {
        throw new Error(`Failed to write health check results: ${insertError.message}`);
      }
    });
    const failures = results.filter((r) => r.status === "down");
    if (failures.length > 0) {
      await step.run("send-slack-alert", async () => sendSlackAlert(failures));
    }
    return {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      total_checked: results.length,
      healthy: results.filter((r) => r.status === "healthy").length,
      down: failures.length,
      services_down: failures.map((f) => f.service),
      expiring_soon: results.filter((r) => r.days_until_expiry !== void 0 && r.days_until_expiry < 7).map((r) => ({
        service: r.service,
        days_until_expiry: r.days_until_expiry
      }))
    };
  }
);
export {
  daily_health_monitor_default as default
};
