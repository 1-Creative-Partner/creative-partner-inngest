import { inngest } from '../inngest-client.js';
import { supabase } from '../supabase-client.js';

export const basecampNightlySync = inngest.createFunction(
  {
    id: 'basecamp-nightly-sync',
    name: 'Basecamp Nightly Sync',
    retries: 3,
  },
  { cron: '0 3 * * *' }, // 3am daily
  async ({ step, logger }) => {

    // Step 1: Get Basecamp credentials from Supabase
    const credentials = await step.run('get-basecamp-credentials', async () => {
      const { data, error } = await supabase
        .from('system_awareness')
        .select('content, structured_data')
        .eq('awareness_key', 'basecamp_oauth_app')
        .single();

      if (error) throw new Error(`Cannot load Basecamp credentials: ${error.message}`);
      return data;
    });

    // Step 2: Fetch projects from Basecamp API
    const projects = await step.run('fetch-basecamp-projects', async () => {
      const token = credentials?.structured_data?.access_token;
      if (!token) throw new Error('No Basecamp access token found - refresh OAuth');

      const res = await fetch('https://3.basecampapi.com/6162345/projects.json', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Creative Partner OS (chad@creativepartnersolutions.com)',
        }
      });

      if (!res.ok) throw new Error(`Basecamp API returned ${res.status} - token may be expired`);
      const data = await res.json();
      logger.info(`Found ${data.length} Basecamp projects`);
      return data;
    });

    // Step 3: Sync each project to Supabase
    const synced = [];
    for (const project of projects) {
      const result = await step.run(`sync-project-${project.id}`, async () => {
        const { error } = await supabase
          .from('system_awareness')
          .upsert({
            awareness_key: `basecamp_project_${project.id}`,
            category: 'platform_config',
            title: `Basecamp: ${project.name}`,
            content: JSON.stringify({
              id: project.id,
              name: project.name,
              status: project.status,
              synced_at: new Date().toISOString(),
            }),
          }, { onConflict: 'awareness_key' });

        if (error) throw new Error(`Failed to sync project ${project.name}: ${error.message}`);
        return { id: project.id, name: project.name };
      });
      synced.push(result);
    }

    return { synced: synced.length, projects: synced };
  }
);
