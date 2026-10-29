/**
 * 多模态辅助：入站读图、出站图文拆分。
 *
 * 设计要点（对应计划 §3.1 / IR8 / IR13）：
 *  · 入站图片只在「本机读取 → base64 内联进 image_url 内容块」，不把本机绝对路径当 URL 外发，
 *    也不把图片字节写进日志（日志只说「哪张被跳过、为什么」）。
 *  · 入站体积护栏：超过 maxBytes 的图直接跳过并记日志，避免原样 base64 外发爆 token / 费用。
 *  · 出站：模型若返回 [[image:...]] / [[file:...]] 标记，则走原生 sendImage / sendFile，
 *    文本部分走 stripMarkdown 纯文本（微信不渲染 ``` 围栏）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function mimeOf(p) {
  return MIME[path.extname(p || '').toLowerCase()] || 'image/jpeg';
}

/** 模型地址是否指向本机（127.0.0.1 / localhost / ::1 / 0.0.0.0）。 */
function isLocalBase(baseUrl) {
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|::1|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(
    String(baseUrl || '').trim()
  );
}

/**
 * 判定「这条带图消息到底能不能看图」（IR3）。
 *
 * 结论只有两种：
 *  · 能看：显式配了 AI_VISION_MODEL（云端视觉模型，或本机的 llava 一类），
 *    或用的是云端模型（未配视觉模型时回落到 AI_MODEL）。
 *  · 不能看：没配视觉模型 **且** 模型地址指向本机 —— 本机纯文本模型（如 ollama 的
 *    qwen / llama 文本档）收下 image_url 内容块只会报 400 或直接忽略图片，
 *    与其静默失败、让用户以为「助手没看见」，不如明确告知。
 *
 * 隐私：判定发生在**读图之前**，判定为「不能看」时调用方不会读盘、不组装 image_url，
 * 因此图片字节不会离开本机（IR8）。
 *
 * @param {{baseUrl?:string, visionModel?:string}} cfg
 * @returns {{ok:boolean, reason:'vision-model'|'cloud'|'local-no-vision', local:boolean}}
 */
export function visionSupport(cfg = {}) {
  const baseUrl = String(cfg.baseUrl || '');
  const local = isLocalBase(baseUrl);
  // 显式声明了视觉模型就听用户的：本机 llava 之类的本地视觉模型也算「能看」
  if (String(cfg.visionModel || '').trim()) return { ok: true, reason: 'vision-model', local };
  if (local) return { ok: false, reason: 'local-no-vision', local: true };
  return { ok: true, reason: 'cloud', local: false };
}

/**
 * 把入站图片列表读成多模态内容块。
 * @param {string[]} images 本机图片路径（normalize.js 已落到本机）
 * @param {{maxBytes?:number, tmpDir?:string, logger?:object}} opts maxBytes=0 表示不限
 * @returns {{blocks:Array, skipped:Array<{path:string,reason:string,bytes?:number}>, usedNative:boolean}}
 */
export function readImageContent(images, { maxBytes = 0, logger } = {}) {
  const blocks = [];
  const skipped = [];
  const list = Array.isArray(images) ? images : [];
  for (const p of list) {
    const file = String(p || '');
    if (!file) continue;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      skipped.push({ path: file, reason: 'missing' });
      logger?.warn?.(`图片未纳入（文件不存在）：${file}`);
      continue;
    }
    if (maxBytes > 0 && st.size > maxBytes) {
      skipped.push({ path: file, reason: 'too-large', bytes: st.size });
      logger?.warn?.(`图片未纳入（超过体积上限 ${maxBytes} 字节）：${file}（${st.size} 字节）`);
      continue;
    }
    let b64;
    try {
      b64 = fs.readFileSync(file).toString('base64');
    } catch {
      skipped.push({ path: file, reason: 'unreadable' });
      continue;
    }
    // 内联 data URI：图片不出机本机路径不外发，只把字节交给模型服务商（云端路径才外发）。
    blocks.push({ type: 'image_url', image_url: { url: `data:${mimeOf(file)};base64,${b64}` } });
  }
  return { blocks, skipped, usedNative: false };
}

const OUTBOUND_RE = /\[\[(?:image|file):([^\]]+)\]\]/g;

/**
 * 把模型回复文本拆成「纯文本段」与「需要原生发送的图片 / 文件标记」。
 * 文本段后续仍走 stripMarkdown；图片 / 文件走 sendImage / sendFile（IR9 / IR12 / IR10）。
 * @returns {{text:string, images:string[], files:string[]}}
 */
export function parseOutbound(text) {
  const s = String(text || '');
  const images = [];
  const files = [];
  let m;
  OUTBOUND_RE.lastIndex = 0;
  while ((m = OUTBOUND_RE.exec(s)) !== null) {
    const token = m[1].trim();
    if (!token) continue;
    // 标记里区分 image / file 由前缀决定，但为稳妥都收集：以首个前缀归类
    if (m[0].startsWith('[[image:')) images.push(token);
    else files.push(token);
  }
  const clean = s.replace(OUTBOUND_RE, '').replace(/\s{2,}/g, ' ').trim();
  return { text: clean, images, files };
}

/**
 * 把出站媒体标记解析成本机文件路径：
 *  · 已经是本机路径 → 原样返回；
 *  · data URI（模型返回 b64_json）→ 解码写临时文件后返回其路径（hook 只认文件路径）。
 * @param {string} token
 * @param {{tmpDir?:string}} opts
 */
export function resolveOutboundMedia(token, { tmpDir } = {}) {
  const t = String(token || '').trim();
  if (!t) return null;
  const dataMatch = /^data:([^;]+);base64,(.+)$/i.exec(t);
  if (dataMatch) {
    const mime = dataMatch[1].toLowerCase();
    const b64 = dataMatch[2];
    const dir = tmpDir || path.join(os.tmpdir(), 'autochat-media');
    fs.mkdirSync(dir, { recursive: true });
    const ext = Object.entries(MIME).find(([, v]) => v === mime)?.[0] || '.bin';
    const file = path.join(dir, `media-${crypto.randomBytes(6).toString('hex')}${ext}`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    return file;
  }
  return t;
}
