import { ROOT } from '../../core/paths.js';
import { section, line, json, hint } from '../ui.js';
import { listChats, saveChats, setChatEnabled, removeChat, upsertChat } from '../../tasks/chats.js';
import { checkChatAvailability } from '../../tasks/doctor.js';

/**
 * autochat chats —— 按会话配置（群 / 好友级差异）。
 * 子命令：list（默认） / add / rm / enable / disable / set / check
 */
export async function run(ctx) {
  const sub = (ctx.positional[0] || 'list').toLowerCase();
  const id = ctx.positional[1];
  const chats = listChats(ROOT);

  if (sub === 'check') {
    const result = await checkChatAvailability({ rootDir: ROOT });
    const items = result.items || [];
    if (ctx.flag('json')) {
      json({ ok: result.ok, items });
      if (!result.ok) process.exitCode = 2;
      return;
    }
    section('群可用性（哪些群在听）');
    for (const it of items) {
      line(it.level, it.name, it.detail);
      if (it.next) hint(it.next);
    }
    const bad = items.filter((i) => i.level === 'bad');
    section('小结');
    line(bad.length ? 'bad' : 'ok', '可用性阻断项', bad.length ? bad.length + ' 项需要先解决' : '没有');
    if (!bad.length) line('ok', '下一步', '可用 `autochat doctor` 看整体环境体检');
    if (bad.length) process.exitCode = 2;
    return;
  }

  if (sub === 'list') {
    if (ctx.flag('json')) {
      json(chats);
      return;
    }
    section('按会话配置（' + Object.keys(chats).length + '）');
    const keys = Object.keys(chats);
    if (!keys.length) {
      line('warn', '(空)', '还没有为任何群或好友单独配置');
      hint('添加：autochat chats add <会话id>');
      return;
    }
    for (const k of keys) {
      const c = chats[k] || {};
      const bits = [];
      bits.push(c.enabled === false ? '已停用' : '参与回复');
      if (c.groupReply) bits.push('群策略 ' + c.groupReply);
      if (c.personaFile) bits.push('人设 ' + c.personaFile);
      if (c.model) bits.push('单独模型 ' + c.model);
      if (c.reasoningEffort) bits.push('思考强度 ' + c.reasoningEffort);
      if (c.replyMode) bits.push('回复模式 ' + c.replyMode);
      // 与 GUI 会话卡的「覆盖 N 项」标签对齐：灰度开关必须可见，否则 CLI 侧无从核对
      if (c.webSearch !== undefined && c.webSearch !== '') bits.push('联网搜索 ' + (c.webSearch === true || c.webSearch === '1' ? '开' : '关'));
      if (c.aiTools !== undefined && c.aiTools !== '') bits.push('AI工具 ' + (c.aiTools === true || c.aiTools === '1' ? '开' : '关'));
      if (c.modelRouting !== undefined && c.modelRouting !== '') bits.push('双模型路由 ' + (c.modelRouting === true || c.modelRouting === '1' ? '开' : '关'));
      if (c.longTaskNotice !== undefined && c.longTaskNotice !== '') bits.push('长任务提示 ' + (c.longTaskNotice === true || c.longTaskNotice === '1' ? '开' : '关'));
      if (c.docAnalysis !== undefined && c.docAnalysis !== '') bits.push('文档解读 ' + (c.docAnalysis === true || c.docAnalysis === '1' ? '开' : '关'));
      if (c.lightModel) bits.push('轻量模型 ' + c.lightModel);
      line(c.enabled === false ? 'warn' : 'ok', k, bits.join('｜'));
    }
    return;
  }

  if (!id) {
    line('bad', '缺少会话 id', '用法：autochat chats ' + sub + ' <会话id>');
    return;
  }

  if (sub === 'add') {
    upsertChat(id, { enabled: true }, ROOT);
    line('ok', '已加入', id);
  } else if (sub === 'rm') {
    removeChat(id, ROOT);
    line('ok', '已移除', id);
  } else if (sub === 'enable' || sub === 'disable') {
    setChatEnabled(id, sub === 'enable', ROOT);
    line('ok', sub === 'enable' ? '已启用' : '已停用', id);
  } else if (sub === 'set') {
    const patch = {};
    for (const pair of ctx.positional.slice(2)) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      patch[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    upsertChat(id, patch, ROOT);
    line('ok', '已更新', id + ' ' + JSON.stringify(patch));
  } else {
    line('bad', '未知子命令', sub);
    return;
  }
  hint('记得把同一个会话 id 加进 .env 的 WX_POLL_CHATS，否则收不到它的消息');
}
