import { inngest } from '../inngest-client.js';
import { supabase } from '../supabase-client.js';

export const promptAutoscorer = inngest.createFunction(
  {
    id: 'prompt-autoscorer',
    name: 'Prompt Autoscorer',
    retries: 2,
    // Prevent hammering Anthropic API - max 1 concurrent run
    concurrency: { limit: 1 },
  },
  { cron: '0 */6 * * *' }, // Every 6 hours - same as n8n
  async ({ step, logger }) => {

    // Step 1: Get unscored prompts
    const unscored = await step.run('get-unscored-prompts', async () => {
      const { data, error } = await supabase
        .from('prompt_result_log')
        .select('id, task_type, user_prompt, output, iteration_number')
        .is('score', null)
        .limit(10); // Process 10 at a time

      if (error) throw new Error(`Failed to fetch unscored prompts: ${error.message}`);
      logger.info(`Found ${data.length} unscored prompts`);
      return data;
    });

    if (!unscored || unscored.length === 0) {
      return { message: 'No unscored prompts', processed: 0 };
    }

    // Step 2: Score each prompt via Anthropic API
    const scored = [];
    for (const prompt of unscored) {
      const score = await step.run(`score-prompt-${prompt.id}`, async () => {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 100,
            messages: [{
              role: 'user',
              content: `Rate this prompt output 1-5. Reply with just a number.
Task: ${prompt.task_type}
Prompt: ${prompt.user_prompt?.substring(0, 200)}
Output: ${prompt.output?.substring(0, 200)}`
            }]
          })
        });

        if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
        const data = await res.json();
        const scoreText = data.content[0]?.text?.trim();
        const scoreNum = parseInt(scoreText);
        
        if (isNaN(scoreNum) || scoreNum < 1 || scoreNum > 5) {
          throw new Error(`Invalid score returned: ${scoreText}`);
        }

        // Write score back to Supabase
        const { error } = await supabase
          .from('prompt_result_log')
          .update({ 
            score: scoreNum,
            scored_at: new Date().toISOString(),
            scorer: 'inngest-autoscorer',
          })
          .eq('id', prompt.id);

        if (error) throw new Error(`Failed to save score: ${error.message}`);
        return { id: prompt.id, score: scoreNum };
      });
      scored.push(score);
    }

    return { processed: scored.length, scores: scored };
  }
);
