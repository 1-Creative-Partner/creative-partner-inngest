import { inngest } from '../../inngest-client.js';
import { supabase } from '../../supabase-client.js';

/**
 * Matrix Optimizer — Weekly analysis of model_routing_log
 *
 * Aggregates quality scores per model per task type.
 * Updates llm_model_matrix recommended_use_cases based on real performance data.
 * Alerts Slack when models are promoted or demoted.
 *
 * Runs: Every Sunday at 10am UTC (after LLM Landscape Monitor at 9am)
 */
export const matrixOptimizer = inngest.createFunction(
  {
    id: 'matrix-optimizer',
    name: 'Matrix Optimizer',
    concurrency: { limit: 1 },
    retries: 1,
  },
  { cron: '0 10 * * 0' }, // Sunday 10am UTC
  async ({ step, logger }) => {

    // Step 1: Get routing logs from the past 7 days that have quality scores
    const scoredLogs = await step.run('get-scored-logs', async () => {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('model_routing_log')
        .select('model_used, task_type, quality_score, latency_ms, provider, cost_tier')
        .not('quality_score', 'is', null)
        .gte('created_at', weekAgo);

      if (error) throw new Error(`Failed to fetch routing logs: ${error.message}`);
      return data || [];
    });

    if (scoredLogs.length < 10) {
      logger.info(`Only ${scoredLogs.length} scored logs this week — need at least 10 for optimization`);
      return { status: 'skipped', reason: 'insufficient data', scored_logs: scoredLogs.length };
    }

    // Step 2: Aggregate scores per model per task type
    const aggregated = await step.run('aggregate-scores', async () => {
      const buckets = {};

      for (const log of scoredLogs) {
        const key = `${log.model_used}::${log.task_type}`;
        if (!buckets[key]) {
          buckets[key] = {
            model: log.model_used,
            task_type: log.task_type,
            provider: log.provider,
            cost_tier: log.cost_tier,
            scores: [],
            latencies: [],
          };
        }
        buckets[key].scores.push(Number(log.quality_score));
        if (log.latency_ms) buckets[key].latencies.push(log.latency_ms);
      }

      return Object.values(buckets).map(b => ({
        model: b.model,
        task_type: b.task_type,
        provider: b.provider,
        cost_tier: b.cost_tier,
        sample_count: b.scores.length,
        avg_score: (b.scores.reduce((a, c) => a + c, 0) / b.scores.length).toFixed(2),
        min_score: Math.min(...b.scores),
        max_score: Math.max(...b.scores),
        avg_latency_ms: b.latencies.length > 0
          ? Math.round(b.latencies.reduce((a, c) => a + c, 0) / b.latencies.length)
          : null,
      }));
    });

    // Step 3: Identify promotions and demotions
    const changes = await step.run('identify-changes', async () => {
      const DEMOTION_THRESHOLD = 3.0;   // avg below 3.0 = remove from task
      const PROMOTION_THRESHOLD = 4.2;  // avg above 4.2 = add to task if not already there
      const MIN_SAMPLES = 3;            // need at least 3 samples to act

      const demotions = [];
      const promotions = [];

      for (const agg of aggregated) {
        if (agg.sample_count < MIN_SAMPLES) continue;

        const avgScore = Number(agg.avg_score);

        if (avgScore < DEMOTION_THRESHOLD) {
          demotions.push({
            model: agg.model,
            task_type: agg.task_type,
            avg_score: agg.avg_score,
            samples: agg.sample_count,
            action: 'demote',
          });
        } else if (avgScore >= PROMOTION_THRESHOLD) {
          promotions.push({
            model: agg.model,
            task_type: agg.task_type,
            avg_score: agg.avg_score,
            samples: agg.sample_count,
            action: 'promote',
          });
        }
      }

      return { demotions, promotions };
    });

    // Step 4: Apply changes to llm_model_matrix
    const applied = await step.run('apply-matrix-changes', async () => {
      let demoted = 0;
      let promoted = 0;

      // Process demotions — remove task from recommended_use_cases
      for (const d of changes.demotions) {
        const { data: model } = await supabase
          .from('llm_model_matrix')
          .select('model_id, recommended_use_cases')
          .eq('model_id', d.model)
          .single();

        if (!model) continue;

        const currentUses = model.recommended_use_cases || [];
        const updatedUses = currentUses.filter(uc =>
          !uc.toLowerCase().includes(d.task_type.toLowerCase())
        );

        if (updatedUses.length < currentUses.length) {
          await supabase
            .from('llm_model_matrix')
            .update({
              recommended_use_cases: updatedUses,
              updated_at: new Date().toISOString(),
            })
            .eq('model_id', d.model);
          demoted++;
        }
      }

      // Process promotions — add task to recommended_use_cases if not there
      for (const p of changes.promotions) {
        const { data: model } = await supabase
          .from('llm_model_matrix')
          .select('model_id, recommended_use_cases')
          .eq('model_id', p.model)
          .single();

        if (!model) continue;

        const currentUses = model.recommended_use_cases || [];
        const alreadyHas = currentUses.some(uc =>
          uc.toLowerCase().includes(p.task_type.toLowerCase())
        );

        if (!alreadyHas) {
          await supabase
            .from('llm_model_matrix')
            .update({
              recommended_use_cases: [...currentUses, p.task_type],
              updated_at: new Date().toISOString(),
            })
            .eq('model_id', p.model);
          promoted++;
        }
      }

      return { demoted, promoted };
    });

    // Step 5: Write optimization report to system_awareness
    await step.run('write-report', async () => {
      const report = {
        run_date: new Date().toISOString(),
        logs_analyzed: scoredLogs.length,
        model_task_combos: aggregated.length,
        demotions: changes.demotions,
        promotions: changes.promotions,
        applied: applied,
        aggregated_scores: aggregated,
      };

      // Upsert the report
      await supabase
        .from('system_awareness')
        .delete()
        .eq('awareness_key', 'matrix_optimizer_last_run');

      await supabase
        .from('system_awareness')
        .insert({
          awareness_key: 'matrix_optimizer_last_run',
          category: 'platform_config',
          title: 'Matrix Optimizer Last Run',
          content: JSON.stringify(report, null, 2),
        });
    });

    // Step 6: Slack alert if changes were made
    if (changes.demotions.length > 0 || changes.promotions.length > 0) {
      await step.run('slack-alert', async () => {
        const { data: row } = await supabase
          .from('system_awareness')
          .select('content')
          .eq('awareness_key', 'slack_webhook_system_alerts')
          .single();

        const webhookUrl = row?.content?.trim();
        if (!webhookUrl) return;

        const demotionLines = changes.demotions.map(d =>
          `  :red_circle: ${d.model} removed from "${d.task_type}" (avg ${d.avg_score}/5, ${d.samples} samples)`
        ).join('\n');

        const promotionLines = changes.promotions.map(p =>
          `  :large_green_circle: ${p.model} added to "${p.task_type}" (avg ${p.avg_score}/5, ${p.samples} samples)`
        ).join('\n');

        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: [
              '*Matrix Optimizer — Weekly Update*',
              `Analyzed ${scoredLogs.length} scored routing logs.`,
              changes.demotions.length > 0 ? `\n*Demotions:*\n${demotionLines}` : '',
              changes.promotions.length > 0 ? `\n*Promotions:*\n${promotionLines}` : '',
              `\nApplied: ${applied.demoted} demotions, ${applied.promoted} promotions.`,
            ].filter(Boolean).join('\n'),
          }),
        });
      });
    }

    // Step 7: CIA episode
    await step.run('write-cia-episode', async () => {
      await supabase.from('cia_episode').insert({
        episode_type: 'measurement',
        source_system: 'claude',
        actor: 'inngest/matrix-optimizer',
        content: `Weekly matrix optimization: analyzed ${scoredLogs.length} routing logs across ${aggregated.length} model-task combos. ${changes.demotions.length} demotions, ${changes.promotions.length} promotions. Applied: ${applied.demoted} demotions, ${applied.promoted} promotions.`,
        timestamp_event: new Date().toISOString(),
      });
    });

    return {
      status: 'complete',
      logs_analyzed: scoredLogs.length,
      model_task_combos: aggregated.length,
      demotions: changes.demotions.length,
      promotions: changes.promotions.length,
      applied,
    };
  }
);
