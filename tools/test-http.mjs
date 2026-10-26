/**
 * HTTP / HMI 接口回归测试。
 * 会启动一个临时服务器（端口 4190），跑完自动关闭。
 * 这里用 node:http 而不是 fetch，避免系统代理环境影响本地回环测试。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 4190;
const HOST = '127.0.0.1';
const SAMPLE = path.join(ROOT, 'samples', 'demo-gbk.txt');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (body) requestHeaders['Content-Length'] = body.length;
    const req = http.request({ hostname: HOST, port: PORT, path: pathname, method, headers: requestHeaders }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(pathname, options) {
  const response = await request(pathname, options);
  return { ...response, json: JSON.parse(response.body.toString('utf8') || '{}') };
}

async function waitHealth(timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await request('/api/health');
      if (response.status === 200) return JSON.parse(response.body.toString('utf8'));
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('server did not start');
}

async function pollJob(id, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const response = await requestJson(`/api/jobs/${id}`);
    const job = response.json;
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error);
    await sleep(250);
  }
  throw new Error('job timeout');
}

async function main() {
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => process.stdout.write(`  ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`  ${chunk}`));
  try {
    const health = await waitHealth();
    assert.equal(health.server, 'novel-clean');
    assert.ok(health.model, 'health should report a model');

    const bytes = fs.readFileSync(SAMPLE);
    const response = await requestJson(`/api/analyze?name=${encodeURIComponent('雾城来信-GBK旧稿.txt')}&ai=0&bookName=${encodeURIComponent('雾城来信')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    assert.equal(response.status, 202);
    const created = response.json;
    assert.ok(created.jobId);
    const job = await pollJob(created.jobId);
    const summary = job.summary;
    console.log(`✓ 任务完成：${summary.input.encodingLabel} · ${summary.input.chars} → ${summary.output.chars} 字 · ${summary.durationMs} ms`);
    assert.equal(summary.title, '雾城来信');
    assert.equal(summary.bookName, '雾城来信');
    assert.equal(summary.ai.calls, 0);
    const checks = Object.fromEntries(summary.checks.map((item) => [item.type, item]));
    assert.equal(checks.truncation.found, 3);
    assert.equal(checks.irrelevant.found, 6);
    assert.equal(checks.chapter.status, 'warn');
    assert.deepEqual(summary.chapter.gaps[0].missing, [3]);
    assert.equal(checks.invisible.found, 8);

    const chapters = await requestJson(`/api/jobs/${created.jobId}/blocks?filter=chapter&limit=20`);
    assert.equal(chapters.json.total, 3);
    assert.deepEqual(chapters.json.blocks.map((block) => block.cleaned), [
      '《雾城来信》（第1章）雨夜',
      '《雾城来信》（第2章）旧信',
      '《雾城来信》（第4章）空屋',
    ]);
    assert.equal(summary.chapter.formatCount, 3);
    console.log('✓ 章节筛选返回完整 3 章，标题统一为《书名》（第N章）原标题，缺第 3 章被标记');

    const all = await requestJson(`/api/jobs/${created.jobId}/blocks?filter=all&limit=300`);
    assert.equal(all.json.total, 28);

    const exported = await request(`/api/jobs/${created.jobId}/export`);
    assert.ok(exported.headers['content-type'].includes('charset=utf-8'));
    const body = exported.body;
    assert.notEqual(body.subarray(0, 3).toString('hex'), 'efbbbf', 'export must not have UTF-8 BOM');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    assert.ok(!text.includes('\r'));
    for (const marker of ['求收藏', '作者的话', 'www.example-novel.com', '☆☆☆☆☆', '本章未完', '（本章完）作者']) {
      assert.ok(!text.includes(marker), `ad marker remained: ${marker}`);
    }
    assert.ok(!/[\u200b\u00a0\u00ad\u202e\ufeff\ufe0f]/.test(text), 'invisible chars remain');
    for (const line of text.split('\n')) {
      if (!line || /^第[0-9一二三四五六七八九十百零〇]+章/.test(line) || /^《[^》]+》（第[0-9]+章）/.test(line)) continue;
      assert.ok(line.startsWith('     ') && !line.startsWith('      '), `bad indent: ${JSON.stringify(line.slice(0, 20))}`);
    }
    assert.ok(text.includes('《雾城来信》（第1章）雨夜'));
    assert.ok(text.includes('她看见柜台上放着一封没有署名的信，信封的边缘已经发黄。'));
    console.log(`✓ 导出 ${body.length} bytes：UTF-8 无 BOM，5 空格缩进，广告与不可见字符已清除`);

    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-clean-save-'));
    const saved = await requestJson(`/api/jobs/${created.jobId}/save?dir=${encodeURIComponent(saveDir)}`, { method: 'POST' });
    assert.equal(saved.status, 200);
    assert.ok(fs.existsSync(saved.json.path), 'saved text missing');
    assert.ok(fs.existsSync(saved.json.reportPath), 'saved report missing');
    const report = JSON.parse(fs.readFileSync(saved.json.reportPath, 'utf8'));
    assert.equal(report.schema, 'novel-clean/report@1');
    assert.equal(report.job.bookName, '雾城来信');
    assert.equal(report.checks.length, 7);
    assert.ok(report.issues.length > 0);
    assert.equal(report.chapters.formatCount, 3);
    assert.ok(/^[a-f0-9]{64}$/.test(report.files.text.sha256));
    assert.equal(report.disabled.length, 0);
    fs.rmSync(saveDir, { recursive: true, force: true });
    console.log('✓ 指定目录保存：正文 + report.json，含 7 项检查与全量 issue');

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-clean-project-'));
    const project = await requestJson(`/api/jobs/${created.jobId}/project?dir=${encodeURIComponent(projectDir)}`, { method: 'POST' });
    assert.equal(project.status, 200);
    for (const name of ['source.txt', 'target.utf8.txt', 'project.json', 'report.json', 'state.json', 'README.md']) {
      assert.ok(fs.existsSync(path.join(project.json.dir, name)), `project missing ${name}`);
    }
    const opened = await requestJson(`/api/projects/open?path=${encodeURIComponent(project.json.dir)}`, { method: 'POST' });
    assert.equal(opened.status, 200);
    const reopened = await requestJson(`/api/jobs/${opened.json.jobId}`);
    assert.equal(reopened.json.status, 'done');
    assert.equal(reopened.json.summary.output.chars, summary.output.chars);
    const reopenedBlocks = await requestJson(`/api/jobs/${opened.json.jobId}/blocks?limit=all`);
    assert.equal(reopenedBlocks.json.blocks.length, 28);
    fs.rmSync(projectDir, { recursive: true, force: true });
    console.log('✓ 工程导出与重新加载：source / target / project / report / state / README');

    const issues = await requestJson(`/api/jobs/${created.jobId}/issues?type=truncation&info=0`);
    const merge = issues.json.issues.find((issue) => issue.type === 'truncation' && issue.accepted);
    assert.ok(merge, 'expected a merge issue');
    const rendered = await requestJson(`/api/jobs/${created.jobId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ disabled: [merge.id] })),
    });
    assert.equal(rendered.json.summary.checks.find((item) => item.type === 'truncation').found, 2);
    const split = await requestJson(`/api/jobs/${created.jobId}/blocks?filter=all&limit=300`);
    assert.equal(split.json.total, 29);
    const splitText = (await request(`/api/jobs/${created.jobId}/export`)).body.toString('utf8');
    assert.ok(splitText.includes('没有署名的信，\n'));
    console.log('✓ 关闭一条合并后：truncation 3 → 2，对比行 28 → 29');

    await requestJson(`/api/jobs/${created.jobId}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ disabled: [] })),
    });
    const restored = await requestJson(`/api/jobs/${created.jobId}/blocks?filter=all&limit=300`);
    assert.equal(restored.json.total, 28);
    console.log('✓ 恢复合并后回到 28 行');
  } finally {
    server.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
