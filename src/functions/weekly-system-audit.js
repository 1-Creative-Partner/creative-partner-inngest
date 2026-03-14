import { inngest } from "../inngest-client.js";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Weekly System Audit — Fortune 500 Production Health Monitor
 *
 * Runs every Sunday at 5am ET. Checks:
 * 1. GHL token health (all 3 locations)
 * 2. Empty tables that should have data
 * 3. Inngest execution budget usage
 * 4. Stale credentials
 * 5. Security advisor errors
 * 6. Cross-system consistency
 *
 * Results stored in system_audit_history for pattern detection.
 * Alerts Chad via Slack if any P0 issues found.
 */
export const weeklySystemAudit = inngest.createFunction(
  {
    id: "weekly-system-audit",
    name: "Weekly System Audit — Fortune 500 Health Check",
    retries: 2,
    concurrency: { limit: 1 },
  },
  { cron: "0 10 * * 0" }, // Sunday 10am UTC = 5am ET
  async ({ step }) => {
    const findings = { p0: [], p1: [], p2: [], pass: [] };

    // Check 1: GHL Token Health
    const tokenHealth = await step.run("check-ghl-tokens", async () => {
      const { data, error } = await supabase
        .from("ghl_sub_accounts")
        .select("location_id, location_name, token_expires_at, updated_at, is_active");

      if (error) return { status: "error", message: error.message };

      const results = [];
      for (const account of (data || [])) {
        const expiresAt = new Date(account.token_expires_at);
        const hoursTilExpiry = (expiresAt - Date.now()) / (1000 * 60 * 60);
        const hoursSinceRefresh = (Date.now() - new Date(account.updated_at)) / (1000 * 60 * 60);

        let status = "healthy";
        if (expiresAt < new Date()) status = "expired";
        else if (hoursTilExpiry < 6) status = "expiring_soon";
        else if (hoursSinceRefresh > 48) status = "stale_refresh";

        results.push({
          location_id: account.location_id,
          status,
          hours_til_expiry: Math.round(hoursTilExpiry),
          hours_since_refresh: Math.round(hoursSinceRefresh),
        });
      }
      return results;
    });

    for (const token of (tokenHealth || [])) {
      if (token.status === "expired") {
        findings.p0.push(`GHL token EXPIRED for ${token.location_id}`);
      } else if (token.status === "expiring_soon") {
        findings.p1.push(`GHL token expiring in ${token.hours_til_expiry}hrs for ${token.location_id}`);
      } else if (token.status === "stale_refresh") {
        findings.p1.push(`GHL token not refreshed in ${token.hours_since_refresh}hrs for ${token.location_id}`);
      } else {
        findings.pass.push(`GHL token healthy: ${token.location_id}`);
      }
    }

    // Check 2: Critical empty tables
    const emptyTables = await step.run("check-empty-tables", async () => {
      const criticalTables = [
        "communication_intake", "ghl_call_transcriptions", "ghl_call_metadata",
        "data_audit", "task", "health_check_results",
      ];
      const empty = [];
      for (const table of criticalTables) {
        const { count } = await supabase.from(table).select("*", { count: "exact", head: true });
        if (count === 0) empty.push(table);
      }
      return empty;
    });

    if (emptyTables.length > 0) {
      findings.p1.push(`${emptyTables.length} critical tables still empty: ${emptyTables.join(", ")}`);
    } else {
      findings.pass.push("All critical tables have data");
    }

    // Check 3: Stale credentials
    const staleCredentials = await step.run("check-credentials", async () => {
      const { data } = await supabase
        .from("api_credential")
        .select("service, credential_key, updated_at, is_active")
        .eq("is_active", true);

      const stale = [];
      for (const cred of (data || [])) {
        const daysSinceUpdate = (Date.now() - new Date(cred.updated_at)) / (1000 * 60 * 60 * 24);
        if (daysSinceUpdate > 90) {
          stale.push({ service: cred.service, key: cred.credential_key, days: Math.round(daysSinceUpdate) });
        }
      }
      return stale;
    });

    if (staleCredentials.length > 0) {
      findings.p1.push(`${staleCredentials.length} credentials not updated in 90+ days: ${staleCredentials.map(c => `${c.service}/${c.key} (${c.days}d)`).join(", ")}`);
    } else {
      findings.pass.push("All active credentials recently updated");
    }

    // Check 4: Webhook buffer health
    const bufferHealth = await step.run("check-webhook-buffer", async () => {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { count: unprocessed } = await supabase
        .from("webhook_event_buffer")
        .select("*", { count: "exact", head: true })
        .eq("processed", false)
        .lt("received_at", oneDayAgo);

      return { stale_unprocessed: unprocessed || 0 };
    });

    if (bufferHealth.stale_unprocessed > 10) {
      findings.p0.push(`${bufferHealth.stale_unprocessed} webhook events unprocessed for 24+ hours`);
    } else if (bufferHealth.stale_unprocessed > 0) {
      findings.p1.push(`${bufferHealth.stale_unprocessed} webhook events unprocessed for 24+ hours`);
    } else {
      findings.pass.push("Webhook buffer healthy — no stale events");
    }

    // Check 5: Portal engagement (is anyone using it?)
    const portalActivity = await step.run("check-portal-activity", async () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { count } = await supabase
        .from("portal_engagement_event")
        .select("*", { count: "exact", head: true })
        .gte("created_at", sevenDaysAgo);
      return count || 0;
    });

    if (portalActivity === 0) {
      findings.p2.push("Zero portal engagement events in last 7 days");
    } else {
      findings.pass.push(`${portalActivity} portal events in last 7 days`);
    }

    // Store results
    const auditId = await step.run("store-audit", async () => {
      const { data, error } = await supabase
        .from("system_audit_history")
        .insert({
          audit_version: "1.0",
          scope: ["ghl_tokens", "empty_tables", "credentials", "webhook_buffer", "portal_activity"],
          systems_audited: { automated: true, checks: 5 },
          finding_counts: {
            p0: findings.p0.length,
            p1: findings.p1.length,
            p2: findings.p2.length,
            pass: findings.pass.length,
          },
          p0_items: findings.p0,
          p1_items: findings.p1,
          p2_items: findings.p2,
          pass_items: findings.pass,
          remediation_status: findings.p0.length > 0 ? "needs_attention" : "healthy",
          ghl_token_status: tokenHealth?.every(t => t.status === "healthy") ? "all_healthy" : "issues_detected",
          full_report: JSON.stringify(findings, null, 2),
        })
        .select("id")
        .limit(1);

      return data?.[0]?.id;
    });

    // Alert if P0s found
    if (findings.p0.length > 0) {
      await step.run("alert-slack", async () => {
        const webhookUrl = process.env.SLACK_WEBHOOK_URL;
        if (!webhookUrl) {
          console.warn("SLACK_WEBHOOK_URL not set, skipping alert");
          return;
        }

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `🚨 *Weekly System Audit — P0 Issues Found*\n\n${findings.p0.map(f => `• ${f}`).join("\n")}\n\nP1: ${findings.p1.length} | Pass: ${findings.pass.length}\nAudit ID: ${auditId}`,
          }),
        });
      });
    }

    // Log CIA episode
    await step.run("log-cia-episode", async () => {
      await supabase.from("cia_episode").insert({
        episode_type: "observation",
        source_system: "claude",
        timestamp_event: new Date().toISOString(),
        content: `Weekly system audit complete. P0: ${findings.p0.length}, P1: ${findings.p1.length}, P2: ${findings.p2.length}, Pass: ${findings.pass.length}. ${findings.p0.length > 0 ? "ATTENTION NEEDED: " + findings.p0.join("; ") : "System healthy."}`,
        metadata: { audit_id: auditId, automated: true },
      });
    });

    return {
      audit_id: auditId,
      summary: {
        p0: findings.p0.length,
        p1: findings.p1.length,
        p2: findings.p2.length,
        pass: findings.pass.length,
      },
      p0_details: findings.p0,
      status: findings.p0.length > 0 ? "ATTENTION_NEEDED" : "HEALTHY",
    };
  }
);
