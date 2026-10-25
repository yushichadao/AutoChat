import { ROOT } from '../src/core/paths.js';
import { diagnose } from '../src/tasks/doctor.js';

/**
 * 环境体检的兼容入口。
 *
 * 已并入 `autochat doctor`（输出完全一致），这里只保留一个薄封装，
 * 让旧文档与旧脚本仍然能直接跑这个文件。
 */
const result = await diagnose({ rootDir: ROOT });
for (const it of result.items) {
  const icon = it.level === 'ok' ? '[ok]  ' : it.level === 'warn' ? '[!!]  ' : '[x]   ';
  console.log('  ' + icon + it.name + (it.detail ? ' — ' + it.detail : ''));
  if (it.next) console.log('         → 下一步：' + it.next);
}
const bad = (result.items || []).filter((i) => i.level === 'bad').length;
console.log('');
console.log(bad ? '  有 ' + bad + ' 项阻断问题需要先解决（autochat doctor 看完整清单）' : '  没有阻断问题');
process.exit(bad ? 2 : 0);
