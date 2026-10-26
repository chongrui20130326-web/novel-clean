import { SAMPLE_TEXT } from '../samples/sample.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SAMPLE_DIR = path.join(ROOT, 'samples');

fs.mkdirSync(SAMPLE_DIR, { recursive: true });
const utf8File = path.join(SAMPLE_DIR, 'demo-utf8.txt');
fs.writeFileSync(utf8File, `\uFEFF${SAMPLE_TEXT}`, 'utf8');
console.log(`wrote ${utf8File} (${fs.statSync(utf8File).size} bytes, UTF-8 BOM)`);

// Node 原生没有 GBK 编码器，用 Python 生成旧稿编码版本；没有 Python 就跳过。
const gbkFile = path.join(SAMPLE_DIR, 'demo-gbk.txt');
const python = process.env.PYTHON || 'python';
const scriptFile = path.join(SAMPLE_DIR, '.make-gbk.py');
const code = [
  'src = ' + JSON.stringify(utf8File),
  'dst = ' + JSON.stringify(gbkFile),
  'text = open(src, "r", encoding="utf-8-sig").read()',
  'data = text.encode("gb18030")',
  'open(dst, "wb").write(data)',
  'print(len(data))',
].join('\n');
fs.writeFileSync(scriptFile, code, 'utf8');
const result = spawnSync(python, [scriptFile], { encoding: 'utf8' });
if (result.status === 0) {
  console.log(`wrote ${gbkFile} (${result.stdout.trim()} bytes, GBK/GB18030)`);
} else {
  console.warn('skip GBK sample: python unavailable or encode failed');
  console.warn(result.error?.message || result.stderr?.slice(0, 300));
}
fs.rmSync(scriptFile, { force: true });
