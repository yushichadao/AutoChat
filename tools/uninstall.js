import { ROOT } from '../src/core/paths.js';
import { uninstall } from '../src/tasks/install.js';

/**
 * 卸载还原的兼容入口。
 *
 * 已并入 `autochat uninstall`（同一份实现），这里只保留一个薄封装，
 * 让旧文档与旧脚本仍然能直接跑这个文件。
 */
const args = process.argv.slice(2);
const r = await uninstall({
  rootDir: ROOT,
  purge: args.includes('--purge'),
  force: args.includes('--force'),
  dryRun: args.includes('--dry-run'),
});
for (const s of r.steps) {
  console.log('  ' + (s.ok ? '[ok]  ' : '[x]   ') + s.name + (s.detail ? ' — ' + s.detail : ''));
}
console.log('');
console.log('  提醒：');
console.log('  · 微信进程里可能还驻留着已注入的 hook DLL，重启微信即可清除');
console.log('  · 恢复更新通道后微信会自动升级到最新版，届时需重新匹配 hook 方案');
console.log('  · 如需保留上下文，删除 data/ 前请自行备份');
