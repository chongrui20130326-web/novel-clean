/**
 * HMI 截图 + 交互冒烟测试。
 * 用法：node tools/shoot-hmi.mjs
 * 需要本机 Chrome；Chrome 由脚本启动，通过 CDP 控制。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SHOTS = path.join(ROOT, 'screenshots');
const CHROME = process.env.CHROME || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9223;
const URL = 'http://127.0.0.1:4180';
const width = 1600;
const height = 1000;

fs.mkdirSync(SHOTS, { recursive: true });
const profile = path.join(os.tmpdir(), `novel-clean-chrome-${Date.now()}`);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForJson(url, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`timeout waiting ${url}`);
}

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  const errors = [];
  try {
    await waitForJson(`http://127.0.0.1:${PORT}/json/version`);
    const target = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' }).then((response) => response.json());
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        errors.push(message.params.args.map((arg) => arg.value || arg.description || '').join(' '));
      }
      if (message.method === 'Runtime.exceptionThrown') {
        errors.push(message.params.exceptionDetails?.exception?.description || 'page exception');
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        errors.push(message.params.entry.text);
      }
    });
    const cmd = (method, params = {}) => new Promise((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, { resolve, reject });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });

    await cmd('Page.enable');
    await cmd('Runtime.enable');
    await cmd('Log.enable');
    await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await cmd('Page.navigate', { url: URL });
    await sleep(2200);
    await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      .then((result) => fs.writeFileSync(path.join(SHOTS, 'ui-home.png'), Buffer.from(result.data, 'base64')));

    const home = await cmd('Runtime.evaluate', {
      expression: `JSON.stringify({
        title: document.title,
        model: document.querySelector('#modelPillText')?.textContent,
        sample: !!document.querySelector('[data-sample="gbk"]'),
        checks: document.querySelectorAll('.syllabus-list li').length,
      })`,
      returnByValue: true,
    });
    console.log('HOME', home.result.value);

    await cmd('Runtime.evaluate', { expression: `document.querySelector('[data-sample="gbk"]').click()` });
    await sleep(700);
    await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      .then((result) => fs.writeFileSync(path.join(SHOTS, 'ui-progress.png'), Buffer.from(result.data, 'base64')));
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 180000) {
      const status = await cmd('Runtime.evaluate', {
        expression: `JSON.stringify({
          work: !document.querySelector('#workView').hidden,
          overlay: !document.querySelector('#progressOverlay').hidden,
          rows: document.querySelectorAll('.diff-row').length,
          progress: document.querySelector('#progressPercent')?.textContent,
          title: document.querySelector('#progressTitle')?.textContent,
        })`,
        returnByValue: true,
      });
      const value = JSON.parse(status.result.value);
      process.stdout.write(`\rWAIT ${value.progress} ${value.title} rows=${value.rows}    `);
      if (value.work && !value.overlay && value.rows > 0) { ready = true; break; }
      await sleep(1000);
    }
    console.log('');
    if (!ready) throw new Error('workspace did not become ready');
    await sleep(1200);
    await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      .then((result) => fs.writeFileSync(path.join(SHOTS, 'ui-workspace.png'), Buffer.from(result.data, 'base64')));

    const workspace = await cmd('Runtime.evaluate', {
      expression: `JSON.stringify({
        title: document.querySelector('#docTitle')?.textContent,
        chars: [document.querySelector('#charsBefore')?.textContent, document.querySelector('#charsAfter')?.textContent],
        checks: [...document.querySelectorAll('.check-tile')].map(e => [e.querySelector('.check-label')?.textContent, e.querySelector('.check-detail')?.textContent, e.className]),
        issues: document.querySelectorAll('.issue-card').length,
        rows: document.querySelectorAll('.diff-row').length,
        merged: document.querySelectorAll('.merge-line').length,
        del: document.querySelectorAll('.paragraph-text del').length,
        inv: document.querySelectorAll('.inv-token').length,
        deleted: document.querySelectorAll('.removed-ghost').length,
        indentBad: document.querySelectorAll('.indent-badge.bad').length,
      })`,
      returnByValue: true,
    });
    console.log('WORKSPACE', workspace.result.value);

    // 无关内容筛选：整段删除与行内网址的对照。
    await cmd('Runtime.evaluate', { expression: `document.querySelector('[data-filter="irrelevant"]').click()` });
    await sleep(1600);
    await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      .then((result) => fs.writeFileSync(path.join(SHOTS, 'ui-filter-irrelevant.png'), Buffer.from(result.data, 'base64')));

    // 章节连续性筛选。
    await cmd('Runtime.evaluate', { expression: `document.querySelector('[data-filter="chapter"]').click()` });
    await sleep(1200);
    await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      .then((result) => fs.writeFileSync(path.join(SHOTS, 'ui-filter-chapter.png'), Buffer.from(result.data, 'base64')));

    // 不可见字符筛选。
    await cmd('Runtime.evaluate', { expression: `document.querySelector('[data-filter="invisible"]').click()` });
    await sleep(1200);
    await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      .then((result) => fs.writeFileSync(path.join(SHOTS, 'ui-filter-invisible.png'), Buffer.from(result.data, 'base64')));

    // 点击“零宽空格”记录，定位到原文里的不可见标记。
    await cmd('Runtime.evaluate', {
      expression: `(() => {
        const card = [...document.querySelectorAll('.issue-card')].find(e => e.textContent.includes('零宽空格'));
        if (card) card.click();
      })()`,
    });
    await sleep(900);
    await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      .then((result) => fs.writeFileSync(path.join(SHOTS, 'ui-invisible-jump.png'), Buffer.from(result.data, 'base64')));

    // 截断筛选。
    await cmd('Runtime.evaluate', { expression: `document.querySelector('[data-filter="truncation"]').click()` });
    await sleep(1200);
    await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      .then((result) => fs.writeFileSync(path.join(SHOTS, 'ui-filter-truncation.png'), Buffer.from(result.data, 'base64')));

    // 关闭第一条 AI 修复，验证对比会重新渲染。
    await cmd('Runtime.evaluate', { expression: `document.querySelector('[data-filter="all"]').click()` });
    await sleep(1200);
    const toggleInfo = await cmd('Runtime.evaluate', {
      expression: `(() => {
        const input = document.querySelector('.issue-card input[data-toggle]');
        if (!input) return 'none';
        input.click();
        return input.dataset.toggle;
      })()`,
      returnByValue: true,
    });
    console.log('TOGGLE', toggleInfo.result.value);
    await sleep(2200);
    const afterToggle = await cmd('Runtime.evaluate', {
      expression: `JSON.stringify({ chars: document.querySelector('#charsAfter')?.textContent, rows: document.querySelectorAll('.diff-row').length, checks: [...document.querySelectorAll('.check-tile')].map(e => e.querySelector('.check-detail')?.textContent), toast: document.querySelector('#toast')?.textContent })`,
      returnByValue: true,
    });
    console.log('AFTER_TOGGLE', afterToggle.result.value);
    await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      .then((result) => fs.writeFileSync(path.join(SHOTS, 'ui-toggled.png'), Buffer.from(result.data, 'base64')));

    console.log('ERRORS', JSON.stringify(errors.slice(0, 10), null, 2));
    await cmd('Browser.close').catch(() => {});
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
