/**
 * ReAct 式工具调用循环（§16.4）。
 *
 * 把「调模型 → 解析 tool_calls → 执行 → 回填 → 再调用」封装成独立函数，
 * 由 replier 在 AI_TOOLS 开启时调用。白名单 + 最大轮次 + 日志均在 replier 层决定后传入。
 *
 * @param {object} args
 * @param {Array} args.messages 初始消息
 * @param {object} args.ai AIClient（chat 需支持 tools，返回 {text, toolCalls}）
 * @param {string[]} args.allowedTools 白名单（技能名）
 * @param {number} [args.maxRounds] 最大轮次（默认 3）
 * @param {object} [args.toolCtx] 传给技能执行的上下文（如 { webSearchConfig }）
 * @param {Function} [args.log]
 * @returns {Promise<{text:string, rounds:number, calls:Array, truncated?:boolean}>}
 */
import { listToolDefs, callTool } from './registry.js';

export async function runToolLoop({ messages, ai, allowedTools = [], maxRounds = 3, toolCtx = {}, log } = {}) {
  if (!Array.isArray(allowedTools) || !allowedTools.length) {
    const r = await ai.chat(messages, {});
    return { text: r.text || '', rounds: 1, calls: [] };
  }
  const tools = listToolDefs(allowedTools);
  const conv = messages.slice();
  const calls = [];
  const fileMarkers = [];
  // write_doc 等「生成文件」类工具会把文件路径以 [[file:...]] 标记返回；
  // 我们不依赖模型自行回显该标记（不可靠），而是把生成的文件标记自动补进最终回复，
  // 由 responder 解析后作为原生文件消息发出（§16.4）。
  const withFileMarkers = (text) => {
    let t = String(text || '');
    for (const mk of fileMarkers) {
      if (mk && !t.includes(mk)) t = `${t}\n${mk}`.trim();
    }
    return t;
  };
  let round = 0;
  while (round < maxRounds) {
    round += 1;
    const r = await ai.chat(conv, { tools, toolChoice: 'auto' });
    const tcs = (r.toolCalls || []).filter(Boolean);
    if (!tcs.length) return { text: withFileMarkers(r.text || ''), rounds: round, calls };
    // 把助手这条（含 tool_calls）原样回上下文，API 才接受随后的 tool 结果
    conv.push({ role: 'assistant', content: r.text || '', tool_calls: tcs });
    // 并行执行本轮全部工具调用：它们互相独立，串行只是白等（真降延迟，不是骗感知）。
    // 结果按原顺序回填，保证「谁问谁答」对得上、上下文顺序稳定。
    const done = await Promise.all(tcs.map(async (tc) => {
      const name = tc.function && tc.function.name;
      if (!allowedTools.includes(name)) {
        return { name, tc, result: { error: `工具 ${name} 不在白名单` } };
      }
      let a = {};
      try {
        a = JSON.parse(tc.function && tc.function.arguments ? tc.function.arguments : '{}');
      } catch {
        a = {};
      }
      return { name, tc, result: await callTool(name, a, toolCtx) };
    }));
    for (const { name, tc, result } of done) {
      calls.push({ name, args: tc.function && tc.function.arguments, result });
      if (log && log.info) log.info(`工具调用 ${name} → ${truncate(JSON.stringify(result), 140)}`);
      if (result && result.marker) fileMarkers.push(result.marker);
      conv.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  // 超过最大轮次：再调一次（不带 tools）逼出最终文本
  const final = await ai.chat(conv, {});
  return { text: withFileMarkers(final.text || ''), rounds: maxRounds, calls, truncated: true };
}

function truncate(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}
