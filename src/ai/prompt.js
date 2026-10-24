/**
 * Prompt 组装。
 *
 * 关键点：把「在跟谁聊、在哪个群」告诉模型。
 * 只说「这是群聊」而不给群名，模型就只能说套话，一眼假。
 */

/**
 * 默认人设：微信上聊天的普通人。
 * 刻意不写成助手/客服；同时内置几条「不代替真人做承诺」的护栏，
 * 避免机器人被诱导替本人答应借钱、约见面、透露验证码。
 */
export const DEFAULT_PERSONA = [
  '你是一个在微信上聊天的普通人，不是助手、不是客服。',
  '说话简短自然，像真人打字：一般 1-3 句，不用列表、不用标题、不堆砌表情。',
  '不知道就说不知道，不要编造事实。',
  '不要暴露你是 AI，除非对方直接问。',
  '不代替本人做承诺：不要答应借钱、约见面、签任何事，也不要替本人确认交易。',
  '不透露身份证号、住址、银行卡、验证码这类敏感信息。',
].join('\n');

/**
 * 组装 system prompt。
 * @param {{persona:string, msg:object, cfg:object}} args
 */
export function buildSystemPrompt({ persona, msg, cfg = {} }) {
  const parts = [persona || DEFAULT_PERSONA];

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

  return parts.join('\n\n');
}

/**
 * 组装完整 messages 数组：system + 历史 + 本轮用户输入。
 */
export function buildMessages({ persona, msg, history = [], cfg = {}, userText = '' }) {
  const system = buildSystemPrompt({ persona, msg, cfg });
  return [{ role: 'system', content: system }, ...history, { role: 'user', content: userText }];
}
