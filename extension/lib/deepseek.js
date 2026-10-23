// DeepSeek 官方 API 客户端（OpenAI 兼容 chat/completions，支持图片与 JSON Output）。
// 注意：任何情况下都不打印 apiKey。

export class DeepSeekError extends Error {
  constructor(message, { status = 0, code = '', body = '' } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function normalizeBase(apiBase) {
  return String(apiBase || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
}

export async function chatCompletion({
  apiBase,
  apiKey,
  model,
  thinking,
  reasoningEffort,
  messages,
  maxTokens = 800,
  responseFormat = 'json_object',
  timeoutMs = 120000,
}) {
  if (!apiKey) {
    throw new DeepSeekError('还没有填写 DeepSeek API Key，请先在设置页填写。');
  }
  // fetch 的 Header 只能是 ISO-8859-1 字符，中文/全角符号会让浏览器直接抛错，这里提前给出可读提示。
  if (!/^[\x20-\x7e]+$/.test(apiKey)) {
    throw new DeepSeekError('API Key 里含有中文或全角字符，请检查是不是复制错了（Key 应该只包含字母、数字和连字符）。');
  }
  const url = `${normalizeBase(apiBase)}/chat/completions`;
  const body = {
    model: model || 'deepseek-flash',
    messages,
    stream: false,
    max_tokens: maxTokens,
  };
  if (thinking === 'enabled') {
    body.thinking = { type: 'enabled' };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  } else {
    body.thinking = { type: 'disabled' };
  }
  if (responseFormat === 'json_object') body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') {
      throw new DeepSeekError(`调用 DeepSeek 超时（${Math.round(timeoutMs / 1000)} 秒）。`);
    }
    throw new DeepSeekError(`调用 DeepSeek 失败：${error?.message || error}`);
  }
  clearTimeout(timer);

  const elapsedMs = Date.now() - startedAt;
  const rawText = await response.text();
  if (!response.ok) {
    let detail = '';
    let code = '';
    try {
      const parsed = JSON.parse(rawText);
      detail = parsed?.error?.message || rawText.slice(0, 300);
      code = parsed?.error?.code || '';
    } catch {
      detail = rawText.slice(0, 300);
    }
    throw new DeepSeekError(`DeepSeek API 返回 ${response.status}：${detail}`, {
      status: response.status,
      code,
      body: rawText.slice(0, 1000),
    });
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new DeepSeekError('DeepSeek 返回的内容不是合法 JSON（网络层）。');
  }
  if (data?.error) {
    throw new DeepSeekError(`DeepSeek 返回错误：${data.error.message || JSON.stringify(data.error)}`);
  }
  const choice = data?.choices?.[0] || {};
  const message = choice?.message || {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    finishReason: choice?.finish_reason || '',
    usage: data?.usage || {},
    model: data?.model || model,
    elapsedMs,
    requestId: data?.id || '',
  };
}

// 设置页"测试连接"用：发一句最短的话，验证地址 + Key + 模型是否可用。
export async function testConnection(settings) {
  const result = await chatCompletion({
    ...settings,
    messages: [{ role: 'user', content: '只回复两个字：可用' }],
    maxTokens: 20,
    responseFormat: 'none',
    timeoutMs: 45000,
  });
  return { text: result.content, elapsedMs: result.elapsedMs, model: result.model };
}
