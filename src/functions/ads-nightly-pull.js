import { inngest } from '../inngest-client.js';
import { supabase } from '../supabase-client.js';

export const adsNightlyPull = inngest.createFunction(
  {
    id: 'ads-nightly-pull',
    name: 'Ads Nightly Pull',
    retries: 3,
  },
  { cron: '30 2 * * *' }, // 2:30am daily
  async ({ step, logger }) => {

    const clients = await step.run('get-clients-with-ads', async () => {
      const { data, error } = await supabase
        .from('customer')
        .select('id, company_name, google_ads_customer_id, facebook_ad_account_id')
        .eq('status', 'active')
        .or('google_ads_customer_id.not.is.null,facebook_ad_account_id.not.is.null');

      if (error) throw new Error(`Failed to fetch ad clients: ${error.message}`);
      return data;
    });

    if (!clients || clients.length === 0) {
      return { message: 'No clients with ads configured', processed: 0 };
    }

    const results = [];
    for (const client of clients) {
      const result = await step.run(`pull-ads-${client.id}`, async () => {
        logger.info(`Pulling ad data for ${client.company_name}`);

        const { error } = await supabase
          .from('ppc_campaign_data')
          .upsert({
            customer_id: client.id,
            snapshot_date: new Date().toISOString().split('T')[0],
            pulled_at: new Date().toISOString(),
            status: 'pending_credentials',
          }, { onConflict: 'customer_id,snapshot_date' });

        if (error) throw new Error(`Write failed for ${client.company_name}: ${error.message}`);
        return { client_id: client.id, status: 'ok' };
      });
      results.push(result);
    }

    return { processed: results.length, results };
  }
);
