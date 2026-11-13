import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const chromeRoot = dirname(fileURLToPath(import.meta.url));
export const resourceRoot = join(chromeRoot, '..', 'Pocket Evo 站点导入', 'Pocket Evo 站点导入 Extension', 'Resources');
export const textExtensions = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.md']);

export function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, '\n');
}

export function normalizeAsset(name, bytes) {
  if (!textExtensions.has(extname(name).toLowerCase())) return bytes;
  return Buffer.from(normalizeLineEndings(bytes.toString('utf8')), 'utf8');
}

export function replaceOnce(source, before, after, name) {
  source = normalizeLineEndings(source);
  before = normalizeLineEndings(before);
  after = normalizeLineEndings(after);
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`补丁 ${name} 的匹配次数为 ${count}，需要核对固定资源`);
  return source.replace(before, () => after);
}

export async function build() {
  const lock = JSON.parse(await readFile(join(chromeRoot, 'vendor-lock.json'), 'utf8'));
  const resources = new Map();
  for (const [name, expected] of Object.entries(lock.files)) {
    const bytes = normalizeAsset(name, await readFile(join(resourceRoot, name)));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`固定资源校验失败 ${name}`);
    resources.set(name, bytes);
  }
  const notice = normalizeAsset(lock.notice.sourcePath, await readFile(join(chromeRoot, '..', lock.notice.sourcePath)));
  if (createHash('sha256').update(notice).digest('hex') !== lock.notice.sha256) {
    throw new Error('第三方许可文件校验失败');
  }
  const resolvedRoot = realpathSync(chromeRoot);
  const dist = resolve(resolvedRoot, 'dist');
  if (relative(resolvedRoot, dist) !== 'dist') throw new Error('构建输出目录无效');
  try {
    if (realpathSync(dist) !== dist) throw new Error('构建输出目录不能重定向到其他位置');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  for (const [name, bytes] of resources) {
    const target = join(dist, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(join(dist, 'THIRD_PARTY_NOTICES.md'), notice);
  const platformRoot = join(chromeRoot, 'src');
  const platformOutput = join(dist, 'chrome');
  await mkdir(platformOutput, { recursive: true });
  for (const name of await readdir(platformRoot)) {
    const bytes = normalizeAsset(name, await readFile(join(platformRoot, name)));
    await writeFile(join(platformOutput, name), bytes);
  }
  const manifest = JSON.parse(resources.get('manifest.json').toString('utf8'));
  manifest.name = 'Pocket Evo Chrome';
  manifest.description = 'PT 站点管理、聚合搜索、下载器推送与 Pocket Evo 二维码导入';
  manifest.minimum_chrome_version = '132';
  manifest.permissions = manifest.permissions.filter((name) => name !== 'nativeMessaging');
  manifest.permissions.push('declarativeNetRequestWithHostAccess', 'webRequest');
  manifest.optional_permissions = ['history', 'bookmarks'];
  manifest.background = { service_worker: 'chrome/background.js', type: 'module' };
  await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const patches = JSON.parse(await readFile(join(chromeRoot, 'patches.json'), 'utf8'));
  for (const [name, replacements] of Object.entries(patches)) {
    let source = await readFile(join(dist, name), 'utf8');
    for (const patch of replacements) source = replaceOnce(source, patch.before, patch.after, patch.name);
    await writeFile(join(dist, name), source);
  }
  const generated = await readdir(join(dist, 'chrome'));
  console.log(`Chrome 构建完成，校验 ${Object.keys(lock.files).length} 个固定资源，平台文件 ${generated.length} 个，许可文件 1 个`);
  return dist;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await build();
