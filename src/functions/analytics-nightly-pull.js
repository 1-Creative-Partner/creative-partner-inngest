import { inngest } from '../inngest-client.js';
import { supabase } from '../supabase-client.js';

export const analyticsNightlyPull = inngest.createFunction(
  {
    id: 'analytics-nightly-pull',
    name: 'Analytics Nightly Pull',
    retries: 3,
  },
  { cron: '0 2 * * *' }, // 2am daily - same as n8n schedule
  async ({ step, logger }) => {

    // Step 1: Get active clients with GA4 or Search Console configured
    // If this fails, Inngest retries the whole function - nothing lost
    const clients = await step.run('get-active-clients', async () => {
      const { data, error } = await supabase
        .from('customer')
        .select('id, company_name, google_analytics_property_id, search_console_url')
        .eq('status', 'active')
        .not('google_analytics_property_id', 'is', null);

      if (error) throw new Error(`Failed to fetch clients: ${error.message}`);
      logger.info(`Found ${data.length} clients with analytics configured`);
      return data;
    });

    if (!clients || clients.length === 0) {
      return { message: 'No clients with analytics configured', processed: 0 };
    }

    // Step 2: Pull analytics per client
    // Each client is a separate step - if client 3 fails, clients 1+2 are already saved
    const results = [];
    for (const client of clients) {
      const result = await step.run(`pull-analytics-${client.id}`, async () => {
        try {
          // GA4 pull - replace with real GA4 API call once credentials configured
          // For now: log that we would pull data
          logger.info(`Pulling GA4 data for ${client.company_name} (${client.google_analytics_property_id})`);
          
          // Write snapshot to Supabase
          // Using service role key - no 401 errors possible
          const { error: writeError } = await supabase
            .from('analytics_snapshot')
            .upsert({
              customer_id: client.id,
              snapshot_date: new Date().toISOString().split('T')[0],
              source: 'ga4',
              pulled_at: new Date().toISOString(),
              status: 'pending_credentials', // Will be 'success' once GA4 creds added
            }, { onConflict: 'customer_id,snapshot_date,source' });

          if (writeError) throw new Error(`Supabase write failed: ${writeError.message}`);
          
          return { client_id: client.id, status: 'ok' };
        } catch (err) {
          // Throwing here causes Inngest to retry just this step
          throw new Error(`Analytics pull failed for ${client.company_name}: ${err.message}`);
        }
      });
      results.push(result);
    }

    // Step 3: Log completion
    await step.run('log-completion', async () => {
      const { error } = await supabase
        .from('system_evolution_log')
        .insert({
          actor: 'inngest',
          evolution_type: 'operational_decision',
          title: 'Analytics Nightly Pull Completed',
          domain: 'automation',
          trigger_context: 'Scheduled cron 2am daily',
          rationale: 'Automated analytics data collection',
          change_description: `Processed ${results.length} clients`,
          expected_outcome: 'Analytics snapshots updated in Supabase',
          lesson_learned: 'Inngest step-based execution prevents partial failures',
          impact_level: 'low',
          source: 'inngest.com',
          source_type: 'web_search',
        });
      if (error) logger.warn(`Could not log completion: ${error.message}`);
    });

    return { 
      processed: results.length, 
      results,
      completed_at: new Date().toISOString()
    };
  }
);
