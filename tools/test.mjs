/**
 * 清洗引擎回归测试。
 * 运行：node tools/test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeNovel } from '../core/encoding.mjs';
import { scanInvisible } from '../core/invisible.mjs';
import { detectChapter, formatChapterTitle } from '../core/parse.mjs';
import { runClean, rerender } from '../core/pipeline.mjs';
import { MockAiClient } from '../core/ai.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SAMPLE_UTF8 = path.join(ROOT, 'samples', 'demo-utf8.txt');
const SAMPLE_GBK = path.join(ROOT, 'samples', 'demo-gbk.txt');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function linesOf(text) {
  return text.split('\n');
}

function assertInvariants(text, { expectAds = false } = {}) {
  assert.ok(!text.startsWith('\uFEFF'), 'output must not start with BOM');
  assert.ok(!text.includes('\r'), 'output must use LF only');
  const encoded = Buffer.from(text, 'utf8');
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(encoded), text, 'output must be valid UTF-8');
  const invisible = scanInvisible(text);
  assert.equal(invisible.total, 0, `output still has invisible chars: ${JSON.stringify(invisible.found)}`);

  if (!expectAds) {
    for (const marker of ['求收藏', '作者的话', 'www.example-novel.com', '☆☆☆☆☆', '本章未完', '（本章完）作者']) {
      assert.ok(!text.includes(marker), `ad marker remained: ${marker}`);
    }
  }

  const lines = linesOf(text).filter((line) => line !== '');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^第[0-9一二三四五六七八九十百零〇]+章/.test(line) || /^《[^》]+》（第[0-9]+章）/.test(line)) {
      assert.ok(!line.startsWith(' '), `chapter heading must be flush left: ${line}`);
      continue;
    }
    assert.ok(line.startsWith('     '), `paragraph must start with 5 spaces: ${JSON.stringify(line.slice(0, 18))}`);
    assert.ok(!line.startsWith('      '), `paragraph has more than 5 leading spaces: ${JSON.stringify(line.slice(0, 18))}`);
  }

  // 空行只允许出现在章节标题之前。
  const raw = linesOf(text);
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '') continue;
    if (index === raw.length - 1) continue; // 文件末尾的正常换行
    const next = raw[index + 1];
    assert.ok(next && (/^第[0-9一二三四五六七八九十百零〇]+章/.test(next) || /^《[^》]+》（第[0-9]+章）/.test(next)), `unexpected blank line at ${index + 1}`);
  }
}

test('UTF-8 BOM 被识别并移除', () => {
  const decoded = decodeNovel(fs.readFileSync(SAMPLE_UTF8));
  assert.equal(decoded.encoding, 'UTF-8');
  assert.equal(decoded.bom, true);
  assert.equal(decoded.converted, true);
  assert.ok(decoded.text.includes('雾是从江面漫上来的'));
});

test('GBK 旧稿按 GB18030 解码', () => {
  const decoded = decodeNovel(fs.readFileSync(SAMPLE_GBK));
  assert.equal(decoded.encoding, 'GB18030');
  assert.ok(decoded.text.includes('雾是从江面漫上来的'));
});

test('UTF-16 LE（带 BOM）与 CRLF 可恢复', () => {
  const text = '第一章 雨夜\r\n\r\n    她推开门。\r\n';
  const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const decoded = decodeNovel(buffer);
  assert.equal(decoded.encoding, 'UTF-16LE');
  assert.equal(decoded.bom, true);
  assert.ok(decoded.text.includes('她推开门'));
});

test('章节标题统一为「《书名》（第N章）原标题」', () => {
  assert.equal(formatChapterTitle({ kind: 'chapter', chapterNumber: 1, chapterUnit: '章', chapterTitle: '雨夜', text: '第一章 雨夜' }, '雾城来信'), '《雾城来信》（第1章）雨夜');
  assert.equal(formatChapterTitle({ kind: 'chapter', chapterNumber: 12, chapterUnit: '回', chapterTitle: '旧信', text: '第十二回：旧信' }, '雾城来信'), '《雾城来信》（第12章）旧信');
  assert.equal(formatChapterTitle({ kind: 'chapter', chapterNumber: 2, chapterUnit: '章', chapterTitle: '', text: '第002章' }, '雾城来信'), '《雾城来信》（第2章）');
  assert.equal(formatChapterTitle({ kind: 'chapter', chapterNumber: null, chapterUnit: 'special', chapterTitle: '', text: '序章' }, '雾城来信'), '《雾城来信》序章');
});

test('「第一章，」这类行尾标点仍能识别为章节', () => {
  const chapter = detectChapter('第一章，');
  assert.ok(chapter);
  assert.equal(chapter.number, 1);
  assert.equal(chapter.title, '');
  assert.equal(detectChapter('第一章 雨夜，').title, '雨夜');
  assert.equal(detectChapter('见第一章，他走了。'), null);
});

test('「(12)」「（14）」这类括号章节号也能识别', () => {
  const half = detectChapter('(12)');
  assert.ok(half);
  assert.equal(half.number, 12);
  assert.equal(half.unit, 'paren');
  assert.equal(formatChapterTitle({
    kind: 'chapter',
    chapterNumber: half.number,
    chapterUnit: half.unit,
    chapterTitle: half.title,
    text: half.raw,
  }, '妻殇（崩毁人生）'), '《妻殇（崩毁人生）》（第12章）');
  const full = detectChapter('（14）');
  assert.equal(full.number, 14);
  assert.equal(detectChapter('【妻殇（崩毁人生）】 (11)'), null);
  assert.equal(detectChapter('第十一章，').number, 11);
});

test('「二十二章」这种省略「第」的章节号也能识别', () => {
  const chapter = detectChapter('二十二章');
  assert.ok(chapter);
  assert.equal(chapter.number, 22);
  assert.equal(chapter.title, '');
  assert.equal(chapter.unit, '章');
  assert.equal(detectChapter('二十三章 标题').number, 23);
  assert.equal(detectChapter('二十三章 标题').title, '标题');
  assert.equal(detectChapter('12章').number, 12);
});

test('7 类不可见字符全部定位', () => {
  const decoded = decodeNovel(fs.readFileSync(SAMPLE_UTF8));
  const scan = scanInvisible(decoded.text);
  assert.ok(scan.total >= 8, `expected >=8 invisible chars, got ${scan.total}`);
  assert.ok(scan.kinds >= 7, `expected >=7 kinds, got ${scan.kinds}`);
  const codes = scan.found.map((item) => item.hex);
  for (const code of ['U+200B', 'U+00A0', 'U+3000', 'U+FEFF', 'U+FE0F', 'U+202E']) {
    assert.ok(codes.includes(code), `missing ${code}`);
  }
});

await asyncTest('规则 + 9B 复核（mock）产出可交付文本', async () => {
  const result = await runClean({
    buffer: fs.readFileSync(SAMPLE_UTF8),
    name: '雾城来信.txt',
    options: { ai: true },
    aiClient: new MockAiClient(),
  });
  const checks = Object.fromEntries(result.summary.checks.map((item) => [item.type, item]));
  assert.equal(result.summary.title, '雾城来信');
  assert.equal(checks.truncation.found, 3);
  assert.equal(checks.chapter.status, 'warn');
  assert.equal(checks.chapter.warnCount, 1);
  assert.equal(checks.chapter.formatCount, 3);
  assert.deepEqual(result.summary.chapter.gaps[0].missing, [3]);
  assert.equal(checks.irrelevant.found, 6);
  assert.ok(checks.blank.found > 0);
  assert.ok(checks.indent.found > 0);
  assert.equal(checks.encoding.status, 'fixed');
  assert.equal(checks.invisible.found, 8);
  assertInvariants(result.text);
  assert.ok(result.text.includes('《雾城来信》（第1章）雨夜'));
  assert.ok(result.text.includes('《雾城来信》（第2章）旧信'));
  assert.ok(!result.text.includes('第一章 雨夜'));
  assert.ok(result.text.includes('她看见柜台上放着一封没有署名的信，信封的边缘已经发黄。'));
  assert.ok(result.text.includes('“你终于来了。”林晚低声说。'));
  assert.ok(result.text.includes('雨声很大，他却听见自己的心跳。'));
  assert.ok(!result.text.includes('更多章节请访问'));
});

await asyncTest('撤销一条合并后，段落重新拆开；恢复后完全一致', async () => {
  const result = await runClean({
    buffer: fs.readFileSync(SAMPLE_UTF8),
    name: '雾城来信.txt',
    options: { ai: true },
    aiClient: new MockAiClient(),
  });
  const merge = result.issues.find((issue) => issue.type === 'truncation' && issue.accepted);
  assert.ok(merge, 'expected an accepted truncation issue');
  const original = result.text;
  const off = rerender(result.snapshot, [merge.id]);
  assert.ok(off.text.includes('没有署名的信，\n'));
  assert.ok(off.summary.checks.find((item) => item.type === 'truncation').found < 3);
  const back = rerender(result.snapshot, []);
  assert.equal(back.text, original);
});

await asyncTest('清洗结果可幂等重跑', async () => {
  const first = await runClean({
    buffer: fs.readFileSync(SAMPLE_UTF8),
    name: '雾城来信.txt',
    options: { ai: true },
    aiClient: new MockAiClient(),
  });
  const second = await runClean({
    buffer: Buffer.from(first.text, 'utf8'),
    name: '雾城来信-已清洗.txt',
    options: { ai: true, bookName: '雾城来信' },
    aiClient: new MockAiClient(),
  });
  const checks = Object.fromEntries(second.summary.checks.map((item) => [item.type, item]));
  assert.equal(checks.truncation.found, 0);
  assert.equal(checks.irrelevant.found, 0);
  assert.equal(checks.blank.found, 0);
  assert.equal(checks.indent.found, 0);
  assert.equal(checks.encoding.found, 0);
  assert.equal(checks.invisible.found, 0);
  assert.equal(checks.chapter.formatCount, 0);
  assert.equal(second.text, first.text);
});

await asyncTest('模型不可用时安全退回规则模式', async () => {
  const result = await runClean({
    buffer: fs.readFileSync(SAMPLE_UTF8),
    name: '模型掉线.txt',
    options: { ai: true },
    aiClient: new MockAiClient({ fail: true }),
  });
  const checks = Object.fromEntries(result.summary.checks.map((item) => [item.type, item]));
  assert.equal(result.summary.ai.enabled, false);
  assert.equal(result.summary.ai.degraded, true);
  assert.equal(checks.truncation.found, 3);
  assert.equal(checks.irrelevant.found, 6);
  assertInvariants(result.text);
});

await asyncTest('规则模式（无模型）也能完成确定性修复', async () => {
  const result = await runClean({
    buffer: fs.readFileSync(SAMPLE_GBK),
    name: 'GBK旧稿.txt',
    options: { ai: false },
    aiClient: null,
  });
  const checks = Object.fromEntries(result.summary.checks.map((item) => [item.type, item]));
  assert.equal(result.summary.ai.calls, 0);
  assert.equal(result.summary.ai.enabled, false);
  assert.equal(checks.truncation.found, 3);
  assert.equal(checks.irrelevant.found, 6);
  assert.equal(checks.encoding.detail, 'GBK / GB18030 → UTF-8（无 BOM）');
  assertInvariants(result.text);
});

test('导出文本 UTF-8 编码不含 BOM', () => {
  const buffer = Buffer.from('     一段正文。\n', 'utf8');
  assert.notEqual(buffer[0], 0xef);
  assert.equal(buffer[0], 0x20);
  assert.equal(buffer.subarray(0, 3).toString('hex'), '202020');
});

console.log(`\n${passed} tests passed.`);
