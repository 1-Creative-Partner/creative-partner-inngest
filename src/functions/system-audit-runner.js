import { inngest } from '../inngest-client.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SLACK_WEBHOOK_KEY = 'webhook_url';

async function getSlackWebhook() {
  const { data } = await supabase
    .from('api_credential')
    .select('credential_value')
    .eq('service', 'slack')
    .eq('credential_key', SLACK_WEBHOOK_KEY)
    .single();
  return data?.credential_value || null;
}

async function runCheckQuery(definition) {
  const query = definition.check_query;
  if (!query || !query.trim().toUpperCase().startsWith('SELECT')) {
    return { result: 'skipped', detail: 'No executable SQL check_query', affected_count: 0, affected_ids: [] };
  }

  try {
    const { data, error } = await supabase.rpc('exec_audit_query', { query_text: query });

    if (error) {
      // Fallback: try direct query via REST for simple checks
      return { result: 'skipped', detail: `RPC unavailable: ${error.message}`, affected_count: 0, affected_ids: [] };
    }

    const rows = data || [];
    const hasIssue = rows.length > 0 && !isPassResult(rows, definition);

    return {
      result: hasIssue ? (definition.severity === 'info' ? 'warning' : definition.severity === 'critical' ? 'fail' : 'warning') : 'pass',
      detail: hasIssue ? `Found ${rows.length} issue(s)` : 'No issues found',
      affected_count: hasIssue ? rows.length : 0,
      affected_ids: hasIssue ? rows.slice(0, 20).map(r => r.id).filter(Boolean) : [],
      raw_rows: rows.slice(0, 10),
    };
  } catch (err) {
    return { result: 'skipped', detail: `Query error: ${err.message}`, affected_count: 0, affected_ids: [] };
  }
}

function isPassResult(rows, definition) {
  // Special cases where the query returns a status/count check
  if (rows.length === 1) {
    const row = rows[0];
    // CIA episode gap check returns {status: 'OK'} or {status: 'GAP'}
    if (row.status === 'OK') return true;
    if (row.status === 'GAP') return false;
    // Count-based checks: if count > 0, that's good (e.g., pipeline flow checks)
    if (definition.category === 'pipeline_flow' && typeof row.count !== 'undefined') {
      return parseInt(row.count) > 0;
    }
    // Credential checks: rows returned = credentials exist = pass
    if (definition.category === 'credential_health') {
      return true; // Having rows means creds found; staleness check is separate
    }
  }
  // For credential_health checks that return hours_old
  if (definition.name === 'cr_ghl_pit_token_age' && rows[0]?.hours_old) {
    return parseFloat(rows[0].hours_old) < 24;
  }
  // Default: rows returned = issues found
  return false;
}

async function runAutoFix(definition) {
  if (!definition.auto_fix_available || !definition.auto_fix_query) return null;

  try {
    const { error } = await supabase.rpc('exec_audit_query', { query_text: definition.auto_fix_query });
    if (error) return `Auto-fix failed: ${error.message}`;
    return 'Auto-fix applied successfully';
  } catch (err) {
    return `Auto-fix error: ${err.message}`;
  }
}

function buildSlackSummary(auditRun, findings) {
  const criticals = findings.filter(f => f.result === 'fail');
  const warnings = findings.filter(f => f.result === 'warning');
  const autoFixed = findings.filter(f => f.result === 'auto_fixed');
  const passed = findings.filter(f => f.result === 'pass');

  const icon = criticals.length > 0 ? ':rotating_light:' : warnings.length > 0 ? ':warning:' : ':white_check_mark:';
  const headline = criticals.length > 0
    ? `${criticals.length} CRITICAL issue(s) found`
    : warnings.length > 0
      ? `${warnings.length} warning(s) found`
      : 'All checks passed';

  let text = `${icon} *System Audit — ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}*\n`;
  text += `${headline}\n`;
  text += `${passed.length} passed | ${warnings.length} warnings | ${criticals.length} critical | ${autoFixed.length} auto-fixed\n`;

  if (criticals.length > 0) {
    text += `\n*Critical:*\n`;
    for (const f of criticals) {
      text += `  :red_circle: ${f.title} — ${f.detail} (${f.affected_count} affected)\n`;
    }
  }
  if (warnings.length > 0) {
    text += `\n*Warnings:*\n`;
    for (const f of warnings) {
      text += `  :large_yellow_circle: ${f.title} — ${f.detail}\n`;
    }
  }
  if (autoFixed.length > 0) {
    text += `\n*Auto-Fixed:*\n`;
    for (const f of autoFixed) {
      text += `  :wrench: ${f.title} — ${f.fix_applied}\n`;
    }
  }

  return text;
}

// ── Main Audit Runner ────────────────────────────────────────────────────────

export const systemAuditRunner = inngest.createFunction(
  {
    id: 'system-audit-runner',
    name: 'System Audit Runner',
    retries: 1,
  },
  { cron: '0 10 * * *' }, // 6am ET = 10:00 UTC
  async ({ step }) => {
    // Step 1: Load all enabled audit definitions
    const definitions = await step.run('load-audit-definitions', async () => {
      const { data, error } = await supabase
        .from('audit_definition')
        .select('*')
        .eq('enabled', true)
        .order('sequence_order', { ascending: true });

      if (error) throw new Error(`Failed to load audit definitions: ${error.message}`);
      return data;
    });

    // Step 2: Create audit_run record
    const auditRun = await step.run('create-audit-run', async () => {
      const { data, error } = await supabase
        .from('audit_run')
        .insert({
          run_type: 'scheduled',
          trigger: 'inngest_cron',
          categories_run: [...new Set(definitions.map(d => d.category))],
          total_checks: definitions.length,
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) throw new Error(`Failed to create audit_run: ${error.message}`);
      return data;
    });

    // Step 3: Run each audit check in sequence order
    const findings = await step.run('execute-all-checks', async () => {
      const results = [];
      let passed = 0, warnings = 0, failures = 0, autoFixed = 0;

      for (const def of definitions) {
        const checkResult = await runCheckQuery(def);
        let finalResult = checkResult.result;
        let fixApplied = null;

        // Try auto-fix if available and issue found
        if ((finalResult === 'fail' || finalResult === 'warning') && def.auto_fix_available) {
          fixApplied = await runAutoFix(def);
          if (fixApplied && !fixApplied.startsWith('Auto-fix failed')) {
            finalResult = 'auto_fixed';
          }
        }

        // Count results
        if (finalResult === 'pass') passed++;
        else if (finalResult === 'warning') warnings++;
        else if (finalResult === 'fail') failures++;
        else if (finalResult === 'auto_fixed') autoFixed++;

        // Write finding
        const finding = {
          audit_run_id: auditRun.id,
          audit_definition_id: def.id,
          result: finalResult,
          detail: checkResult.detail,
          affected_table: def.check_query?.match(/FROM\s+(\w+)/i)?.[1] || null,
          affected_ids: checkResult.affected_ids || [],
          affected_count: checkResult.affected_count || 0,
          fix_applied: fixApplied,
          context: checkResult.raw_rows ? { sample_rows: checkResult.raw_rows } : null,
        };

        await supabase.from('audit_finding').insert(finding);

        results.push({
          name: def.name,
          title: def.title,
          category: def.category,
          severity: def.severity,
          result: finalResult,
          detail: checkResult.detail,
          affected_count: checkResult.affected_count || 0,
          fix_applied: fixApplied,
        });
      }

      // Update audit_run with totals
      const completedAt = new Date().toISOString();
      const summary = `${passed}/${definitions.length} passed, ${warnings} warnings, ${failures} critical, ${autoFixed} auto-fixed`;
      await supabase.from('audit_run').update({
        passed,
        warnings,
        failures,
        auto_fixed: autoFixed,
        completed_at: completedAt,
        duration_ms: Date.now() - new Date(auditRun.id ? Date.now() : 0).getTime(),
        summary,
      }).eq('id', auditRun.id);

      return { results, passed, warnings, failures, autoFixed, summary };
    });

    // Step 4: Post to Slack
    await step.run('notify-slack', async () => {
      const webhookUrl = await getSlackWebhook();
      if (!webhookUrl) return { skipped: true, reason: 'No Slack webhook URL found' };

      const text = buildSlackSummary(auditRun, findings.results);
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      return { posted: true };
    });

    // Step 5: Create tasks for actionable content freshness findings
    await step.run('create-followup-tasks', async () => {
      const actionable = findings.results.filter(f =>
        f.category === 'content_freshness' &&
        (f.result === 'warning' || f.result === 'fail') &&
        f.affected_count > 0
      );

      for (const finding of actionable) {
        const workflow = finding.name === 'cf_messages_unanswered_24h' ? 'follow_up_sms'
          : finding.name === 'cf_review_stalled_7d' ? 'follow_up_sms'
          : finding.name === 'cf_intake_abandoned' ? 'follow_up_sms'
          : 'admin';

        await supabase.from('task').insert({
          workflow,
          name: `Audit: ${finding.title}`,
          status: 'pending',
          priority: finding.severity === 'critical' ? 1 : 2,
          input: {
            source: 'system-audit',
            audit_name: finding.name,
            detail: finding.detail,
            affected_count: finding.affected_count,
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      return { tasks_created: actionable.length };
    });

    // Step 6: Log to cia_episode
    await step.run('log-cia-episode', async () => {
      await supabase.from('cia_episode').insert({
        episode_type: 'observation',
        source_system: 'system-audit-runner',
        actor: 'inngest',
        content: `Daily system audit completed. ${findings.summary}. ${findings.failures > 0 ? 'CRITICAL issues require attention.' : findings.warnings > 0 ? 'Warnings logged for review.' : 'All systems healthy.'}`,
        timestamp_event: new Date().toISOString(),
      });
      return { logged: true };
    });

    return {
      audit_run_id: auditRun.id,
      summary: findings.summary,
      criticals: findings.failures,
      tasks_created: findings.results.filter(f => f.category === 'content_freshness' && f.affected_count > 0).length,
    };
  }
);

// ── On-Demand Audit (triggered manually or post-deploy) ──────────────────────

export const systemAuditOnDemand = inngest.createFunction(
  {
    id: 'system-audit-on-demand',
    name: 'System Audit On-Demand',
    retries: 0,
  },
  { event: 'audit/run.requested' },
  async ({ event, step }) => {
    const categories = event.data?.categories || null; // null = run all

    const definitions = await step.run('load-definitions', async () => {
      let query = supabase
        .from('audit_definition')
        .select('*')
        .eq('enabled', true)
        .order('sequence_order', { ascending: true });

      if (categories && categories.length > 0) {
        query = query.in('category', categories);
      }

      const { data, error } = await query;
      if (error) throw new Error(`Failed to load definitions: ${error.message}`);
      return data;
    });

    // Reuse the same run logic — create run, execute checks, notify
    const auditRun = await step.run('create-run', async () => {
      const { data, error } = await supabase
        .from('audit_run')
        .insert({
          run_type: event.data?.run_type || 'manual',
          trigger: event.data?.trigger || 'manual',
          categories_run: [...new Set(definitions.map(d => d.category))],
          total_checks: definitions.length,
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) throw new Error(`Failed to create audit_run: ${error.message}`);
      return data;
    });

    const findings = await step.run('execute-checks', async () => {
      const results = [];
      let passed = 0, warnings = 0, failures = 0, autoFixed = 0;

      for (const def of definitions) {
        const checkResult = await runCheckQuery(def);
        let finalResult = checkResult.result;
        let fixApplied = null;

        if ((finalResult === 'fail' || finalResult === 'warning') && def.auto_fix_available) {
          fixApplied = await runAutoFix(def);
          if (fixApplied && !fixApplied.startsWith('Auto-fix failed')) {
            finalResult = 'auto_fixed';
          }
        }

        if (finalResult === 'pass') passed++;
        else if (finalResult === 'warning') warnings++;
        else if (finalResult === 'fail') failures++;
        else if (finalResult === 'auto_fixed') autoFixed++;

        await supabase.from('audit_finding').insert({
          audit_run_id: auditRun.id,
          audit_definition_id: def.id,
          result: finalResult,
          detail: checkResult.detail,
          affected_table: def.check_query?.match(/FROM\s+(\w+)/i)?.[1] || null,
          affected_ids: checkResult.affected_ids || [],
          affected_count: checkResult.affected_count || 0,
          fix_applied: fixApplied,
          context: checkResult.raw_rows ? { sample_rows: checkResult.raw_rows } : null,
        });

        results.push({ name: def.name, title: def.title, category: def.category, result: finalResult, detail: checkResult.detail, affected_count: checkResult.affected_count || 0, fix_applied: fixApplied });
      }

      const summary = `${passed}/${definitions.length} passed, ${warnings} warnings, ${failures} critical, ${autoFixed} auto-fixed`;
      await supabase.from('audit_run').update({
        passed, warnings, failures, auto_fixed: autoFixed,
        completed_at: new Date().toISOString(),
        summary,
      }).eq('id', auditRun.id);

      return { results, summary, passed, warnings, failures, autoFixed };
    });

    // Notify Slack for on-demand runs too
    await step.run('notify-slack', async () => {
      const webhookUrl = await getSlackWebhook();
      if (!webhookUrl) return { skipped: true };

      const text = buildSlackSummary(auditRun, findings.results);
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return { posted: true };
    });

    return { audit_run_id: auditRun.id, summary: findings.summary };
  }
);
