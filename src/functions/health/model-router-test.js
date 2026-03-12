import { inngest } from '../../inngest-client.js';
import { routeModel } from '../../model-router.js';
import { supabase } from '../../supabase-client.js';

/**
 * Model Router Test Harness
 *
 * Validates that routeModel() works end-to-end:
 *   1. Task-based routing (auto-picks cheapest model for task type)
 *   2. Explicit model routing (forces a specific model_id)
 *   3. Confirms model_routing_log gets populated
 *
 * Trigger manually via Inngest dashboard: send event "test/model-router"
 * Or schedule as a daily health check.
 */
export const modelRouterTest = inngest.createFunction(
  {
    id: 'model-router-test',
    name: 'Health: Model Router Test Harness',
    retries: 1,
    concurrency: { limit: 1 },
  },
  { event: 'test/model-router' },
  async ({ event, step }) => {
    const results = {};

    // Step 1: Test task-based routing (should pick cheapest model for "classification")
    results.taskRouting = await step.run('test-task-routing', async () => {
      try {
        const res = await routeModel({
          task: 'classification',
          prompt: 'Classify this business type: "We pressure wash driveways and houses in Lansing MI." Return one of: local_service, ecommerce, saas, national_brand.',
          system: 'You are a business classifier. Return ONLY the classification label, nothing else.',
          caller: 'model-router-test',
          maxTokens: 50,
        });

        return {
          success: true,
          model: res.model,
          openrouter_model: res.openrouter_model,
          provider: res.provider,
          route: res.route,
          cost_tier: res.cost_tier,
          latency_ms: res.latency_ms,
          input_tokens: res.input_tokens,
          output_tokens: res.output_tokens,
          response_preview: res.text?.substring(0, 100),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // Step 2: Test explicit model routing (force a specific model)
    results.explicitModel = await step.run('test-explicit-model', async () => {
      try {
        const res = await routeModel({
          model: 'gpt-4o-mini',
          prompt: 'What is 2 + 2? Reply with just the number.',
          caller: 'model-router-test',
          maxTokens: 10,
        });

        return {
          success: true,
          model: res.model,
          route: res.route,
          latency_ms: res.latency_ms,
          response_preview: res.text?.substring(0, 50),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // Step 3: Verify model_routing_log was populated
    results.logCheck = await step.run('verify-routing-log', async () => {
      const { data, error } = await supabase
        .from('model_routing_log')
        .select('id, function_name, model_used, route, latency_ms, created_at')
        .eq('function_name', 'model-router-test')
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) {
        return { success: false, error: error.message };
      }

      return {
        success: data.length > 0,
        rows_found: data.length,
        latest_entries: data,
      };
    });

    // Step 4: Log results to cia_episode
    await step.run('log-test-results', async () => {
      const allPassed = results.taskRouting?.success && results.explicitModel?.success && results.logCheck?.success;

      await supabase.from('cia_episode').insert({
        episode_type: 'observation',
        source_system: 'claude',
        actor: 'model-router-test',
        content: allPassed
          ? `Model router test PASSED. Task routing: ${results.taskRouting.model} via ${results.taskRouting.route} (${results.taskRouting.latency_ms}ms). Explicit: ${results.explicitModel.model} via ${results.explicitModel.route}. Log has ${results.logCheck.rows_found} entries.`
          : `Model router test FAILED. Task routing: ${results.taskRouting?.success ? 'PASS' : results.taskRouting?.error}. Explicit: ${results.explicitModel?.success ? 'PASS' : results.explicitModel?.error}. Log check: ${results.logCheck?.success ? 'PASS' : results.logCheck?.error}.`,
        metadata: results,
        timestamp_event: new Date().toISOString(),
      });

      return { logged: true };
    });

    return {
      success: results.taskRouting?.success && results.explicitModel?.success && results.logCheck?.success,
      results,
    };
  }
);
