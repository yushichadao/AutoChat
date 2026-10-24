/**
 * 环境诊断：把网关跑起来之前最容易卡住的几件事一次查完。
 *   node tools/check-env.js
 */
import fs from 'node:fs';
import process from 'node:process';
import { loadConfig } from '../src/config.js';
import { detectWeChat, listWeChatProcesses, isPortOpen } from '../src/bridge/process.js';
import { isElevated } from '../src/bridge/injector.js';
import { describeSupport, PROFILES } from '../src/bridge/profiles.js';
import { probeHook } from '../src/bridge/probe.js';

const ok = (m) => console.log(`  [ok]   ${m}`);
const warn = (m) => console.log(`  [!!]   ${m}`);
const bad = (m) => console.log(`  [x]    ${m}`);

const cfg = loadConfig();

console.log('\n== 0. 身份与安全 ==');
if (cfg.wechat.selfId) {
  ok(`本机微信 wxid 已配置：${cfg.wechat.selfId}`);
} else {
  warn(
    '未配置 WX_SELF_ID：数据库轮询会把机器人自己发出的消息当成别人的提问，造成自问自答、刷屏与额度浪费。' +
      '请填上你本机微信的 wxid，或改用 webhook 接收'
  );
}
if (['127.0.0.1', 'localhost', '::1'].includes(cfg.wechat.webhookBind)) {
  ok(`webhook 只监听回环 ${cfg.wechat.webhookBind}:${cfg.wechat.webhookPort}`);
} else if (cfg.wechat.webhookToken) {
  ok(`webhook 监听 ${cfg.wechat.webhookBind}:${cfg.wechat.webhookPort}（已启用 token 鉴权）`);
} else {
  bad(`webhook 监听 ${cfg.wechat.webhookBind} 且没有 token，局域网任意设备都能伪造消息触发 AI 回复`);
}

console.log('\n== 1. 微信客户端 ==');
const install = await detectWeChat(cfg.wechat.installDir);
if (!install) {
  bad('未找到微信安装目录，设置 WX_INSTALL_DIR 指向包含 Weixin.exe 的目录');
} else {
  ok(`安装目录 ${install.dir}`);
  ok(`版本 ${install.version || '未知'}`);

  const support = describeSupport(install.version);
  if (support.ok && !support.warn) ok(support.text);
  else if (support.ok) warn(support.text);
  else bad(support.text);

  if (support.profile) {
    const p = support.profile;
    console.log(`         来源 ${p.url}`);
    console.log(`         能力 发送=${p.send ? '是' : '否'} 接收=${p.recv ? '是' : '否'} 许可=${p.license}`);
    if (p.note) console.log(`         备注 ${p.note}`);
  } else {
    console.log(`         已知方案：${PROFILES.map((p) => p.wechat).join(' / ')}`);
  }
}

console.log('\n== 2. 微信进程 ==');
const procs = await listWeChatProcesses(cfg.wechat.processName);
if (!procs.length) warn(`没有运行中的 ${cfg.wechat.processName}，注入前需要先登录微信`);
else for (const p of procs) ok(`PID ${p.pid} → ${p.exe}`);

console.log('\n== 3. hook DLL ==');
if (!cfg.wechat.dllPath) {
  bad('未配置 WX_DLL_PATH');
} else if (!fs.existsSync(cfg.wechat.dllPath)) {
  bad(`文件不存在: ${cfg.wechat.dllPath}`);
} else {
  const size = fs.statSync(cfg.wechat.dllPath).size;
  ok(`${cfg.wechat.dllPath} (${Math.round(size / 1024)} KB)`);
  if (/version\.dll$/i.test(cfg.wechat.dllPath)) {
    ok('文件名是 version.dll，适合代理模式');
  } else {
    warn('文件名不是 version.dll，代理模式会自动复制成 version.dll；inject 模式保持原名');
  }

  // 微信自动更新会把旧版本目录整个删掉，DLL 随之静默失效（实测 11 分钟就被升回去了）
  const upDir = `${process.env.APPDATA || ''}\\Tencent\\xwechat\\update`;
  try {
    if (fs.existsSync(upDir)) {
      const st = fs.statSync(upDir);
      if (st.isDirectory()) {
        warn('微信更新通道仍开启（update 是目录），随时可能自动升级并删掉当前版本目录');
      } else {
        ok('微信更新通道已阻断（update 是只读文件）');
      }
    } else {
      warn('找不到 update 路径，无法判断自动更新是否被关闭');
    }
  } catch {
    /* 忽略 */
  }
}

console.log('\n== 4. 权限 ==');
if (await isElevated()) ok('当前是管理员', '注入需要管理员权限');
else warn('当前不是管理员，CreateRemoteThread 注入很可能失败（代理模式不受影响）');

console.log('\n== 5. hook 服务与能力 ==');
if (await isPortOpen(cfg.wechat.host, cfg.wechat.port)) {
  ok(`${cfg.wechat.host}:${cfg.wechat.port} 已在监听`);
  const probe = await probeHook(cfg.wechat.host, cfg.wechat.port);
  if (!probe.reachable) {
    bad('端口能连但所有接口都不可用，DLL 版本与本机微信大概率不匹配');
  } else {
    ok(`可用接口 ${Object.keys(probe.capabilities).join(', ')}`);
    if (probe.canSend === false) bad('缺少发送接口，无法回消息');
    else if (probe.canSend === undefined) console.log('         （发送类接口默认不探，避免误发；首次发送时才会验证）');
    if (!probe.canReceivePush && !probe.canQueryDb) bad('既没有回调也没有查库接口，收不到消息');
    else if (!probe.canReceivePush) warn('没有回调接口，接收只能靠轮询（需要 WX_POLL_SQL）');
    else if (!probe.canQueryDb) warn('没有查库接口，接收只能靠 DLL 回调');
  }
} else {
  warn(`${cfg.wechat.host}:${cfg.wechat.port} 未监听（还没注入，或 DLL 没起服务）`);
}

console.log('\n== 6. 按会话配置 ==');
const chatIds = Object.keys(cfg.chats || {});
if (!chatIds.length) {
  console.log('         （没有配置 config.json 的 chats，所有会话共用全局设置）');
} else {
  for (const id of chatIds) {
    const c = cfg.chats[id] || {};
    const bits = [];
    if (c.enabled === false) bits.push('已停用');
    if (c.groupReply) bits.push(`群策略 ${c.groupReply}`);
    if (c.triggerPrefix !== undefined) bits.push(`前缀 "${c.triggerPrefix}"`);
    if (c.personaFile) bits.push(`人设 ${c.personaFile}`);
    if (c.systemPrompt) bits.push('内联人设');
    ok(`${id}: ${bits.length ? bits.join('｜') : '沿用全局设置'}`);
  }
}

console.log('\n== 7. AI 自动回复 ==');
if (!cfg.ai.enabled) {
  warn('AI 未启用（AI_ENABLED=0）');
} else {
  ok(`模型 ${cfg.ai.model}`);
  ok(`地址 ${cfg.ai.baseUrl || '(未配置)'}`);
  if (cfg.ai.triggerPrefix) ok(`触发前缀 "${cfg.ai.triggerPrefix}"`);
  if (cfg.ai.groupAtNames?.length) {
    ok(`群里被 @ 时认可的称呼：${cfg.ai.groupAtNames.join(' / ')}`);
  } else {
    warn(
      '未配置 AI_GROUP_AT_NAMES：群里出现任意 @ 都会触发，容易被误触发或被刷额度。' +
        '建议填上你的称呼，如 AI_GROUP_AT_NAMES=小助手'
    );
  }
  console.log(
    `         群聊策略 ${cfg.ai.groupReply}｜冷却 ${cfg.ai.cooldownMs}ms｜每小时上限 ${cfg.ai.maxPerHour || '不限'}｜并发 ${cfg.ai.maxConcurrent}`
  );

  if (cfg.ai.baseUrl) {
    const { AIClient } = await import('../src/ai/client.js');
    try {
      const ai = new AIClient({
        baseUrl: cfg.ai.baseUrl,
        apiKey: cfg.ai.apiKey,
        model: cfg.ai.model,
        timeoutMs: 15000,
      });
      const t0 = Date.now();
      const res = await ai.chat([{ role: 'user', content: '只回复两个字：正常' }], { maxTokens: 16 });
      ok(`联通性正常 ${Date.now() - t0}ms → ${String(res.text).replace(/\s+/g, ' ').slice(0, 40)}`);
    } catch (err) {
      bad(`调用失败: ${err.message}`);
    }
  }
}

console.log('');
process.exit(0);
