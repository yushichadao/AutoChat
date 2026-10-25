#!/usr/bin/env node
import process from 'node:process';
import { EXIT, fail, paint, setColor, section, line } from './ui.js';

/**
 * 命令行入口（CLI）。
 *
 * 职责边界：**只做参数解析、命令分发与退出码**；
 * 具体逻辑在 src/tasks/，界面输出在 src/cli/ui.js，一个命令一个文件。
 */

const argv = process.argv.slice(2);
const cmd = (argv[0] || '').toLowerCase();
const rest = argv.slice(1);

/** 传给各命令的上下文。 */
const ctx = {
  args: rest,
  flag: (name) => rest.includes('--' + name),
  opt: (name, def = '') => {
    const i = rest.indexOf('--' + name);
    if (i < 0) return def;
    const v = rest[i + 1];
    if (!v || v.startsWith('--')) return def;
    return v;
  },
  positional: rest.filter((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = rest[i - 1] || '';
    return !prev.startsWith('--');
  }),
};

const COMMANDS = [
  'status', 'doctor', 'setup', 'install', 'uninstall', 'start', 'stop', 'pause', 'resume',
  'logs', 'context', 'chats', 'config', 'lock', 'autodll', 'self', 'model', 'version', 'gui',
];

function printHelp() {
  section('AutoChat —— 微信侧本地 AI 助手');
  console.log(paint('bold', '第一次用'));
  console.log('  autochat setup            初始化向导：检测 → 锁版本 → 选 DLL → 配模型 → 小号 → 启动');
  console.log('  autochat doctor           环境体检：问题清单 + 修复顺序');
  console.log('  autochat gui              图形化配置器（与命令行等价的另一套入口）');
  console.log('');
  console.log(paint('bold', '运行'));
  console.log('  autochat start            启动助手服务（--background 后台跑，--elevate 提权启动）');
  console.log('  autochat stop             停止助手服务');
  console.log('  autochat status           当前状态快照');
  console.log('  autochat logs             看服务日志尾部（--lines N，--err 看错误）');
  console.log('');
  console.log(paint('bold', '自动回复'));
  console.log('  autochat pause [原因]     暂停自动回复（立刻生效，仍接收消息）');
  console.log('  autochat resume           恢复自动回复');
  console.log('');
  console.log(paint('bold', '模型'));
  console.log('  autochat model test       测试当前模型配置能不能用');
  console.log('  autochat model list       列出服务端有哪些模型');
  console.log('  autochat model service    本地模型服务：status / start / stop');
  console.log('');
  console.log(paint('bold', '管理'));
  console.log('  autochat chats list|add|rm|enable|disable <会话id>');
  console.log('  autochat context [会话id] [--clear]            查看 / 清空上下文记忆');
  console.log('  autochat config get|set                      读 / 写 .env');
  console.log('  autochat lock [--status]                     锁定微信版本（阻断自动更新）');
  console.log('  autochat autodll [--write]                   按微信版本自动匹配 hook DLL');
  console.log('  autochat install [--autostart] [--shortcut] [--deploy-dll] [--lock] [--service]');
  console.log('  autochat uninstall [--purge] [--force] [--dry-run]');
  console.log('  autochat version                            版本与运行环境');
  console.log('');
  console.log(paint('dim', '  多数命令支持 --json 输出（便于脚本处理）'));
}

async function runCommand(name) {
  const mod = await import('./commands/' + name + '.js');
  await mod.run(ctx);
}

async function main() {
  if (ctx.flag('no-color')) setColor(false);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    await runCommand('version');
    return;
  }
  if (!COMMANDS.includes(cmd)) {
    if (cmd === 'tui') {
      fail('autochat tui 已并入 autochat setup，请改用 autochat setup');
      return;
    }
    fail('未知命令：' + cmd + '（autochat help 看全部命令）');
    return;
  }
  await runCommand(cmd);
}

main().catch((err) => {
  console.error(paint('red', '执行失败：') + (err && err.stack ? err.stack : err));
  process.exitCode = EXIT.error;
});
