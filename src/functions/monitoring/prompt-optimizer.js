import { inngest } from '../../inngest-client.js';
import { supabase } from '../../supabase-client.js';
import { routeModel } from '../../model-router.js';

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_PROPOSALS || process.env.SLACK_WEBHOOK_AGENT_ALERTS;

/**
 * Prompt Optimizer
 *
 * Weekly cron (Monday 9am UTC) that:
 * 1. Reads prompt_result_log entries from the past 7 days
 * 2. Groups by task_type (transcript_intelligence, business_analysis, morning_briefing)
 * 3. Uses Claude Sonnet to analyze patterns — what outputs scored high vs low
 * 4. Proposes prompt improvements
 * 5. Writes proposals to prompt_version_history
 * 6. Posts to Slack for Chad to approve/reject
 *
 * Also handles: manual trigger via "prompt/optimize.requested" event
 */
export const promptOptimizer = inngest.createFunction(
  {
    id: 'prompt-optimizer',
    name: 'Prompt Optimizer (Weekly)',
    retries: 1,
    concurrency: { limit: 1 },
  },
  [
    { cron: '0 9 * * 1' }, // Monday 9am UTC
    { event: 'prompt/optimize.requested' },
  ],
  async ({ step }) => {
    const results = {};

    // Step 1: Gather scored outputs from the past 30 days
    const scoredData = await step.run('gather-scored-outputs', async () => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const { data: logs } = await supabase
        .from('prompt_result_log')
        .select('id, task_type, model_used, system_prompt, user_prompt, output, output_type, chad_score, auto_score, score_rationale, prompt_version, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(200);

      if (!logs || logs.length === 0) {
        return { hasData: false, count: 0 };
      }

      // Group by task_type
      const grouped = {};
      for (const log of logs) {
        const key = log.task_type || 'unknown';
        if (!grouped[key]) grouped[key] = { total: 0, scored: 0, avgScore: null, entries: [] };
        grouped[key].total++;
        if (log.chad_score || log.auto_score) {
          grouped[key].scored++;
          grouped[key].entries.push(log);
        }
      }

      // Compute avg scores
      for (const key of Object.keys(grouped)) {
        const entries = grouped[key].entries;
        if (entries.length > 0) {
          const scores = entries.map(e => e.chad_score || e.auto_score).filter(Boolean);
          grouped[key].avgScore = scores.length > 0
            ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
            : null;
        }
      }

      return { hasData: true, count: logs.length, grouped };
    });

    if (!scoredData.hasData) {
      await step.run('log-no-data', async () => {
        await supabase.from('cia_episode').insert({
          episode_type: 'observation',
          source_system: 'claude',
          actor: 'prompt-optimizer',
          content: 'Prompt optimizer ran but found no scored outputs yet. Outputs will accumulate as agents fire. Score them in /admin/model-performance.',
          timestamp_event: new Date().toISOString(),
        });
      });
      return { success: true, skipped: true, reason: 'no_scored_data' };
    }

    // Step 2: Analyze each task type and generate improvement proposals
    const proposals = await step.run('generate-proposals', async () => {
      const { grouped } = scoredData;
      const taskTypes = Object.keys(grouped).filter(k => grouped[k].scored >= 3); // need at least 3 scored examples

      if (taskTypes.length === 0) {
        return { proposals: [], reason: 'insufficient_scored_entries' };
      }

      const allProposals = [];

      for (const taskType of taskTypes) {
        const group = grouped[taskType];
        const highScored = group.entries.filter(e => (e.chad_score || e.auto_score) >= 7).slice(0, 3);
        const lowScored = group.entries.filter(e => (e.chad_score || e.auto_score) <= 4).slice(0, 3);

        if (highScored.length === 0 && lowScored.length === 0) continue;

        const analysisPrompt = `You are a prompt engineering expert analyzing AI agent performance data for a digital marketing agency.

TASK TYPE: ${taskType}
AVERAGE SCORE: ${group.avgScore}/10
TOTAL RUNS: ${group.total} (${group.scored} scored)

${highScored.length > 0 ? `HIGH-SCORING OUTPUTS (score 7-10):
${highScored.map(e => `Score: ${e.chad_score || e.auto_score}
System prompt: ${e.system_prompt?.substring(0, 200)}
Output: ${e.output?.substring(0, 300)}
---`).join('\n')}` : ''}

${lowScored.length > 0 ? `LOW-SCORING OUTPUTS (score 1-4):
${lowScored.map(e => `Score: ${e.chad_score || e.auto_score}
System prompt: ${e.system_prompt?.substring(0, 200)}
Output: ${e.output?.substring(0, 300)}
Rationale: ${e.score_rationale || 'none'}
---`).join('\n')}` : ''}

CURRENT SYSTEM PROMPT:
${group.entries[0]?.system_prompt || 'Not captured'}

Analyze what makes the high-scoring outputs better than low-scoring ones. Then propose a specific improved system prompt.

Return JSON:
{
  "pattern_analysis": "2-3 sentences on what separates high vs low scores",
  "key_improvement": "The single most important change to make",
  "proposed_system_prompt": "The full improved system prompt text",
  "expected_score_improvement": "+X points (e.g. +1.5)",
  "confidence": "low|medium|high"
}`;

        try {
          const result = await routeModel({
            task: 'analysis',
            prompt: analysisPrompt,
            system: 'You are a prompt engineering expert. Return ONLY valid JSON.',
            caller: 'prompt-optimizer',
            maxTokens: 1000,
          });

          let parsed;
          try {
            const clean = result.text.replace(/```json?/g, '').replace(/```/g, '').trim();
            parsed = JSON.parse(clean);
          } catch {
            parsed = { raw: result.text, parse_error: true };
          }

          allProposals.push({
            taskType,
            avgScore: group.avgScore,
            totalRuns: group.total,
            currentPrompt: group.entries[0]?.system_prompt,
            analysis: parsed,
            modelUsed: result.model,
          });
        } catch (err) {
          console.warn(`Failed to analyze ${taskType}:`, err.message);
        }
      }

      return { proposals: allProposals };
    });

    results.proposalCount = proposals.proposals?.length || 0;

    // Step 3: Write proposals to prompt_version_history
    await step.run('write-to-history', async () => {
      if (!proposals.proposals?.length) return { skipped: true };

      for (const p of proposals.proposals) {
        if (!p.analysis?.proposed_system_prompt || p.analysis?.parse_error) continue;

        // Find the agent profile for this task type
        const taskToAgent = {
          transcript_intelligence: 'transcript-intelligence-agent',
          business_analysis: 'business-analyzer',
          morning_briefing: 'morning-briefing-agent',
        };
        const agentName = taskToAgent[p.taskType] || p.taskType;

        const { data: profile } = await supabase
          .from('inngest_agent_profile')
          .select('id, prompt_version, current_system_prompt')
          .eq('agent_name', agentName)
          .single();

        if (!profile) continue;

        const newVersion = (profile.prompt_version || 1) + 1;

        await supabase.from('prompt_version_history').insert({
          agent_profile_id: profile.id,
          function_id: taskToAgent[p.taskType] || p.taskType,
          agent_name: agentName,
          version_number: newVersion,
          change_type: 'system_prompt',
          previous_value: profile.current_system_prompt,
          new_value: p.analysis.proposed_system_prompt,
          change_reason: p.analysis.key_improvement,
          changed_by: 'prompt-optimizer',
          score_before: parseFloat(p.avgScore),
          notes: p.analysis.pattern_analysis,
          outcome: 'pending',
        });
      }

      return { written: proposals.proposals.length };
    });

    // Step 4: Post proposals to Slack for Chad to review
    await step.run('notify-slack', async () => {
      if (!proposals.proposals?.length || !SLACK_WEBHOOK) return { skipped: true };

      const validProposals = proposals.proposals.filter(p => !p.analysis?.parse_error);
      if (!validProposals.length) return { skipped: true };

      const blocks = [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🧠 Prompt Optimizer — Weekly Report', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Analyzed *${scoredData.count} outputs* from the past 30 days. Found *${validProposals.length} improvement opportunity${validProposals.length !== 1 ? 'ies' : ''}*.`,
          },
        },
        { type: 'divider' },
      ];

      for (const p of validProposals) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${p.taskType.replace(/_/g, ' ').toUpperCase()}*\nAvg score: *${p.avgScore}/10* across ${p.totalRuns} runs\n\n*Pattern:* ${p.analysis.pattern_analysis}\n\n*Key improvement:* ${p.analysis.key_improvement}\n\n*Expected gain:* ${p.analysis.expected_score_improvement || 'unknown'} | Confidence: ${p.analysis.confidence || 'unknown'}`,
          },
        });
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Proposed new prompt (preview):*\n\`\`\`${(p.analysis.proposed_system_prompt || '').substring(0, 250)}...\`\`\``,
          },
        });
        blocks.push({ type: 'divider' });
      }

      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_Review & approve proposals at admin.creativepartnersolutions.com/admin/model-performance_`,
        }],
      });

      await fetch(SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Prompt Optimizer: ${validProposals.length} improvement proposals ready`, blocks }),
      });

      return { notified: true, proposalCount: validProposals.length };
    });

    // Step 5: Log CIA episode
    await step.run('log-cia-episode', async () => {
      await supabase.from('cia_episode').insert({
        episode_type: 'action',
        source_system: 'claude',
        actor: 'prompt-optimizer',
        content: `Prompt optimizer analyzed ${scoredData.count} outputs. Generated ${results.proposalCount} improvement proposals. ${results.proposalCount > 0 ? 'Proposals posted to Slack for Chad review.' : 'Insufficient scored data for proposals.'}`,
        metadata: {
          outputs_analyzed: scoredData.count,
          proposal_count: results.proposalCount,
          task_types_analyzed: Object.keys(scoredData.grouped || {}),
        },
        timestamp_event: new Date().toISOString(),
      });
    });

    return {
      success: true,
      outputsAnalyzed: scoredData.count,
      proposalsGenerated: results.proposalCount,
    };
  }
);
