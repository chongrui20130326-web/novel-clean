/**
 * 本地 9B 模型复核层（Ollama）。
 *
 * 设计原则：模型只做“判断”，不自由重写。
 *  - 截断：模型判断是否合并，并给出逐字拼接结果；软件再校验 merged 是否
 *    真的等于两行原文（去空白后）。校验不过就退回软件拼接，绝不接受改写。
 *  - 无关内容：模型判断整段是否该删，返回类别和置信度；删除动作仍由软件执行。
 *
 * 这样即使 9B 模型偶发幻觉，也不会把正文改丢。
 */

const TRUNCATION_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          merge: { type: 'boolean' },
          merged: { type: 'string' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['id', 'merge', 'merged', 'confidence', 'reason'],
      },
    },
  },
  required: ['decisions'],
};

const IRRELEVANT_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          remove: { type: 'boolean' },
          kind: { type: 'string' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['id', 'remove', 'kind', 'confidence', 'reason'],
      },
    },
  },
  required: ['decisions'],
};

const TRUNCATION_SYSTEM = `你是中文小说校对员。用户会给出若干“换行候选”：上一行末尾没有句末标点，下一行可能是同一句话的续写。
你的任务是判断这个换行是不是把一句话硬拆成了两行。

merge=true 的条件（必须同时满足）：
1. 上一行在语法上没有结束，下一行是它的直接续写；
2. 合并后是一个自然、完整的句子或分句；
3. 不是换人说话、场景切换、诗歌、列表或另起一段。

merge=false 的情况：章节标题、两段独立对话、下一行另起新段、上一行其实已经说完、你不确定。

如果 merge=true，merged 必须是“上一行原文 + 下一行原文”的逐字拼接：
- 只允许去掉换行；英文单词之间可以补一个空格；
- 不得改写、增删任何字，不得补句号，不得调整语序。
如果 merge=false，merged 填空字符串。

只输出 JSON，不要 markdown，不要解释。格式：
{"decisions":[{"id":"T1","merge":true,"merged":"拼接后的原文","confidence":0.95,"reason":"不超过30字"}]}`;

const IRRELEVANT_SYSTEM = `你是中文小说编辑。用户会给出若干“疑似无关内容”，请判断是否应从小说正文中整段删除。

remove=true：广告、作者留言/请假条、求收藏求推荐、网站导航、盗版网址、联系方式、纯符号、与故事无关的更新/版权说明。
remove=false：角色对话、书信/短信/日记内容、正文叙述、章节标题、情节中出现的网址或广告（如果它推动剧情）、你拿不准的段落。
特别注意：如果一段里既有故事又有广告，但故事是主体，remove=false（软件会另行处理行内网址）。

kind 取值：ad、author_note、url、contact、noise、story、other。
只输出 JSON，不要 markdown，不要解释。格式：
{"decisions":[{"id":"D1","remove":true,"kind":"ad","confidence":0.95,"reason":"不超过30字"}]}`;

function normalizeForCompare(text) {
  return String(text || '').replace(/[\s\u200b-\u200f\u2060\ufeff]/g, '');
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('模型返回空内容');
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error(`模型没有返回合法 JSON：${unfenced.slice(0, 120)}`);
  }
}

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function short(text, max = 180) {
  const value = String(text || '').replace(/\n/g, ' ');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

class NativeOllamaClient {
  constructor({ baseUrl = 'http://127.0.0.1:11434', model, timeoutMs = 240000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.stats = {
      calls: 0,
      failedCalls: 0,
      promptTokens: 0,
      evalTokens: 0,
      durationMs: 0,
      model: model || '',
      errors: [],
    };
  }

  async health() {
    try {
      const tags = await this.request('/api/tags', { method: 'GET' }, 3000);
      const models = Array.isArray(tags?.models) ? tags.models : [];
      const found = models.find((item) => item.name === this.model || item.model === this.model);
      let running = null;
      try {
        const ps = await this.request('/api/ps', { method: 'GET' }, 2000);
        running = (ps?.models || []).find((item) => item.name === this.model || item.model === this.model) || null;
      } catch {
        // /api/ps 在旧版 Ollama 上可能不存在，不影响主流程。
      }
      return {
        ok: Boolean(found),
        baseUrl: this.baseUrl,
        model: this.model,
        models: models.map((item) => ({
          name: item.name || item.model,
          size: item.size,
          parameters: item.details?.parameter_size || '',
          quantization: item.details?.quantization_level || '',
          family: item.details?.family || '',
        })),
        found: found
          ? {
            name: found.name || found.model,
            size: found.size,
            parameters: found.details?.parameter_size || '',
            quantization: found.details?.quantization_level || '',
          }
          : null,
        running: Boolean(running),
        error: found ? '' : `Ollama 已连接，但没有找到模型 ${this.model}`,
      };
    } catch (error) {
      return {
        ok: false,
        baseUrl: this.baseUrl,
        model: this.model,
        models: [],
        running: false,
        error: `Ollama 不可用：${error.message}`,
      };
    }
  }

  async request(path, options = {}, timeoutMs = this.timeoutMs) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama HTTP ${response.status}${body ? `：${body.slice(0, 200)}` : ''}`);
    }
    return response.json();
  }

  async chat({ system, user, schema, numPredict = 640 }) {
    const started = Date.now();
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      think: false,
      format: schema,
      keep_alive: '30m',
      options: {
        temperature: 0,
        top_p: 0.9,
        num_ctx: 8192,
        num_predict: numPredict,
      },
    };

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.request('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(body),
        });
        const content = result?.message?.content || '';
        if (!content.trim()) {
          throw new Error('模型 content 为空（think 可能未关闭）');
        }
        this.stats.calls += 1;
        this.stats.durationMs += Date.now() - started;
        this.stats.promptTokens += result.prompt_eval_count || 0;
        this.stats.evalTokens += result.eval_count || 0;
        return {
          json: extractJson(content),
          raw: content,
          promptTokens: result.prompt_eval_count || 0,
          evalTokens: result.eval_count || 0,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          body.messages.push({ role: 'user', content: '上一次输出无法解析。请只输出合法 JSON，不要 markdown。' });
          body.options.temperature = 0.1;
        }
      }
    }
    this.stats.failedCalls += 1;
    this.stats.errors.push(lastError?.message || '未知错误');
    throw lastError;
  }

  /** @param {Array} candidates detectTruncation 的输出 */
  async reviewTruncations(candidates, { limit = 24, batchSize = 4, onProgress = () => {} } = {}) {
    const selected = candidates
      .slice()
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
    const decisions = new Map();
    let done = 0;
    for (let offset = 0; offset < selected.length; offset += batchSize) {
      const batch = selected.slice(offset, offset + batchSize);
      const user = buildTruncationPrompt(batch);
      onProgress({ phase: 'truncation', done, total: selected.length, batch: batch.length });
      try {
        const result = await this.chat({
          system: TRUNCATION_SYSTEM,
          user,
          schema: TRUNCATION_SCHEMA,
          numPredict: 700,
        });
        const list = Array.isArray(result.json?.decisions) ? result.json.decisions : [];
        for (const decision of list) {
          const id = String(decision.id || '').trim();
          const candidate = batch.find((item) => item.id === id);
          if (!candidate) continue;
          const merge = decision.merge === true;
          let merged = String(decision.merged || '');
          let mergedSource = 'ai';
          const expected = normalizeForCompare(candidate.left + candidate.join + candidate.right);
          if (merge) {
            if (!merged || normalizeForCompare(merged) !== expected) {
              merged = candidate.left + candidate.join + candidate.right;
              mergedSource = 'fallback';
            }
          }
          decisions.set(id, {
            merge,
            merged: merge ? merged : '',
            mergedSource,
            confidence: clamp(decision.confidence, 0, 1),
            reason: short(decision.reason, 80),
            layer: 'ai',
          });
        }
        // 模型漏掉的条目按“不合并”处理，避免误伤。
        for (const candidate of batch) {
          if (!decisions.has(candidate.id)) {
            decisions.set(candidate.id, {
              merge: false,
              merged: '',
              mergedSource: 'missing',
              confidence: 0,
              reason: '模型未返回该条，按不合并处理',
              layer: 'ai',
            });
          }
        }
      } catch (error) {
        this.stats.errors.push(`截断复核：${error.message}`);
        for (const candidate of batch) {
          decisions.set(candidate.id, {
            merge: false,
            merged: '',
            mergedSource: 'error',
            confidence: 0,
            reason: `AI 调用失败：${short(error.message, 60)}`,
            layer: 'rule',
            error: true,
          });
        }
      }
      done += batch.length;
      onProgress({
        phase: 'truncation',
        done,
        total: selected.length,
        batch: batch.length,
        tokensPerSecond: this.stats.lastTokensPerSecond || null,
        completionTokens: this.stats.lastCompletionTokens || 0,
        durationMs: this.stats.lastDurationMs || 0,
        speedSource: this.stats.lastSpeedSource || '',
      });
    }
    return { selected, decisions, skipped: Math.max(0, candidates.length - selected.length) };
  }

  /** @param {Array} candidates detectIrrelevant 的输出 */
  async reviewIrrelevant(candidates, { limit = 20, batchSize = 4, onProgress = () => {} } = {}) {
    const selected = candidates
      .filter((item) => item.mode !== 'inline')
      .slice(0, limit);
    const decisions = new Map();
    let done = 0;
    for (let offset = 0; offset < selected.length; offset += batchSize) {
      const batch = selected.slice(offset, offset + batchSize);
      const user = buildIrrelevantPrompt(batch);
      onProgress({ phase: 'irrelevant', done, total: selected.length, batch: batch.length });
      try {
        const result = await this.chat({
          system: IRRELEVANT_SYSTEM,
          user,
          schema: IRRELEVANT_SCHEMA,
          numPredict: 520,
        });
        const list = Array.isArray(result.json?.decisions) ? result.json.decisions : [];
        for (const decision of list) {
          const id = String(decision.id || '').trim();
          const candidate = batch.find((item) => item.id === id);
          if (!candidate) continue;
          decisions.set(id, {
            remove: decision.remove === true,
            kind: String(decision.kind || 'other').slice(0, 24),
            confidence: clamp(decision.confidence, 0, 1),
            reason: short(decision.reason, 80),
            layer: 'ai',
          });
        }
        for (const candidate of batch) {
          if (!decisions.has(candidate.id)) {
            decisions.set(candidate.id, {
              remove: candidate.strength === 'strong',
              kind: 'other',
              confidence: 0,
              reason: '模型未返回该条，按规则结果处理',
              layer: 'rule',
              missing: true,
            });
          }
        }
      } catch (error) {
        this.stats.errors.push(`无关内容复核：${error.message}`);
        for (const candidate of batch) {
          decisions.set(candidate.id, {
            remove: candidate.strength === 'strong',
            kind: 'other',
            confidence: 0,
            reason: `AI 调用失败：${short(error.message, 60)}`,
            layer: 'rule',
            error: true,
          });
        }
      }
      done += batch.length;
      onProgress({
        phase: 'irrelevant',
        done,
        total: selected.length,
        batch: batch.length,
        tokensPerSecond: this.stats.lastTokensPerSecond || null,
        completionTokens: this.stats.lastCompletionTokens || 0,
        durationMs: this.stats.lastDurationMs || 0,
        speedSource: this.stats.lastSpeedSource || '',
      });
    }
    return { selected, decisions, skipped: Math.max(0, candidates.length - selected.length) };
  }
}

/* ------------------------------------------------------------------
 * 本地模型路由（OpenAI 兼容，默认 http://127.0.0.1:8090/v1）
 * ------------------------------------------------------------------ */

function gatewayRootOf(value) {
  const trimmed = String(value || 'http://127.0.0.1:8090').replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}

function modelMeta(name, model = {}) {
  const id = String(name || '');
  const backend = String(model.owned_by || '');
  const status = String(model.status || '');
  let parameters = '';
  let quantization = backend === 'strata' ? 'Strata' : 'Ollama';

  const qwen = id.match(/qwen3\.5:([0-9.]+)b/i);
  if (qwen) parameters = `${qwen[1]}B`;
  if (id === 'strata-q2') { parameters = 'Strata Q2'; quantization = 'IQ2_XXS'; }
  if (id === 'strata-q3') { parameters = 'Strata Q3'; quantization = 'IQ3_XXS'; }
  if (id === 'strata-q4') { parameters = 'Strata Q4'; quantization = 'Q4_K_S'; }

  return {
    name: id,
    parameters,
    quantization,
    size: 0,
    backend,
    status,
  };
}

export class OllamaClient extends NativeOllamaClient {
  constructor({
    baseUrl = 'http://127.0.0.1:8090',
    model,
    timeoutMs = 900000,
    apiKey = process.env.MODEL_GATEWAY_API_KEY || process.env.GATEWAY_API_KEY || 'local',
  } = {}) {
    const root = gatewayRootOf(baseUrl);
    super({ baseUrl: `${root}/v1`, model, timeoutMs });
    this.gatewayRoot = root;
    this.baseUrl = `${root}/v1`;
    this.apiKey = apiKey;
  }

  async gatewayJson(url, options = {}, timeoutMs = this.timeoutMs) {
    const headers = { ...(options.headers || {}) };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const detail = data?.error?.message || data?.detail || text.slice(0, 200);
      throw Object.assign(new Error(`模型路由 HTTP ${response.status}${detail ? `：${detail}` : ''}`), {
        status: response.status,
        body: data,
      });
    }
    return data;
  }

  async health() {
    try {
      const [modelsPayload, healthPayload, defaultPayload] = await Promise.all([
        this.gatewayJson(`${this.gatewayRoot}/v1/models`, { method: 'GET' }, 6000),
        this.gatewayJson(`${this.gatewayRoot}/health`, { method: 'GET' }, 8000).catch(() => null),
        this.gatewayJson(`${this.gatewayRoot}/admin/default-model`, { method: 'GET' }, 3000).catch(() => null),
      ]);
      const models = (Array.isArray(modelsPayload?.data) ? modelsPayload.data : [])
        .map((item) => modelMeta(item.id, item));
      const defaultModel = String(defaultPayload?.model || '');
      const found = models.find((item) => item.name === this.model)
        || models.find((item) => item.name === defaultModel)
        || models[0]
        || null;
      const backends = healthPayload?.backends || {};
      return {
        ok: models.length > 0,
        baseUrl: this.baseUrl,
        gatewayBase: this.gatewayRoot,
        model: this.model,
        defaultModel,
        models,
        found,
        running: found?.status === 'active',
        backends,
        activeStrataModel: healthPayload?.active_strata_model || '',
        ollama: {
          baseUrl: this.gatewayRoot,
          reachable: Boolean(backends.ollama === 'reachable'),
          error: models.length ? '' : '模型路由没有返回模型列表',
        },
        error: models.length
          ? (models.some((item) => item.name === this.model) ? '' : `路由中没有模型 ${this.model}`)
          : '模型路由不可用',
      };
    } catch (error) {
      return {
        ok: false,
        baseUrl: this.baseUrl,
        gatewayBase: this.gatewayRoot,
        model: this.model,
        defaultModel: '',
        models: [],
        found: null,
        running: false,
        backends: {},
        ollama: { baseUrl: this.gatewayRoot, reachable: false, error: error.message },
        error: `本地模型路由不可用：${error.message}`,
      };
    }
  }

  async chat({ system, user, schema, numPredict = 640 }) {
    const started = Date.now();
    const schemaHint = schema
      ? `\n\n输出必须是符合以下 JSON Schema 的单个 JSON 对象：\n${JSON.stringify(schema)}`
      : '';
    const messages = [
      { role: 'system', content: `${system}${schemaHint}` },
      { role: 'user', content: user },
    ];
    let responseFormat = schema
      ? { type: 'json_schema', json_schema: { name: 'novel_clean_decision', schema } }
      : null;

    let lastError = null;
    let correctionSent = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const body = {
        model: this.model,
        messages,
        stream: false,
        temperature: 0,
        top_p: 0.9,
        max_tokens: numPredict,
        reasoning_effort: 'none',
      };
      if (responseFormat) body.response_format = responseFormat;

      try {
        const result = await this.gatewayJson(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(body),
        }, this.timeoutMs);
        const message = result?.choices?.[0]?.message || {};
        const content = typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((part) => part?.text || '').join('')
            : '';
        if (!content.trim()) {
          throw new Error('模型 content 为空（reasoning 可能未关闭）');
        }
        const promptTokens = result?.usage?.prompt_tokens || 0;
        const evalTokens = result?.usage?.completion_tokens || 0;
        const durationMs = Date.now() - started;
        const timing = result?.timings || {};
        const predictedMs = Number(timing.predicted_ms) || 0;
        const predictedN = Number(timing.predicted_n) || evalTokens;
        const backendSpeed = Number(timing.predicted_per_second) || 0;
        const tokensPerSecond = backendSpeed
          || (predictedN && predictedMs ? predictedN / (predictedMs / 1000) : 0)
          || (evalTokens && durationMs ? evalTokens / (durationMs / 1000) : 0);
        const speedSource = backendSpeed ? 'backend' : 'wall';

        this.stats.calls += 1;
        this.stats.durationMs += durationMs;
        this.stats.promptTokens += promptTokens;
        this.stats.evalTokens += evalTokens;
        this.stats.lastTokensPerSecond = tokensPerSecond;
        this.stats.lastCompletionTokens = evalTokens;
        this.stats.lastDurationMs = durationMs;
        this.stats.lastSpeedSource = speedSource;
        return {
          json: extractJson(content),
          raw: content,
          promptTokens,
          evalTokens,
          durationMs,
          tokensPerSecond,
          speedSource,
        };
      } catch (error) {
        lastError = error;
        // 某些后端不支持 json_schema；逐级降为 json_object / 纯提示词。
        if (error.status === 400 && responseFormat) {
          responseFormat = responseFormat.type === 'json_schema' ? { type: 'json_object' } : null;
          continue;
        }
        if (!correctionSent) {
          correctionSent = true;
          messages.push({
            role: 'user',
            content: '上一次输出无法解析。请只输出合法 JSON，不要 markdown，不要解释。',
          });
          continue;
        }
        break;
      }
    }

    this.stats.failedCalls += 1;
    this.stats.errors.push(lastError?.message || '未知错误');
    throw lastError;
  }
}

function buildTruncationPrompt(batch) {
  const parts = [
    '判断下面每组上下行是否应合并。若合并，merged 必须逐字拼接两行，不得改写。',
    '',
  ];
  batch.forEach((candidate, index) => {
    parts.push(`【${candidate.id}】第 ${index + 1} 条`);
    if (candidate.chapterTitle) parts.push(`章节：${candidate.chapterTitle}`);
    if (candidate.contextBefore) parts.push(`更前文：…${candidate.contextBefore}`);
    parts.push(`上一行：${candidate.left}`);
    parts.push(`下一行：${candidate.right}`);
    if (candidate.contextAfter) parts.push(`更后文：${candidate.contextAfter}…`);
    parts.push('');
  });
  parts.push('只输出 JSON：{"decisions":[...]}。每条都要有 id、merge、merged、confidence、reason。');
  return parts.join('\n');
}

function buildIrrelevantPrompt(batch) {
  const parts = [
    '判断下面每段是否应从小说正文中整段删除。故事内容一律保留。',
    '',
  ];
  batch.forEach((candidate, index) => {
    parts.push(`【${candidate.id}】第 ${index + 1} 条${candidate.chapterTitle ? ` · ${candidate.chapterTitle}` : ''}`);
    if (candidate.contextBefore) parts.push(`前文：…${candidate.contextBefore}`);
    parts.push(`待判断：${candidate.text}`);
    if (candidate.contextAfter) parts.push(`后文：${candidate.contextAfter}…`);
    parts.push('');
  });
  parts.push('只输出 JSON：{"decisions":[...]}。每条都要有 id、remove、kind、confidence、reason。');
  return parts.join('\n');
}

/** 测试/离线演示用：按规则强度模拟模型判断。 */
export class MockAiClient {
  constructor({ model = 'mock-9b', fail = false } = {}) {
    this.model = model;
    this.fail = fail;
    this.stats = { calls: 0, failedCalls: 0, promptTokens: 0, evalTokens: 0, durationMs: 0, model, errors: [] };
  }

  async health() {
    return {
      ok: !this.fail,
      baseUrl: 'mock://local',
      model: this.model,
      models: [{ name: this.model, size: 0, parameters: '9B', quantization: 'mock', family: 'mock' }],
      found: { name: this.model, size: 0, parameters: '9B', quantization: 'mock' },
      running: !this.fail,
      error: this.fail ? 'mock failure' : '',
    };
  }

  async reviewTruncations(candidates, { limit = 24, onProgress = () => {} } = {}) {
    const selected = candidates.slice(0, limit);
    const decisions = new Map();
    selected.forEach((candidate, index) => {
      decisions.set(candidate.id, {
        merge: candidate.strength === 'strong',
        merged: candidate.strength === 'strong' ? candidate.left + candidate.join + candidate.right : '',
        mergedSource: 'mock',
        confidence: candidate.strength === 'strong' ? 0.92 : 0.4,
        reason: 'mock 规则判断',
        layer: 'ai',
      });
      onProgress({ phase: 'truncation', done: index + 1, total: selected.length });
    });
    this.stats.calls += 1;
    return { selected, decisions, skipped: Math.max(0, candidates.length - selected.length) };
  }

  async reviewIrrelevant(candidates, { limit = 20, onProgress = () => {} } = {}) {
    const selected = candidates.slice(0, limit);
    const decisions = new Map();
    selected.forEach((candidate, index) => {
      decisions.set(candidate.id, {
        remove: candidate.strength === 'strong',
        kind: 'mock',
        confidence: 0.9,
        reason: 'mock 规则判断',
        layer: 'ai',
      });
      onProgress({ phase: 'irrelevant', done: index + 1, total: selected.length });
    });
    this.stats.calls += 1;
    return { selected, decisions, skipped: Math.max(0, candidates.length - selected.length) };
  }
}
