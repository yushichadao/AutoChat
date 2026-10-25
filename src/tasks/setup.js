import process from 'node:process';
import { ROOT } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { detectWeChat } from '../bridge/process.js';
import { detectBuiltinDll } from './autodll.js';
import { isVersionLocked } from './lock.js';
import { serviceStatus } from './service.js';

/**
 * 初始化向导状态机（任务层）。
 *
 * 职责边界：**只回答「每一步现在是什么状态、缺什么、下一步做什么」**，
 * 不负责提问，也不负责渲染。
 *
 * CLI 把它渲染成终端问答，图形化配置器把它渲染成步骤条 —— 两端共用同一份判断，
 * 不会出现「命令行能配的，界面上没有」。
 */

export const STEP_IDS = ['node', 'wechat', 'lock', 'dll', 'model', 'self', 'start'];

/** 每一步的标题（界面与终端共用一份措辞）。 */
export const STEP_TITLES = {
  node: 'Node 运行环境',
  wechat: '微信客户端',
  lock: '锁定微信版本',
  dll: '匹配 hook DLL',
  model: '接一个模型',
  self: '小号 / 同号',
  start: '启动助手服务',
};

function step(id, level, detail, next, action) {
  const s = { id, title: STEP_TITLES[id] || id, level, detail, next: next || '' };
  if (action) s.action = action;
  return s;
}

/**
 * 评估每一步的状态。
 * @returns {Promise<Array<{id:string,title:string,level:string,detail:string,next:string,action?:object}>>}
 */
export async function evaluateSteps({ rootDir = ROOT } = {}) {
  const cfg = loadConfig({ rootDir });
  const steps = [];

  // ① Node 运行环境
  const major = Number(process.versions.node.split('.')[0]) || 0;
  steps.push(
    major >= 18
      ? step('node', 'ok', process.version + '（够用）', '')
      : step('node', 'bad', '当前 ' + process.version + '，需要 18 以上', '去 nodejs.org 装 LTS 版 Node')
  );

  // ② 微信客户端
  const wechat = await detectWeChat(cfg.wechat.installDir).catch(() => null);
  if (!wechat || !wechat.dir) {
    steps.push(step('wechat', 'bad', '没有找到微信客户端', '安装 Windows 版微信，并登录要跑回复的那个号'));
  } else {
    steps.push(step('wechat', 'ok', wechat.dir + (wechat.version ? '（' + wechat.version + '）' : ''), ''));
  }

  // ③ 锁定微信版本
  const locked = await isVersionLocked();
  steps.push(
    locked
      ? step('lock', 'ok', '已锁定，微信不会自动升级', '')
      : step('lock', 'warn', '微信还能自动更新 —— 一升级 hook DLL 就失效', '锁定微信版本', { kind: 'lock', label: '锁定版本' })
  );

  // ④ 匹配 hook DLL
  const dll = await detectBuiltinDll(rootDir);
  if (cfg.wechat.dllPath) {
    steps.push(step('dll', 'ok', '已配置 ' + cfg.wechat.dllPath, ''));
  } else if (dll.path) {
    steps.push(step('dll', 'warn', '已匹配到内置 DLL（微信 ' + dll.version + '）', '写入 WX_DLL_PATH', { kind: 'autodll', label: '自动检测 DLL' }));
  } else {
    steps.push(step('dll', 'bad', '没找到匹配内置方案的 DLL', '准备一个与微信版本匹配的 hook DLL'));
  }

  // ⑤ 接一个模型
  if (cfg.ai.baseUrl && cfg.ai.model) {
    steps.push(step('model', 'ok', cfg.ai.model + ' @ ' + cfg.ai.baseUrl, ''));
  } else {
    steps.push(step('model', 'bad', '还没配置模型', '跑初始化向导选一个（本地 Ollama 或云端 API）', { kind: 'model', label: '配置模型' }));
  }

  // ⑥ 小号 / 同号
  const mode = cfg.wechat.selfMode;
  steps.push(
    mode === 'id'
      ? step('self', 'ok', '同号模式（按已发消息 id 过滤）', '')
      : step('self', 'ok', '小号模式（按 wxid 过滤，最稳）', '')
  );

  // ⑦ 启动助手服务
  const svc = await serviceStatus(rootDir);
  steps.push(
    svc.running
      ? step('start', 'ok', '服务运行中（pid ' + svc.pid + '）', '')
      : step('start', 'warn', '服务没在跑', '启动助手服务', { kind: 'start', label: '启动服务' })
  );

  return steps;
}

/** 汇总：还差几步。 */
export function summarize(steps) {
  const bad = steps.filter((s) => s.level === 'bad');
  const warn = steps.filter((s) => s.level === 'warn');
  const todo = steps.filter((s) => s.level === 'todo');
  return {
    total: steps.length,
    done: steps.length - bad.length - warn.length - todo.length,
    bad: bad.length,
    warn: warn.length,
    todo: todo.length,
    ready: bad.length === 0,
  };
}
