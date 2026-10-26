import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runClean, rerender } from './core/pipeline.mjs';
import { OllamaClient } from './core/ai.mjs';
import { exportFileName } from './core/render.mjs';
import { buildReport } from './core/report.mjs';
import { serializeSnapshot, reviveSnapshot } from './core/snapshot.mjs';
import { SAMPLE_TEXT } from './samples/sample.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, 'ui');
const SAMPLE_DIR = path.join(HERE, 'samples');
const PORT = Number(process.env.PORT || 4180);
const HOST = process.env.HOST || '127.0.0.1';
const MODEL = process.env.MODEL_GATEWAY_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:9b-uncensored';
const MODEL_BASE = process.env.MODEL_GATEWAY_BASE || process.env.OLLAMA_BASE || 'http://127.0.0.1:8090';
const MAX_BYTES = 32 * 1024 * 1024;
const JOB_TTL = 2 * 60 * 60 * 1000;
const JOBS_DIR = path.join(HERE, '.data', 'jobs');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const jobs = new Map();
const queue = [];
let activeJob = null;
let healthCache = { at: 0, value: null };

function now() {
  return Date.now();
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sendJson(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(value);
}

function readRaw(request, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error(`文件超过 ${(limit / 1024 / 1024).toFixed(0)} MB`), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJsonBody(request, limit = 1024 * 1024) {
  const raw = await readRaw(request, limit);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

function sanitizeFileName(name) {
  return String(name || '未命名.txt')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || '未命名.txt';
}

function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function jobPublic(job) {
  return {
    id: job.id,
    status: job.status,
    name: job.name,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: job.progress,
    error: job.error || '',
    queuePosition: job.status === 'queued' ? queue.indexOf(job) + 1 : 0,
    summary: job.view?.summary || null,
    disabled: job.disabled || [],
  };
}

function persistedFile(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

/** 把最终正文落盘，服务重启后仍可再次导出。 */
function persistJob(job) {
  if (!job.view?.text) return;
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    const payload = {
      id: job.id,
      name: job.name,
      title: job.view.summary?.title || job.name,
      summary: job.view.summary || null,
      issues: job.view.issues || [],
      disabled: job.disabled || [],
      options: job.options || {},
      sourcePath: job.sourcePath || '',
      sourceBytes: job.sourceBytes || 0,
      sourceHash: job.sourceHash || '',
      snapshot: serializeSnapshot(job.result?.snapshot),
      text: job.view.text,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(persistedFile(job.id), JSON.stringify(payload), 'utf8');
  } catch (error) {
    log(`job ${job.id} persist failed · ${error.message}`);
  }
}

function readPersisted(id) {
  try {
    const value = JSON.parse(fs.readFileSync(persistedFile(id), 'utf8'));
    if (!value?.text) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 服务重启后，页面还会继续轮询原来的 jobId。
 * 这里按需从 .data/jobs/<id>.json 恢复任务，而不是在启动时加载所有几十 MB 的快照。
 */
function hydrateJob(id) {
  const saved = readPersisted(id);
  if (!saved?.snapshot) return null;
  try {
    const snapshot = reviveSnapshot(saved.snapshot);
    const disabled = Array.isArray(saved.disabled) ? saved.disabled.map(String) : [];
    const output = rerender(snapshot, disabled);
    const sourcePath = saved.sourcePath || path.join(JOBS_DIR, `${id}.source`);
    const job = {
      id,
      name: saved.name || saved.title || '恢复稿.txt',
      sourcePath: fs.existsSync(sourcePath) ? sourcePath : '',
      sourceBytes: saved.sourceBytes || 0,
      sourceHash: saved.sourceHash || '',
      options: saved.options || {},
      status: 'done',
      createdAt: saved.savedAt || now(),
      updatedAt: now(),
      progress: {
        percent: 100,
        stage: 'done',
        label: '任务已恢复',
        detail: `${output.summary.input.chars} → ${output.summary.output.chars} 字`,
        elapsedMs: output.summary.durationMs,
        ai: output.summary.ai,
      },
      result: { snapshot },
      view: {
        summary: output.summary,
        issues: output.issues,
        blocks: output.blocks,
        text: output.text,
      },
      disabled,
      error: '',
    };
    jobs.set(id, job);
    log(`job ${id} hydrated from disk`);
    return job;
  } catch (error) {
    log(`job ${id} hydrate failed · ${error.message}`);
    return null;
  }
}

function jobExportContext(job) {
  return {
    id: job.id,
    name: job.name,
    title: job.view?.summary?.title || job.name,
    summary: job.view?.summary || null,
    issues: job.view?.issues || [],
    disabled: job.disabled || [],
    text: job.view?.text || '',
    sourcePath: job.sourcePath || '',
    sourceBytes: job.sourceBytes || 0,
    sourceHash: job.sourceHash || '',
    snapshot: job.result?.snapshot || null,
    options: job.options || {},
  };
}

function persistedExportContext(saved) {
  return {
    id: saved.id || '',
    name: saved.name || '',
    title: saved.title || saved.name || '',
    summary: saved.summary || null,
    issues: saved.issues || [],
    disabled: saved.disabled || [],
    text: saved.text || '',
    sourcePath: saved.sourcePath || path.join(JOBS_DIR, `${saved.id}.source`),
    sourceBytes: saved.sourceBytes || 0,
    sourceHash: saved.sourceHash || '',
    snapshot: reviveSnapshot(saved.snapshot),
    options: saved.options || {},
  };
}

function resolveSaveDir(raw) {
  const value = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
  if (!value) return DOWNLOADS_DIR;

  // 支持 ~ 与 ~/目录；其余按绝对/相对本机路径处理。
  let expanded = value;
  if (value === '~') expanded = os.homedir();
  else if (/^~[\\/]/.test(value)) expanded = path.join(os.homedir(), value.slice(2));

  const full = path.resolve(expanded);
  try {
    fs.mkdirSync(full, { recursive: true });
    if (!fs.statSync(full).isDirectory()) throw new Error('不是文件夹');
  } catch (error) {
    throw Object.assign(new Error(`保存目录不可用：${error.message}\n${full}`), { status: 400 });
  }
  return full;
}

function uniqueExportPaths(title, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const textName = exportFileName(title || '未命名稿件');
  let index = 1;
  while (index < 10000) {
    const suffix = index === 1 ? '' : `-${index}`;
    const textPath = path.join(dir, textName.replace(/(\.utf8\.txt)$/i, `${suffix}$1`));
    const reportPath = textPath.replace(/\.utf8\.txt$/i, '.report.json');
    if (!fs.existsSync(textPath) && !fs.existsSync(reportPath)) return { textPath, reportPath };
    index += 1;
  }
  throw Object.assign(new Error('同一目录下的同名文件太多，请换一个目录'), { status: 409 });
}

function saveExport(context, rawDir = '') {
  const dir = resolveSaveDir(rawDir);
  const { textPath, reportPath } = uniqueExportPaths(context.title, dir);
  const body = Buffer.from(String(context.text || ''), 'utf8');
  fs.writeFileSync(textPath, body);

  const report = buildReport({
    ...context,
    textPath,
    reportPath,
  });
  const reportBody = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(reportPath, reportBody);

  return {
    ok: true,
    dir,
    path: textPath,
    filename: path.basename(textPath),
    bytes: body.length,
    reportPath,
    reportFilename: path.basename(reportPath),
    reportBytes: reportBody.length,
  };
}

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function projectFolderName(title) {
  const base = exportFileName(title || '未命名稿件').replace(/\.utf8\.txt$/i, '');
  return `${base}-工程`;
}

function uniqueProjectDir(parent, title) {
  let root = path.join(parent, projectFolderName(title));
  let index = 2;
  while (fs.existsSync(root)) {
    root = path.join(parent, `${projectFolderName(title)}-${index}`);
    index += 1;
  }
  return root;
}

function sourceExtension(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '.txt';
}

/**
 * 导出一套可重新加载的工程：
 *   source.*       原始文件
 *   target.utf8.txt 当前清洗结果
 *   report.json    清洗报告
 *   state.json     内部快照（用于逐条撤销和二次优化）
 *   project.json   索引
 *   README.md      人读说明
 */
function exportProject(context, rawDir = '') {
  if (!context.snapshot) {
    throw Object.assign(new Error('这个任务没有保留内部快照（旧任务），请重新导入后再导出工程'), { status: 410 });
  }
  if (!context.sourcePath || !fs.existsSync(context.sourcePath)) {
    throw Object.assign(new Error('源文件未保留，无法生成完整工程；请重新导入原文件'), { status: 410 });
  }

  const parent = resolveSaveDir(rawDir);
  const root = uniqueProjectDir(parent, context.title);
  fs.mkdirSync(root, { recursive: true });

  const sourceName = `source${sourceExtension(context.name)}`;
  const targetName = 'target.utf8.txt';
  const reportName = 'report.json';
  const stateName = 'state.json';
  const indexPath = path.join(root, 'project.json');
  const readmePath = path.join(root, 'README.md');
  const sourcePath = path.join(root, sourceName);
  const targetPath = path.join(root, targetName);
  const reportPath = path.join(root, reportName);
  const statePath = path.join(root, stateName);

  fs.copyFileSync(context.sourcePath, sourcePath);
  const targetBody = Buffer.from(String(context.text || ''), 'utf8');
  fs.writeFileSync(targetPath, targetBody);

  const state = {
    schema: 'novel-clean/state@1',
    savedAt: new Date().toISOString(),
    job: { id: context.id, name: context.name, title: context.title },
    options: context.options || {},
    disabled: context.disabled || [],
    snapshot: serializeSnapshot(context.snapshot),
  };
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');

  const sourceHash = sha256OfFile(sourcePath);
  const targetHash = crypto.createHash('sha256').update(targetBody).digest('hex');
  const report = buildReport({
    ...context,
    textPath: targetPath,
    reportPath,
  });
  const reportBody = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(reportPath, reportBody);

  const index = {
    schema: 'novel-clean/project@1',
    createdAt: new Date().toISOString(),
    app: { name: '墨净', version: '1.0.0' },
    book: {
      title: context.title,
      bookName: context.summary?.bookName || context.title,
      sourceFile: context.name,
    },
    source: {
      file: sourceName,
      bytes: fs.statSync(sourcePath).size,
      sha256: sourceHash,
      encoding: context.summary?.input?.encoding || '',
      encodingLabel: context.summary?.input?.encodingLabel || '',
    },
    target: {
      file: targetName,
      bytes: targetBody.length,
      sha256: targetHash,
    },
    files: {
      source: sourceName,
      target: targetName,
      report: reportName,
      state: stateName,
      index: 'project.json',
      readme: 'README.md',
    },
    options: context.options || {},
    disabled: context.disabled || [],
    summary: context.summary || null,
    chapter: context.summary?.chapter || null,
    checks: context.summary?.checks || [],
  };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');

  const readme = [
    `# ${context.title} · 墨净清洗工程`,
    '',
    '在墨净首页点「打开已有工程」，选择这个目录，即可继续做逐条取舍和二次优化。',
    '',
    '## 文件',
    '',
    `- \`${sourceName}\` — 原稿源文件，${sourceHash.slice(0, 16)}…`,
    `- \`${targetName}\` — 当前清洗结果，UTF-8 无 BOM，${targetBody.length} bytes`,
    `- \`${reportName}\` — 清洗报告，含七项检查、章节、全量 issue、哈希`,
    `- \`${stateName}\` — 内部快照，保留逐条开关与二次渲染所需状态，请不要手改`,
    `- \`project.json\` — 工程索引`,
    '',
    '## 重新加载',
    '',
    '```text',
    '墨净 → 打开已有工程 → 选择本目录',
    '```',
    '',
    `- 书名：${context.summary?.bookName || context.title}`,
    `- 源文件：${context.name}`,
    `- 本书字数：${context.summary?.output?.chars ?? '—'}`,
    `- 章节：${context.summary?.output?.chapters ?? '—'}`,
    `- 已关闭的条目：${(context.disabled || []).length}`,
    '',
  ].join('\n');
  fs.writeFileSync(readmePath, readme, 'utf8');

  return {
    ok: true,
    parent,
    dir: root,
    projectPath: indexPath,
    readmePath,
    sourcePath,
    targetPath,
    reportPath,
    statePath,
    files: [sourceName, targetName, reportName, stateName, 'project.json', 'README.md'],
    bytes: targetBody.length,
    reportBytes: reportBody.length,
  };
}

function loadProject(rawPath) {
  const value = String(rawPath || '').trim().replace(/^"(.*)"$/, '$1');
  if (!value) throw Object.assign(new Error('请填写工程目录'), { status: 400 });
  const resolved = path.resolve(value);
  let projectFile = resolved;
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) projectFile = path.join(resolved, 'project.json');
  if (!fs.existsSync(projectFile)) {
    throw Object.assign(new Error(`找不到工程索引：${projectFile}`), { status: 404 });
  }
  const root = path.dirname(projectFile);
  const index = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  if (index.schema !== 'novel-clean/project@1') {
    throw Object.assign(new Error('不是墨净工程：schema 不匹配'), { status: 400 });
  }
  const fileOf = (key, fallback) => path.join(root, path.basename(index.files?.[key] || fallback));
  const statePath = fileOf('state', 'state.json');
  const sourcePath = fileOf('source', 'source.txt');
  const targetPath = fileOf('target', 'target.utf8.txt');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!state.snapshot) throw Object.assign(new Error('工程缺少内部快照，无法二次优化'), { status: 400 });
  if (!fs.existsSync(sourcePath)) throw Object.assign(new Error('工程缺少源文件'), { status: 400 });

  const sourceBytes = fs.readFileSync(sourcePath);
  const disabled = Array.isArray(state.disabled) ? state.disabled.map(String) : [];
  const snapshot = reviveSnapshot(state.snapshot);
  const output = rerender(snapshot, disabled);
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    name: state.job?.name || index.book?.sourceFile || '工程稿.txt',
    sourcePath,
    sourceBytes: sourceBytes.length,
    sourceHash: index.source?.sha256 || crypto.createHash('sha256').update(sourceBytes).digest('hex'),
    options: state.options || index.options || {},
    status: 'done',
    createdAt: now(),
    updatedAt: now(),
    progress: {
      percent: 100,
      stage: 'done',
      label: '工程已加载',
      detail: `${output.summary.input.chars} → ${output.summary.output.chars} 字`,
      elapsedMs: output.summary.durationMs,
      ai: output.summary.ai,
    },
    result: { snapshot },
    view: {
      summary: output.summary,
      issues: output.issues,
      blocks: output.blocks,
      text: output.text,
    },
    disabled,
    error: '',
  };
  jobs.set(id, job);
  persistJob(job);
  return {
    jobId: id,
    disabled,
    summary: output.summary,
    files: {
      source: sourcePath,
      target: targetPath,
      report: path.join(root, path.basename(index.files?.report || 'report.json')),
    },
  };
}

function sendReportAttachment(response, context) {
  const report = buildReport(context);
  const body = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
  const fileName = `${String(context.title || '未命名稿件').replace(/[\\/:*?"<>|]/g, '_')}.report.json`;
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="report.json"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendExportAttachment(response, text, title) {
  const fileName = exportFileName(title || '未命名稿件');
  const body = Buffer.from(String(text || ''), 'utf8');
  response.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="novel.utf8.txt"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function createJob({ buffer, name, options }) {
  const id = crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const sourcePath = path.join(JOBS_DIR, `${id}.source`);
  fs.writeFileSync(sourcePath, buffer);
  const job = {
    id,
    name,
    buffer,
    sourcePath,
    sourceBytes: buffer.length,
    sourceHash: crypto.createHash('sha256').update(buffer).digest('hex'),
    options,
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
    progress: {
      percent: 0,
      stage: 'queued',
      label: '排队中',
      detail: '前面的清洗任务完成后开始',
      elapsedMs: 0,
    },
    result: null,
    view: null,
    disabled: [],
    error: '',
  };
  jobs.set(id, job);
  queue.push(job);
  drainQueue();
  return job;
}

async function drainQueue() {
  if (activeJob) return;
  const job = queue.shift();
  if (!job) return;
  activeJob = job;
  job.status = 'running';
  job.updatedAt = now();
  log(`job ${job.id} start · ${job.name} · ${(job.buffer.length / 1024).toFixed(1)} KB · ai=${job.options.ai}`);
  try {
    const aiClient = job.options.ai
      ? new OllamaClient({ baseUrl: MODEL_BASE, model: job.options.model || MODEL, timeoutMs: 900000 })
      : null;
    const result = await runClean({
      buffer: job.buffer,
      name: job.name,
      options: job.options,
      aiClient,
      onProgress: (progress) => {
        job.progress = progress;
        job.updatedAt = now();
      },
    });
    job.result = result;
    job.view = { summary: result.summary, issues: result.issues, blocks: result.blocks, text: result.text };
    job.status = 'done';
    job.progress = {
      percent: 100,
      stage: 'done',
      label: '清洗完成',
      detail: `${result.summary.input.chars} → ${result.summary.output.chars} 字`,
      elapsedMs: result.summary.durationMs,
      ai: job.options.ai ? { done: result.snapshot.aiTotal, total: result.snapshot.aiTotal } : null,
    };
    persistJob(job);
    log(`job ${job.id} done · ${result.summary.durationMs} ms · issues=${result.issues.length} · ai=${result.summary.ai.calls} calls`);
  } catch (error) {
    job.status = 'error';
    job.error = error?.message || String(error);
    job.progress = {
      ...job.progress,
      percent: 100,
      stage: 'error',
      label: '清洗失败',
      detail: job.error,
    };
    log(`job ${job.id} error · ${job.error}`);
  } finally {
    delete job.buffer;
    job.updatedAt = now();
    activeJob = null;
    drainQueue();
  }
}

function requireJob(id, response) {
  const job = jobs.get(id);
  if (!job) {
    sendJson(response, { error: '任务不存在或已过期' }, 404);
    return null;
  }
  return job;
}

function filterBlocks(job, query) {
  const filter = String(query.get('filter') || 'all');
  const onlyChanged = query.get('changed') === '1';
  const q = String(query.get('q') || '').trim().toLowerCase();
  let blocks = job.view.blocks;
  if (filter === 'chapter') {
    blocks = blocks.filter((block) => block.kind === 'chapter');
  } else if (filter !== 'all' && !['encoding', 'invisible'].includes(filter)) {
    blocks = blocks.filter((block) => block.issueTypes.includes(filter));
  }
  if (onlyChanged) blocks = blocks.filter((block) => block.changed || block.deleted || block.merged);
  if (q) {
    blocks = blocks.filter((block) => `${block.original}\n${block.cleaned}\n${block.chapterTitle || ''}`.toLowerCase().includes(q));
  }
  const total = blocks.length;
  const all = query.get('limit') === 'all';
  const offset = clampInt(query.get('offset'), 0, Math.max(0, total), 0);
  const limit = all ? total : clampInt(query.get('limit'), 1, 300, 160);
  return {
    total,
    offset: all ? 0 : offset,
    limit,
    blocks: all ? blocks : blocks.slice(offset, offset + limit),
    hasMore: all ? false : offset + limit < total,
    filter,
  };
}

function safeStaticPath(urlPath) {
  const map = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/style.css': 'style.css',
    '/favicon.svg': 'favicon.svg',
  };
  const name = map[urlPath];
  if (!name) return null;
  const full = path.join(UI_DIR, name);
  if (!full.startsWith(UI_DIR)) return null;
  return full;
}

function serveStatic(response, file) {
  if (!fs.existsSync(file)) {
    sendText(response, 'not found', 404);
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(response);
}

async function handleHealth(response, force = false) {
  if (!force && healthCache.value && now() - healthCache.at < 5000) {
    sendJson(response, healthCache.value);
    return;
  }
  const client = new OllamaClient({ baseUrl: MODEL_BASE, model: MODEL, timeoutMs: 8000 });
  const health = await client.health();
  const value = {
    ok: Boolean(health.ok),
    server: 'novel-clean',
    version: '1.0.0',
    gateway: {
      baseUrl: MODEL_BASE,
      root: health.gatewayBase || MODEL_BASE,
      reachable: Boolean(health.ok),
      error: health.error || '',
      backends: health.backends || {},
      activeStrataModel: health.activeStrataModel || '',
    },
    // 兼容旧前端字段名
    ollama: {
      baseUrl: MODEL_BASE,
      reachable: Boolean(health.ok),
      error: health.error || '',
    },
    model: MODEL,
    modelInfo: health.found || null,
    running: health.running || false,
    models: health.models || [],
    limits: {
      maxBytes: MAX_BYTES,
      aiTruncation: 24,
      aiIrrelevant: 20,
    },
    time: new Date().toISOString(),
  };
  healthCache = { at: now(), value };
  sendJson(response, value);
}

async function handleAnalyze(request, response, query) {
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  let buffer;
  let name = sanitizeFileName(query.get('name') || '粘贴稿.txt');

  // 本地路径兜底：侧栏 webview 的文件选择器有时拿不到文件内容（File.size=0），
  // 允许本机用户把绝对路径交给本地服务端读取。服务只监听 127.0.0.1。
  const requestedPath = String(query.get('path') || '').trim().replace(/^"(.*)"$/, '$1');
  if (requestedPath) {
    let full;
    try {
      full = requestedPath.startsWith('file://') ? fileURLToPath(requestedPath) : path.resolve(requestedPath);
      const stat = fs.statSync(full);
      if (!stat.isFile()) throw new Error('不是普通文件');
      if (stat.size === 0) throw new Error('文件是空的（0 字节）');
      if (stat.size > MAX_BYTES) throw new Error(`文件有 ${(stat.size / 1024 / 1024).toFixed(1)} MB，超过 32 MB 上限`);
      buffer = fs.readFileSync(full);
      name = sanitizeFileName(path.basename(full));
    } catch (error) {
      throw Object.assign(new Error(`读取本地路径失败：${error.message}\n${full || requestedPath}`), { status: 400 });
    }
  } else if (contentType.includes('application/json')) {
    const body = await readJsonBody(request);
    const text = String(body.text || '');
    if (!text.trim()) throw Object.assign(new Error('没有收到文本'), { status: 400 });
    buffer = Buffer.from(text, 'utf8');
    if (body.name) name = sanitizeFileName(body.name);
  } else {
    buffer = await readRaw(request);
    const headerName = request.headers['x-file-name'];
    if (headerName) {
      try { name = sanitizeFileName(decodeURIComponent(String(headerName))); } catch { /* ignore */ }
    }
  }
  if (buffer.length < 10) throw Object.assign(new Error('文本太短，至少需要 10 个字节'), { status: 400 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('文件超过 32 MB'), { status: 413 });

  const options = {
    ai: query.get('ai') !== '0',
    model: String(query.get('model') || MODEL).replace(/[^A-Za-z0-9._:/-]/g, '').slice(0, 80) || MODEL,
    maxTruncation: clampInt(query.get('maxTruncation'), 0, 60, 24),
    maxIrrelevant: clampInt(query.get('maxIrrelevant'), 0, 60, 20),
    bookName: String(query.get('bookName') || '').trim().slice(0, 100),
  };
  const job = createJob({ buffer, name, options });
  sendJson(response, { jobId: job.id, status: job.status, queuePosition: queue.indexOf(job) + 1 }, 202);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);
  const query = url.searchParams;

  if (request.method === 'GET' && pathname === '/api/health') {
    await handleHealth(response, query.get('force') === '1');
    return;
  }

  if (request.method === 'GET' && pathname === '/api/sample') {
    const format = query.get('format') === 'gbk' ? 'gbk' : 'utf8';
    const file = path.join(SAMPLE_DIR, format === 'gbk' ? 'demo-gbk.txt' : 'demo-utf8.txt');
    let data;
    let actual = format;
    try {
      data = fs.readFileSync(file);
    } catch {
      data = Buffer.from(`\uFEFF${SAMPLE_TEXT}`, 'utf8');
      actual = 'utf8';
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
      'X-Sample-Encoding': actual,
      'Cache-Control': 'no-store',
    });
    response.end(data);
    return;
  }

  if (request.method === 'POST' && pathname === '/api/analyze') {
    await handleAnalyze(request, response, query);
    return;
  }

  if (request.method === 'POST' && pathname === '/api/projects/open') {
    sendJson(response, loadProject(query.get('path') || ''));
    return;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9]+)(?:\/(blocks|issues|render|export|save|report|project))?$/);
  if (jobMatch) {
    const jobId = jobMatch[1];
    const action = jobMatch[2] || '';
    const job = jobs.get(jobId) || hydrateJob(jobId);

    // 服务重启后内存里的 job 会消失，但导出正文已落盘。
    // export/save/report 仍可用，避免侧栏里的旧结果一点导出就 404。
    if (!job) {
      const saved = readPersisted(jobId);
      if (!saved) {
        sendJson(response, { error: '任务不存在或已过期；请重新导入后再导出' }, 404);
        return;
      }
      const context = persistedExportContext(saved);
      if (request.method === 'GET' && action === 'export') {
        sendExportAttachment(response, context.text, context.title);
        return;
      }
      if (request.method === 'GET' && action === 'report') {
        sendReportAttachment(response, context);
        return;
      }
      if (request.method === 'POST' && action === 'save') {
        sendJson(response, saveExport(context, query.get('dir') || ''));
        return;
      }
      if (request.method === 'POST' && action === 'project') {
        sendJson(response, exportProject(context, query.get('dir') || ''));
        return;
      }
      sendJson(response, { error: '该任务已从内存回收，只能导出正文、报告、工程或保存到目录' }, 410);
      return;
    }

    if (request.method === 'GET' && !action) {
      sendJson(response, jobPublic(job));
      return;
    }

    if (request.method === 'GET' && action === 'blocks') {
      if (!job.view) {
        sendJson(response, { error: '任务尚未完成', status: job.status }, 409);
        return;
      }
      sendJson(response, filterBlocks(job, query));
      return;
    }

    if (request.method === 'GET' && action === 'issues') {
      if (!job.view) {
        sendJson(response, { error: '任务尚未完成', status: job.status }, 409);
        return;
      }
      const type = String(query.get('type') || 'all');
      const includeInfo = query.get('info') !== '0';
      let issues = job.view.issues;
      if (type !== 'all') issues = issues.filter((issue) => issue.type === type);
      if (!includeInfo) issues = issues.filter((issue) => issue.severity !== 'info');
      const total = issues.length;
      sendJson(response, {
        total,
        issues: issues.slice(0, 1200),
        counts: job.view.summary.checks.reduce((accumulator, check) => {
          accumulator[check.type] = check.found;
          return accumulator;
        }, {}),
      });
      return;
    }

    if (request.method === 'POST' && action === 'render') {
      if (!job.result) {
        sendJson(response, { error: '任务尚未完成' }, 409);
        return;
      }
      const body = await readJsonBody(request);
      const disabled = Array.isArray(body.disabled)
        ? body.disabled.map((id) => String(id)).filter((id) => /^[A-Z]\d{3,5}$/.test(id)).slice(0, 2000)
        : [];
      const output = rerender(job.result.snapshot, disabled);
      job.view = output;
      job.disabled = disabled;
      persistJob(job);
      sendJson(response, { summary: output.summary, disabled: job.disabled });
      return;
    }

    if (request.method === 'GET' && action === 'export') {
      if (!job.view) {
        sendJson(response, { error: '任务尚未完成' }, 409);
        return;
      }
      sendExportAttachment(response, job.view.text, job.view.summary.title || job.name);
      return;
    }

    if (request.method === 'GET' && action === 'report') {
      if (!job.view) {
        sendJson(response, { error: '任务尚未完成' }, 409);
        return;
      }
      sendReportAttachment(response, jobExportContext(job));
      return;
    }

    // 侧栏 webview 会拦截 Content-Disposition 下载；直接让本地服务写目录，
    // 返回正文和报告的真实路径给界面显示。
    if (request.method === 'POST' && action === 'save') {
      if (!job.view) {
        sendJson(response, { error: '任务尚未完成' }, 409);
        return;
      }
      sendJson(response, saveExport(jobExportContext(job), query.get('dir') || ''));
      return;
    }

    if (request.method === 'POST' && action === 'project') {
      if (!job.view) {
        sendJson(response, { error: '任务尚未完成' }, 409);
        return;
      }
      sendJson(response, exportProject(jobExportContext(job), query.get('dir') || ''));
      return;
    }

    sendJson(response, { error: '不支持的 job 操作' }, 405);
    return;
  }

  if (request.method === 'GET') {
    const file = safeStaticPath(pathname);
    if (file) {
      serveStatic(response, file);
      return;
    }
  }

  sendJson(response, { error: 'not found' }, 404);
}

const server = http.createServer((request, response) => {
  const started = now();
  response.on('finish', () => {
    if (request.url?.startsWith('/api/')) {
      log(`${request.method} ${request.url} ${response.statusCode} ${now() - started}ms`);
    }
  });
  handleRequest(request, response).catch((error) => {
    const status = error?.status || 500;
    log(`ERROR ${request.method} ${request.url} · ${error?.stack || error}`);
    if (!response.headersSent) sendJson(response, { error: error?.message || '服务器内部错误' }, status);
    else response.end();
  });
});

server.listen(PORT, HOST, () => {
  log(`novel-clean listening on http://${HOST}:${PORT}`);
  log(`model=${MODEL} router=${MODEL_BASE}`);
});

setInterval(() => {
  const cutoff = now() - JOB_TTL;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.updatedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

process.on('SIGINT', () => {
  log('SIGINT · shutting down');
  server.close(() => process.exit(0));
});
