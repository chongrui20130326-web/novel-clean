/**
 * 编码识别与规范化。
 *
 * 小说稿的编码比网页复杂：UTF-8、UTF-8 BOM、GBK/GB18030、UTF-16，
 * 以及“复制粘贴留下的 BOM / 零宽字符”。这里先把字节变成可信的 JS 字符串，
 * 并记录原编码，交给报告层展示；最终导出永远写 UTF-8（无 BOM）。
 */

const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'UTF-8', label: 'UTF-8 BOM', bom: true },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'UTF-32LE', label: 'UTF-32 LE', bom: true },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'UTF-32BE', label: 'UTF-32 BE', bom: true },
  { bytes: [0xff, 0xfe], encoding: 'UTF-16LE', label: 'UTF-16 LE', bom: true },
  { bytes: [0xfe, 0xff], encoding: 'UTF-16BE', label: 'UTF-16 BE', bom: true },
];

const COMMON_HAN = new Set(
  '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'.split(''),
);

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function decode(buffer, encoding) {
  return new TextDecoder(encoding, { fatal: false }).decode(buffer);
}

function strictUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/** 用常用汉字命中率判断“这段解码是否像中文正文”。 */
function hanScore(text) {
  const sample = text.slice(0, 8000);
  if (!sample) return 0;
  let hits = 0;
  let han = 0;
  for (const char of sample) {
    if (char >= '\u4e00' && char <= '\u9fff') {
      han += 1;
      if (COMMON_HAN.has(char)) hits += 1;
    }
  }
  if (!han) return 0;
  return (hits / han) * 0.7 + (han / sample.length) * 0.3;
}

/** UTF-16 无 BOM 时最常见的形态：一半字节是 0x00。 */
function sniffUtf16(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let evenZero = 0;
  let oddZero = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 0) evenZero += 1;
    else oddZero += 1;
  }
  const half = Math.floor(sample.length / 2);
  if (half < 4) return null;
  if (oddZero / half > 0.6 && evenZero / half < 0.2) return 'UTF-16LE';
  if (evenZero / half > 0.6 && oddZero / half < 0.2) return 'UTF-16BE';
  return null;
}

/**
 * @param {Buffer|Uint8Array} input
 * @returns {{
 *   text: string, encoding: string, encodingLabel: string, bom: boolean,
 *   confidence: number, converted: boolean, notes: string[]
 * }}
 */
export function decodeNovel(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const notes = [];
  let encoding = '';
  let encodingLabel = '';
  let bom = false;
  let body = buffer;

  for (const entry of BOMS) {
    if (!startsWith(buffer, entry.bytes)) continue;
    // UTF-32 需要先于 UTF-16 判断（FF FE 00 00 会被 UTF-16 误认）。
    encoding = entry.encoding;
    encodingLabel = entry.label;
    bom = true;
    body = buffer.subarray(entry.bytes.length);
    notes.push(`检测到 ${entry.label}，已移除文件头 BOM`);
    break;
  }

  let text = '';
  if (!encoding) {
    const utf8 = strictUtf8(buffer);
    if (utf8 !== null) {
      encoding = 'UTF-8';
      encodingLabel = 'UTF-8';
      text = utf8;
    } else {
      const utf16 = sniffUtf16(buffer);
      if (utf16) {
        encoding = utf16;
        encodingLabel = `${utf16}（无 BOM）`;
        text = decode(buffer, utf16);
        notes.push('检测到无 BOM 的 UTF-16，已按字节分布推断端序');
      } else {
        // 中文旧稿最常见的两种：GB18030 与 Big5。用常用字命中率选一个。
        const gb = decode(buffer, 'gb18030');
        const big5 = decode(buffer, 'big5');
        const gbScore = hanScore(gb);
        const big5Score = hanScore(big5);
        if (big5Score > gbScore + 0.08) {
          encoding = 'Big5';
          encodingLabel = 'Big5';
          text = big5;
        } else {
          encoding = 'GB18030';
          encodingLabel = 'GBK / GB18030';
          text = gb;
        }
        notes.push(`文件不是合法 UTF-8，按 ${encodingLabel} 解码`);
      }
    }
  } else if (encoding === 'UTF-32LE' || encoding === 'UTF-32BE') {
    // TextDecoder 不支持 UTF-32；手工按码点解码。
    text = decodeUtf32(body, encoding === 'UTF-32LE');
  } else if (encoding === 'UTF-16LE' || encoding === 'UTF-16BE') {
    text = decode(body, encoding);
  } else {
    text = decode(body, 'utf-8');
  }

  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  const confidence = replacementCount === 0 ? 0.99 : Math.max(0.3, 1 - replacementCount / Math.max(1, text.length));
  if (replacementCount) notes.push(`解码后有 ${replacementCount} 个替换字符，原文件可能有坏字节`);

  return {
    text,
    encoding,
    encodingLabel,
    bom,
    confidence,
    converted: encoding !== 'UTF-8' || bom,
    notes,
  };
}

function decodeUtf32(buffer, littleEndian) {
  let out = '';
  for (let index = 0; index + 3 < buffer.length; index += 4) {
    const code = littleEndian
      ? (buffer[index] | (buffer[index + 1] << 8) | (buffer[index + 2] << 16) | (buffer[index + 3] << 24)) >>> 0
      : ((buffer[index] << 24) | (buffer[index + 1] << 16) | (buffer[index + 2] << 8) | buffer[index + 3]) >>> 0;
    if (code === 0xfeff) continue;
    if (code > 0x10ffff) out += '\uFFFD';
    else out += String.fromCodePoint(code);
  }
  return out;
}

/** 统计换行风格，并统一成 LF。返回规范化文本与报告。 */
export function normalizeNewlines(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  const lf = (text.match(/\n/g) || []).length;
  const style = crlf > 0 ? 'CRLF' : cr > 0 ? 'CR' : 'LF';
  const normalized = text.replace(/\r\n?/g, '\n');
  return {
    text: normalized,
    style,
    crlf,
    cr,
    lf,
    changed: crlf + cr > 0,
  };
}
