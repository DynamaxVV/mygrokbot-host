// Provider maps: harness control plane -> upstream wire fields.
//
// Ported/trimmed from opengrok's Contract A (tools/provider-maps.cjs). The point is
// preserved: a map only touches fields it has actually verified for that route, and
// returns the route label it applied so the call can be audited. Unknown lanes are
// explicit no-ops, never guesses.
//
// ctx: { modelId, baseUrl, maxMode, parameters }

const GROK_MODEL_RE = /^grok[-.]/i;
const EFFORT_TO_XAI = { low: 'low', medium: 'medium', high: 'high', max: 'xhigh', xhigh: 'xhigh', minimal: 'low' };

const CLAUDE_MODEL_RE = /^claude[-.]/i;
const GEMINI_MODEL_RE = /^gemini/i;
const DEEPSEEK_MODEL_RE = /^deepseek/i;
const GLM_MODEL_RE = /^(glm[-.\d]|zai-org\/glm)/i;
const QWEN_MODEL_RE = /^qwen/i;

export function param(parameters, id) {
  if (!Array.isArray(parameters)) return undefined;
  for (const p of parameters) {
    if (p && p.id === id) return p.value;
  }
  return undefined;
}

function isGrokRoute(modelId) {
  return GROK_MODEL_RE.test(String(modelId || ''));
}

// xAI: reasoning_effort in {low, medium, high, xhigh}; reasoning is always on.
function applyGrok(body, maxMode, parameters) {
  const effort = param(parameters, 'effort');
  const fast = param(parameters, 'fast');
  if (maxMode === true) {
    body.reasoning_effort = 'xhigh';
    return;
  }
  if (fast === true) {
    body.reasoning_effort = 'low';
    return;
  }
  if (effort != null && Object.hasOwn(EFFORT_TO_XAI, String(effort))) {
    body.reasoning_effort = EFFORT_TO_XAI[String(effort)];
  }
}

// GLM: thinking:{type} + reasoning_effort {low,medium,high,max}; bare requests already think.
function applyGlm(body, parameters) {
  const fast = param(parameters, 'fast');
  if (fast === true || String(fast).toLowerCase() === 'true') {
    body.thinking = { type: 'disabled' };
    return 'glm-fast-off';
  }
  const effort = param(parameters, 'effort');
  const GLM_EFFORT = { low: 'low', medium: 'medium', high: 'high', max: 'max', xhigh: 'max', maximal: 'max' };
  const token = effort != null ? GLM_EFFORT[String(effort)] : undefined;
  if (token) {
    if (!body.thinking) body.thinking = { type: 'enabled' };
    if (body.reasoning_effort == null) body.reasoning_effort = token;
    return 'glm-effort';
  }
  const thinking = param(parameters, 'thinking');
  if (thinking === false || String(thinking).toLowerCase() === 'false') {
    body.thinking = { type: 'disabled' };
    return 'glm-thinking-off';
  }
  return null;
}

// DeepSeek: thinking on the wire is a top-level object plus a high default effort.
function applyDeepSeek(body, modelId, parameters) {
  const thinkingParam = param(parameters, 'thinking');
  const wantsThinking =
    String(modelId).endsWith(':thinking') || thinkingParam === true || String(thinkingParam).toLowerCase() === 'true';
  if (!wantsThinking) return null;
  body.thinking = { type: 'enabled' };
  if (body.reasoning_effort == null) {
    const effort = param(parameters, 'effort');
    body.reasoning_effort = effort ? String(effort) : 'high';
  }
  if (body.max_tokens == null) body.max_tokens = 256000;
  return 'deepseek-thinking';
}

// Qwen: chat_template_kwargs.enable_thinking, only filled when the caller stayed silent.
function applyQwen(body, maxMode, parameters) {
  const thinking = param(parameters, 'thinking');
  const off = thinking === false || String(thinking).toLowerCase() === 'false';
  const on = thinking === true || String(thinking).toLowerCase() === 'true' || maxMode === true;
  if (off) {
    body.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), enable_thinking: false };
    return 'qwen-thinking-off';
  }
  if (on) {
    body.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), enable_thinking: true };
    return 'qwen-thinking-on';
  }
  return 'qwen-passthrough';
}

// Gemini: only the verified tiered family gets an effort->slug rewrite.
const GEMINI_TIERED_FAMILY_RE = /^gemini-3\.6-flash$/i;
const GEMINI_EFFORT_TO_SLUG = { low: 'low', medium: 'medium', high: 'high', max: 'high', xhigh: 'high' };
function applyGemini(body, parameters) {
  const model = String(body.model || '');
  if (!GEMINI_TIERED_FAMILY_RE.test(model)) return 'gemini-passthrough';
  const effort = param(parameters, 'effort');
  if (effort == null) return 'gemini-passthrough';
  if (param(parameters, 'fast') === true) return 'gemini-passthrough';
  const token = GEMINI_EFFORT_TO_SLUG[String(effort)];
  if (!token) return 'gemini-passthrough';
  body.model = `${model}-${token}`;
  return 'gemini-slug';
}

export function routeNameForModel(modelId, baseUrl = '') {
  const m = String(modelId || '');
  const b = String(baseUrl || '');
  if (isGrokRoute(m)) return 'grok';
  if (CLAUDE_MODEL_RE.test(m)) return 'claude';
  if (GEMINI_MODEL_RE.test(m)) return 'gemini';
  if (DEEPSEEK_MODEL_RE.test(m)) return 'deepseek';
  if (GLM_MODEL_RE.test(m)) return 'glm';
  if (QWEN_MODEL_RE.test(m)) return 'qwen';
  if (/openai|gpt-/i.test(m)) return 'openai';
  if (b.includes('/mock')) return 'mock';
  return 'openai-compatible';
}

export function applyProviderReasoningControls(body, ctx = {}) {
  const modelId = String(ctx.modelId || '');
  const baseUrl = String(ctx.baseUrl || '');
  if (isGrokRoute(modelId)) {
    applyGrok(body, ctx.maxMode === true, ctx.parameters);
    return 'grok';
  }
  if (CLAUDE_MODEL_RE.test(modelId)) return 'claude-passthrough';
  if (GEMINI_MODEL_RE.test(modelId)) return applyGemini(body, ctx.parameters);
  if (DEEPSEEK_MODEL_RE.test(modelId)) return applyDeepSeek(body, modelId, ctx.parameters) ?? 'deepseek-passthrough';
  if (GLM_MODEL_RE.test(modelId)) return applyGlm(body, ctx.parameters) ?? 'glm-passthrough';
  if (QWEN_MODEL_RE.test(modelId)) return applyQwen(body, ctx.maxMode === true, ctx.parameters);
  if (baseUrl.includes('/mock')) return 'mock';
  return 'none';
}
