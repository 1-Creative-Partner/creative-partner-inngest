// Hello World validation function for P1-001
// Verifies Inngest → Render → Supabase pipeline is fully operational

import { inngest } from '../../inngest-client.js';
import { supabase } from '../../supabase-client.js';

export const helloWorldHealthCheck = inngest.createFunction(
  { 
    id: "hello-world-health-check", 
    name: "Hello World Health Check",
    retries: 2
  },
  { cron: "0 */6 * * *" }, // Every 6 hours
  async ({ event, step, logger }) => {
    const result = await step.run("verify-pipeline", async () => {
      const timestamp = new Date().toISOString();
      
      logger.info('Running Inngest pipeline health check');
      
      // Test Supabase connectivity
      const { data, error } = await supabase
        .from('cia_episode')
        .insert({
          episode_type: 'measurement',
          source_system: 'claude',
          actor: 'Inngest Hello World',
          content: `Inngest pipeline health check passed at ${timestamp}. Render → Inngest → Supabase connectivity verified.`,
          metadata: {
            function_id: 'hello-world-health-check',
            timestamp: timestamp,
            environment: 'production'
          },
          timestamp_event: timestamp
        })
        .select()
        .single();

      if (error) {
        logger.error('Supabase write failed:', error);
        throw new Error(`Supabase write failed: ${error.message}`);
      }
      
      logger.info('Health check completed successfully');
      
      return {
        status: 'healthy',
        timestamp: timestamp,
        supabase_write_confirmed: true,
        cia_episode_id: data.id
      };
    });

    return { success: true, result };
  }
);
