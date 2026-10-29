/**
 * 办公文档读写（基础办公，§16.6）——**零运行时依赖**。
 *
 * 项目 package.json 明确是「零运行时依赖」，所以这里不引任何 npm 库：
 * docx / xlsx / pptx 本质是 ZIP + XML，用 Node 内置的 zlib 自己读写；
 * 纯文本类（txt / md / csv）直接读；PDF 做尽力而为的文本抽取。
 *
 * 两条边界：
 *  1. 抽取失败一律返回 { ok:false, reason }，绝不让一次解析异常打挂整轮对话；
 *  2. 生成的文件只写到调用方给的目录（沙箱由上层保证），本模块不做路径穿越放行。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ── ZIP 基础：CRC32（无依赖实现）─────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 读 ZIP（只走中央目录，够用于 OOXML）。
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} 文件名 → 内容
 */
export function zipRead(buf) {
  const out = new Map();
  let eocd = -1;
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (localOff + 30 <= buf.length) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, Math.min(start + compSize, buf.length));
      let data = raw;
      if (method === 8) {
        try { data = zlib.inflateRawSync(raw); } catch { data = raw; }
      }
      out.set(name, data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * 写 ZIP（deflate + CRC32）。
 * @param {Array<{name:string, data:Buffer|string}>} entries
 * @returns {Buffer}
 */
export function zipWrite(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ── XML → 文本 ────────────────────────────────────────────────────────
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** 把块级标签变成换行，再剥掉所有标签。 */
function xmlToText(xml, blockTags = []) {
  let s = String(xml);
  for (const t of blockTags) s = s.replace(new RegExp(`</?${t}[^>]*>`, 'gi'), '\n');
  s = s.replace(/<[^>]+>/g, '');
  return decodeEntities(s).replace(/\n{3,}/g, '\n\n').trim();
}

// ── 各格式抽取 ────────────────────────────────────────────────────────
function docxToText(entries) {
  const xml = entries.get('word/document.xml');
  if (!xml) return '';
  return xmlToText(xml.toString('utf8'), ['w:p', 'w:tr', 'w:br']);
}

function xlsxToText(entries) {
  const shared = [];
  const ss = entries.get('xl/sharedStrings.xml');
  if (ss) {
    const items = ss.toString('utf8').match(/<si>[\s\S]*?<\/si>/g) || [];
    for (const si of items) {
      const ts = si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || [];
      shared.push(decodeEntities(ts.map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const names = [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] || 0) - Number(/(\d+)/.exec(b)?.[1] || 0));
  const lines = [];
  for (const name of names) {
    const xml = entries.get(name).toString('utf8');
    const rows = xml.match(/<row[\s\S]*?<\/row>|<row[^>]*\/>/g) || [];
    for (const row of rows) {
      const cells = row.match(/<c[\s\S]*?<\/c>|<c[^>]*\/>/g) || [];
      lines.push(cells.map((c) => {
        const inline = /<is>([\s\S]*?)<\/is>/.exec(c);
        if (inline) return decodeEntities(inline[1].replace(/<[^>]+>/g, ''));
        const v = /<v>([\s\S]*?)<\/v>/.exec(c);
        if (!v) return '';
        const type = /t="([^"]+)"/.exec(c)?.[1] || 'n';
        return type === 's' ? (shared[Number(v[1])] ?? '') : v[1];
      }).join('\t'));
    }
  }
  return lines.join('\n').trim();
}

function pptxToText(entries) {
  const names = [...entries.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] || 0) - Number(/(\d+)/.exec(b)?.[1] || 0));
  const slides = [];
  for (const name of names) {
    const xml = entries.get(name).toString('utf8');
    const ts = xml.match(/<a:t>[\s\S]*?<\/a:t>/g) || [];
    slides.push(decodeEntities(ts.map((t) => t.replace(/<[^>]+>/g, '')).join('\n')));
  }
  return slides.map((s, i) => `—— 第 ${i + 1} 页 ——\n${s}`).join('\n\n').trim();
}

/** PDF 文本抽取（尽力而为：只解 Flate 流里的 Tj / TJ 文本算子）。 */
function pdfToText(buf) {
  const s = buf.toString('latin1');
  const chunks = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(s))) {
    let data = Buffer.from(m[1], 'latin1');
    try { data = zlib.inflateSync(data); } catch { /* 未压缩或其它滤镜，就用原文 */ }
    chunks.push(data.toString('latin1'));
  }
  const unesc = (x) => x.replace(/\\([nrt()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '(': '(', ')': ')', '\\': '\\' }[c] || c));
  const out = [];
  for (const c of chunks) {
    for (const t of c.match(/\((?:\\.|[^\\()])*\)\s*Tj/g) || []) out.push(unesc(t.slice(1, t.lastIndexOf(')'))));
    for (const a of c.match(/\[[\s\S]*?\]\s*TJ/g) || []) {
      const parts = a.match(/\((?:\\.|[^\\()])*\)/g) || [];
      out.push(parts.map((p) => unesc(p.slice(1, -1))).join(''));
    }
  }
  return out.join('').replace(/[ \t]+/g, ' ').trim();
}

/** 纯文本类扩展名（直接 utf8 读）。 */
const PLAIN_TEXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.yml', '.yaml', '.ini']);

/**
 * 抽取文档文本。
 * @param {string} filePath 本机文件路径
 * @param {{maxChars?:number}} [opts] maxChars>0 时截断（防长文档撑爆上下文）
 * @returns {{ok:boolean, kind:string, text:string, truncated?:boolean, reason?:string}}
 */
export function extractText(filePath, { maxChars = 0 } = {}) {
  try {
    const ext = path.extname(String(filePath)).toLowerCase();
    let text = '';
    let kind = ext.replace('.', '') || 'unknown';

    if (PLAIN_TEXT.has(ext)) {
      text = fs.readFileSync(filePath, 'utf8');
    } else if (ext === '.docx') {
      text = docxToText(zipRead(fs.readFileSync(filePath)));
    } else if (ext === '.xlsx') {
      text = xlsxToText(zipRead(fs.readFileSync(filePath)));
    } else if (ext === '.pptx') {
      text = pptxToText(zipRead(fs.readFileSync(filePath)));
    } else if (ext === '.pdf') {
      text = pdfToText(fs.readFileSync(filePath));
    } else {
      return { ok: false, kind, text: '', reason: `暂不支持的格式：${ext || '(无扩展名)'}` };
    }

    let truncated = false;
    if (maxChars > 0 && text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字）`;
      truncated = true;
    }
    return { ok: true, kind, text, truncated };
  } catch (e) {
    return { ok: false, kind: '', text: '', reason: String(e && e.message ? e.message : e) };
  }
}

// ── 生成：文档以文件形式发送（用户 2026-10-27 定）───────────────────

/** 写纯文本类文件（md / txt / csv …）。 */
export function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(content ?? ''), 'utf8');
  return filePath;
}

const xmlEsc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** 生成最小可用的 .docx（段落数组）。 */
export function writeDocx(filePath, { title = '', paragraphs = [] } = {}) {
  const body = [
    ...(title ? [`<w:p><w:r><w:t xml:space="preserve">${xmlEsc(title)}</w:t></w:r></w:p>`] : []),
    ...paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(p)}</w:t></w:r></w:p>`),
  ].join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  const buf = zipWrite([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: document },
  ]);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return filePath;
}

/** 生成最小可用的 .xlsx（二维数组，内联字符串，不用 sharedStrings）。 */
export function writeXlsx(filePath, { sheetName = 'Sheet1', rows = [] } = {}) {
  const colName = (i) => {
    let n = i + 1; let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  const sheetRows = rows.map((row, ri) => {
    const cells = row.map((val, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      if (typeof val === 'number' && Number.isFinite(val)) return `<c r="${ref}"><v>${val}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const buf = zipWrite([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return filePath;
}
