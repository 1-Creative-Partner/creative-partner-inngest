// KG Enrichment Sunday — P2-002
// Every Sunday 5am UTC: scan all active client knowledge graphs,
// identify stale entries (>30 days old), flag gaps, update completeness scores,
// queue high-gap clients for re-enrichment in claude_code_job_queue.

import { inngest } from '../../inngest-client.js';
import { supabase } from '../../supabase-client.js';

const STALE_DAYS = 30;
const LOW_COMPLETENESS_THRESHOLD = 0.6;

export const kgEnrichmentSunday = inngest.createFunction(
  {
    id: 'kg-enrichment-sunday',
    name: 'KG Enrichment Sunday',
    retries: 2,
  },
  { cron: '0 5 * * 0' }, // 5am UTC every Sunday (1hr after competitor scan)
  async ({ step, logger }) => {

    // Step 1: Load all current knowledge graphs
    const graphs = await step.run('load-knowledge-graphs', async () => {
      const { data, error } = await supabase
        .from('client_knowledge_graph')
        .select('id, customer_id, version, completeness_score, gaps_identified, updated_at, is_current')
        .eq('is_current', true);

      if (error) throw new Error(`Failed to load knowledge graphs: ${error.message}`);
      logger.info(`Loaded ${data.length} active client knowledge graphs`);
      return data || [];
    });

    if (graphs.length === 0) {
      return { message: 'No knowledge graphs found', processed: 0 };
    }

    // Step 2: Analyze each graph for staleness and gaps
    const now = new Date();
    const staleThreshold = new Date(now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000);
    const results = [];

    for (const graph of graphs) {
      const result = await step.run(`analyze-kg-${graph.customer_id}`, async () => {
        const updatedAt = new Date(graph.updated_at);
        const ageInDays = Math.floor((now - updatedAt) / (1000 * 60 * 60 * 24));
        const isStale = updatedAt < staleThreshold;
        const hasLowCompleteness = (graph.completeness_score || 0) < LOW_COMPLETENESS_THRESHOLD;
        const gapCount = Array.isArray(graph.gaps_identified) ? graph.gaps_identified.length : 0;
        const needsEnrichment = isStale || hasLowCompleteness || gapCount > 3;

        logger.info(`KG ${graph.customer_id}: age=${ageInDays}d, completeness=${graph.completeness_score}, gaps=${gapCount}, stale=${isStale}`);

        return {
          customer_id: graph.customer_id,
          kg_id: graph.id,
          age_days: ageInDays,
          is_stale: isStale,
          completeness_score: graph.completeness_score,
          gap_count: gapCount,
          needs_enrichment: needsEnrichment,
        };
      });

      results.push(result);
    }

    // Step 3: Queue enrichment jobs for clients that need it
    const toEnrich = results.filter(r => r.needs_enrichment);

    await step.run('queue-enrichment-jobs', async () => {
      if (toEnrich.length === 0) {
        logger.info('All knowledge graphs are healthy — no enrichment needed');
        return;
      }

      for (const client of toEnrich) {
        // Check if enrichment job already pending for this client
        const { data: existing } = await supabase
          .from('claude_code_job_queue')
          .select('id')
          .eq('job_id', `KG-ENRICH-${client.customer_id}`)
          .eq('status', 'pending')
          .single();

        if (existing) {
          logger.info(`Enrichment job already queued for ${client.customer_id} — skipping`);
          continue;
        }

        const reason = [
          client.is_stale ? `stale (${client.age_days}d)` : null,
          client.completeness_score < LOW_COMPLETENESS_THRESHOLD ? `low completeness (${client.completeness_score})` : null,
          client.gap_count > 3 ? `${client.gap_count} gaps` : null,
        ].filter(Boolean).join(', ');

        const { error } = await supabase
          .from('claude_code_job_queue')
          .insert({
            job_id: `KG-ENRICH-${client.customer_id}-${new Date().toISOString().split('T')[0]}`,
            title: `Re-enrich knowledge graph for client ${client.customer_id}`,
            status: 'pending',
            priority: client.completeness_score < 0.4 ? 2 : 5,
            context: `Auto-queued by kg-enrichment-sunday. Reason: ${reason}. Current completeness: ${client.completeness_score}. Gap count: ${client.gap_count}.`,
            instructions: `Run business-analyzer skill for customer_id=${client.customer_id}. Focus on filling ${client.gap_count} identified gaps. Update client_knowledge_graph with new version.`,
            cia_layer: 'execution',
            cia_node_type: 'job',
          });

        if (error) {
          logger.warn(`Failed to queue enrichment for ${client.customer_id}: ${error.message}`);
        } else {
          logger.info(`Queued enrichment job for ${client.customer_id} (reason: ${reason})`);
        }
      }
    });

    // Step 4: Log summary to cia_episode
    await step.run('log-summary', async () => {
      const { error } = await supabase
        .from('cia_episode')
        .insert({
          episode_type: 'measurement',
          source_system: 'inngest',
          actor: 'KG Enrichment Sunday',
          content: `Weekly KG audit complete. ${graphs.length} graphs scanned. ${toEnrich.length} queued for enrichment. Stale: ${results.filter(r => r.is_stale).length}. Low completeness: ${results.filter(r => r.completeness_score < LOW_COMPLETENESS_THRESHOLD).length}.`,
          metadata: {
            function_id: 'kg-enrichment-sunday',
            total_graphs: graphs.length,
            queued_for_enrichment: toEnrich.length,
            stale_count: results.filter(r => r.is_stale).length,
            low_completeness_count: results.filter(r => r.completeness_score < LOW_COMPLETENESS_THRESHOLD).length,
            client_details: results,
          },
          timestamp_event: new Date().toISOString(),
        });

      if (error) logger.warn(`CIA episode log failed: ${error.message}`);
    });

    return {
      success: true,
      total_graphs: graphs.length,
      healthy: results.filter(r => !r.needs_enrichment).length,
      queued_for_enrichment: toEnrich.length,
      stale: results.filter(r => r.is_stale).length,
    };
  }
);
