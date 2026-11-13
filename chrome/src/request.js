import { decodeBase64 } from './binary.js';

const restrictedHeaders = new Set(['cookie', 'referer', 'user-agent', 'origin']);

export async function chromeQbitLogin(response, request, baseUrl) {
  if (response.ok && response.text.trim() === 'Ok.') return true;
  if (response.status !== 204 || response.text.trim()) return false;
  const version = await request(`${baseUrl}/api/v2/app/version`, { method: 'GET', credentials: 'include' });
  return version.ok && /^v?\d+\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(version.text.trim());
}

export function chromeQbitAddResult(response) {
  const checkTasks = '请先检查任务列表，避免重复发送';
  const unknown = { ok: false, message: `下载器返回了无法确认的添加结果，${checkTasks}` };
  const status = response?.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return unknown;
  if (response.ok !== true || status < 200 || status >= 300) {
    return { ok: false, message: `下载器返回 HTTP ${status}，${checkTasks}` };
  }
  if (typeof response.text !== 'string') return unknown;
  const text = response.text.trim();
  if (text === 'Ok.' && status === 200) return { ok: true, message: '已推送' };
  if (text === 'Fails.') return { ok: false, message: `下载器拒绝（可能已存在），${checkTasks}` };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return unknown;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
  const { success_count: success, failure_count: failure, pending_count: pending, added_torrent_ids: ids } = value;
  if (![success, failure, pending].every((count) => Number.isSafeInteger(count) && count >= 0)) return unknown;
  if (!Array.isArray(ids) || ids.length !== success || !ids.every(
    (id) => typeof id === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(id),
  )) return unknown;
  const counts = `成功 ${success}，失败 ${failure}，待处理 ${pending}`;
  if (pending > 0 || status === 202) return { ok: false, message: `下载器仍有任务待处理（${counts}），${checkTasks}` };
  if (success > 0 && failure === 0) return { ok: true, message: '已推送' };
  if (success > 0) return { ok: false, message: `下载器部分添加成功（${counts}），${checkTasks}` };
  return { ok: false, message: `下载器未确认添加成功（${counts}），${checkTasks}` };
}

export async function chromeFetch(value, init = {}, options = {}) {
  const url = new URL(value);
  const headers = new Headers(init.headers);
  const needsBroker = options.forceBroker || options.torrent || [...headers.keys()].some((name) => restrictedHeaders.has(name));
  if (!needsBroker) return fetch(value, init);
  if (init.body != null && typeof init.body !== 'string' && !(init.body instanceof URLSearchParams)) {
    throw new Error('站点请求包含不支持的请求体');
  }
  if (init.body instanceof URLSearchParams && !headers.has('content-type')) {
    headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
  }
  if (init.signal?.aborted) throw init.signal.reason;
  const reply = await chrome.runtime.sendMessage({
    type: 'pocket-evo-chrome-fetch',
    url: url.href,
    method: init.method || 'GET',
    headers: Object.fromEntries(headers),
    body: init.body == null ? undefined : String(init.body),
    credentials: init.credentials || 'include',
    timeoutMs: options.timeoutMs || 20000,
  });
  if (!reply?.ok) throw new Error(reply?.error || 'Chrome 请求通道不可用');
  const result = reply.response;
  const location = new Headers(result.headers).get('location');
  if (!options.torrent && [301, 302, 303, 307, 308].includes(result.status) && location) {
    const target = new URL(location, url);
    if (target.origin !== url.origin) throw new Error('站点跳转到其他来源，请更新站点地址');
    const redirects = (options.redirects || 0) + 1;
    if (redirects > 10) throw new Error('站点跳转次数过多');
    const method = (init.method || 'GET').toUpperCase();
    const useGet = result.status === 303 || ([301, 302].includes(result.status) && method === 'POST');
    const next = useGet ? { ...init, method: 'GET', body: undefined } : init;
    return chromeFetch(target.href, next, { ...options, redirects });
  }
  return new Response([204, 205, 304].includes(result.status) ? null : decodeBase64(result.base64), {
    status: result.status,
    headers: result.headers,
  });
}

export function chromeTorrentFetch(url, init, site, referer, tokenOnly, timeoutMs) {
  const headers = new Headers(init.headers);
  if (!tokenOnly) {
    if (site.cookie) headers.set('Cookie', site.cookie);
    if (site.userAgent) headers.set('User-Agent', site.userAgent);
    headers.set('Referer', referer);
  }
  return chromeFetch(url, { ...init, headers }, { torrent: true, timeoutMs });
}

export async function chromeNetworkDiagnostic(input) {
  const started = Date.now();
  const result = { supported: true, echoOk: false, echoMs: null, fetchOk: false, fetchMs: null, fetchStatus: null, fetchBytes: null, error: null };
  try {
    const pong = await chrome.runtime.sendMessage({ type: 'pocket-evo-chrome-ping' });
    result.echoOk = pong?.ok === true;
    result.echoMs = Date.now() - started;
    const fetchStarted = Date.now();
    const response = await chromeFetch(input.url, { headers: input.headers || {} }, { forceBroker: true });
    result.fetchOk = response.ok;
    result.fetchStatus = response.status;
    result.fetchBytes = (await response.arrayBuffer()).byteLength;
    result.fetchMs = Date.now() - fetchStarted;
    if (!response.ok) result.error = `HTTP ${response.status}`;
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Chrome 请求失败';
  }
  return result;
}
