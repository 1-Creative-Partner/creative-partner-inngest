// GHL OAuth Token Refresh — P1-003
// Refreshes OAuth access tokens for ALL active GHL sub-accounts every 20 hours.
//
// WHY THIS MATTERS:
//   GHL OAuth tokens expire after 24 hours. Each refresh issues a NEW refresh_token —
//   the old one is immediately invalidated. This function must write the new tokens
//   to ghl_sub_accounts before the next API call or the account locks out permanently.
//
// ACCOUNTS COVERED:
//   - Creative Partner (VpL3sVe4Vb1ANBx9DOL6)
//   - Bailey Brothers (1g6SSCGibOPFz5vLATNV)
//   - JumpStart 2 Recovery (C6ALWYCMrzuUGZQWGS33)
//   - Any future sub-accounts added to ghl_sub_accounts WHERE is_active = true
//
// BLAST RADIUS IF THIS FAILS:
//   All GHL API calls (CRM Bridge, n8n, Inngest functions using GHL) will 401.
//   Client automations stop. GHL contact sync stops. CIA model goes stale for all GHL data.

import { inngest } from '../../inngest-client.js';
import { supabase } from '../../supabase-client.js';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const GHL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';
// Token lifetime: 24 hours. Refresh at 20 hours = 4-hour safety buffer.
const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const ghlOauthRefresh = inngest.createFunction(
  {
    id: 'ghl-oauth-refresh',
    name: 'GHL OAuth Token Refresh',
    retries: 3,
    // Concurrency: only one refresh run at a time to prevent race conditions
    // where two concurrent refreshes both use the same refresh_token and one invalidates the other.
    concurrency: { limit: 1 },
  },
  [
    { cron: 'TZ=America/New_York 0 */20 * * *' }, // Every 20 hours — stays well within 24h expiry
    { event: 'cp/ghl.token.refresh.requested' },  // Manual trigger for immediate refresh
  ],
  async ({ step, logger }) => {

    // ─── Step 1: Load GHL OAuth app credentials ──────────────────────────────
    const appCreds = await step.run('load-ghl-app-credentials', async () => {
      const { data, error } = await supabase
        .from('system_awareness')
        .select('structured_data')
        .eq('awareness_key', 'ghl_oauth_app')
        .single();

      if (error) throw new Error(`Failed to load GHL OAuth app credentials: ${error.message}`);
      if (!data?.structured_data?.client_id) throw new Error('No client_id in ghl_oauth_app awareness');
      if (!data?.structured_data?.client_secret) throw new Error('No client_secret in ghl_oauth_app awareness');

      logger.info(`GHL app credentials loaded. client_id: ${data.structured_data.client_id}`);
      return {
        client_id: data.structured_data.client_id,
        client_secret: data.structured_data.client_secret,
      };
    });

    // ─── Step 2: Load all active sub-accounts ────────────────────────────────
    const subAccounts = await step.run('load-active-sub-accounts', async () => {
      const { data, error } = await supabase
        .from('ghl_sub_accounts')
        .select('id, location_id, location_name, refresh_token, token_expires_at')
        .eq('is_active', true)
        .not('refresh_token', 'is', null);

      if (error) throw new Error(`Failed to load GHL sub-accounts: ${error.message}`);
      if (!data || data.length === 0) throw new Error('No active GHL sub-accounts found with refresh tokens');

      logger.info(`Found ${data.length} active sub-accounts to refresh`);
      return data;
    });

    // ─── Step 3: Refresh each sub-account token independently ────────────────
    // Each account runs in its own step so one failure doesn't block others.
    const results = [];
    for (const account of subAccounts) {
      const result = await step.run(`refresh-token-${account.location_id}`, async () => {
        logger.info(`Refreshing token for: ${account.location_name} (${account.location_id})`);

        // Call GHL OAuth token refresh endpoint
        const params = new URLSearchParams({
          client_id: appCreds.client_id,
          client_secret: appCreds.client_secret,
          grant_type: 'refresh_token',
          refresh_token: account.refresh_token,
          user_type: 'Location',
        });

        const res = await fetch(GHL_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`GHL token refresh failed for ${account.location_name} (${res.status}): ${errorText}`);
        }

        const tokenData = await res.json();

        if (!tokenData.access_token) {
          throw new Error(`No access_token in GHL response for ${account.location_name}: ${JSON.stringify(tokenData)}`);
        }
        if (!tokenData.refresh_token) {
          throw new Error(`No refresh_token in GHL response for ${account.location_name} — CRITICAL: old token was consumed but no new one returned`);
        }

        const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString();
        const refreshedAt = new Date().toISOString();

        // Immediately write new tokens — old refresh_token is now invalid
        const { error: updateError } = await supabase
          .from('ghl_sub_accounts')
          .update({
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            token_expires_at: expiresAt,
            updated_at: refreshedAt,
          })
          .eq('id', account.id);

        if (updateError) {
          // This is the worst-case scenario: token was refreshed but we can't save it.
          // The old refresh_token is already invalid. Log everything for manual recovery.
          throw new Error(
            `CRITICAL: Token refreshed for ${account.location_name} but DB write failed: ${updateError.message}. ` +
            `New access_token starts with: ${tokenData.access_token.slice(0, 20)}...`
          );
        }

        // Log to monitoring_events (non-fatal if fails)
        const { error: monitorError } = await supabase.from('monitoring_events').insert({
          event_type: 'ghl_token_refresh',
          severity: 'info',
          source: 'inngest_ghl_oauth_refresh',
          location_id: account.location_id,
          location_name: account.location_name,
          message: `GHL OAuth token refreshed successfully for ${account.location_name || account.location_id}`,
          details: {
            location_id: account.location_id,
            previous_expiry: account.token_expires_at,
            new_expiry: expiresAt,
            refreshed_at: refreshedAt,
          },
          resolved: true,
        });
        if (monitorError) logger.warn(`monitoring_events insert failed (non-fatal): ${monitorError.message}`);

        // Sync to api_credential so legacy consumers (deal-detector, etc.) get fresh tokens too
        // The credential_value is JSON with a "token" field that consumers parse
        const locationCredMap = {
          'VpL3sVe4Vb1ANBx9DOL6': 'pit_creative_partner',
          'C6ALWYCMrzuUGZQWGS33': 'pit_jumpstart_2_recovery',
          '1g6SSCGibOPFz5vLATNV': 'pit_bailey_brothers',
        };
        const credKey = locationCredMap[account.location_id];
        if (credKey) {
          const credValue = JSON.stringify({
            token: tokenData.access_token,
            location: account.location_name,
            location_id: account.location_id,
            refreshed: refreshedAt,
            expires: expiresAt,
          });
          const { error: credErr } = await supabase
            .from('api_credential')
            .update({ credential_value: credValue, updated_at: refreshedAt })
            .eq('service', 'ghl')
            .eq('credential_key', credKey);
          if (credErr) logger.warn(`api_credential sync failed for ${credKey} (non-fatal): ${credErr.message}`);
          else logger.info(`api_credential synced for ${credKey}`);
        }

        logger.info(`Token refreshed and saved for ${account.location_name}. New expiry: ${expiresAt}`);
        return {
          success: true,
          location_id: account.location_id,
          location_name: account.location_name,
          new_expiry: expiresAt,
        };
      });

      results.push(result);
    }

    // ─── Step 4: Send Slack alert for any failures ────────────────────────────
    const failures = results.filter(r => !r.success);
    if (failures.length > 0 && SLACK_WEBHOOK_URL) {
      await step.run('slack-alert-failures', async () => {
        const payload = {
          text: `*GHL OAuth Refresh: ${failures.length} FAILURE(S)*`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*GHL Token Refresh Failed* — ${failures.length} of ${results.length} accounts\n\n*Failed accounts:*\n${failures.map(f => `• ${f.location_name || f.location_id}: ${f.error}`).join('\n')}\n\n:warning: These accounts will fail all GHL API calls until tokens are manually refreshed.`,
              },
            },
          ],
        };

        const res = await fetch(SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) logger.warn(`Slack alert failed: ${res.status}`);
        else logger.info('Slack failure alert sent to #system-alerts');
      });
    }

    // ─── Step 5: Log summary to cia_episode ──────────────────────────────────
    await step.run('log-cia-episode', async () => {
      const successCount = results.filter(r => r.success).length;
      const failCount = failures.length;

      const { error } = await supabase.from('cia_episode').insert({
        episode_type: 'measurement',
        source_system: 'claude',
        actor: 'GHL OAuth Refresh',
        content: `GHL OAuth token refresh complete. ${successCount}/${results.length} accounts refreshed successfully.${failCount > 0 ? ` ${failCount} failures — check #system-alerts.` : ' All tokens current.'}`,
        metadata: {
          function_id: 'ghl-oauth-refresh',
          accounts_refreshed: successCount,
          accounts_failed: failCount,
          accounts: results.map(r => ({
            location_id: r.location_id,
            location_name: r.location_name,
            success: r.success,
            new_expiry: r.new_expiry,
          })),
        },
        timestamp_event: new Date().toISOString(),
      });

      if (error) logger.warn(`CIA episode log failed (non-fatal): ${error.message}`);
    });

    const successCount = results.filter(r => r.success).length;
    return {
      success: failures.length === 0,
      accounts_refreshed: successCount,
      accounts_failed: failures.length,
      results,
    };
  }
);
