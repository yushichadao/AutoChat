import { section, line, json, hint, next } from '../ui.js';
import { lockWeChatUpdate, isVersionLocked } from '../../tasks/lock.js';

/**
 * autochat lock —— 锁定微信版本（阻断自动更新）。
 *
 * 为什么必须做：微信一更新就会删掉整个旧版本目录，hook DLL 随之静默失效，
 * 表现为「昨天还好好的，今天突然不理人了」。
 */
export async function run(ctx) {
  if (ctx.flag('status')) {
    const locked = await isVersionLocked();
    if (ctx.flag('json')) {
      json({ locked });
      return;
    }
    section('微信版本锁定状态');
    line(locked ? 'ok' : 'warn', locked ? '已锁定' : '未锁定',
      locked ? '微信无法自动更新（也意味着错过安全补丁）' : '微信可能随时自动更新并让 hook DLL 失效');
    if (!locked) next('锁定：autochat lock');
    return;
  }

  const r = await lockWeChatUpdate();
  if (ctx.flag('json')) {
    json(r);
    return;
  }
  section('锁定微信版本');
  line(r.ok ? 'ok' : 'bad', r.ok ? '已锁定' : '锁定失败', r.detail);
  if (r.ok) hint('想恢复自动更新：autochat uninstall（会解除阻断）');
}
