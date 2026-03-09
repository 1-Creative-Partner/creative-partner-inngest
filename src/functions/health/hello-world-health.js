// Hello World validation function for P1-001
// Verifies Inngest → Render → Supabase pipeline is fully operational

const { inngest } = require('../inngest-client');
const { supabase } = require('../supabase-client');

module.exports = inngest.createFunction(
  { id: "hello-world-health-check", name: "Hello World Health Check" },
  { cron: "0 */6 * * *" }, // Every 6 hours
  async ({ event, step }) => {
    const result = await step.run("verify-pipeline", async () => {
      const timestamp = new Date().toISOString();
      
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

      if (error) throw new Error(`Supabase write failed: ${error.message}`);
      
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
