import { ROOT } from '../../core/paths.js';
import { section, line, json, hint, next } from '../ui.js';
import { install, uninstall } from '../../tasks/install.js';

/**
 * autochat install —— 一键安装（写配置 / 开机自启 / 快捷方式 / 部署 DLL / 锁定版本）。
 */
export async function run(ctx) {
  const env = {};
  for (const pair of ctx.positional) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  const r = await install({
    rootDir: ROOT,
    env,
    autostart: ctx.flag('autostart'),
    shortcut: ctx.flag('shortcut'),
    deployDll: ctx.flag('deploy-dll'),
    lock: ctx.flag('lock'),
    service: ctx.flag('service'),
  });

  if (ctx.flag('json')) {
    json(r);
    return;
  }
  section('安装');
  for (const s of r.steps) line(s.ok ? 'ok' : 'bad', s.name, s.detail);
  line(r.ok ? 'ok' : 'warn', r.ok ? '安装完成' : '安装完成，但有步骤没成功');
  if (!r.ok) next('看上面标红的步骤，按提示处理后重跑');
}
