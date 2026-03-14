import { supabase } from './supabase-client.js';

/**
 * Model Router — Routes LLM calls through OpenRouter using llm_model_matrix
 *
 * Every call is logged to model_routing_log for quality optimization.
 *
 * Usage:
 *   const result = await routeModel({ task: "classification", prompt: "...", caller: "prompt-autoscorer" });
 *   const result = await routeModel({ task: "content writing", prompt: "...", model: "claude-sonnet-4-6", caller: "content-writer" });
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

// Cache the model matrix for 1 hour
let modelCache = null;
let cacheExpiry = 0;

async function getModelMatrix() {
  if (modelCache && Date.now() < cacheExpiry) return modelCache;

  const { data, error } = await supabase
    .from('llm_model_matrix')
    .select('model_id, provider, model_tier, openrouter_id, input_cost_per_mtok, output_cost_per_mtok, recommended_use_cases, fallback_model_id, is_active')
    .eq('is_active', true);

  if (error) {
    console.error('Failed to load model matrix:', error.message);
    return modelCache || [];
  }

  modelCache = data;
  cacheExpiry = Date.now() + 60 * 60 * 1000;
  return data;
}

/**
 * Find the cheapest model that lists this task in recommended_use_cases
 */
async function findBestModel(taskType) {
  const matrix = await getModelMatrix();
  const taskLower = taskType.toLowerCase();

  const candidates = matrix.filter(m =>
    m.openrouter_id &&
    m.recommended_use_cases?.some(uc => uc.toLowerCase().includes(taskLower))
  );

  if (candidates.length === 0) {
    const cheapest = matrix
      .filter(m => m.openrouter_id)
      .sort((a, b) => Number(a.input_cost_per_mtok) - Number(b.input_cost_per_mtok));
    return cheapest[0] || null;
  }

  candidates.sort((a, b) => Number(a.input_cost_per_mtok) - Number(b.input_cost_per_mtok));
  return candidates[0];
}

/**
 * Log a routed call to model_routing_log (fire-and-forget, never blocks)
 */
async function logRouting(entry) {
  try {
    await supabase.from('model_routing_log').insert(entry);
  } catch (err) {
    console.warn('Failed to log routing:', err.message);
  }
}

/**
 * Route a completion request to the best model
 *
 * @param {Object} opts
 * @param {string} opts.task - Task type for auto-routing
 * @param {string} opts.prompt - The user message
 * @param {string} [opts.system] - Optional system message
 * @param {string} [opts.model] - Force a specific model_id
 * @param {string} [opts.caller] - Which function is calling (for audit trail)
 * @param {number} [opts.maxTokens=256] - Max output tokens
 * @param {Array} [opts.tools] - OpenAI-format tools for function calling
 * @param {Array} [opts.messages] - Full messages array (overrides prompt/system if provided)
 * @returns {Promise<{text: string, model: string, provider: string, cost_tier: string, route: string, toolCalls?: Array, rawResponse?: Object}>}
 */
export async function routeModel({ task, prompt, system, model, caller = 'unknown', maxTokens = 256, tools, messages: rawMessages }) {
  const startTime = Date.now();
  let targetModel;
  let openrouterId;

  if (model) {
    const matrix = await getModelMatrix();
    const found = matrix.find(m => m.model_id === model);
    targetModel = found || { model_id: model, openrouter_id: model, model_tier: 'unknown', provider: 'unknown' };
    openrouterId = found?.openrouter_id || model;
  } else if (task) {
    targetModel = await findBestModel(task);
    if (!targetModel) {
      throw new Error(`No model found for task "${task}" and no fallback available`);
    }
    openrouterId = targetModel.openrouter_id;
  } else {
    throw new Error('Must provide either task or model');
  }

  // Build messages: use raw messages if provided, else construct from prompt/system
  const messages = rawMessages || (() => {
    const m = [];
    if (system) m.push({ role: 'system', content: system });
    if (prompt) m.push({ role: 'user', content: prompt });
    return m;
  })();

  // Try OpenRouter first
  if (OPENROUTER_API_KEY && openrouterId) {
    try {
      const body = {
        model: openrouterId,
        messages,
        max_tokens: maxTokens,
      };
      if (tools && tools.length > 0) body.tools = tools;

      const res = await fetch(OPENROUTER_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://creativepartnersolutions.com',
          'X-Title': 'Creative Partner OS',
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json();
        const message = data.choices?.[0]?.message || {};
        const text = message.content || '';
        const toolCalls = message.tool_calls || null;
        const usage = data.usage || {};
        const latencyMs = Date.now() - startTime;

        const result = {
          text,
          model: targetModel.model_id,
          openrouter_model: openrouterId,
          provider: targetModel.provider || 'openrouter',
          cost_tier: targetModel.model_tier || 'unknown',
          route: 'openrouter',
          latency_ms: latencyMs,
          input_tokens: usage.prompt_tokens || null,
          output_tokens: usage.completion_tokens || null,
        };
        if (toolCalls) {
          result.toolCalls = toolCalls;
          result.rawResponse = data;
        }

        // Log to model_routing_log (awaited — fire-and-forget breaks inside Inngest step.run)
        await logRouting({
          function_name: caller,
          task_type: task || 'explicit-model',
          model_requested: model || null,
          model_used: targetModel.model_id,
          openrouter_model: openrouterId,
          provider: targetModel.provider || 'openrouter',
          cost_tier: targetModel.model_tier || 'unknown',
          route: 'openrouter',
          input_tokens: usage.prompt_tokens || null,
          output_tokens: usage.completion_tokens || null,
          latency_ms: latencyMs,
          prompt_preview: (prompt || JSON.stringify(messages).substring(0, 200)).substring(0, 200),
          output_preview: text.substring(0, 200),
        });

        return result;
      }

      console.warn(`OpenRouter ${res.status} for ${openrouterId}, falling back...`);
    } catch (err) {
      console.warn(`OpenRouter error: ${err.message}, falling back...`);
    }
  }

  // Fallback: direct Anthropic API
  if (ANTHROPIC_API_KEY && (targetModel.provider === 'anthropic' || !openrouterId)) {
    const anthropicModel = targetModel.model_id || 'claude-haiku-4-5-20251001';
    const anthropicBody = {
      model: anthropicModel,
      max_tokens: maxTokens,
    };

    // Convert tools from OpenAI format to Anthropic format if provided
    if (tools && tools.length > 0) {
      anthropicBody.tools = tools.map(t => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description,
        input_schema: t.function?.parameters || t.input_schema,
      }));
    }

    // Build Anthropic messages
    if (rawMessages) {
      // Extract system from messages if present
      const sysMsg = rawMessages.find(m => m.role === 'system');
      if (sysMsg) anthropicBody.system = sysMsg.content;
      anthropicBody.messages = rawMessages.filter(m => m.role !== 'system');
    } else {
      if (system) anthropicBody.system = system;
      anthropicBody.messages = [{ role: 'user', content: prompt }];
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
    const data = await res.json();
    const text = data.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
    const anthropicToolUses = data.content?.filter(c => c.type === 'tool_use') || [];
    const usage = data.usage || {};
    const latencyMs = Date.now() - startTime;

    const result = {
      text,
      model: anthropicModel,
      provider: 'anthropic',
      cost_tier: targetModel.model_tier || 'micro',
      route: 'direct-anthropic',
      latency_ms: latencyMs,
      input_tokens: usage.input_tokens || null,
      output_tokens: usage.output_tokens || null,
    };
    if (anthropicToolUses.length > 0) {
      result.toolCalls = anthropicToolUses;
      result.rawResponse = data;
      result.stopReason = data.stop_reason;
    }

    await logRouting({
      function_name: caller,
      task_type: task || 'explicit-model',
      model_requested: model || null,
      model_used: anthropicModel,
      openrouter_model: null,
      provider: 'anthropic',
      cost_tier: targetModel.model_tier || 'micro',
      route: 'direct-anthropic',
      input_tokens: usage.input_tokens || null,
      output_tokens: usage.output_tokens || null,
      latency_ms: latencyMs,
      prompt_preview: (prompt || JSON.stringify(rawMessages || []).substring(0, 200)).substring(0, 200),
      output_preview: text.substring(0, 200),
    });

    return result;
  }

  throw new Error('No API key available (need OPENROUTER_API_KEY or ANTHROPIC_API_KEY)');
}
