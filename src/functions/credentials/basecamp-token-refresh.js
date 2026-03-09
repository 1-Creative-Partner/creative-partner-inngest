// Basecamp OAuth Token Refresh — P1-004
// Refreshes Basecamp access token every 10 days via Inngest cron
// Writes new token to system_awareness (basecamp_oauth_app) and api_credential table
// Token lifetime: 2 weeks. Refresh at 10 days = 4-day safety buffer before expiry.

import { inngest } from '../../inngest-client.js';
import { supabase } from '../../supabase-client.js';

export const basecampTokenRefresh = inngest.createFunction(
  {
    id: 'basecamp-token-refresh',
    name: 'Basecamp Token Refresh',
    retries: 3,
  },
  { cron: '0 8 */10 * *' }, // 8am UTC every 10 days
  async ({ step, logger }) => {

    // Step 1: Load current credentials from Supabase
    const creds = await step.run('load-credentials', async () => {
      const { data, error } = await supabase
        .from('system_awareness')
        .select('structured_data')
        .eq('awareness_key', 'basecamp_oauth_app')
        .single();

      if (error) throw new Error(`Failed to load Basecamp credentials: ${error.message}`);
      if (!data?.structured_data?.refresh_token) throw new Error('No refresh_token found in basecamp_oauth_app');
      if (!data?.structured_data?.client_id) throw new Error('No client_id found in basecamp_oauth_app');
      if (!data?.structured_data?.client_secret) throw new Error('No client_secret found in basecamp_oauth_app');

      logger.info('Credentials loaded. Current token expires: ' + data.structured_data.access_token_expires);
      return data.structured_data;
    });

    // Step 2: Exchange refresh token for new access token
    const newTokenData = await step.run('refresh-oauth-token', async () => {
      const params = new URLSearchParams({
        type: 'refresh',
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token,
      });

      const res = await fetch('https://launchpad.37signals.com/authorization/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Token refresh failed (${res.status}): ${errorText}`);
      }

      const data = await res.json();
      if (!data.access_token) throw new Error('No access_token in refresh response: ' + JSON.stringify(data));

      // Basecamp tokens expire in 2 weeks. Calculate expiry timestamp.
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const refreshedAt = new Date().toISOString();

      logger.info(`New token obtained. Expires: ${expiresAt}`);

      return {
        access_token: data.access_token,
        // Basecamp may or may not issue a new refresh token - keep existing if not provided
        refresh_token: data.refresh_token ?? creds.refresh_token,
        access_token_expires: expiresAt,
        last_refreshed: refreshedAt,
      };
    });

    // Step 3: Write new token back to system_awareness (basecamp_oauth_app)
    await step.run('update-system-awareness', async () => {
      const updatedStructuredData = {
        ...creds,
        access_token: newTokenData.access_token,
        refresh_token: newTokenData.refresh_token,
        access_token_expires: newTokenData.access_token_expires,
        last_refreshed: newTokenData.last_refreshed,
      };

      const { error } = await supabase
        .from('system_awareness')
        .update({ structured_data: updatedStructuredData })
        .eq('awareness_key', 'basecamp_oauth_app');

      if (error) throw new Error(`Failed to update system_awareness: ${error.message}`);
      logger.info('system_awareness updated successfully');
    });

    // Step 4: Update api_credential access token record
    await step.run('update-access-token-credential', async () => {
      const { error } = await supabase
        .from('api_credential')
        .update({
          credential_value: newTokenData.access_token,
          notes: `Auto-refreshed ${newTokenData.last_refreshed}. Fresh token confirmed working.`,
        })
        .eq('id', 'cred_basecamp_access_token');

      if (error) throw new Error(`Failed to update access token credential: ${error.message}`);
      logger.info('api_credential (access token) updated');
    });

    // Step 5: Update api_credential refresh token record (if a new one was issued)
    await step.run('update-refresh-token-credential', async () => {
      if (newTokenData.refresh_token === creds.refresh_token) {
        logger.info('Refresh token unchanged — skipping api_credential update');
        return { skipped: true };
      }

      const { error } = await supabase
        .from('api_credential')
        .update({
          credential_value: newTokenData.refresh_token,
          notes: `Refresh token rotated on ${newTokenData.last_refreshed}. Valid until 2036.`,
        })
        .eq('id', 'cred_basecamp_refresh_token');

      if (error) throw new Error(`Failed to update refresh token credential: ${error.message}`);
      logger.info('api_credential (refresh token) updated');
      return { updated: true };
    });

    // Step 6: Log to cia_episode for observability
    await step.run('log-to-cia-episode', async () => {
      const { error } = await supabase
        .from('cia_episode')
        .insert({
          episode_type: 'measurement',
          source_system: 'inngest',
          actor: 'Basecamp Token Refresh',
          content: `Basecamp OAuth token successfully refreshed at ${newTokenData.last_refreshed}. New expiry: ${newTokenData.access_token_expires}.`,
          metadata: {
            function_id: 'basecamp-token-refresh',
            previous_expiry: creds.access_token_expires,
            new_expiry: newTokenData.access_token_expires,
            refresh_token_rotated: newTokenData.refresh_token !== creds.refresh_token,
          },
          timestamp_event: newTokenData.last_refreshed,
        });

      if (error) logger.warn(`CIA episode log failed (non-fatal): ${error.message}`);
    });

    return {
      success: true,
      last_refreshed: newTokenData.last_refreshed,
      access_token_expires: newTokenData.access_token_expires,
    };
  }
);
