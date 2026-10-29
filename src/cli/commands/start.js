import { ROOT } from '../../core/paths.js';
import { section, line, ok, json, hint, next } from '../ui.js';
import { startBackground, serviceStatus } from '../../tasks/service.js';
import { elevateSelf } from '../../core/win.js';

/**
 * autochat start —— 启动助手服务。
 *
 * 三种形态：
 *   默认（前台）    在当前终端里跑，日志直接打在终端
 *   --background   后台跑（脱离终端），日志写到 data/autochat.out
 *   --elevate      先弹 UAC 提权再启动（注入 hook DLL 需要管理员）
 */
export async function run(ctx) {
  if (ctx.flag('elevate')) {
    const r = await elevateSelf(['src/cli/index.js', 'start']);
    line(r.ok ? 'ok' : 'bad', '提权', r.message);
    return;
  }

  if (ctx.flag('background')) {
    section('后台启动助手服务');
    const st = await serviceStatus(ROOT);
    if (st.running) {
      line('warn', '已经在运行', 'pid ' + st.pid);
      next('要先重启请先 autochat stop');
      return;
    }
    const r = await startBackground(ROOT);
    line(r.ok ? 'ok' : 'bad', r.ok ? '已后台启动' : '启动失败', r.message);
    if (r.ok) hint('日志：autochat logs（data/autochat.out）');
    else process.exitCode = 1; // 启动失败给非零退出码，便于脚本判断（I11）
    return;
  }

  if (ctx.flag('json')) {
    const st = await serviceStatus(ROOT);
    json(st);
    return;
  }

  section('启动助手服务');
  ok('正在前台运行（按 Ctrl+C 停止）');
  await import('../../index.js');
}
