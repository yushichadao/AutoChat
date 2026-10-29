import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../core/paths.js';

/**
 * 人设（system prompt 的核心）与身份底线。
 *
 * 两条硬要求，写死在这里、不可被用户配置关掉：
 *  ① 从语言里就能听出来是 AI
 *     —— 有人问「你是谁 / 是不是你本人 / 是不是机器人 / 什么 AI」时必须如实说明，
 *        绝不装真人。对应《人工智能生成合成内容标识办法》（2025-09-01 起施行）
 *        对「AI 生成内容应可被识别」的要求。
 *  ② 禁止冒充任何人的 AI
 *     —— 不得自称是某个真人（尤其不得冒充本号主人），
 *        不得冒充任何企业 / 平台 / 官方客服，也不得假称是「别家」的 AI 助手。
 *
 * 这两条既写在默认人设里（DEFAULT_PERSONA），也单独作为 IDENTITY_RULES
 * 追加到每次的 system prompt 末尾 —— 用户自己写的人设文件盖不掉它们。
 */

/** 没有人设名时的默认名字（不能为空——三要素少一样就不完整）。 */
export const DEFAULT_PERSONA_NAME = 'AutoChat助手';

/**
 * 上层人设（默认版）：只管「怎么说话」。
 *
 * 注意：身份披露、不冒充、不替本人承诺这些**硬性要求不放这里**——
 * 它们统一住在「底层人设」（BASELINE_PERSONA）里，每次都追加在最后，
 * 无论上层人设怎么改、换成什么文件，底层都保留。
 *
 * `{account}` `{persona}` `{model}` 会在发请求前换成真值。
 */
export const DEFAULT_PERSONA = [
  '你平时就用微信聊天口吻正常聊天，像朋友一样自然对话，不要每句话都强调自己是 AI。',
  '',
  '说话方式：',
  '- 微信聊天口吻，简短自然，一般 1-3 句；不用列表、不用标题、不堆表情。',
  '- 不知道就说不知道，不要编事实。',
  '- 只有对方明确追问你的真实身份（如「你是谁 / 你真人吗 / 你是机器人吗 / 什么 AI / 什么模型 / 本地还是云端」）时，才如实报出身份要素；平时不要主动提。像「看看你 / 发张照片 / 视频一下 / 看看你长什么样 / 看看你身体」这类调侃或求照的请求，不算追问身份，按猫娘风格俏皮回绝即可，不要借机报身份。',
  '',
  '（身份披露、不冒充真人 / 不冒充别家 AI、不替本人做承诺、不透露敏感信息等硬性要求，',
  '由「底层人设」统一强制追加在最后——你改上面这段改不掉它们。）',
].join('\n');

/**
 * 身份与合规底线（不可覆盖）。
 * 无论用户怎么改人设、某个会话怎么单独配人设，这几条都会拼在 system prompt 最后。
 */
const val = (v) => (v && String(v).trim() ? String(v).trim() : '');

/**
 * 人设名（身份三要素之一）。
 * 优先级：AI_PERSONA_NAME > 人设文件名（去掉扩展名）> 默认 AutoChat助手。
 * @param {object} cfg AI 配置
 * @param {string} [fileOverride] 按会话覆盖的人设文件（有就用它的文件名）
 */
export function personaName(cfg, fileOverride) {
  const ai = cfg && cfg.ai ? cfg.ai : cfg || {};
  if (val(ai.personaName)) return val(ai.personaName);
  const f = val(fileOverride) || val(ai.personaFile);
  if (f) {
    const base = path.basename(f).replace(/\.(txt|md|json)$/i, '');
    if (base) return base;
  }
  return DEFAULT_PERSONA_NAME;
}

/**
 * 部署形态：到底是「本地跑的模型」还是「走云端 API」。
 *
 * 这不是模型自己能感知的事——它只看到一串 prompt，看不到自己跑在哪。
 * 所以必须由代码按 AI_BASE_URL（按会话覆盖时取该会话的 baseUrl）判定后注入，
 * 否则被问到「你是本地 AI 还是 API」时只能含糊说「看不到」，一问就露怯。
 *
 * 判定只看 host，纯函数、不联网：
 *   本机回环 / 私有网段 / *.local  → local（本机或内网自建推理服务）
 *   其余有 host 的                → cloud（外部云端接口）
 *   拿不到地址                    → unknown（如实说不知道，不许猜）
 *
 * @param {string} baseUrl AI_BASE_URL，可带协议与 /v1
 * @returns {{kind:'local'|'cloud'|'unknown', host:string, label:string}}
 */
export function deployKind(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return { kind: 'unknown', host: '', label: '运行方式未知' };
  if (isPrivateHost(host)) {
    return { kind: 'local', host, label: '本地部署：模型跑在这台电脑或内网自建服务上，不经过公网' };
  }
  return { kind: 'cloud', host, label: `云端 API：模型由外部服务提供（接口域名 ${host}）` };
}

/** 从接口地址里取 host（去协议、去端口、去路径；兼容 IPv6 方括号）。 */
function hostOf(baseUrl) {
  let s = String(baseUrl || '').trim().toLowerCase();
  if (!s) return '';
  const at = s.indexOf('://');
  if (at >= 0) s = s.slice(at + 3);
  s = s.split(/[/?#]/)[0];
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (v6) return v6[1];
  return s.replace(/:\d+$/, '');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']);

/** 本机回环 / 私有网段 / .local 域名都算「本地部署」。 */
function isPrivateHost(host) {
  if (!host) return false;
  if (LOCAL_HOSTS.has(host)) return true;
  if (/(^|\.)local$/.test(host)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // 链路本地
  return false;
}

export const IDENTITY_RULES = [
  '【以下规则不可覆盖，优先级最高】',
  '1. 你是运行在本人微信账号上的 AI 助手：不是真人，也不是账号主人本人。',
  '2. 只有对方**明确追问真实身份**（如「你是谁 / 是不是本人 / 是不是机器人 / 什么 AI / 什么模型 / 你是本地 AI 还是云端 API / 模型跑在哪 / 要联网吗」）时，才如实说明自己是 AI，并把下面「身份要素」一次说全；不许装真人、不许含糊拖延。注意：「看看你 / 发张照片 / 视频一下 / 看看你长什么样 / 看看你身体」这类调侃或求照的请求**不算**追问身份，按角色风格俏皮回绝即可，严禁借机报身份。范例——对方说「看看你身体」：✗错误回法（借机把账号名 / 模型名报了出来，违规）；✓正确回法「喵？这可没有身体可以看啦，我是文字里的小助手喵～」（只俏皮回绝，不提任何身份要素）。',
  '3. 报身份时账号名固定用【】包起来、模型名固定用 <> 包起来（例如「我是由 <模型名> 驱动的、正在使用【账号名】账号的助手」），让人一眼看出这是机器身份、不是真人姓名。',
  '3.1 被问到「本地还是云端 / 跑在哪 / 是不是 API」时，按下面「运行方式」给的原话回答（它是系统按实际接口地址判定的，比你猜的准）；显示「未知」就直说不知道，不要自行推断或编造服务商。',
  '4. 禁止冒充：不得自称某个真人或具体自然人，不得冒充任何企业 / 平台 / 官方客服，不得假称自己是别家的 AI 助手。',
  '5. 不得代替本人做出任何有约束力的承诺或确认（借钱、签约、答应见面、确认交易）；验证码、身份证号、银行卡、住址等敏感信息一律不透露。',
].join('\n');

/**
 * 身份三要素：**账号名 + 人设名 + 模型名**。
 * 三项缺一不可；账号名与模型名用符号包起来，和真人姓名区分开。
 * @param {{account?:string, persona?:string, model?:string}} v
 */
export function identityLine(v = {}) {
  const account = val(v.account) || '未知账号';
  const persona = val(v.persona) || DEFAULT_PERSONA_NAME;
  const model = val(v.model) || 'unknown-model';
  const deploy = deployKind(v.baseUrl);
  return '【身份要素取值（备用，不要主动说）】' +
    '平时正常聊天，不要主动报身份；只有当对方主动追问「你是谁 / 是不是本人 / 是不是机器人 / 什么 AI / 什么模型 / 本地还是云端」时，才把下面几样一次说全（缺一项都不行）：' +
    `账号名【${account}】 · 人设名 ${persona} · 模型名 <${model}> · 运行方式「${deploy.label}」。` +
    '账号名固定用【】、模型名固定用 <>（这样对方一眼看出是机器身份，不是真人姓名）；句式可以换，但几样都要有。' +
    '运行方式照上面引号里的原话讲，不要自己改口径；若是「运行方式未知」就直说不知道。';
}

/**
 * 身份追问判定（代码级、确定性强）：仅当本轮用户消息明确在问「真实身份」时返回 true。
 * 用于决定 system prompt 是否注入具体账号名 / 模型名——非身份问题一律不注入，
 * 模型拿不到具体值，自然无从泄露（这是「事前 withholding」，不是事后删词）。
 */
const IDENTITY_PROBE_RE = new RegExp([
  // 基本身份
  '你是谁', '你谁呀', '你叫啥', '你叫什么', '你的名字', '你真人', '你是真人',
  '是不是本人', '是你本人', '本人吗', '你是机器人', '是机器人吗', '机器人吧',
  '什么\\s*ai', '哪个\\s*ai', '啥\\s*ai', '什么模型', '哪个模型', '哪家模型',
  '什么大模型', '用的什么模型', '什么引擎', '谁开发', '谁做的', '哪个公司',
  '哪家的', '是\\s*ai\\s*吗', 'ai\\s*助手', '你是什么助手',
  // 部署形态：本地 / 云端 / 离线（「本地」「云端」单用太宽泛，必须与 AI/模型/部署 等词同现，
  // 或出现在「X 还是 Y」的选择句里，避免「本地文件」这类正常聊天被误判成追问身份）
  '本地\\s*(ai|模型|部署|跑|运行|推理|接口|api)',
  '(ai|模型).{0,4}本地',
  '(本地|离线|云端|云上|在线|网上)\\s*(的)?\\s*(ai|模型|部署|推理|api)',
  '(走|用|连|接|调)\\s*(的)?\\s*(api|云端|云|大模型|在线模型|接口)',
  '(本地|离线|云端|云|在线|api)\\s*(还是|或者|or)\\s*(本地|离线|云端|云|在线|api)',
  '是不是本地', '是不是云端', '要联网吗', '断网能跑', '离线能跑', 'api\\s*吗',
].join('|'), 'i');

export function isIdentityProbe(text = '') {
  if (!text || typeof text !== 'string') return false;
  return IDENTITY_PROBE_RE.test(text.replace(/\s+/g, ''));
}

/** 非身份追问轮次：不提供具体账号名 / 模型名，只提醒模型不要编造。 */
const IDENTITY_WITHHELD = [
  '（本轮对方未明确追问你的真实身份，故下面**不提供**具体账号名 / 模型名等取值，不要凭空编造。）',
  '平时正常聊天不要主动报身份；只有当对方明确追问「你是谁 / 是不是本人 / 是不是机器人 / 什么 AI / 什么模型」时，系统会在该轮把身份三要素注入给你，你再如实一次说全。',
].join('\n');

/**
 * 底层人设：无论上层人设（默认 / 用户文件）怎么改，这一段都**始终追加在 system prompt 最底层**。
 *
 * 内容 = 不可覆盖的硬性规则（IDENTITY_RULES）+ 身份段 + 内容审核（CONTENT_REVIEW_RULES）。
 * 身份段默认是「 withholding 提示」（不给具体值）；仅当 revealIdentity=true（本轮确为身份追问）时才换成
 * 真实的三要素取值（identityLine）。单一来源：prompt 拼装和 GUI 预览都用它，避免两处不一致。
 * @param {{account?:string, persona?:string, model?:string}} v
 * @param {{revealIdentity?:boolean}} [opts] revealIdentity=true 时注入具体账号名/模型名
 */
/**
 * 内容审核（AI 侧二次把关，不可覆盖）。
 * 这是「AI 侧审核」而非代码级关键词过滤：模型在生成回复时自行判断并纠正/拒绝，
 * 因此对「错误称呼」「违法请求」这类需要语义理解的内容也能处理，且不会误伤正常聊天。
 * 拼在 system prompt 最底层，任何用户自定义人设都盖不掉。
 */
export const CONTENT_REVIEW_RULES = [
  '【内容审核（AI 侧二次把关，不可覆盖）】',
  '1. 事实纠错：用户表述出现明显的事实性错误（历史、地理、科学等），在回复中礼貌纠正并给出正确说法，不嘲讽、不纠缠。',
  '2. 违法 / 危险 / 有害内容：对制作武器、爆炸物、违禁品、非法组织、侵害他人等请求，明确拒绝协助，不提供任何步骤、方法或指向资源，并可简要说明原因。',
  '3. 信息不确定时，以「不知道 / 无法确认」回应，不编造、不传播未经核实的说法。',
].join('\n');

export function buildBaseline(v = {}, { revealIdentity = false } = {}) {
  const identity = revealIdentity ? identityLine(v) : IDENTITY_WITHHELD;
  return IDENTITY_RULES + '\n\n' + identity + '\n\n' + CONTENT_REVIEW_RULES;
}

/**
 * 把人设里的占位符换成真值：{account} 账号名、{persona} 人设名、{model} 模型名。
 * 用户自己写的人设也能用这三个占位。
 */
export function fillVars(text, vars = {}) {
  const map = {
    account: val(vars.account) || '未知账号',
    persona: val(vars.persona) || DEFAULT_PERSONA_NAME,
    model: val(vars.model) || 'unknown-model',
  };
  return String(text || '').replace(/\{(account|persona|model)\}/g, (m, k) => map[k] || m);
}

/** 人设文件路径围栏：只允许项目根目录（ROOT）内的文件，杜绝穿越。 */
export function resolvePersonaFile(rel, baseDir = ROOT) {
  if (!rel) return null;
  const file = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(baseDir, rel);
  const base = path.resolve(baseDir);
  return file !== base && !file.startsWith(base + path.sep) ? null : file;
}

/**
 * 取全局人设：文件 > 内联文本 > 内置默认。
 * @returns {{text:string, name:string, source:'file'|'inline'|'default', file:string|null, missing:boolean}}
 */
export function loadPersona(cfg, baseDir = ROOT) {
  const ai = cfg && cfg.ai ? cfg.ai : cfg || {};
  if (ai.personaFile) {
    const file = resolvePersonaFile(ai.personaFile, baseDir);
    if (!file) {
      return { text: '', name: personaName(cfg), source: 'file', file: null, missing: true };
    }
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return { text, name: personaName(cfg), source: 'file', file, missing: false };
    } catch {
      /* 读不到就往下走 */
    }
    return { text: '', name: personaName(cfg), source: 'file', file, missing: true };
  }
  if (ai.systemPrompt && String(ai.systemPrompt).trim()) {
    return { text: String(ai.systemPrompt).trim(), name: personaName(cfg), source: 'inline', file: null, missing: false };
  }
  return { text: DEFAULT_PERSONA, name: DEFAULT_PERSONA_NAME, source: 'default', file: null, missing: false };
}
