import { inngest } from '../inngest-client.js';
import { supabase } from '../supabase-client.js';
import { routeModel } from '../model-router.js';

/**
 * Business Analyzer — Automated prospect research after deal detection
 *
 * Trigger: customer/analysis.requested (fired by deal-detector)
 *
 * Steps:
 *   1. Fetch customer + existing facts
 *   2. Pull website tech stack via DataForSEO
 *   3. Pull domain rank overview via DataForSEO
 *   4. Pull GBP info via DataForSEO (if discoverable)
 *   5. AI analysis via model router → build knowledge graph
 *   6. Upsert client_knowledge_graph
 *   7. Upsert client_qualification_profile
 *   8. Fire customer/analysis.complete
 */

async function getDataForSEOCredentials() {
  const { data } = await supabase
    .from('api_credential')
    .select('credential_value')
    .eq('credential_key', 'dataforseo_login_password')
    .eq('is_active', true)
    .limit(1)
    .single();

  if (!data?.credential_value) {
    throw new Error('DataForSEO credentials not found in api_credential');
  }

  const parsed = JSON.parse(data.credential_value);
  // DataForSEO uses HTTP Basic Auth: base64(login:password)
  const auth = Buffer.from(`${parsed.login}:${parsed.password}`).toString('base64');
  return auth;
}

async function callDataForSEO(auth, endpoint, body) {
  try {
    const res = await fetch(`https://api.dataforseo.com/v3/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`DataForSEO ${endpoint} failed: ${res.status} ${errText.substring(0, 200)}`);
      return null;
    }

    const data = await res.json();
    return data.tasks?.[0]?.result?.[0] || data.tasks?.[0]?.result || null;
  } catch (err) {
    console.warn(`DataForSEO ${endpoint} error: ${err.message}`);
    return null;
  }
}

export const businessAnalyzer = inngest.createFunction(
  {
    id: 'business-analyzer',
    name: 'Pipeline: Business Analyzer',
    retries: 2,
    concurrency: { limit: 3 },
  },
  { event: 'customer/analysis.requested' },
  async ({ event, step }) => {
    const { customerId, companyName, slug, contactId, dealScore } = event.data;

    // Step 1: Fetch customer record and existing facts
    const context = await step.run('fetch-context', async () => {
      const { data: customer } = await supabase
        .from('customer')
        .select('id, company_name, website_url, current_website_url, current_gbp_url, city, state, industry, business_type')
        .eq('id', customerId)
        .single();

      const { data: facts } = await supabase
        .from('client_facts')
        .select('fact_type, fact_key, fact_summary, confidence, is_high_value')
        .eq('ghl_contact_id', contactId)
        .eq('is_current', true);

      const { data: existingKG } = await supabase
        .from('client_knowledge_graph')
        .select('id, knowledge_graph, completeness_score')
        .eq('customer_id', customerId)
        .eq('is_current', true)
        .limit(1);

      return {
        customer: customer || { id: customerId, company_name: companyName },
        facts: facts || [],
        existingKG: existingKG?.[0] || null,
      };
    });

    const websiteUrl = context.customer.website_url || context.customer.current_website_url;

    // Step 2: Pull website tech stack (if we have a URL)
    const techStack = await step.run('pull-tech-stack', async () => {
      if (!websiteUrl) return { skipped: true, reason: 'No website URL' };

      try {
        const auth = await getDataForSEOCredentials();
        const domain = new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`).hostname;

        const result = await callDataForSEO(auth, 'domain_analytics/technologies/domain_technologies/live', [{
          target: domain,
          limit: 50,
        }]);

        if (!result) return { skipped: true, reason: 'No tech stack data returned' };

        return {
          technologies: result.technologies || result.items?.[0]?.technologies || [],
          domain,
        };
      } catch (err) {
        return { skipped: true, reason: err.message };
      }
    });

    // Step 3: Pull domain rank overview
    const domainRank = await step.run('pull-domain-rank', async () => {
      if (!websiteUrl) return { skipped: true, reason: 'No website URL' };

      try {
        const auth = await getDataForSEOCredentials();
        const domain = new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`).hostname;

        const result = await callDataForSEO(auth, 'dataforseo_labs/google/domain_rank_overview/live', [{
          target: domain,
          location_code: 2840, // US
          language_code: 'en',
        }]);

        if (!result) return { skipped: true, reason: 'No domain rank data returned' };

        const item = result.items?.[0] || result;
        return {
          domain_rank: item.domain_rank || null,
          organic_etv: item.organic_etv || null,
          organic_count: item.organic_count || null,
          organic_is_lost: item.organic_is_lost || null,
          backlinks: item.backlinks || null,
          referring_domains: item.referring_domains || null,
          rank: item.rank || null,
        };
      } catch (err) {
        return { skipped: true, reason: err.message };
      }
    });

    // Step 4: Pull GBP info
    const gbpInfo = await step.run('pull-gbp-info', async () => {
      try {
        const auth = await getDataForSEOCredentials();

        // Search for GBP by company name and location
        const searchQuery = `${companyName} ${context.customer.city || ''} ${context.customer.state || ''}`.trim();

        const result = await callDataForSEO(auth, 'business_data/google/my_business_info/live', [{
          keyword: searchQuery,
          location_code: 2840,
          language_code: 'en',
        }]);

        if (!result?.items?.length) return { skipped: true, reason: 'No GBP listing found' };

        const listing = result.items[0];
        return {
          title: listing.title,
          rating: listing.rating?.value || null,
          review_count: listing.rating?.votes_count || null,
          category: listing.category || null,
          address: listing.address || null,
          phone: listing.phone || null,
          url: listing.url || null,
          place_id: listing.place_id || null,
          is_claimed: listing.is_claimed || null,
        };
      } catch (err) {
        return { skipped: true, reason: err.message };
      }
    });

    // Step 5: AI analysis — build knowledge graph via model router
    const analysis = await step.run('ai-analysis', async () => {
      const factsText = context.facts.map(f => `- [${f.fact_type}] ${f.fact_summary} (confidence: ${f.confidence})`).join('\n');

      const prompt = `Analyze this prospect for a marketing agency and build a structured knowledge graph.

COMPANY: ${companyName}
WEBSITE: ${websiteUrl || 'Unknown'}
LOCATION: ${context.customer.city || 'Unknown'}, ${context.customer.state || 'Unknown'}
INDUSTRY: ${context.customer.industry || 'Unknown'}
DEAL SCORE: ${dealScore || 'N/A'}

CLIENT FACTS FROM CALL:
${factsText || 'None extracted yet'}

TECH STACK: ${JSON.stringify(techStack.skipped ? 'Not available' : techStack.technologies?.slice(0, 20))}
DOMAIN RANK: ${JSON.stringify(domainRank.skipped ? 'Not available' : domainRank)}
GBP INFO: ${JSON.stringify(gbpInfo.skipped ? 'Not available' : gbpInfo)}

Return a JSON object with these fields:
{
  "business_overview": {
    "company_name": "",
    "industry": "",
    "business_type": "local_brick_and_mortar|service_area|multi_location|ecommerce|national|hybrid",
    "estimated_size": "micro|small|medium",
    "location_summary": ""
  },
  "digital_presence": {
    "website_quality": "none|poor|average|good|excellent",
    "has_ssl": true/false,
    "cms_platform": "",
    "seo_visibility": "none|low|moderate|high",
    "gbp_status": "not_found|unclaimed|claimed_incomplete|optimized",
    "gbp_rating": null,
    "gbp_review_count": null,
    "social_presence": []
  },
  "opportunity_assessment": {
    "primary_services_needed": [],
    "urgency_level": "low|medium|high|urgent",
    "estimated_monthly_value": null,
    "growth_potential": "low|medium|high",
    "competitive_position": "weak|moderate|strong"
  },
  "gaps_identified": [],
  "recommended_next_steps": [],
  "qualification_score": 0-100
}`;

      try {
        const result = await routeModel({
          task: 'classification',
          prompt,
          system: 'You are a business analyst for a digital marketing agency. Return ONLY valid JSON, no markdown fences.',
          caller: 'business-analyzer',
          maxTokens: 1024,
        });

        // Parse the response
        let parsed;
        try {
          const clean = result.text.replace(/```json?/g, '').replace(/```/g, '').trim();
          parsed = JSON.parse(clean);
        } catch {
          parsed = { raw_analysis: result.text, parse_error: true };
        }

        return {
          analysis: parsed,
          model_used: result.model,
          route: result.route,
          latency_ms: result.latency_ms,
        };
      } catch (err) {
        console.error('AI analysis failed:', err.message);
        return {
          analysis: { error: err.message },
          model_used: 'none',
          route: 'failed',
        };
      }
    });

    // Step 6: Upsert client_knowledge_graph
    const kgResult = await step.run('upsert-knowledge-graph', async () => {
      const knowledgeGraph = {
        business_overview: analysis.analysis.business_overview || {},
        digital_presence: analysis.analysis.digital_presence || {},
        opportunity_assessment: analysis.analysis.opportunity_assessment || {},
        tech_stack: techStack.skipped ? null : techStack,
        domain_rank: domainRank.skipped ? null : domainRank,
        gbp_info: gbpInfo.skipped ? null : gbpInfo,
        deal_score: dealScore,
        gaps_identified: analysis.analysis.gaps_identified || [],
        recommended_next_steps: analysis.analysis.recommended_next_steps || [],
        analyzed_at: new Date().toISOString(),
        analyzer_model: analysis.model_used,
      };

      if (context.existingKG) {
        // Merge with existing KG
        const merged = { ...context.existingKG.knowledge_graph, ...knowledgeGraph };
        const { error } = await supabase
          .from('client_knowledge_graph')
          .update({
            knowledge_graph: merged,
            completeness_score: analysis.analysis.qualification_score || 30,
            updated_at: new Date().toISOString(),
            source: 'business-analyzer',
            provenance_tag: 'auto-analyzed',
          })
          .eq('id', context.existingKG.id);

        if (error) console.warn('KG update error:', error.message);
        return { updated: true, kg_id: context.existingKG.id };
      } else {
        const kgId = `kg_${customerId}_${Date.now()}`;
        const { error } = await supabase
          .from('client_knowledge_graph')
          .insert({
            id: kgId,
            tenant_id: 'creative-partner',
            customer_id: customerId,
            version: 1,
            knowledge_graph: knowledgeGraph,
            source: 'business-analyzer',
            skill_version: 'business-analyzer-v1',
            completeness_score: analysis.analysis.qualification_score || 30,
            is_current: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: 'active',
            provenance_tag: 'auto-analyzed',
          });

        if (error) console.warn('KG insert error:', error.message);
        return { created: true, kg_id: kgId };
      }
    });

    // Step 7: Upsert client_qualification_profile
    const qualResult = await step.run('upsert-qualification', async () => {
      const a = analysis.analysis;
      const dp = a.digital_presence || {};
      const oa = a.opportunity_assessment || {};

      const profile = {
        tenant_id: 'creative-partner',
        customer_id: customerId,
        is_current: true,
        g2_has_website: !!websiteUrl,
        g2_website_url: websiteUrl || null,
        g2_gbp_status: dp.gbp_status || null,
        g3_service_area_type: a.business_overview?.business_type || null,
        g3_industry_vertical: a.business_overview?.industry || context.customer.industry || null,
        g4_gbp_rating: gbpInfo.rating || dp.gbp_rating || null,
        g4_gbp_review_count: gbpInfo.review_count || dp.gbp_review_count || null,
        completeness_score: a.qualification_score || 30,
        proposal_tier: oa.estimated_monthly_value >= 3000 ? 'premium' : oa.estimated_monthly_value >= 1500 ? 'standard' : 'starter',
        created_by: 'business-analyzer',
        notes: `Auto-generated by business-analyzer. Model: ${analysis.model_used}. Route: ${analysis.route}.`,
        updated_at: new Date().toISOString(),
      };

      // Check if profile exists
      const { data: existing } = await supabase
        .from('client_qualification_profile')
        .select('id')
        .eq('customer_id', customerId)
        .eq('is_current', true)
        .limit(1);

      if (existing && existing.length > 0) {
        const { error } = await supabase
          .from('client_qualification_profile')
          .update(profile)
          .eq('id', existing[0].id);
        if (error) console.warn('Qual profile update error:', error.message);
        return { updated: true };
      } else {
        profile.created_at = new Date().toISOString();
        const { error } = await supabase
          .from('client_qualification_profile')
          .insert(profile);
        if (error) console.warn('Qual profile insert error:', error.message);
        return { created: true };
      }
    });

    // Step 8: Fire downstream event
    await step.run('fire-analysis-complete', async () => {
      await inngest.send({
        name: 'customer/analysis.complete',
        data: {
          customerId,
          companyName,
          slug,
          contactId,
          qualificationScore: analysis.analysis.qualification_score || 30,
          gapsIdentified: analysis.analysis.gaps_identified || [],
          servicesNeeded: analysis.analysis.opportunity_assessment?.primary_services_needed || [],
          kgResult,
          qualResult,
        },
      });
      return { fired: true };
    });

    // Step 8b: Log output to prompt_result_log for quality tracking
    await step.run('log-prompt-result', async () => {
      await supabase.from('prompt_result_log').insert({
        tenant_id: 'creative-partner',
        task_type: 'business_analysis',
        customer_id: customerId,
        model_used: analysis.model_used || 'unknown',
        prompt_version: 1,
        system_prompt: 'You are a business analyst for a digital marketing agency. Return ONLY valid JSON, no markdown fences.',
        user_prompt: `COMPANY: ${companyName} | WEBSITE: ${websiteUrl || 'Unknown'} | INDUSTRY: ${context.customer?.industry || 'Unknown'}`,
        output: JSON.stringify(analysis.analysis).substring(0, 2000),
        output_type: 'knowledge_graph',
        updated_at: new Date().toISOString(),
      });
      return { logged: true };
    });

    // Step 9: Log CIA episode
    await step.run('log-cia-episode', async () => {
      await supabase.from('cia_episode').insert({
        episode_type: 'action',
        source_system: 'inngest',
        actor: 'business-analyzer',
        content: `Business analysis completed for ${companyName}. Qualification: ${analysis.analysis.qualification_score || 'N/A'}/100. Website: ${dp?.website_quality || 'unknown'}. GBP: ${dp?.gbp_status || 'unknown'}. Services needed: ${analysis.analysis.opportunity_assessment?.primary_services_needed?.join(', ') || 'TBD'}. Model: ${analysis.model_used} via ${analysis.route}.`,
        metadata: {
          customer_id: customerId,
          model_used: analysis.model_used,
          route: analysis.route,
          latency_ms: analysis.latency_ms,
          tech_stack_found: !techStack.skipped,
          domain_rank_found: !domainRank.skipped,
          gbp_found: !gbpInfo.skipped,
          qualification_score: analysis.analysis.qualification_score,
        },
        timestamp_event: new Date().toISOString(),
      });
    });

    return {
      success: true,
      customerId,
      companyName,
      qualificationScore: analysis.analysis.qualification_score || null,
      modelUsed: analysis.model_used,
      techStackFound: !techStack.skipped,
      domainRankFound: !domainRank.skipped,
      gbpFound: !gbpInfo.skipped,
      nextEvent: 'customer/analysis.complete',
    };
  }
);
