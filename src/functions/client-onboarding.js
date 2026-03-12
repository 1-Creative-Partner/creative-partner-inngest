import { inngest } from '../inngest-client.js';
import { supabase } from '../supabase-client.js';

/**
 * Client Onboarding — Full provisioning after deal closes
 *
 * Trigger: customer/onboarding.started
 *
 * Steps:
 *   1. Create GHL contact (if needed)
 *   2. Scaffold portal project (content_review_project + portal_stage)
 *   3. Scaffold knowledge graph
 *   4. Create client_state
 *   5. Slack notification
 *   6. CIA episode log
 *
 * NOTE: Basecamp steps REMOVED — Basecamp is being phased out (Chad, 2026-03-12).
 * Portal project scaffolding added in its place.
 */

const SLACK_WEBHOOK_SYSTEM_ALERTS = process.env.SLACK_WEBHOOK_SYSTEM_ALERTS;
const GHL_LOCATION_ID = 'VpL3sVe4Vb1ANBx9DOL6';

async function getGHLToken() {
  const { data } = await supabase
    .from('api_credential')
    .select('credential_value')
    .eq('id', 'ac_312efcfe-7abc-4d0a-9590-d58fc5389920')
    .single();

  let token;
  try {
    const parsed = JSON.parse(data?.credential_value || '{}');
    token = parsed.token || parsed.access_token || data?.credential_value || '';
  } catch {
    token = data?.credential_value || '';
  }

  if (!token) throw new Error('No GHL token available');
  return token;
}

export const clientOnboardingAutomation = inngest.createFunction(
  {
    id: 'client-onboarding-automation',
    name: 'Client Onboarding: Full Provisioning',
    retries: 2,
  },
  { event: 'customer/onboarding.started' },
  async ({ event, step }) => {
    const {
      customer_id,
      company_name,
      contact_name,
      email,
      phone,
      website,
      industry = 'unknown',
      trigger_type = 'new_customer',
      slug,
    } = event.data;

    // Generate slug if not provided
    const clientSlug = slug || company_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);

    // Step 1: Create GHL contact (if not already linked)
    const ghlContact = await step.run('create-ghl-contact', async () => {
      // Check if customer already has a GHL contact
      const { data: customer } = await supabase
        .from('customer')
        .select('ghl_contact_id')
        .eq('id', customer_id)
        .single();

      if (customer?.ghl_contact_id) {
        return { id: customer.ghl_contact_id, skipped: true };
      }

      const token = await getGHLToken();
      const nameParts = (contact_name || '').split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      const res = await fetch('https://services.leadconnectorhq.com/contacts/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          phone,
          companyName: company_name,
          website,
          locationId: GHL_LOCATION_ID,
          tags: ['new-client', 'onboarding', industry].filter(Boolean),
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`GHL contact creation failed: ${res.status} ${err}`);
      }

      const result = await res.json();
      const contact = result.contact || result;

      // Store GHL contact ID on customer
      if (contact.id) {
        await supabase
          .from('customer')
          .update({ ghl_contact_id: contact.id, updated_at: new Date().toISOString() })
          .eq('id', customer_id);
      }

      return contact;
    });

    // Step 2: Scaffold portal project
    const portalProject = await step.run('scaffold-portal-project', async () => {
      // Check if portal project already exists
      const { data: existing } = await supabase
        .from('content_review_project')
        .select('id')
        .eq('customer_id', customer_id)
        .limit(1);

      if (existing && existing.length > 0) {
        return { id: existing[0].id, skipped: true };
      }

      const projectId = `crp_${customer_id}`;

      const { data, error } = await supabase
        .from('content_review_project')
        .insert({
          id: projectId,
          customer_id,
          project_name: `${company_name} Website`,
          client_name: company_name,
          client_slug: clientSlug,
          client_phone: phone || null,
          contact_name: contact_name || null,
          contact_email: email || null,
          stage: 1, // Discovery
          stage_labels: {
            1: 'Discovery',
            2: 'Strategy',
            3: 'Content',
            4: 'Design & Build',
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        console.warn('Portal project creation warning:', error.message);
        return { id: projectId, error: error.message };
      }

      // Create portal stages
      const stages = [
        { id: `ps_${projectId}_1`, project_id: projectId, name: 'Discovery', order: 1, color: '#3B82F6', stage_status: 'active' },
        { id: `ps_${projectId}_2`, project_id: projectId, name: 'Strategy', order: 2, color: '#8B5CF6', stage_status: 'locked' },
        { id: `ps_${projectId}_3`, project_id: projectId, name: 'Content', order: 3, color: '#F59E0B', stage_status: 'locked' },
        { id: `ps_${projectId}_4`, project_id: projectId, name: 'Design & Build', order: 4, color: '#10B981', stage_status: 'locked' },
      ];

      const { error: stageError } = await supabase
        .from('portal_stage')
        .insert(stages);

      if (stageError) {
        console.warn('Portal stages creation warning:', stageError.message);
      }

      return { id: projectId, created: true, stages: stages.length };
    });

    // Step 3: Scaffold knowledge graph
    await step.run('scaffold-knowledge-graph', async () => {
      const kgId = `kg_${customer_id}_onboarding`;

      const { error } = await supabase
        .from('client_knowledge_graph')
        .upsert({
          id: kgId,
          tenant_id: 'creative-partner',
          customer_id,
          version: 1,
          knowledge_graph: {
            business_overview: {
              company_name,
              industry,
              website,
              contact_name,
              email,
            },
          },
          source: 'client-onboarding',
          is_current: true,
          status: 'active',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'customer_id' });

      if (error) {
        console.warn('Knowledge graph scaffold warning:', error.message);
      }
    });

    // Step 4: Create client_state
    await step.run('create-client-state', async () => {
      const { error } = await supabase
        .from('client_state')
        .upsert({
          customer_id,
          lifecycle_stage: 'onboarding',
          health_score: 80,
          engagement_score: 50,
          last_activity_at: new Date().toISOString(),
        }, { onConflict: 'customer_id' });

      if (error) {
        console.warn('Client state creation warning:', error.message);
      }
    });

    // Step 5: Slack notification
    await step.run('send-slack-notification', async () => {
      if (!SLACK_WEBHOOK_SYSTEM_ALERTS) {
        console.warn('SLACK_WEBHOOK_SYSTEM_ALERTS not set');
        return { skipped: true };
      }

      await fetch(SLACK_WEBHOOK_SYSTEM_ALERTS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `New Client Onboarded: ${company_name}`,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: 'New Client Onboarded', emoji: true },
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Company:*\n${company_name}` },
                { type: 'mrkdwn', text: `*Contact:*\n${contact_name || 'N/A'}` },
                { type: 'mrkdwn', text: `*Industry:*\n${industry}` },
                { type: 'mrkdwn', text: `*Portal:*\nportal.creativepartnersolutions.com/portal/${clientSlug}` },
              ],
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: 'Portal project created. GHL contact synced. Ready for discovery.' },
            },
          ],
        }),
      });

      return { sent: true };
    });

    // Step 6: Log CIA episode
    await step.run('log-cia-episode', async () => {
      await supabase.from('cia_episode').insert({
        episode_type: 'change',
        source_system: 'inngest',
        actor: 'client-onboarding-automation',
        content: `New client onboarded: ${company_name}. Portal project ${portalProject.id} created. GHL contact ${ghlContact.skipped ? 'already existed' : 'created'}. Knowledge graph scaffolded. Trigger: ${trigger_type}.`,
        metadata: {
          customer_id,
          company_name,
          industry,
          portal_project_id: portalProject.id,
          ghl_contact_id: ghlContact.id,
          trigger_type,
          slug: clientSlug,
        },
        timestamp_event: new Date().toISOString(),
      });
    });

    return {
      success: true,
      customer_id,
      company_name,
      slug: clientSlug,
      portal_project_id: portalProject.id,
      ghl_contact_id: ghlContact.id,
    };
  }
);
