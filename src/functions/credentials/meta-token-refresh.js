// Meta Marketing API Token Refresh — P1-005
// Refreshes Meta long-lived user access token every 20 days via Inngest cron
// Token lifetime: ~60 days. 20-day cron = safe refresh cadence.
// Threshold guard: skips refresh if token has >15 days remaining.
//
// Meta token refresh flow (server-side, no user interaction required):
//   GET https://graph.facebook.com/oauth/access_token
//     ?grant_type=fb_exchange_token
//     &client_id={app_id}
//     &client_secret={app_secret}
//     &fb_exchange_token={current_long_lived_token}
// → Returns a new long-lived token valid for 60 more days.
//
// Supabase: reads/writes api_credential table directly (no system_awareness entry for Meta)
// App ID: 1558710265420502 (Creative Partner Ads)
// User ID: 26297979906494387 (Chad Morgan)

import { inngest } from '../../inngest-client.js';
import { supabase } from '../../supabase-client.js';

const META_TOKEN_CREDENTIAL_ID = 'ac_cdbe3ebd-88d3-4143-a777-660564960458';
const META_APP_SECRET_CREDENTIAL_ID = 'a6ee3e7c-a8a7-4312-9011-bf4dc89d46e0';
const META_APP_ID = '1558710265420502';
const GRAPH_API_VERSION = 'v22.0';
// Refresh threshold: if token expires in ≤ 15 days, refresh. Otherwise skip.
const REFRESH_THRESHOLD_DAYS = 15;

export const metaTokenRefresh = inngest.createFunction(
  {
    id: 'meta-token-refresh',
    name: 'Meta Token Refresh',
    retries: 3,
  },
  { cron: '0 9 */20 * *' }, // 9am UTC every 20 days
  async ({ step, logger }) => {

    // Step 1: Load current token and app secret from api_credential
    const creds = await step.run('load-meta-credentials', async () => {
      const { data: tokenRow, error: tokenError } = await supabase
        .from('api_credential')
        .select('credential_value, expires_at, notes')
        .eq('id', META_TOKEN_CREDENTIAL_ID)
        .single();

      if (tokenError) throw new Error(`Failed to load Meta token credential: ${tokenError.message}`);
      if (!tokenRow?.credential_value) throw new Error('No token value found for Meta credential');

      const { data: secretRow, error: secretError } = await supabase
        .from('api_credential')
        .select('credential_value')
        .eq('id', META_APP_SECRET_CREDENTIAL_ID)
        .single();

      if (secretError) throw new Error(`Failed to load Meta app secret: ${secretError.message}`);
      if (!secretRow?.credential_value) throw new Error('No app secret found in api_credential');

      logger.info(`Meta token loaded. Current expiry: ${tokenRow.expires_at}`);

      return {
        access_token: tokenRow.credential_value,
        app_secret: secretRow.credential_value,
        expires_at: tokenRow.expires_at,
        current_notes: tokenRow.notes,
      };
    });

    // Step 2: Check if refresh is needed (threshold guard)
    const shouldRefresh = await step.run('check-refresh-needed', async () => {
      if (!creds.expires_at) {
        logger.info('No expiry date on record — proceeding with refresh to be safe');
        return true;
      }

      const expiryDate = new Date(creds.expires_at);
      const now = new Date();
      const daysUntilExpiry = (expiryDate - now) / (1000 * 60 * 60 * 24);

      logger.info(`Days until Meta token expiry: ${daysUntilExpiry.toFixed(1)}`);

      if (daysUntilExpiry > REFRESH_THRESHOLD_DAYS) {
        logger.info(`Token is healthy (${daysUntilExpiry.toFixed(1)} days remaining). Skipping refresh.`);
        return false;
      }

      logger.info(`Token expires in ${daysUntilExpiry.toFixed(1)} days — initiating refresh`);
      return true;
    });

    if (!shouldRefresh) {
      return {
        success: true,
        action: 'skipped',
        reason: 'Token still healthy — more than 15 days until expiry',
        expires_at: creds.expires_at,
      };
    }

    // Step 3: Exchange current long-lived token for a fresh 60-day token
    const newTokenData = await step.run('refresh-meta-token', async () => {
      const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`);
      url.searchParams.set('grant_type', 'fb_exchange_token');
      url.searchParams.set('client_id', META_APP_ID);
      url.searchParams.set('client_secret', creds.app_secret);
      url.searchParams.set('fb_exchange_token', creds.access_token);

      const res = await fetch(url.toString());
      const body = await res.json();

      if (!res.ok || body.error) {
        const errMsg = body.error
          ? `Meta API error ${body.error.code}: ${body.error.message}`
          : `HTTP ${res.status}: ${JSON.stringify(body)}`;
        throw new Error(`Meta token refresh failed — ${errMsg}`);
      }

      if (!body.access_token) {
        throw new Error('No access_token in Meta refresh response: ' + JSON.stringify(body));
      }

      // Meta returns expires_in in seconds
      const expiresInMs = (body.expires_in ?? 5184000) * 1000; // default 60 days if not provided
      const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
      const refreshedAt = new Date().toISOString();

      logger.info(`New Meta token obtained. Expires: ${expiresAt} (in ${body.expires_in}s)`);

      return {
        access_token: body.access_token,
        expires_at: expiresAt,
        refreshed_at: refreshedAt,
        expires_in_seconds: body.expires_in,
      };
    });

    // Step 4: Write new token back to api_credential
    await step.run('update-meta-token-credential', async () => {
      const updatedNotes = `Auto-refreshed by Inngest meta-token-refresh at ${newTokenData.refreshed_at}. `
        + `App: Creative Partner Ads (${META_APP_ID}). User: Chad Morgan. `
        + `Expires: ${newTokenData.expires_at}. `
        + `Permissions: ads_management, ads_read, read_insights, business_management, public_profile.`;

      const { error } = await supabase
        .from('api_credential')
        .update({
          credential_value: newTokenData.access_token,
          expires_at: newTokenData.expires_at,
          last_verified_at: newTokenData.refreshed_at,
          notes: updatedNotes,
        })
        .eq('id', META_TOKEN_CREDENTIAL_ID);

      if (error) throw new Error(`Failed to update Meta token in api_credential: ${error.message}`);
      logger.info('api_credential updated with new Meta token');
    });

    // Step 5: Verify the new token works by calling /me
    await step.run('verify-new-token', async () => {
      const verifyUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/me?access_token=${newTokenData.access_token}&fields=id,name`;
      const res = await fetch(verifyUrl);
      const body = await res.json();

      if (!res.ok || body.error) {
        // Non-fatal — token was saved, verification is best-effort
        logger.warn(`Token verification failed (non-fatal): ${JSON.stringify(body.error ?? body)}`);
        return { verified: false };
      }

      logger.info(`Token verified. User: ${body.name} (${body.id})`);
      return { verified: true, user_id: body.id, user_name: body.name };
    });

    // Step 6: Log to cia_episode for observability
    await step.run('log-to-cia-episode', async () => {
      const { error } = await supabase
        .from('cia_episode')
        .insert({
          episode_type: 'measurement',
          source_system: 'inngest',
          actor: 'Meta Token Refresh',
          content: `Meta Marketing API long-lived token successfully refreshed at ${newTokenData.refreshed_at}. New expiry: ${newTokenData.expires_at}.`,
          metadata: {
            function_id: 'meta-token-refresh',
            previous_expiry: creds.expires_at,
            new_expiry: newTokenData.expires_at,
            expires_in_seconds: newTokenData.expires_in_seconds,
            app_id: META_APP_ID,
          },
          timestamp_event: newTokenData.refreshed_at,
        });

      if (error) logger.warn(`CIA episode log failed (non-fatal): ${error.message}`);
    });

    return {
      success: true,
      action: 'refreshed',
      refreshed_at: newTokenData.refreshed_at,
      expires_at: newTokenData.expires_at,
    };
  }
);
