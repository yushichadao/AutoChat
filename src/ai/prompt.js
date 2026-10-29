/**
 * Prompt 组装。
 *
 * 关键点：把「在跟谁聊、在哪个群」告诉模型。
 * 只说「这是群聊」而不给群名，模型就只能说套话，一眼假。
 */
import { DEFAULT_PERSONA, buildBaseline, isIdentityProbe, fillVars } from './persona.js';

export { DEFAULT_PERSONA, buildBaseline };

/**
 * 组装 system prompt。
 *
 * 人设（persona）负责「怎么说话」，身份底线（IDENTITY_RULES）负责「不许装真人、不许冒充」——
 * 后者每次都追加在最后，用户自定义人设盖不掉。
 *
 * 身份三要素 = 账号名【x】+ 人设名 + 模型名 <y>：
 * {account} / {persona} / {model} 三个占位在这里换成真值。
 *
 * @param {{persona:string, msg:object, cfg:object, memorySummary?:object, userText?:string}} args
 *   userText：本轮用户原文，用于判定是否确为身份追问（是才把具体账号名/模型名注入 prompt）。
 */
export function buildSystemPrompt({ persona, msg, cfg = {}, memorySummary = null, userText = '' }) {
  const vars = {
    account: cfg.account,
    persona: cfg.personaName,
    model: cfg.model,
    // 本轮实际用的接口地址（含按会话覆盖）：用来判定「本地部署还是云端 API」，
    // 只在该轮确为身份追问时才随身份要素一起注入，平时 withholding。
    baseUrl: cfg.baseUrl,
  };
  const parts = [fillVars(persona || DEFAULT_PERSONA, vars)];

  if (msg.chatType === 'group') {
    const group = msg.chatName ? `「${msg.chatName}」` : '一个群聊';
    const who = msg.senderName || msg.senderId || '群友';
    parts.push(`你现在在微信群${group}里，跟你说话的是「${who}」。`);
    if (cfg.groupReply === 'mention') {
      parts.push('群里可能有人不是在跟你说话，不确定对方是不是在问你时，别抢着回答。');
    }
  } else {
    const who = msg.chatName || msg.senderName || msg.senderId || '对方';
    parts.push(`你现在在微信上和「${who}」私聊。`);
  }

  // 长期记忆摘要（MS5）：把持久的结构化概括回注系统提示，跨会话保持一致性。
  // 只挑有内容的字段注入，空摘要不占用 token。
  if (memorySummary && (memorySummary.facts?.length || memorySummary.preferences?.length || memorySummary.events?.length)) {
    const lines = [];
    if (memorySummary.facts?.length) lines.push('· 事实/约定：' + memorySummary.facts.slice(-12).join('；'));
    if (memorySummary.preferences?.length) lines.push('· 偏好：' + memorySummary.preferences.slice(-12).join('；'));
    if (memorySummary.events?.length) lines.push('· 事件：' + memorySummary.events.slice(-12).join('；'));
    parts.push('【你之前的记忆（长期，跨会话有效）】\n' + lines.join('\n'));
  }

  // 底层人设放最后：无论上层人设（默认 / 用户文件）怎么改，这一段都始终追加、盖不掉。
  // 身份三要素（账号名/模型名）仅在「本轮确为身份追问」时注入——否则 withholding，
  // 让模型根本拿不到具体值，杜绝非身份问题（如「看看你身体」）借机泄露。
  parts.push(buildBaseline(vars, { revealIdentity: isIdentityProbe(userText) }));

  return parts.join('\n\n');
}

/**
 * 组装完整 messages 数组：system + 历史 + 本轮用户输入。
 * @param {object} args
 * @param {string|Array} [args.userContent] 本轮用户输入内容。
 *   传数组 => 多模态（文本 + image_url 内容块，见 §3.1 图→文）；
 *   传字符串或省略 => 纯文本（userText）。
 * @param {object} [args.memorySummary] 长期记忆摘要（MS5），回注系统提示。
 */
export function buildMessages({ persona, msg, history = [], cfg = {}, userText = '', userContent, memorySummary = null }) {
  const system = buildSystemPrompt({ persona, msg, cfg, memorySummary, userText });
  const userMsg = userContent !== undefined ? userContent : userText;
  return [{ role: 'system', content: system }, ...history, { role: 'user', content: userMsg }];
}
