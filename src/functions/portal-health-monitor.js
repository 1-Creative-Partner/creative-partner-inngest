import { inngest } from '../inngest-client.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PORTAL_BASE = 'https://portal.creativepartnersolutions.com';
const INNGEST_HEALTH_URL = 'https://creative-partner-inngest.onrender.com/health';

const PORTAL_ROUTES = [
  { name: 'Landing', url: `${PORTAL_BASE}/landing` },
  { name: 'Portal (Bailey Brothers)', url: `${PORTAL_BASE}/portal/bailey-brothers` },
  { name: 'Review (David Wilson)', url: `${PORTAL_BASE}/review/david-wilson` },
  { name: 'Proposals (Bailey Brothers)', url: `${PORTAL_BASE}/proposals/bailey-brothers` },
  { name: 'Admin Login', url: `${PORTAL_BASE}/admin/login` },
];

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function sendSlackAlert(failedChecks) {
  const webhookURL = process.env.SLACK_WEBHOOK_URL;
  if (!webhookURL) return;

  const message = {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Portal Health Alert' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Failed checks:*\n' + failedChecks.join('\n'),
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Checked at ' + new Date().toISOString(),
          },
        ],
      },
    ],
  };

  await fetch(webhookURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
}

export const portalHealthMonitor = inngest.createFunction(
  {
    id: 'portal-health-monitor',
    name: 'Portal Health Monitor - Routes, Inngest, Supabase, GHL Tokens',
  },
  { cron: '0 */6 * * *' },
  async ({ step }) => {
    const failedChecks = [];

    // Step 1: Check portal routes
    const routeResults = await step.run('check-portal-routes', async () => {
      const results = [];
      for (const route of PORTAL_ROUTES) {
        try {
          const response = await fetchWithTimeout(route.url);
          const passed = response.status === 200;
          results.push({
            name: route.name,
            url: route.url,
            status: response.status,
            passed,
          });
          if (!passed) {
            results.push({ _failed: `${route.name}: HTTP ${response.status}` });
          }
        } catch (error) {
          results.push({
            name: route.name,
            url: route.url,
            status: 0,
            passed: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            _failed: `${route.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }
      return results;
    });

    for (const r of routeResults) {
      if (r._failed) {
        failedChecks.push(r._failed);
      }
    }

    // Step 2: Check Inngest health endpoint
    const inngestResult = await step.run('check-inngest-health', async () => {
      try {
        const response = await fetchWithTimeout(INNGEST_HEALTH_URL);
        if (!response.ok) {
          return { passed: false, error: `HTTP ${response.status}` };
        }
        const data = await response.json();
        const passed = data.status === 'ok';
        return { passed, data };
      } catch (error) {
        return {
          passed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

    if (!inngestResult.passed) {
      failedChecks.push(`Inngest health: ${inngestResult.error || 'status not ok'}`);
    }

    // Step 3: Check Supabase health
    const supabaseResult = await step.run('check-supabase-health', async () => {
      try {
        const { data, error } = await supabase
          .from('customer')
          .select('id', { count: 'exact', head: true });
        if (error) {
          return { passed: false, error: error.message };
        }
        // head:true returns count in the response metadata
        // Just verify we can query without error
        return { passed: true, count: data?.length ?? 0 };
      } catch (error) {
        return {
          passed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

    if (!supabaseResult.passed) {
      failedChecks.push(`Supabase health: ${supabaseResult.error}`);
    }

    // Step 4: Check GHL token freshness
    const ghlTokenResult = await step.run('check-ghl-tokens', async () => {
      try {
        const { data, error } = await supabase
          .from('ghl_sub_accounts')
          .select('location_name, token_expires_at')
          .eq('is_active', true);
        if (error) {
          return { passed: false, error: error.message, tokens: [] };
        }
        if (!data || data.length === 0) {
          return { passed: true, tokens: [], note: 'No active GHL sub-accounts found' };
        }

        const now = new Date();
        const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        const expiring = [];

        for (const account of data) {
          if (account.token_expires_at) {
            const expiresAt = new Date(account.token_expires_at);
            if (expiresAt <= twoHoursFromNow) {
              expiring.push(
                `${account.location_name}: expires at ${account.token_expires_at}`
              );
            }
          }
        }

        return {
          passed: expiring.length === 0,
          tokens: data,
          expiring,
        };
      } catch (error) {
        return {
          passed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          tokens: [],
        };
      }
    });

    if (!ghlTokenResult.passed) {
      if (ghlTokenResult.error) {
        failedChecks.push(`GHL tokens: ${ghlTokenResult.error}`);
      }
      if (ghlTokenResult.expiring && ghlTokenResult.expiring.length > 0) {
        for (const msg of ghlTokenResult.expiring) {
          failedChecks.push(`GHL token expiring: ${msg}`);
        }
      }
    }

    // Step 5: Report results
    await step.run('report-results', async () => {
      const allPassed = failedChecks.length === 0;
      const timestamp = new Date().toISOString();

      // Write to cia_episode
      await supabase.from('cia_episode').insert({
        episode_type: 'measurement',
        source_system: 'claude',
        content: allPassed
          ? `Portal health check passed. All routes responding, Inngest healthy, Supabase connected, GHL tokens valid.`
          : `Portal health check FAILED. ${failedChecks.length} issue(s): ${failedChecks.join('; ')}`,
        timestamp_event: timestamp,
      });

      // If any check failed, alert via Slack
      if (!allPassed) {
        await sendSlackAlert(failedChecks);
      }
    });

    return {
      timestamp: new Date().toISOString(),
      all_passed: failedChecks.length === 0,
      failed_count: failedChecks.length,
      failed_checks: failedChecks,
    };
  }
);
