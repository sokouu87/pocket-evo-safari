import { encodeBase64 } from './binary.js';

const restrictedHeaders = new Set(['cookie', 'referer', 'user-agent', 'origin']);
const pagePaths = new Set(['/window.html', '/popup.html', '/fullscreen.html']);
const maxBodyBytes = 20000000;
const ruleStart = 1000000;

export function trustedExtensionPage(sender, runtime) {
  if (sender.id !== runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === runtime.id && pagePaths.has(url.pathname);
  } catch {
    return false;
  }
}

export function validateRequest(message) {
  const url = new URL(message.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请求地址无效');
  url.hash = '';
  const method = String(message.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].includes(method)) throw new Error('请求方法无效');
  if (message.body != null && (typeof message.body !== 'string' || message.body.length > maxBodyBytes)) throw new Error('请求体无效');
  const headers = new Headers(message.headers);
  const modifications = [];
  for (const [name, value] of [...headers]) {
    if (restrictedHeaders.has(name)) {
      modifications.push({ header: name, operation: 'set', value });
      headers.delete(name);
    }
  }
  return {
    url: url.href,
    method,
    headers: Object.fromEntries(headers),
    modifications,
    body: message.body,
    credentials: message.credentials === 'omit' ? 'omit' : 'include',
    timeoutMs: Math.min(25000, Math.max(1000, Number(message.timeoutMs) || 20000)),
  };
}

export function makeHeaderRule(id, request, extensionId) {
  const escaped = request.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    id,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: request.modifications },
    condition: {
      regexFilter: `^${escaped}$`,
      isUrlFilterCaseSensitive: true,
      initiatorDomains: [extensionId],
      resourceTypes: ['xmlhttprequest'],
      requestMethods: [request.method.toLowerCase()],
      tabIds: [-1],
    },
  };
}

export async function readBoundedBody(response, limit = maxBodyBytes) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('响应超过 20 MB 限制');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createBroker(api, fetchImpl = fetch) {
  const pending = new Map();
  const tails = new Map();
  let nextRuleId = ruleStart;
  const ready = api.declarativeNetRequest.getSessionRules().then((rules) => {
    const removeRuleIds = rules.filter((rule) => rule.id >= ruleStart).map((rule) => rule.id);
    return api.declarativeNetRequest.updateSessionRules({ removeRuleIds });
  });
  ready.catch(() => undefined);

  function observe(details) {
    if (details.initiator !== api.runtime.getURL('').replace(/\/$/, '') || details.tabId !== -1) return;
    const state = pending.get(details.url);
    if (!state || details.method !== state.method || details.statusCode < 300 || details.statusCode >= 400) return;
    const location = details.redirectUrl || details.responseHeaders?.find((header) => header.name.toLowerCase() === 'location')?.value;
    if (location) {
      try {
        state.redirect = { status: details.statusCode, url: new URL(location, details.url).href };
      } catch {
        state.invalidRedirect = true;
      }
      state.notify?.();
    }
  }
  api.webRequest.onHeadersReceived.addListener(observe, { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest'] }, ['responseHeaders']);
  api.webRequest.onBeforeRedirect.addListener(observe, { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest'] });

  async function perform(request) {
    await ready;
    const id = nextRuleId++;
    const state = { method: request.method, redirect: null, notify: null };
    let ruleAdded = false;
    try {
      if (request.modifications.length) {
        const rule = makeHeaderRule(id, request, api.runtime.id);
        const support = await api.declarativeNetRequest.isRegexSupported({ regex: rule.condition.regexFilter, isCaseSensitive: true });
        if (!support.isSupported) throw new Error('请求地址超出 Chrome 精确规则限制');
        await api.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
        ruleAdded = true;
      }
      pending.set(request.url, state);
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        credentials: request.credentials,
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      if (response.type === 'opaqueredirect' && !state.redirect) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 250);
          state.notify = () => { clearTimeout(timeout); resolve(); };
        });
      }
      if (state.invalidRedirect) throw new Error('跳转地址无效');
      if (state.redirect) return { status: state.redirect.status, headers: { location: state.redirect.url }, base64: '' };
      if (response.type === 'opaqueredirect') throw new Error('Chrome 未返回可验证的跳转地址');
      const bytes = await readBoundedBody(response);
      return { status: response.status, headers: Object.fromEntries(response.headers), base64: encodeBase64(bytes) };
    } finally {
      pending.delete(request.url);
      if (ruleAdded) await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
    }
  }

  function request(message) {
    const value = validateRequest(message);
    const previous = tails.get(value.url) || Promise.resolve();
    const result = previous.catch(() => undefined).then(() => perform(value));
    const tail = result.catch(() => undefined);
    tails.set(value.url, tail);
    void tail.then(() => { if (tails.get(value.url) === tail) tails.delete(value.url); });
    return result;
  }
  return { ready, request };
}
