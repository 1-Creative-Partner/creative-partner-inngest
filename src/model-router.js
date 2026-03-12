import { supabase } from './supabase-client.js';

/**
 * Model Router — Routes LLM calls through OpenRouter using llm_model_matrix
 *
 * Looks up the cheapest qualified model for a task type from Supabase,
 * then calls it via OpenRouter's OpenAI-compatible API.
 *
 * Usage:
 *   const result = await routeModel({ task: "classification", prompt: "..." });
 *   const result = await routeModel({ task: "content writing", prompt: "...", model: "claude-sonnet-4-6" });
 *
 * Falls back to direct Anthropic API if OpenRouter key is missing.
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

// Cache the model matrix for 1 hour (avoid DB hit every call)
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
    return modelCache || []; // return stale cache if available
  }

  modelCache = data;
  cacheExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
  return data;
}

/**
 * Find the cheapest model that lists this task in recommended_use_cases
 */
async function findBestModel(taskType) {
  const matrix = await getModelMatrix();

  // Find models whose recommended_use_cases contain a matching term
  const taskLower = taskType.toLowerCase();
  const candidates = matrix.filter(m =>
    m.openrouter_id && // must be routable via OpenRouter
    m.recommended_use_cases?.some(uc => uc.toLowerCase().includes(taskLower))
  );

  if (candidates.length === 0) {
    // Default fallback: cheapest model with an OpenRouter ID
    const cheapest = matrix
      .filter(m => m.openrouter_id)
      .sort((a, b) => Number(a.input_cost_per_mtok) - Number(b.input_cost_per_mtok));
    return cheapest[0] || null;
  }

  // Sort by input cost ascending (cheapest first)
  candidates.sort((a, b) => Number(a.input_cost_per_mtok) - Number(b.input_cost_per_mtok));
  return candidates[0];
}

/**
 * Route a completion request to the best model via OpenRouter
 *
 * @param {Object} opts
 * @param {string} opts.task - Task type for auto-routing (e.g. "classification", "content writing")
 * @param {string} opts.prompt - The user message
 * @param {string} [opts.system] - Optional system message
 * @param {string} [opts.model] - Force a specific model_id (skips auto-routing)
 * @param {number} [opts.maxTokens=256] - Max output tokens
 * @returns {Promise<{text: string, model: string, provider: string, cost_tier: string}>}
 */
export async function routeModel({ task, prompt, system, model, maxTokens = 256 }) {
  let targetModel;
  let openrouterId;

  if (model) {
    // Explicit model override — look up its OpenRouter ID
    const matrix = await getModelMatrix();
    const found = matrix.find(m => m.model_id === model);
    targetModel = found || { model_id: model, openrouter_id: model, model_tier: 'unknown' };
    openrouterId = found?.openrouter_id || model;
  } else if (task) {
    // Auto-route based on task type
    targetModel = await findBestModel(task);
    if (!targetModel) {
      throw new Error(`No model found for task "${task}" and no fallback available`);
    }
    openrouterId = targetModel.openrouter_id;
  } else {
    throw new Error('Must provide either task or model');
  }

  // Build messages array
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  // Try OpenRouter first
  if (OPENROUTER_API_KEY && openrouterId) {
    try {
      const res = await fetch(OPENROUTER_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://creativepartnersolutions.com',
          'X-Title': 'Creative Partner OS',
        },
        body: JSON.stringify({
          model: openrouterId,
          messages,
          max_tokens: maxTokens,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        return {
          text,
          model: targetModel.model_id,
          openrouter_model: openrouterId,
          provider: targetModel.provider || 'openrouter',
          cost_tier: targetModel.model_tier || 'unknown',
          route: 'openrouter',
        };
      }

      console.warn(`OpenRouter ${res.status} for ${openrouterId}, falling back...`);
    } catch (err) {
      console.warn(`OpenRouter error: ${err.message}, falling back...`);
    }
  }

  // Fallback: direct Anthropic API (only works for Anthropic models)
  if (ANTHROPIC_API_KEY && (targetModel.provider === 'anthropic' || !openrouterId)) {
    const anthropicModel = targetModel.model_id || 'claude-haiku-4-5-20251001';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: system ? `${system}\n\n${prompt}` : prompt }],
      }),
    });

    if (!res.ok) throw new Error(`Anthropic API error: ${res.status}`);
    const data = await res.json();
    return {
      text: data.content?.[0]?.text || '',
      model: anthropicModel,
      provider: 'anthropic',
      cost_tier: targetModel.model_tier || 'micro',
      route: 'direct-anthropic',
    };
  }

  throw new Error('No API key available (need OPENROUTER_API_KEY or ANTHROPIC_API_KEY)');
}
