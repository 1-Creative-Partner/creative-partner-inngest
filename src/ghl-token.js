// ghl-token.js — Single source of truth for GHL API tokens
//
// WHY THIS EXISTS:
//   Before this file, GHL tokens lived in TWO places that were never synced:
//   - ghl_sub_accounts: refreshed every 20hr by ghl-oauth-refresh (OAuth JWTs)
//   - api_credential: manually created PITs that went stale and broke everything
//
//   Every function (deal-detector, transcript-processor, client-onboarding, etc.)
//   read from api_credential and got expired tokens. The OAuth refresh that kept
//   ghl_sub_accounts current had zero consumers.
//
//   This utility reads from ghl_sub_accounts (the authoritative, auto-refreshed source).
//   All functions must use getGHLToken() — never query api_credential for GHL tokens directly.

import { supabase } from './supabase-client.js';

const CP_LOCATION_ID = 'VpL3sVe4Vb1ANBx9DOL6';

/**
 * Get a fresh GHL access token for a location.
 * Reads from ghl_sub_accounts (refreshed every 20hr by ghl-oauth-refresh).
 *
 * @param {string} [locationId] — defaults to Creative Partner location
 * @returns {Promise<string>} — Bearer-ready access token
 * @throws {Error} — if no active account or token is expired
 */
export async function getGHLToken(locationId = CP_LOCATION_ID) {
  const { data, error } = await supabase
    .from('ghl_sub_accounts')
    .select('access_token, token_expires_at, location_name, updated_at')
    .eq('location_id', locationId)
    .eq('is_active', true)
    .limit(1);

  if (error) {
    throw new Error(`Failed to fetch GHL token for ${locationId}: ${error.message}`);
  }

  const account = data?.[0];
  if (!account) {
    throw new Error(`No active GHL sub-account found for location ${locationId}`);
  }

  if (!account.access_token) {
    throw new Error(`GHL sub-account ${locationId} (${account.location_name}) has no access_token — run manual OAuth flow`);
  }

  // Warn if token is close to expiry (< 2 hours remaining)
  const expiresAt = new Date(account.token_expires_at);
  const hoursRemaining = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursRemaining < 0) {
    throw new Error(
      `GHL token for ${locationId} EXPIRED ${Math.abs(hoursRemaining).toFixed(1)}h ago. ` +
      `Last refresh: ${account.updated_at}. The ghl-oauth-refresh cron may be failing.`
    );
  }
  if (hoursRemaining < 2) {
    console.warn(
      `GHL token for ${locationId} expires in ${hoursRemaining.toFixed(1)}h — refresh should fire soon`
    );
  }

  return account.access_token;
}

/**
 * Get GHL tokens for ALL active locations.
 * Useful for batch operations across sub-accounts.
 *
 * @returns {Promise<Array<{location_id: string, location_name: string, access_token: string}>>}
 */
export async function getAllGHLTokens() {
  const { data, error } = await supabase
    .from('ghl_sub_accounts')
    .select('location_id, location_name, access_token, token_expires_at')
    .eq('is_active', true)
    .not('access_token', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch GHL tokens: ${error.message}`);
  }

  return (data || []).map(a => ({
    location_id: a.location_id,
    location_name: a.location_name,
    access_token: a.access_token,
    expires_at: a.token_expires_at,
  }));
}

// Location ID constants for convenience
export const GHL_LOCATIONS = {
  CREATIVE_PARTNER: 'VpL3sVe4Vb1ANBx9DOL6',
  BAILEY_BROTHERS: '1g6SSCGibOPFz5vLATNV',
  JUMPSTART_2_RECOVERY: 'C6ALWYCMrzuUGZQWGS33',
};
