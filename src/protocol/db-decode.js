import zlib from 'node:zlib';

/**
 * 微信本地消息库里的 message_content 有好几种存法：
 *   · 明文 XML / 纯文本（4.x 常见）
 *   · 十六进制字符串（部分版本把字节流存成 hex）
 *   · zstd 压缩后再存成 hex（较新的版本）
 *
 * 直接把 hex 当文本发给模型，模型会看到一串十六进制乱码；
 * 把明文当 hex 解，又会把「1234」这种正常消息解成控制字符。
 * 所以这里按「能解、且解出来像人话」的原则逐级尝试。
 */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HEX_RE = /^[0-9a-fA-F]+$/;

/** Node 自带 zstd（22.15+ / 23+）才有；没有就只支持明文与 hex。 */
const hasZstd = typeof zlib.zstdDecompressSync === 'function';

/** 解码结果里可打印字符太少，说明多半解错了，当作原文。 */
function looksReadable(s) {
  if (!s) return false;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 0xfffd) bad += 1;
  }
  return bad / s.length < 0.1;
}

function decodeHex(text) {
  if (text.length % 2 !== 0) return null;
  const buf = Buffer.from(text, 'hex');
  if (!buf.length) return null;

  // zstd 压缩帧
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
    if (!hasZstd) return null;
    try {
      const out = zlib.zstdDecompressSync(buf, { maxOutputLength: 4 * 1024 * 1024 });
      const s = out.toString('utf8');
      return looksReadable(s) ? s : null;
    } catch {
      return null;
    }
  }

  const s = buf.toString('utf8');
  return looksReadable(s) ? s : null;
}

/**
 * 把数据库里的 content 还原成可读文本。
 * 解不出来就原样返回 —— 宁可给模型看原文，也不要给乱码。
 */
export function decodeDbContent(raw) {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) return raw;
  // 明显是 XML / 普通文本，直接放行
  if (text.startsWith('<') || !HEX_RE.test(text)) return raw;
  if (text.length < 4 || text.length % 2 !== 0) return raw;
  const out = decodeHex(text);
  return out === null ? raw : out;
}

export const __test = { decodeHex, looksReadable, hasZstd };
