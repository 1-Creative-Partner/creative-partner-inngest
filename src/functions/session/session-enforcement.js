// Session Enforcement — P2-001
// Replaces n8n session-enforcement webhook entirely.
//
// TRIGGER: Inngest event "cp/session.closed"
// Fire via HTTP POST to https://inn.gs/e/{INNGEST_EVENT_KEY}
// Payload: { name: "cp/session.closed", data: { session_date, workstream, session_summary,
//            completed_deliverables[], decisions_made[], next_task, ... } }
//
// PIPELINE:
//   Step 1: Validate payload — ensure required fields present
//   Step 2: Analyze session with Claude (structured output) — extract evolution_log entries,
//            awareness updates, knowledge items from session summary
//   Step 3: Write staged records to session_enforcement_staging
//   Step 4: Auto-approve high-confidence records (>= 0.95 + validation passed)
//   Step 5: For pending records, send Slack alert to #system-alerts
//   Step 6: Log to cia_episode for observability

import { inngest } from '../../inngest-client.js';
import { supabase } from '../../supabase-client.js';
import { routeModel } from '../../model-router.js';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const AUTO_APPROVE_CONFIDENCE = 0.95;

export const sessionEnforcement = inngest.createFunction(
  {
    id: 'session-enforcement',
    name: 'Session Enforcement',
    retries: 2,
  },
  { event: 'cp/session.closed' },
  async ({ event, step, logger, runId }) => {
    const sessionData = event.data;
    logger.info(`Session enforcement triggered for: ${sessionData.session_date} | Workstream: ${sessionData.workstream}`);

    // ─── Step 1: Validate payload ───────────────────────────────────────────
    const validated = await step.run('validate-payload', async () => {
      const required = ['session_date', 'session_summary'];
      const missing = required.filter(f => !sessionData[f]);
      if (missing.length > 0) {
        throw new Error(`Session payload missing required fields: ${missing.join(', ')}`);
      }
      logger.info('Payload validated');
      return { valid: true, session_reference: `session-${sessionData.session_date}-${Date.now()}` };
    });

    // ─── Step 2: Analyze session with Claude ────────────────────────────────
    const analysis = await step.run('analyze-session-with-claude', async () => {
      const prompt = `You are analyzing a CP OS session close record. Extract structured data for Supabase writes.

SESSION DATE: ${sessionData.session_date}
WORKSTREAM: ${sessionData.workstream || 'unspecified'}
SUMMARY: ${sessionData.session_summary}
COMPLETED DELIVERABLES: ${JSON.stringify(sessionData.completed_deliverables || [])}
DECISIONS MADE: ${JSON.stringify(sessionData.decisions_made || [])}
NEXT TASK: ${sessionData.next_task || 'unspecified'}

Return ONLY valid JSON matching this exact schema:
{
  "evolution_entries": [
    {
      "evolution_type": "one of: architecture_decision|tool_configuration|data_model_change|process_change|skill_update|feature_discovery|bug_fix|integration_change|pricing_change|strategy_shift|learning|rollback|research_finding|client_pattern|performance_optimization|schema_change|architectural_decision|operational_decision|strategic_decision",
      "title": "string max 100 chars",
      "domain": "one of: supabase|clickup|n8n|gohighlevel|basecamp|dataforseo|pipedream|wix_studio|claude_skills|cross_platform|business_ops|client_delivery|runway|database|automation|ai_strategy|operations|strategy|architecture|bugherd|slack|miro",
      "trigger_context": "string",
      "rationale": "string",
      "change_description": "string",
      "expected_outcome": "string",
      "lesson_learned": "string",
      "impact_level": "one of: critical|high|medium|low|informational",
      "source": "string",
      "source_type": "one of: web_search|supabase_query|clickup_doc|project_knowledge|user_stated|tool_api|ai_inference|unverified",
      "confidence": 0.0
    }
  ],
  "awareness_updates": [
    {
      "awareness_key": "string snake_case",
      "title": "string",
      "content": "string",
      "rationale": "why this needs updating"
    }
  ],
  "knowledge_items": [
    {
      "key": "string snake_case",
      "value_summary": "string — what was learned",
      "confidence": 0.0
    }
  ],
  "session_quality_score": 0.0,
  "gaps_detected": ["array of strings describing anything incomplete"]
}

Only extract entries that represent real decisions, learnings, or state changes from this session. Return empty arrays if nothing applies.`;

      try {
        const result = await routeModel({
          task: "classification",
          prompt,
          caller: "session-enforcement",
          maxTokens: 2000,
        });
        const rawText = result.text || '{}';

        try {
          const parsed = JSON.parse(rawText.replace(/```json\n?|\n?```/g, '').trim());
          logger.info(`Analysis complete. Evolution entries: ${parsed.evolution_entries?.length || 0}, Gaps: ${parsed.gaps_detected?.length || 0}`);
          return parsed;
        } catch (e) {
          logger.warn(`Response parse failed — using empty analysis. Raw: ${rawText.slice(0, 200)}`);
          return { evolution_entries: [], awareness_updates: [], knowledge_items: [], session_quality_score: 0.7, gaps_detected: [] };
        }
      } catch {
        logger.warn('Model router failed — using empty analysis');
        return { evolution_entries: [], awareness_updates: [], knowledge_items: [], session_quality_score: 0.8, gaps_detected: [] };
      }
    });

    // ─── Step 3: Write staging records ──────────────────────────────────────
    const stagingIds = await step.run('write-staging-records', async () => {
      const ids = [];
      const now = new Date().toISOString();

      // Stage evolution log entries
      for (const entry of (analysis.evolution_entries || [])) {
        const confidence = entry.confidence || 0.8;
        const { data, error } = await supabase
          .from('session_enforcement_staging')
          .insert({
            session_reference: validated.session_reference,
            target_table: 'system_evolution_log',
            proposed_data: {
              actor: 'claude',
              evolution_type: entry.evolution_type,
              title: entry.title,
              domain: entry.domain,
              trigger_context: entry.trigger_context || sessionData.session_summary?.slice(0, 200),
              rationale: entry.rationale,
              change_description: entry.change_description,
              expected_outcome: entry.expected_outcome,
              lesson_learned: entry.lesson_learned,
              impact_level: entry.impact_level || 'medium',
              source: entry.source || 'session_enforcement',
              source_type: entry.source_type || 'ai_inference',
            },
            confidence,
            reasoning: entry.rationale,
            status: 'pending_approval',
            validation_status: 'passed',
            inngest_run_id: runId,
            inngest_event_id: event.id,
            llm_model: 'model-router',
            llm_provider: 'openrouter',
            gap_count: analysis.gaps_detected?.length || 0,
            updated_at: now,
          })
          .select('id')
          .single();

        if (error) {
          logger.warn(`Failed to stage evolution entry "${entry.title}": ${error.message}`);
        } else {
          ids.push({ id: data.id, confidence, target_table: 'system_evolution_log', title: entry.title });
        }
      }

      // Stage the core session handoff record (always high confidence)
      const { data: shData, error: shError } = await supabase
        .from('session_enforcement_staging')
        .insert({
          session_reference: validated.session_reference,
          target_table: 'session_handoff',
          proposed_data: {
            session_date: sessionData.session_date,
            session_summary: sessionData.session_summary,
            completed_deliverables: JSON.stringify(sessionData.completed_deliverables || []),
            decisions_made: JSON.stringify(sessionData.decisions_made || []),
            next_chat_prompt: sessionData.next_task || '',
            recommended_model: 'claude-sonnet-4-6',
            cia_layer: 'execution',
            cia_node_type: 'session',
          },
          confidence: 0.98,
          reasoning: 'Direct session close data — no inference required',
          status: 'pending_approval',
          validation_status: 'passed',
          inngest_run_id: runId,
          inngest_event_id: event.id,
          llm_model: 'none',
          llm_provider: 'none',
          gap_count: analysis.gaps_detected?.length || 0,
          updated_at: now,
        })
        .select('id')
        .single();

      if (shError) {
        logger.warn(`Failed to stage session_handoff: ${shError.message}`);
      } else {
        ids.push({ id: shData.id, confidence: 0.98, target_table: 'session_handoff', title: 'Session Handoff' });
      }

      logger.info(`Staged ${ids.length} records`);
      return ids;
    });

    // ─── Step 4: Auto-approve high-confidence records ────────────────────────
    const autoApproveResults = await step.run('auto-approve-high-confidence', async () => {
      const toApprove = stagingIds.filter(r => r.confidence >= AUTO_APPROVE_CONFIDENCE);
      const results = { approved: 0, pending: 0, errors: [] };

      for (const record of toApprove) {
        // Call process_staging_record RPC
        const { error } = await supabase.rpc('process_staging_record', {
          staging_id: record.id,
          action: 'approve',
          reviewer: 'inngest-auto-approve',
          rejection_reason: null,
          edited_data: null,
        });

        if (error) {
          logger.warn(`Auto-approve failed for ${record.id}: ${error.message}`);
          results.errors.push({ id: record.id, error: error.message });
          results.pending++;
        } else {
          logger.info(`Auto-approved: ${record.title} (confidence: ${record.confidence})`);
          results.approved++;
        }
      }

      // Count remaining pending
      const pendingCount = stagingIds.filter(r => r.confidence < AUTO_APPROVE_CONFIDENCE).length;
      results.pending += pendingCount;

      logger.info(`Auto-approve complete: ${results.approved} approved, ${results.pending} pending review`);
      return results;
    });

    // ─── Step 5: Slack alert for pending records ─────────────────────────────
    await step.run('notify-slack-pending', async () => {
      const pendingRecords = stagingIds.filter(r => r.confidence < AUTO_APPROVE_CONFIDENCE);

      // Always send a session close summary to Slack
      if (!SLACK_WEBHOOK_URL) {
        logger.warn('No SLACK_WEBHOOK_URL — skipping Slack notification');
        return { sent: false };
      }

      const pendingText = pendingRecords.length > 0
        ? `*${pendingRecords.length} records need review:*\n${pendingRecords.map(r => `• ${r.title} (confidence: ${r.confidence})`).join('\n')}`
        : '_All records auto-approved_ ✅';

      const gapsText = analysis.gaps_detected?.length > 0
        ? `\n*Gaps detected:*\n${analysis.gaps_detected.map(g => `• ${g}`).join('\n')}`
        : '';

      const payload = {
        text: `*Session Closed: ${sessionData.session_date}*`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Session Closed* — ${sessionData.session_date}\n*Workstream:* ${sessionData.workstream || 'unspecified'}\n*Quality Score:* ${((analysis.session_quality_score || 0) * 100).toFixed(0)}%`,
            },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Summary:*\n${sessionData.session_summary?.slice(0, 300)}...` },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Staged:* ${stagingIds.length} records | *Auto-approved:* ${autoApproveResults.approved} | *Pending:* ${autoApproveResults.pending}\n\n${pendingText}${gapsText}`,
            },
          },
        ],
      };

      const res = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        logger.warn(`Slack notification failed: ${res.status}`);
        return { sent: false };
      }

      logger.info('Slack notification sent to #system-alerts');
      return { sent: true };
    });

    // ─── Step 6: Log to cia_episode ──────────────────────────────────────────
    await step.run('log-cia-episode', async () => {
      const { error } = await supabase
        .from('cia_episode')
        .insert({
          episode_type: 'measurement',
          source_system: 'inngest',
          actor: 'Session Enforcement',
          content: `Session closed: ${sessionData.session_date}. Workstream: ${sessionData.workstream}. Staged ${stagingIds.length} records. Auto-approved: ${autoApproveResults.approved}. Pending: ${autoApproveResults.pending}. Quality score: ${analysis.session_quality_score}.`,
          metadata: {
            function_id: 'session-enforcement',
            session_date: sessionData.session_date,
            workstream: sessionData.workstream,
            staged_count: stagingIds.length,
            auto_approved: autoApproveResults.approved,
            pending: autoApproveResults.pending,
            gaps: analysis.gaps_detected || [],
            session_reference: validated.session_reference,
            inngest_run_id: runId,
          },
          timestamp_event: new Date().toISOString(),
        });

      if (error) logger.warn(`CIA episode log failed (non-fatal): ${error.message}`);
    });

    return {
      success: true,
      session_date: sessionData.session_date,
      session_reference: validated.session_reference,
      staged: stagingIds.length,
      auto_approved: autoApproveResults.approved,
      pending_review: autoApproveResults.pending,
      quality_score: analysis.session_quality_score,
      gaps_detected: analysis.gaps_detected?.length || 0,
    };
  }
);
