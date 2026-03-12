import { inngest } from '../inngest-client.js';
import { supabase } from '../supabase-client.js';
import { routeModel } from '../model-router.js';

export const promptAutoscorer = inngest.createFunction(
  {
    id: 'prompt-autoscorer',
    name: 'Prompt Autoscorer',
    retries: 2,
    concurrency: { limit: 1 },
  },
  { cron: '0 */6 * * *' }, // Every 6 hours
  async ({ step, logger }) => {

    // Step 1: Get unscored prompts
    const unscored = await step.run('get-unscored-prompts', async () => {
      const { data, error } = await supabase
        .from('prompt_result_log')
        .select('id, task_type, user_prompt, output, iteration_number')
        .is('score', null)
        .limit(10);

      if (error) throw new Error(`Failed to fetch unscored prompts: ${error.message}`);
      logger.info(`Found ${data.length} unscored prompts`);
      return data;
    });

    if (!unscored || unscored.length === 0) {
      return { message: 'No unscored prompts', processed: 0 };
    }

    // Step 2: Score each prompt via model router (cheapest qualified model)
    const scored = [];
    for (const prompt of unscored) {
      const score = await step.run(`score-prompt-${prompt.id}`, async () => {
        const result = await routeModel({
          task: 'classification',  // Routes to cheapest: gemini-flash ($0.10) or gpt-4o-mini ($0.15)
          prompt: `Rate this prompt output 1-5. Reply with just a number.
Task: ${prompt.task_type}
Prompt: ${prompt.user_prompt?.substring(0, 200)}
Output: ${prompt.output?.substring(0, 200)}`,
          maxTokens: 10,
        });

        const scoreNum = parseInt(result.text?.trim());

        if (isNaN(scoreNum) || scoreNum < 1 || scoreNum > 5) {
          throw new Error(`Invalid score returned: ${result.text} (via ${result.model})`);
        }

        // Write score back to Supabase
        const { error } = await supabase
          .from('prompt_result_log')
          .update({
            score: scoreNum,
            scored_at: new Date().toISOString(),
            scorer: `inngest-autoscorer/${result.model}`,
          })
          .eq('id', prompt.id);

        if (error) throw new Error(`Failed to save score: ${error.message}`);
        return { id: prompt.id, score: scoreNum, model: result.model, route: result.route };
      });
      scored.push(score);
    }

    return { processed: scored.length, scores: scored };
  }
);
