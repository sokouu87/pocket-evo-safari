import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import test from 'node:test';
import { build, replaceOnce, normalizeAsset, textExtensions } from '../build.mjs';
import { createBroker, makeHeaderRule, readBoundedBody, trustedExtensionPage, validateRequest } from '../src/broker.js';
import { blobDataUrl, decodeBase64 } from '../src/binary.js';
import { chromeFetch, chromeQbitLogin, chromeQbitAddResult, chromeTorrentFetch } from '../src/request.js';

function fakeApi() {
  const listeners = {};
  const rules = new Map([[1000001, { id: 1000001 }]]);
  const updates = [];
  const api = {
    runtime: { id: 'testextension', getURL: (path) => `chrome-extension://testextension/${path}` },
    declarativeNetRequest: {
      getSessionRules: async () => [...rules.values()],
      isRegexSupported: async () => ({ isSupported: true }),
      updateSessionRules: async (update) => {
        updates.push(update);
        for (const id of update.removeRuleIds || []) rules.delete(id);
        for (const rule of update.addRules || []) rules.set(rule.id, rule);
      },
    },
    webRequest: {
      onHeadersReceived: { addListener: (callback) => { listeners.headers = callback; } },
      onBeforeRedirect: { addListener: (callback) => { listeners.redirect = callback; } },
    },
  };
  return { api, rules, updates, listeners };
}

test('LF 与 CRLF 文本生成相同哈希、精确补丁和输出，字面转义与二进制保持', () => {
  const source = 'const header = "first\\r\\nsecond";\nconst value = 1;\n';
  const windows = source.replaceAll('\n', '\r\n');
  const lf = normalizeAsset('fixture.js', Buffer.from(source));
  const crlf = normalizeAsset('fixture.js', Buffer.from(windows));
  assert.deepEqual(lf, crlf);
  assert.equal(createHash('sha256').update(lf).digest('hex'), createHash('sha256').update(crlf).digest('hex'));
  const before = 'const header = "first\\r\\nsecond";\nconst value = 1;';
  const after = 'const header = "first\\r\\nsecond";\nconst value = 2;';
  const expected = replaceOnce(source, before, after, 'fixture');
  const actual = replaceOnce(windows, before.replaceAll('\n', '\r\n'), after.replaceAll('\n', '\r\n'), 'fixture');
  assert.equal(actual, expected);
  assert.equal(actual.includes('first\\r\\nsecond'), true);
  const binary = Buffer.from([137, 80, 78, 71, 13, 10, 0, 255]);
  assert.equal(normalizeAsset('fixture.png', binary), binary);
  for (const extension of textExtensions) {
    assert.deepEqual(normalizeAsset(`fixture${extension}`, Buffer.from(windows)), lf);
  }
});

test('来源校验只接受本扩展的固定页面', () => {
  const { api } = fakeApi();
  assert.equal(trustedExtensionPage({ id: api.runtime.id, url: api.runtime.getURL('window.html#sites') }, api.runtime), true);
  for (const url of ['https://tracker.invalid/', 'chrome-extension://another/window.html', api.runtime.getURL('assets/content.js')]) {
    assert.equal(trustedExtensionPage({ id: api.runtime.id, url }, api.runtime), false);
  }
  assert.equal(trustedExtensionPage({ id: 'another', url: api.runtime.getURL('popup.html') }, api.runtime), false);
});

test('受限头全部进入精确的 worker session 规则', () => {
  const request = validateRequest({ url: 'https://tracker.invalid/a?token=x.y+z#section', headers: { Cookie: 'session=fixture', Referer: 'https://tracker.invalid/', Origin: 'https://tracker.invalid', 'User-Agent': 'Fixture', Authorization: 'Bearer fixture' } });
  assert.equal(request.modifications.length, 4);
  assert.deepEqual(request.headers, { authorization: 'Bearer fixture' });
  const rule = makeHeaderRule(1000000, request, 'extension');
  const expression = new RegExp(rule.condition.regexFilter);
  assert.equal(expression.test(request.url), true);
  assert.equal(expression.test(request.url + '&extra=1'), false);
  assert.equal(expression.test('https://other.invalid/a?token=x.y+z'), false);
  assert.deepEqual(rule.condition.initiatorDomains, ['extension']);
  assert.deepEqual(rule.condition.tabIds, [-1]);
  assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
  assert.throws(() => validateRequest({ url: 'https://name:secret@tracker.invalid/' }));
  assert.throws(() => validateRequest({ url: 'file:///local' }));
});

test('相同 URL 串行，成功与失败均清理规则，启动清理旧规则', async () => {
  const { api, rules, updates } = fakeApi();
  let active = 0;
  let maximum = 0;
  let count = 0;
  const broker = createBroker(api, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    count += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (count === 1) throw new Error('fixture network failure');
    return new Response('fixture response', { headers: { 'X-Fixture': 'present' } });
  });
  const input = { url: 'https://tracker.invalid/', headers: { Cookie: 'fixture=1' } };
  const results = await Promise.allSettled([broker.request(input), broker.request(input)]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[1].value.headers['x-fixture'], 'present');
  assert.equal(new TextDecoder().decode(decodeBase64(results[1].value.base64)), 'fixture response');
  assert.equal(maximum, 1);
  assert.equal(rules.size, 0);
  assert.deepEqual(updates[0], { removeRuleIds: [1000001] });
});

test('manual 跳转使用同一扩展 worker 的响应头观测结果', async () => {
  const { api, listeners, rules } = fakeApi();
  const broker = createBroker(api, async (url) => {
    listeners.headers({ url, initiator: 'chrome-extension://another', tabId: -1, method: 'GET', statusCode: 302, responseHeaders: [{ name: 'Location', value: 'https://untrusted.invalid/' }] });
    listeners.headers({ url, initiator: 'chrome-extension://testextension', tabId: -1, method: 'GET', statusCode: 302, responseHeaders: [{ name: 'Location', value: '/final.torrent' }] });
    return { type: 'opaqueredirect' };
  });
  const result = await broker.request({ url: 'https://tracker.invalid/start', headers: { Cookie: 'fixture=1' } });
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, 'https://tracker.invalid/final.torrent');
  assert.equal(rules.size, 0);
});

test('无匹配观测的 opaque 跳转失败并清理规则', async () => {
  const { api, rules } = fakeApi();
  const broker = createBroker(api, async () => ({ type: 'opaqueredirect' }));
  await assert.rejects(broker.request({ url: 'https://tracker.invalid/', headers: { Cookie: 'fixture=1' } }), /跳转地址/);
  assert.equal(rules.size, 0);
});

test('无效 Location 在请求边界报错，网络监听器不抛异常', async () => {
  const { api, listeners, rules } = fakeApi();
  const broker = createBroker(api, async (url) => {
    assert.doesNotThrow(() => listeners.headers({ url, initiator: 'chrome-extension://testextension', tabId: -1, method: 'GET', statusCode: 302, responseHeaders: [{ name: 'Location', value: 'http://[' }] }));
    return { type: 'opaqueredirect' };
  });
  await assert.rejects(broker.request({ url: 'https://tracker.invalid/', headers: { Cookie: 'fixture=1' } }), /跳转地址无效/);
  assert.equal(rules.size, 0);
});

test('流式读取限制响应大小，worker 图像转换支持二进制内容', async () => {
  await assert.rejects(readBoundedBody(new Response(new Uint8Array(12)), 10), /20 MB/);
  const dataUrl = await blobDataUrl(new Blob([Uint8Array.of(0, 127, 255)], { type: 'image/png' }));
  assert.equal(dataUrl, 'data:image/png;base64,AH//');
});

test('qBittorrent 保留 Ok. 并通过版本核对支持 204 空体', async () => {
  const calls = [];
  const version = async (...args) => { calls.push(args); return { ok: true, text: 'v5.2.4' }; };
  assert.equal(await chromeQbitLogin({ ok: true, status: 200, text: 'Ok.' }, version, 'http://downloader.invalid'), true);
  assert.equal(calls.length, 0);
  assert.equal(await chromeQbitLogin({ ok: true, status: 204, text: '' }, version, 'http://downloader.invalid'), true);
  assert.equal(calls[0][0], 'http://downloader.invalid/api/v2/app/version');
  assert.equal(calls[0][1].credentials, 'include');
  assert.equal(await chromeQbitLogin({ ok: true, status: 200, text: 'Fails.' }, version, 'http://downloader.invalid'), false);
  assert.equal(await chromeQbitLogin({ ok: true, status: 204, text: '' }, async () => ({ ok: false, text: 'Forbidden' }), 'http://downloader.invalid'), false);
});

test('qBittorrent 添加结果兼容旧响应和新 JSON，待处理及部分失败明确避免重复发送', () => {
  const id = 'a'.repeat(40);
  const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, text: typeof value === 'string' ? value : JSON.stringify(value) });
  const counts = (success, failure, pending) => ({ success_count: success, failure_count: failure, pending_count: pending, added_torrent_ids: Array(success).fill(id) });
  assert.deepEqual(chromeQbitAddResult(response('Ok.')), { ok: true, message: '已推送' });
  assert.deepEqual(chromeQbitAddResult(response(counts(1, 0, 0))), { ok: true, message: '已推送' });
  assert.equal(chromeQbitAddResult(response({ ...counts(1, 0, 0), added_torrent_ids: ['b'.repeat(64)] })).ok, true);
  for (const input of [response('Fails.'), response(counts(0, 0, 1), 202), response(counts(1, 1, 0)), response(counts(0, 1, 0)), response(counts(0, 1, 0), 409), response('Ok.', 403), response('Ok.', 202), response(counts(1, 0, 0), 202)]) {
    const result = chromeQbitAddResult(input);
    assert.equal(result.ok, false);
    assert.match(result.message, /检查任务列表.*避免重复发送/);
  }
  assert.match(chromeQbitAddResult(response(counts(0, 0, 1), 202)).message, /待处理/);
  assert.match(chromeQbitAddResult(response(counts(1, 1, 0))).message, /部分添加成功/);
  assert.match(chromeQbitAddResult(response('sensitive fixture', 500)).message, /HTTP 500/);
  const malformed = [null, undefined, {}, { ok: true, status: 200, text: null }, response('sensitive fixture'), response('{"password":"sensitive fixture"'), response([]), response(null), response(1), response({ ...counts(1, 0, 0), success_count: '1' }), response({ ...counts(1, 0, 0), failure_count: -1 }), response({ ...counts(1, 0, 0), added_torrent_ids: [] }), response({ ...counts(1, 0, 0), added_torrent_ids: ['sensitive fixture'] }), response(counts(0, 0, 0))];
  for (const input of malformed) {
    const result = chromeQbitAddResult(input);
    assert.equal(result.ok, false);
    assert.equal(result.message.includes('sensitive fixture'), false);
  }
});

test('普通下载器 fetch 保留 FormData，站点凭据进入 broker，跨域跳转受控', async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  const direct = [];
  const messages = [];
  try {
    globalThis.fetch = async (...args) => { direct.push(args); return new Response('Ok.'); };
    globalThis.chrome = { runtime: { sendMessage: async (message) => {
      messages.push(message);
      return { ok: true, response: { status: 200, headers: {}, base64: btoa('body') } };
    } } };
    const body = new FormData();
    body.append('torrents', new Blob(['fixture']), 'fixture.torrent');
    await chromeFetch('http://downloader.invalid/api/v2/torrents/add', { method: 'POST', body, credentials: 'include' });
    assert.equal(direct[0][1].body, body);
    assert.equal(messages.length, 0);
    const result = await chromeTorrentFetch('https://tracker.invalid/download', {}, { cookie: 'fixture=1', userAgent: 'Fixture' }, 'https://tracker.invalid/detail', false, 5000);
    assert.equal(await result.text(), 'body');
    assert.equal(messages[0].headers.cookie, 'fixture=1');
    assert.equal(messages[0].headers.referer, 'https://tracker.invalid/detail');
    await chromeTorrentFetch('https://bt1.manfuz.co/fixture.torrent', { credentials: 'omit' }, { cookie: 'fixture=1', userAgent: 'Fixture', token: 'fixture-key' }, 'https://kp.m-team.cc/detail/1', true, 5000);
    assert.equal(messages.at(-1).credentials, 'omit');
    assert.deepEqual(messages.at(-1).headers, {});
    globalThis.chrome.runtime.sendMessage = async (message) => {
      messages.push(message);
      if (message.url.endsWith('/start')) return { ok: true, response: { status: 302, headers: { location: '/final' }, base64: '' } };
      return { ok: true, response: { status: 200, headers: {}, base64: btoa('followed') } };
    };
    const followed = await chromeFetch('https://tracker.invalid/start', {}, { forceBroker: true });
    assert.equal(await followed.text(), 'followed');
    assert.equal(messages.at(-1).url, 'https://tracker.invalid/final');
    globalThis.chrome.runtime.sendMessage = async () => ({ ok: true, response: { status: 302, headers: { location: 'https://another.invalid/' }, base64: '' } });
    await assert.rejects(chromeFetch('https://tracker.invalid/', { headers: { Cookie: 'fixture=1' } }), /其他来源/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
  }
});

async function digestDirectory(root, prefix = '') {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(result, await digestDirectory(root, `${name}/`));
    else result[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
  }
  return result;
}

test('固定资源构建可复现，权限和后台补丁正确，补丁漂移立即失败', async () => {
  const dist = await build();
  const first = await digestDirectory(dist);
  for (const name of Object.keys(first)) {
    if (!textExtensions.has(extname(name))) continue;
    const bytes = await readFile(join(dist, name));
    assert.deepEqual(bytes, normalizeAsset(name, bytes));
  }
  await writeFile(join(dist, 'obsolete-file'), 'fixture');
  await build();
  await assert.rejects(readFile(join(dist, 'obsolete-file')), { code: 'ENOENT' });
  assert.deepEqual(await digestDirectory(dist), first);
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.optional_permissions, ['history', 'bookmarks']);
  assert.equal(manifest.permissions.includes('nativeMessaging'), false);
  assert.equal(manifest.background.type, 'module');
  const worker = await readFile(join(dist, 'assets/background.js'), 'utf8');
  assert.equal(worker.includes('FileReader'), false);
  const window = await readFile(join(dist, 'assets/window-C_9OXhTS.js'), 'utf8');
  assert.equal(window.includes('let chromeResponse=await chromeTorrentFetch'), true);
  assert.equal(window.includes('chromeQbitLogin(i,n,r)'), true);
  assert.equal(window.includes('...chromeQbitAddResult(c)'), true);
  assert.equal(window.includes('Chrome 请求诊断'), true);
  assert.equal(window.includes('Native 自检'), false);
  assert.equal(window.includes('label:`网络自检`'), true);
  assert.equal(window.includes('打开站点详情页后可检测下载链接'), true);
  assert.equal(window.split('无法访问当前标签页').length - 1, 1);
  assert.throws(() => replaceOnce('aa', 'a', 'b', 'fixture'), /匹配次数/);
  assert.throws(() => replaceOnce('a', 'x', 'b', 'fixture'), /匹配次数/);
});

test('实际打包 we 通过正常登录、FormData 和新版添加响应完成推送', async () => {
  const source = await readFile(new URL('../dist/assets/window-C_9OXhTS.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function we(');
  const end = source.indexOf('function Te(', start);
  const push = new Function('xe', 'be', 'Se', 'Ce', 'chromeQbitLogin', 'chromeQbitAddResult', `return (${source.slice(start, end)})`)(
    (url) => url.replace(/\/+$/, ''), decodeBase64, () => [], (value, fallback) => value || fallback,
    chromeQbitLogin, chromeQbitAddResult,
  );
  const requests = [];
  const id = 'c'.repeat(40);
  const result = await push({ id: 'fixture-downloader', url: 'http://downloader.invalid', username: 'fixture', password: 'fixture' }, { base64: btoa('d4:infod4:name1:xee'), filename: 'fixture.torrent' }, async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/auth/login')) return { ok: true, status: 204, text: '' };
    if (url.endsWith('/app/version')) return { ok: true, status: 200, text: 'v5.2.4' };
    return { ok: true, status: 200, text: JSON.stringify({ added_torrent_ids: [id], failure_count: 0, pending_count: 0, success_count: 1 }) };
  });
  assert.deepEqual(result, { serverId: 'fixture-downloader', ok: true, message: '已推送' });
  assert.equal(requests.length, 3);
  const upload = requests.at(-1);
  assert.equal(upload.url.endsWith('/torrents/add'), true);
  assert.equal(upload.init.body instanceof FormData, true);
  assert.equal(upload.init.body.get('torrents').name, 'fixture.torrent');
});

test('分发包包含固定哈希的第三方归属和完整 MIT 许可', async () => {
  const root = new URL('../../', import.meta.url);
  const lock = JSON.parse(await readFile(new URL('../vendor-lock.json', import.meta.url), 'utf8'));
  const original = normalizeAsset(lock.notice.sourcePath, await readFile(new URL(lock.notice.sourcePath, root)));
  const bundled = await readFile(new URL('../dist/THIRD_PARTY_NOTICES.md', import.meta.url));
  assert.deepEqual(bundled, original);
  assert.equal(createHash('sha256').update(bundled).digest('hex'), lock.notice.sha256);
  assert.equal(lock.normalization.lineEndings, 'LF');
  assert.deepEqual(lock.normalization.extensions, [...textExtensions]);
  const text = bundled.toString('utf8').replace(/\r\n/g, '\n');
  assert.match(text, /Kxmrg\/pocket-evo-extension/);
  assert.match(text, /pt-plugins\/PT-depiler/);
  const license = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
  assert.equal(text.split('## MIT License\n\n')[1].trim(), license);
});

test('实际打包下载函数保留 Cookie 参数、可信跳转、次数和 bencode 校验', async () => {
  const source = await readFile(new URL('../dist/assets/window-C_9OXhTS.js', import.meta.url), 'utf8');
  const validateStart = source.indexOf('function ai(');
  const validateEnd = source.indexOf('function ', validateStart + 12);
  const validateTorrent = new Function(`return (${source.slice(validateStart, validateEnd)})`)();
  const start = source.indexOf('async function Nl(');
  const end = source.indexOf('var Pl=', start);
  const functionSource = source.slice(start, end);
  const trustedStart = source.indexOf('function El(');
  const trustedEnd = source.indexOf('async function Dl(', trustedStart);
  const trustedMteamUrl = new Function('Sn', `return (${source.slice(trustedStart, trustedEnd)})`)(() => 'https://api.m-team.cc');
  const bytes = new TextEncoder().encode('d4:infod4:name1:xee');
  const calls = [];
  let response = () => new Response(bytes);
  const download = new Function(
    'chromeTorrentFetch', 'y', 'Ol', 'mn', 'Dl', 'vl', 'il', 'El', 'be', 'ai',
    `return (${functionSource})`,
  )(
    async (...args) => { calls.push(args); return response(); },
    (site) => site.address,
    () => false,
    () => false,
    async () => 'https://api.m-team.cc/start',
    () => false,
    () => false,
    trustedMteamUrl,
    decodeBase64,
    validateTorrent,
  );
  const site = { address: 'https://tracker.invalid', cookie: 'fixture=1' };
  const hit = { title: 'fixture', link: `${site.address}/detail?id=1`, downloadUrl: `${site.address}/download?id=1` };
  const result = await download(site, hit, null, 10);
  assert.equal(result.filename, 'fixture.torrent');
  assert.equal(calls[0][2], site);
  assert.equal(calls[0][3], hit.link);
  assert.equal(calls[0][4], false);
  response = () => new Response('<html>login</html>');
  await assert.rejects(download(site, hit, null, 10), /有效种子/);
  response = () => new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid/file' } });
  const mt = { address: 'https://kp.m-team.cc' };
  const mtHit = { title: 'fixture', link: `${mt.address}/detail/1` };
  await assert.rejects(download(mt, mtHit, null, 10), /非可信地址/);
  response = () => new Response(null, { status: 302, headers: { Location: 'https://api.m-team.cc/again' } });
  const previous = calls.length;
  await assert.rejects(download(mt, mtHit, null, 10), /跳转次数过多/);
  assert.equal(calls.length - previous, 4);
  assert.equal(calls.at(-1)[4], true);
  for (const url of ['http://bt1.manfuz.co/file', 'https://bt1.manfuz.co.evil.invalid/file', 'https://other.manfuz.co/file', 'https://untrusted.invalid/file', 'https://name:secret@bt1.manfuz.co/file', 'https://bt1.manfuz.co:8443/file']) {
    response = () => new Response(null, { status: 302, headers: { Location: url } });
    await assert.rejects(download(mt, mtHit, null, 10), /非可信地址/);
  }
  const sequence = [
    new Response(null, { status: 302, headers: { Location: 'https://bt1.manfuz.co/fixture.torrent' } }),
    new Response(bytes),
  ];
  response = () => sequence.shift();
  const firstRequest = calls.length;
  const cdnResult = await download(mt, mtHit, null, 10);
  assert.equal(cdnResult.filename, 'fixture.torrent');
  assert.equal(calls[firstRequest][0], 'https://api.m-team.cc/start');
  assert.equal(calls[firstRequest + 1][0], 'https://bt1.manfuz.co/fixture.torrent');
  for (const call of calls.slice(firstRequest)) {
    assert.equal(call[1].credentials, 'omit');
    assert.equal(call[4], true);
    assert.equal(call[1].headers, undefined);
  }
  assert.throws(() => validateTorrent(new Uint8Array(20000001)), /有效种子/);
});
