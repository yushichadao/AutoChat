import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
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

  // ④ 匹配 hook DLL：校验「已配置 + 已部署到微信目录 + 版本对得上」
  const dll = await detectBuiltinDll(rootDir);
  const v = (wechat && wechat.version) || (dll && dll.version) || '';
  const installDir = (wechat && wechat.dir) || cfg.wechat.installDir;
  const expected = dll && dll.path;

  // 微信目录里正在用的 version.dll 是不是该版本该用的那份
  let depState = 'none'; // none（未部署） | wrong（版本不对） | right（对得上） | unknown（无法比对）
  let depSize = 0;
  if (installDir) {
    const t = path.join(installDir, 'version.dll');
    if (fs.existsSync(t)) {
      try {
        depSize = fs.statSync(t).size;
        const h = (f) => (f && fs.existsSync(f))
          ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
          : '';
        depState = expected ? (h(t) === h(expected) ? 'right' : 'wrong') : 'wrong';
      } catch {
        depState = 'unknown';
      }
    }
  }

  if (!cfg.wechat.dllPath && expected) {
    steps.push(step('dll', 'warn', '已匹配到内置 DLL（微信 ' + dll.version + '）', '点「自动检测 DLL」写入 WX_DLL_PATH', { kind: 'autodll', label: '自动检测 DLL' }));
  } else if (cfg.wechat.dllPath) {
    if (depState === 'wrong') {
      steps.push(step('dll', 'bad', '微信目录里的 DLL 与微信 ' + v + ' 不匹配（' + (depSize / 1048576).toFixed(1) + ' MB）', '点「改用匹配的 DLL」会自动替换并部署', { kind: 'fix-dll', label: '改用匹配的 DLL' }));
    } else if (depState === 'right') {
      steps.push(step('dll', 'ok', '已部署匹配微信 ' + v + ' 的 DLL', '启动助手后会注入 / 加载'));
    } else {
      // none / unknown：还没写进微信目录，或无法比对
      steps.push(step('dll', 'warn', '已配置 ' + cfg.wechat.dllPath, '还没写进微信目录，点「写入微信目录」', { kind: 'deploy-dll', label: '写入微信目录' }));
    }
  } else {
    steps.push(step('dll', 'bad', '没找到匹配微信版本的 DLL', '准备一个与微信版本匹配的 hook DLL 后填到 WX_DLL_PATH'));
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
