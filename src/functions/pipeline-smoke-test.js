import { inngest } from '../inngest-client.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function sendSlackAlert(failedChecks) {
  const webhookURL = process.env.SLACK_WEBHOOK_URL;
  if (!webhookURL) return;

  const message = {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Pipeline Smoke Test Alert' },
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

export const pipelineSmokeTest = inngest.createFunction(
  {
    id: 'pipeline-smoke-test',
    name: 'Pipeline Smoke Test - Webhook to Supabase Verification',
  },
  { cron: '0 8 * * *' },
  async ({ step }) => {
    const failedChecks = [];

    // Step 1: Check recent webhook activity
    const webhookActivity = await step.run('check-recent-webhook-activity', async () => {
      try {
        // Get events from last 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from('webhook_event_buffer')
          .select('status, received_at')
          .gte('received_at', sevenDaysAgo);

        if (error) {
          return { passed: false, error: error.message };
        }

        const eventCount = data ? data.length : 0;
        const processedCount = data
          ? data.filter((e) => e.status === 'processed').length
          : 0;
        const latestEvent =
          data && data.length > 0
            ? data.reduce((latest, e) =>
                e.received_at > latest ? e.received_at : latest,
              data[0].received_at)
            : null;

        // Check if we have active GHL sub-accounts
        const { data: activeAccounts, error: accountError } = await supabase
          .from('ghl_sub_accounts')
          .select('id')
          .eq('is_active', true)
          .limit(1);

        if (accountError) {
          return { passed: false, error: accountError.message };
        }

        const hasActiveAccounts = activeAccounts && activeAccounts.length > 0;

        // Zero events with active accounts is suspicious
        if (eventCount === 0 && hasActiveAccounts) {
          return {
            passed: false,
            event_count: 0,
            processed_count: 0,
            latest_event: null,
            note: 'No webhook events in 7 days but active GHL sub-accounts exist',
          };
        }

        return {
          passed: true,
          event_count: eventCount,
          processed_count: processedCount,
          latest_event: latestEvent,
        };
      } catch (error) {
        return {
          passed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

    if (!webhookActivity.passed) {
      failedChecks.push(
        `Webhook activity: ${webhookActivity.error || webhookActivity.note || 'Unknown issue'}`
      );
    }

    // Step 2: Check Inngest function registry
    const functionRegistry = await step.run('check-inngest-function-registry', async () => {
      try {
        const { data, error } = await supabase
          .from('inngest_function_registry')
          .select('id')
          .eq('status', 'active');

        if (error) {
          return { passed: false, error: error.message };
        }

        const count = data ? data.length : 0;
        return {
          passed: true,
          active_function_count: count,
        };
      } catch (error) {
        return {
          passed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

    if (!functionRegistry.passed) {
      failedChecks.push(
        `Inngest function registry: ${functionRegistry.error}`
      );
    }

    // Step 3: Check communication pipeline
    const communicationPipeline = await step.run('check-communication-pipeline', async () => {
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // Get total count
        const { data: allData, error: allError } = await supabase
          .from('communication_intake')
          .select('id, created_at, action_routed');

        if (allError) {
          return { passed: false, error: allError.message };
        }

        const total = allData ? allData.length : 0;
        const last7Days = allData
          ? allData.filter((r) => r.created_at > sevenDaysAgo).length
          : 0;
        const routed = allData
          ? allData.filter((r) => r.action_routed === true).length
          : 0;

        return {
          passed: true,
          total,
          last_7_days: last7Days,
          routed,
        };
      } catch (error) {
        return {
          passed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

    if (!communicationPipeline.passed) {
      failedChecks.push(
        `Communication pipeline: ${communicationPipeline.error}`
      );
    }

    // Step 4: Check credential freshness
    const credentialFreshness = await step.run('check-credential-freshness', async () => {
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from('api_credential')
          .select('id, service, updated_at')
          .lt('updated_at', thirtyDaysAgo)
          .in('service', ['ghl', 'openrouter', 'anthropic', 'resend', 'slack']);

        if (error) {
          return { passed: false, error: error.message };
        }

        const staleCredentials = data || [];
        return {
          passed: staleCredentials.length === 0,
          stale_credentials: staleCredentials.map((c) => ({
            id: c.id,
            service: c.service,
            updated_at: c.updated_at,
          })),
        };
      } catch (error) {
        return {
          passed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

    if (!credentialFreshness.passed) {
      if (credentialFreshness.error) {
        failedChecks.push(`Credential freshness: ${credentialFreshness.error}`);
      }
      if (credentialFreshness.stale_credentials && credentialFreshness.stale_credentials.length > 0) {
        const staleList = credentialFreshness.stale_credentials
          .map((c) => `${c.service} (${c.id}, last updated ${c.updated_at})`)
          .join(', ');
        failedChecks.push(`Stale credentials (>30 days): ${staleList}`);
      }
    }

    // Step 5: Report
    await step.run('report', async () => {
      const allPassed = failedChecks.length === 0;
      const timestamp = new Date().toISOString();

      const summary = [
        `Webhooks: ${webhookActivity.event_count ?? '?'} events (7d), ${webhookActivity.processed_count ?? '?'} processed`,
        `Functions: ${functionRegistry.active_function_count ?? '?'} active`,
        `Comms: ${communicationPipeline.total ?? '?'} total, ${communicationPipeline.last_7_days ?? '?'} last 7d, ${communicationPipeline.routed ?? '?'} routed`,
        `Credentials: ${credentialFreshness.stale_credentials?.length ?? '?'} stale`,
      ].join('. ');

      // Write to cia_episode
      await supabase.from('cia_episode').insert({
        episode_type: 'measurement',
        source_system: 'claude',
        content: allPassed
          ? `Pipeline smoke test passed. ${summary}`
          : `Pipeline smoke test FAILED. ${failedChecks.length} issue(s): ${failedChecks.join('; ')}. ${summary}`,
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
      webhook_activity: webhookActivity,
      function_registry: functionRegistry,
      communication_pipeline: communicationPipeline,
      credential_freshness: credentialFreshness,
    };
  }
);
