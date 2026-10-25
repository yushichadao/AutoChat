import { ROOT } from '../../core/paths.js';
import { section, line, json, hint } from '../ui.js';
import { readEditableEnv, writeEditableEnv } from '../../tasks/config.js';

/**
 * autochat config —— 读 / 写 .env。
 * 只允许改白名单里的键（与图形化配置器同一份白名单）。
 */
export async function run(ctx) {
  const sub = (ctx.positional[0] || 'get').toLowerCase();
  const env = readEditableEnv(ROOT);

  if (sub === 'get') {
    const key = ctx.positional[1];
    if (!key) {
      if (ctx.flag('json')) {
        json(env);
        return;
      }
      section('.env');
      for (const k of Object.keys(env)) {
        console.log('  ' + k + '=' + env[k]);
      }
      return;
    }
    if (ctx.flag('json')) {
      json({ [key]: env[key] });
      return;
    }
    console.log(env[key] == null ? '' : String(env[key]));
    return;
  }

  if (sub === 'set') {
    const updates = {};
    for (const pair of ctx.positional.slice(1)) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      updates[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    if (!Object.keys(updates).length) {
      line('bad', '没有要改的内容', '用法：autochat config set KEY=VALUE');
      return;
    }
    const r = writeEditableEnv(updates, ROOT);
    line('ok', '已更新', r.changed.join('、'));
    hint('配置类改动要重启助手服务才生效（自动回复开关也如此）');
    return;
  }

  line('bad', '未知子命令', sub);
}
