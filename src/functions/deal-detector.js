import { inngest } from '../inngest-client.js';
import { supabase } from '../supabase-client.js';

/**
 * Deal Detector — Evaluates client_facts after transcript processing
 *
 * Trigger: ghl/transcript.processed (same as transcript-intelligence-agent)
 * Waits 45 seconds for the intelligence agent to finish writing facts,
 * then evaluates: is this contact a deal worth pursuing?
 *
 * If YES → creates/updates customer record, fires customer/analysis.requested
 * If NO → logs observation and exits
 */

const GHL_PIPELINE_ID = '2AbGBIocWixPhaQXv1nx'; // Business Development pipeline
const GHL_LOCATION_ID = 'VpL3sVe4Vb1ANBx9DOL6';

async function getGHLToken() {
  const { data } = await supabase
    .from('api_credential')
    .select('credential_value')
    .not('credential_value', 'is', null);

  if (!data) throw new Error('No api_credential records found');

  for (const cred of data) {
    try {
      const parsed = JSON.parse(cred.credential_value);
      if (parsed.location_id === GHL_LOCATION_ID && parsed.token?.startsWith('pit-')) {
        return parsed.token;
      }
    } catch { continue; }
  }
  throw new Error('No PIT token found for GHL location');
}

export const dealDetector = inngest.createFunction(
  {
    id: 'deal-detector',
    name: 'Pipeline: Deal Detector',
    retries: 2,
    concurrency: { limit: 5 },
  },
  { event: 'ghl/transcript.processed' },
  async ({ event, step }) => {
    const { contactId, locationId, call_transcript, call_direction } = event.data;

    // Wait for transcript-intelligence-agent to finish writing facts
    await step.sleep('wait-for-facts', '45s');

    // Step 1: Read client_facts for this contact
    const facts = await step.run('read-client-facts', async () => {
      const { data, error } = await supabase
        .from('client_facts')
        .select('id, fact_type, fact_key, fact_summary, confidence, is_high_value, tags')
        .eq('ghl_contact_id', contactId)
        .eq('is_current', true)
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('Failed to read client_facts:', error.message);
        return [];
      }
      return data || [];
    });

    // Step 2: Evaluate deal signals
    const evaluation = await step.run('evaluate-deal-signals', async () => {
      if (facts.length === 0) {
        return { isDeal: false, reason: 'No client facts found for this contact', score: 0 };
      }

      let score = 0;
      const signals = [];

      // High-value facts are strong deal signals
      const highValueFacts = facts.filter(f => f.is_high_value);
      score += highValueFacts.length * 25;
      if (highValueFacts.length > 0) {
        signals.push(`${highValueFacts.length} high-value signal(s)`);
      }

      // Budget signals
      const budgetFacts = facts.filter(f => f.fact_type === 'budget_signal');
      score += budgetFacts.length * 20;
      if (budgetFacts.length > 0) {
        signals.push(`Budget mentioned: ${budgetFacts.map(f => f.fact_summary).join('; ')}`);
      }

      // Service interest
      const serviceFacts = facts.filter(f => f.fact_type === 'service_interest');
      score += serviceFacts.length * 15;
      if (serviceFacts.length > 0) {
        signals.push(`${serviceFacts.length} service interest(s)`);
      }

      // Timeline urgency
      const timelineFacts = facts.filter(f => f.fact_type === 'timeline_signal');
      score += timelineFacts.length * 15;
      if (timelineFacts.length > 0) {
        signals.push('Timeline urgency detected');
      }

      // Decision maker
      const dmFacts = facts.filter(f => f.fact_type === 'decision_maker_signal');
      score += dmFacts.length * 10;

      // Pain points (engagement signal)
      const painFacts = facts.filter(f => f.fact_type === 'pain_point');
      score += painFacts.length * 5;

      // High confidence facts boost score
      const highConfFacts = facts.filter(f => f.confidence >= 0.8);
      score += highConfFacts.length * 5;

      // Objections slightly reduce score
      const objections = facts.filter(f => f.fact_type === 'objection');
      score -= objections.length * 5;

      const isDeal = score >= 30; // Threshold: at least a budget signal + service interest, or 2 high-value signals

      return {
        isDeal,
        score,
        reason: isDeal
          ? `Deal detected (score: ${score}). Signals: ${signals.join(', ')}`
          : `Below deal threshold (score: ${score}/${30}). ${facts.length} fact(s) found but insufficient deal signals.`,
        factCount: facts.length,
        highValueCount: highValueFacts.length,
        signals,
      };
    });

    if (!evaluation.isDeal) {
      // Log and exit — not a deal
      await step.run('log-no-deal', async () => {
        await supabase.from('cia_episode').insert({
          episode_type: 'observation',
          source_system: 'ghl',
          actor: 'deal-detector',
          content: `No deal detected for contact ${contactId}. ${evaluation.reason}`,
          metadata: { contactId, locationId, evaluation },
          timestamp_event: new Date().toISOString(),
        });
      });

      return { isDeal: false, contactId, evaluation };
    }

    // Step 3: Look up or create customer record
    const customer = await step.run('upsert-customer', async () => {
      // Check if customer already exists
      const { data: existing } = await supabase
        .from('customer')
        .select('id, company_name, slug, ghl_contact_id')
        .eq('ghl_contact_id', contactId)
        .limit(1);

      if (existing && existing.length > 0) {
        // Update last contact timestamp
        await supabase
          .from('customer')
          .update({ last_contact_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', existing[0].id);
        return existing[0];
      }

      // Fetch contact details from GHL
      let ghlContact = null;
      try {
        const token = await getGHLToken();
        const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Version': '2021-07-28',
          },
        });
        if (res.ok) {
          const data = await res.json();
          ghlContact = data.contact || data;
        }
      } catch (err) {
        console.warn('Failed to fetch GHL contact:', err.message);
      }

      // Build company name from facts or GHL data
      const companyFact = facts.find(f => f.tags?.includes('company'));
      const companyName = ghlContact?.companyName
        || companyFact?.fact_summary
        || [ghlContact?.firstName, ghlContact?.lastName].filter(Boolean).join(' ')
        || 'Unknown Prospect';

      // Generate slug
      const slug = companyName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50);

      // Create customer record
      const customerId = `cust_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const { data: newCustomer, error } = await supabase
        .from('customer')
        .insert({
          id: customerId,
          tenant_id: 'creative-partner',
          company_name: companyName,
          slug,
          ghl_contact_id: contactId,
          primary_contact_name: [ghlContact?.firstName, ghlContact?.lastName].filter(Boolean).join(' ') || null,
          primary_contact_email: ghlContact?.email || null,
          primary_contact_phone: ghlContact?.phone || null,
          city: ghlContact?.city || null,
          state: ghlContact?.state || null,
          postal_code: ghlContact?.postalCode || null,
          country: ghlContact?.country || 'US',
          website_url: ghlContact?.website || null,
          status: 'prospect',
          discovery_call_date: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('id, company_name, slug, ghl_contact_id')
        .single();

      if (error) {
        console.error('Failed to create customer:', error.message);
        return { id: customerId, company_name: companyName, slug, ghl_contact_id: contactId };
      }

      return newCustomer;
    });

    // Step 4: Create GHL opportunity if none exists
    const opportunity = await step.run('create-ghl-opportunity', async () => {
      // Check if opportunity already exists
      const { data: existingOpp } = await supabase
        .from('customer')
        .select('ghl_opportunity_id')
        .eq('id', customer.id)
        .single();

      if (existingOpp?.ghl_opportunity_id) {
        return { skipped: true, existing_opportunity_id: existingOpp.ghl_opportunity_id };
      }

      try {
        const token = await getGHLToken();

        // Get pipeline stages
        const pipelineRes = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json',
          },
        });

        let stageId = null;
        if (pipelineRes.ok) {
          const pipelineData = await pipelineRes.json();
          const pipeline = pipelineData.pipelines?.find(p => p.id === GHL_PIPELINE_ID);
          // Use first stage (typically "New" or "Lead")
          stageId = pipeline?.stages?.[0]?.id || null;
        }

        if (!stageId) {
          return { skipped: true, reason: 'Could not determine pipeline stage' };
        }

        // Estimate monetary value from budget signals
        const budgetFact = facts.find(f => f.fact_type === 'budget_signal');
        let monetaryValue = 2500; // default estimate
        if (budgetFact?.fact_summary) {
          const match = budgetFact.fact_summary.match(/\$?([\d,]+)/);
          if (match) {
            const parsed = parseInt(match[1].replace(/,/g, ''), 10);
            if (parsed > 0) monetaryValue = parsed;
          }
        }

        const oppRes = await fetch('https://services.leadconnectorhq.com/opportunities/', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Version': '2021-07-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            pipelineId: GHL_PIPELINE_ID,
            locationId: GHL_LOCATION_ID,
            name: `${customer.company_name} - Auto-detected Deal`,
            stageId,
            status: 'open',
            contactId,
            monetaryValue,
            source: 'deal-detector-inngest',
          }),
        });

        if (oppRes.ok) {
          const oppData = await oppRes.json();
          const oppId = oppData.opportunity?.id || oppData.id;

          // Store opportunity ID on customer
          if (oppId) {
            await supabase
              .from('customer')
              .update({ ghl_opportunity_id: oppId, updated_at: new Date().toISOString() })
              .eq('id', customer.id);
          }

          return { created: true, opportunity_id: oppId, monetary_value: monetaryValue };
        } else {
          const errText = await oppRes.text();
          console.warn('GHL opportunity creation failed:', oppRes.status, errText);
          return { skipped: true, reason: `GHL API ${oppRes.status}: ${errText.substring(0, 200)}` };
        }
      } catch (err) {
        console.warn('GHL opportunity error:', err.message);
        return { skipped: true, reason: err.message };
      }
    });

    // Step 5: Fire downstream event for business analysis
    await step.run('fire-analysis-event', async () => {
      await inngest.send({
        name: 'customer/analysis.requested',
        data: {
          customerId: customer.id,
          companyName: customer.company_name,
          slug: customer.slug,
          contactId,
          locationId,
          dealScore: evaluation.score,
          signals: evaluation.signals,
          factCount: evaluation.factCount,
        },
      });
      return { fired: true };
    });

    // Step 6: Log CIA episode
    await step.run('log-deal-detected', async () => {
      await supabase.from('cia_episode').insert({
        episode_type: 'action',
        source_system: 'inngest',
        actor: 'deal-detector',
        content: `Deal detected for ${customer.company_name} (score: ${evaluation.score}). ${evaluation.signals.join(', ')}. Customer: ${customer.id}. GHL opportunity: ${opportunity.opportunity_id || 'skipped'}. Fired customer/analysis.requested.`,
        metadata: {
          customer_id: customer.id,
          ghl_contact_id: contactId,
          deal_score: evaluation.score,
          signals: evaluation.signals,
          opportunity,
          fact_count: evaluation.factCount,
          high_value_count: evaluation.highValueCount,
        },
        timestamp_event: new Date().toISOString(),
      });
    });

    return {
      success: true,
      isDeal: true,
      customerId: customer.id,
      companyName: customer.company_name,
      dealScore: evaluation.score,
      opportunityCreated: opportunity.created || false,
      nextEvent: 'customer/analysis.requested',
    };
  }
);
