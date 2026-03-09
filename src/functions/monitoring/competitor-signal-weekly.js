// Competitor Signal Weekly — P2-002
// Every Sunday 4am UTC: scan all active competitors across all clients,
// check for website changes via DataForSEO, log signals to competitor_pattern_analysis,
// flag high-threat competitors for review in cia_episode.

import { inngest } from '../../inngest-client.js';
import { supabase } from '../../supabase-client.js';

const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;

export const competitorSignalWeekly = inngest.createFunction(
  {
    id: 'competitor-signal-weekly',
    name: 'Competitor Signal Weekly',
    retries: 2,
  },
  { cron: '0 4 * * 0' }, // 4am UTC every Sunday
  async ({ step, logger }) => {

    // Step 1: Load all active competitors across all clients
    const competitors = await step.run('load-competitors', async () => {
      const { data, error } = await supabase
        .from('competitor')
        .select('id, tenant_id, customer_id, name, website_url, threat_level, last_checked_at')
        .not('website_url', 'is', null)
        .order('threat_level', { ascending: false });

      if (error) throw new Error(`Failed to load competitors: ${error.message}`);
      logger.info(`Loaded ${data.length} competitors to scan`);
      return data || [];
    });

    if (competitors.length === 0) {
      return { message: 'No competitors configured yet', scanned: 0 };
    }

    // Step 2: Check DataForSEO credentials
    const hasDfsCredentials = await step.run('check-dataforseo-creds', async () => {
      if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
        logger.warn('DataForSEO credentials not set — running in stub mode');
        return false;
      }
      return true;
    });

    // Step 3: Scan each competitor (capped at 20 per run to stay within budget)
    const toScan = competitors.slice(0, 20);
    const signals = [];

    for (const competitor of toScan) {
      const signal = await step.run(`scan-competitor-${competitor.id}`, async () => {
        logger.info(`Scanning: ${competitor.name} (${competitor.website_url})`);

        let domainData = null;

        if (hasDfsCredentials) {
          try {
            // DataForSEO domain rank overview — checks organic traffic changes
            const auth = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
            const domain = competitor.website_url.replace(/https?:\/\//, '').replace(/\/$/, '');

            const res = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live', {
              method: 'POST',
              headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify([{ target: domain, language_code: 'en', location_code: 2840 }]),
            });

            if (res.ok) {
              const body = await res.json();
              domainData = body?.tasks?.[0]?.result?.[0] || null;
            } else {
              logger.warn(`DataForSEO returned ${res.status} for ${domain}`);
            }
          } catch (e) {
            logger.warn(`DataForSEO scan failed for ${competitor.name}: ${e.message}`);
          }
        }

        // Write signal to competitor_pattern_analysis
        const { error } = await supabase
          .from('competitor_pattern_analysis')
          .insert({
            competitor_id: competitor.id,
            customer_id: competitor.customer_id,
            scan_date: new Date().toISOString().split('T')[0],
            organic_traffic: domainData?.metrics?.organic?.etv || null,
            organic_keywords: domainData?.metrics?.organic?.count || null,
            domain_rank: domainData?.domain_rank || null,
            raw_data: domainData,
            scan_status: domainData ? 'success' : (hasDfsCredentials ? 'api_error' : 'stub'),
          })
          .select('id')
          .single();

        if (error) logger.warn(`Failed to write signal for ${competitor.name}: ${error.message}`);

        return {
          competitor_id: competitor.id,
          name: competitor.name,
          threat_level: competitor.threat_level,
          has_data: !!domainData,
        };
      });

      signals.push(signal);
    }

    // Step 4: Flag high-threat competitors (threat_level >= 4) for review
    await step.run('flag-high-threat', async () => {
      const highThreat = signals.filter(s => s.threat_level >= 4 && s.has_data);
      if (highThreat.length === 0) {
        logger.info('No high-threat competitor changes detected');
        return;
      }

      const { error } = await supabase
        .from('cia_episode')
        .insert({
          episode_type: 'alert',
          source_system: 'inngest',
          actor: 'Competitor Signal Weekly',
          content: `Weekly scan flagged ${highThreat.length} high-threat competitor(s) with active data: ${highThreat.map(c => c.name).join(', ')}. Review competitor_pattern_analysis for latest signals.`,
          metadata: {
            function_id: 'competitor-signal-weekly',
            high_threat_competitors: highThreat,
            total_scanned: signals.length,
          },
          timestamp_event: new Date().toISOString(),
        });

      if (error) logger.warn(`CIA episode flag failed: ${error.message}`);
      logger.info(`Flagged ${highThreat.length} high-threat competitors in cia_episode`);
    });

    return {
      success: true,
      scanned: signals.length,
      with_data: signals.filter(s => s.has_data).length,
      high_threat_flagged: signals.filter(s => s.threat_level >= 4).length,
      mode: hasDfsCredentials ? 'live' : 'stub',
    };
  }
);
