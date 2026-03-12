import { inngest } from '../../inngest-client.js';
import { supabase } from '../../supabase-client.js';
import { routeModel } from '../../model-router.js';

/**
 * Routing Quality Scorer — Scores unscored model_routing_log entries
 *
 * Uses the cheapest model to score outputs from other models.
 * This creates the feedback loop: route → execute → score → optimize matrix.
 *
 * Runs: Every 12 hours
 * Scores: Up to 25 entries per run
 */
export const routingQualityScorer = inngest.createFunction(
  {
    id: 'routing-quality-scorer',
    name: 'Routing Quality Scorer',
    concurrency: { limit: 1 },
    retries: 1,
  },
  { cron: '0 */12 * * *' }, // Every 12 hours
  async ({ step, logger }) => {

    // Step 1: Get unscored routing logs that have output previews
    const unscored = await step.run('get-unscored-logs', async () => {
      const { data, error } = await supabase
        .from('model_routing_log')
        .select('id, task_type, prompt_preview, output_preview, model_used')
        .is('quality_score', null)
        .not('output_preview', 'is', null)
        .not('output_preview', 'eq', '')
        .order('created_at', { ascending: false })
        .limit(25);

      if (error) throw new Error(`Failed to fetch unscored logs: ${error.message}`);
      return data || [];
    });

    if (unscored.length === 0) {
      return { status: 'complete', scored: 0, message: 'No unscored routing logs' };
    }

    logger.info(`Scoring ${unscored.length} routing log entries`);

    // Step 2: Score each entry using cheapest model
    let scored = 0;
    let errors = 0;

    for (const entry of unscored) {
      const result = await step.run(`score-${entry.id.substring(0, 8)}`, async () => {
        try {
          const scoring = await routeModel({
            task: 'simple classification',
            caller: 'routing-quality-scorer',
            maxTokens: 10,
            prompt: `Rate this AI output quality 1-5. Reply with ONLY a number.
Task type: ${entry.task_type}
Prompt: ${entry.prompt_preview || 'N/A'}
Output: ${entry.output_preview || 'N/A'}`,
          });

          const scoreNum = parseFloat(scoring.text?.trim());

          if (isNaN(scoreNum) || scoreNum < 1 || scoreNum > 5) {
            return { id: entry.id, error: `Invalid score: ${scoring.text}` };
          }

          const { error } = await supabase
            .from('model_routing_log')
            .update({
              quality_score: scoreNum,
              quality_scorer: scoring.model,
            })
            .eq('id', entry.id);

          if (error) return { id: entry.id, error: error.message };
          return { id: entry.id, score: scoreNum, scorer: scoring.model };

        } catch (err) {
          return { id: entry.id, error: err.message };
        }
      });

      if (result.error) {
        errors++;
        logger.warn(`Score failed for ${result.id}: ${result.error}`);
      } else {
        scored++;
      }
    }

    return { status: 'complete', total: unscored.length, scored, errors };
  }
);
