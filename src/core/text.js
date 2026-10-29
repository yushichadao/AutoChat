/**
 * 命令行输出解码。
 *
 * 背景（实测于本机）：
 *  · reg.exe 这类 Windows 原生命令行程序，把中文错误按**系统 OEM/ANSI 代码页**
 *    （本机 CP936/GBK）写进管道，字节原样传过来；
 *  · 而 Node 默认把子进程字节当 UTF-8 解，结果是乱码，而且**不可逆**：
 *    GBK 的「系统」= CF B5 CD B3 恰好是合法 UTF-8 序列，会被解成「ϵͳ」；
 *    解不成字节对则变成 U+FFFD 替换符，原始中文彻底丢失。
 *  · 同一根管道里 PowerShell 自己产生的文本又是 UTF-8（[Console]::OutputEncoding=utf-8），
 *    所以一条流里两种编码都可能存在。
 *
 * 解码策略（按可信度排序）：
 *   1. 纯 ASCII：原样返回；
 *   2. 严格 UTF-8 能解且含中文：判定为真 UTF-8 文本，用它；
 *   3. 系统代码页（GBK/GB18030/CP936）能解干净：用它（原生命令行程序走这条）；
 *   4. 兜底：谁都不确定时优先严格 UTF-8，其次带中文的代码页解，最后宽松 UTF-8。
 */

/** CJK 汉字（含扩展 A 与兼容区），用来判断「这段文本本来是不是中文」。 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

function decodeWith(enc, buf, fatal) {
  try {
    return new TextDecoder(enc, { fatal: !!fatal }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * 把子进程输出缓冲解码成可读文本。
 * @param {Buffer|string|undefined|null} chunk
 * @returns {string}
 */
export function decodeCliText(chunk) {
  if (chunk === undefined || chunk === null) return '';
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (!buf.length) return '';

  // 1. 纯 ASCII（绝大多数输出）：快路径
  const latin = buf.toString('latin1');
  if (!/[\x80-\xff]/.test(latin)) return latin;

  const utf8 = decodeWith('utf-8', buf, true); // 严格：非法序列直接抛错
  const cands = ['gbk', 'gb18030', 'cp936']
    .map((enc) => decodeWith(enc, buf, false))
    .filter((x) => x !== null);

  // 2. 真 UTF-8 中文
  if (utf8 !== null && CJK.test(utf8)) return utf8;

  const clean = cands.find((x) => !x.includes('\uFFFD'));
  if (clean) {
    // 代码页解得干净但里面没有中文，而严格 UTF-8 又能解：更可能是 UTF-8 内容
    if (utf8 !== null && !CJK.test(clean)) return utf8;
    return clean;
  }

  const withCjk = cands.find((x) => CJK.test(x));
  if (withCjk) return withCjk;
  if (utf8 !== null) return utf8;
  return cands[0] !== undefined ? cands[0] : buf.toString('utf8');
}

/**
 * 判断一段文本是不是「解码损坏」的乱码。
 *
 * 实测：本机控制台代码页是 65001(UTF-8)，reg.exe 的中文报错在**进 Node 之前**
 * 就被系统转换坏了一半（部分字符变成 U+FFFD 替换符，另一些残留成 CP936 字节），
 * 这种内容**无法还原**，只能识别出来、别往界面上放。
 */
export function isDamagedText(text) {
  const s = String(text || '');
  if (!s) return false;
  if (s.includes('\uFFFD')) return true; // U+FFFD 替换符
  if (s.includes('锟斤拷')) return true; // UTF-8 的 U+FFFD 被按 GBK 解出来的典型乱码
  return false;
}
