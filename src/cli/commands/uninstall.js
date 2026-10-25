import { ROOT } from '../../core/paths.js';
import { section, line, json, hint } from '../ui.js';
import { uninstall } from '../../tasks/install.js';

/**
 * autochat uninstall —— 卸载还原（停服务 / 去自启 / 删快捷方式 / 还原 DLL / 解除更新阻断）。
 */
export async function run(ctx) {
  const r = await uninstall({
    rootDir: ROOT,
    purge: ctx.flag('purge'),
    force: ctx.flag('force'),
    dryRun: ctx.flag('dry-run'),
  });

  if (ctx.flag('json')) {
    json(r);
    return;
  }
  section(ctx.flag('dry-run') ? '卸载（演练，不改任何文件）' : '卸载');
  for (const s of r.steps) line(s.ok ? 'ok' : 'bad', s.name, s.detail);
  if (!ctx.flag('purge')) hint('配置与上下文仍保留；想彻底清掉加 --purge');
}
