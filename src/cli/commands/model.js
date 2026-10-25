import { ROOT } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { section, line, json, hint, next } from '../ui.js';
import { listModels, testChat, discoverLocal, groupedProviders, explainError } from '../../tasks/model.js';
import { modelServiceStatus, startModelService, stopModelService } from '../../tasks/model-service.js';

/**
 * autochat model —— 模型相关子命令组。
 *   model test      测试当前配置能不能用
 *   model list      列出服务端有哪些模型
 *   model service   本地模型服务（start / stop / status）
 */
export async function run(ctx) {
  const sub = (ctx.positional[0] || 'test').toLowerCase();
  const cfg = loadConfig({ rootDir: ROOT });

  if (sub === 'test') {
    const r = await testChat({
      baseUrl: cfg.ai.baseUrl,
      apiKey: cfg.ai.apiKey,
      model: cfg.ai.model,
      timeoutMs: cfg.ai.timeoutMs,
    });
    if (ctx.flag('json')) {
      json(r);
      return;
    }
    section('测试模型连接');
    line('ok', '接口地址', cfg.ai.baseUrl ? cfg.ai.baseUrl : '(没填，先跑 autochat setup)');
    line('ok', '模型名', cfg.ai.model ? cfg.ai.model : '(没填)');
    if (r.ok) {
      line('ok', '成功', '耗时 ' + r.ms + ' 毫秒 · ' + r.model);
      console.log('  ' + r.reply);
      return;
    }
    line('bad', r.title ? r.title : '没成功', '');
    console.log('  ' + (r.detail ? r.detail : ''));
    if (r.error) hint('技术细节：' + r.error);
    return;
  }

  if (sub === 'list') {
    const r = await listModels({ baseUrl: cfg.ai.baseUrl, apiKey: cfg.ai.apiKey });
    if (ctx.flag('json')) {
      json(r);
      return;
    }
    section('可用模型');
    if (!r.ok) {
      const ex = explainError(new Error(r.error), { baseUrl: cfg.ai.baseUrl });
      line('bad', ex.title, ex.detail);
      return;
    }
    if (!r.models.length) {
      line('warn', '连上了，但没返回模型列表', '地址可能不是 /v1 根目录');
      return;
    }
    line('ok', '共 ' + r.models.length + ' 个模型', cfg.ai.baseUrl);
    for (const m of r.models) {
      const cur = m === cfg.ai.model ? ' ← 现在用的' : '';
      console.log('    ' + (m === cfg.ai.model ? '*' : ' ') + ' ' + m + cur);
    }
    return;
  }

  if (sub === 'service') {
    const action = (ctx.positional[1] || 'status').toLowerCase();
    if (action === 'start') {
      section('启动本地模型服务');
      const r = await startModelService({
        rootDir: ROOT,
        runnerId: ctx.opt('runner', ''),
        baseUrl: cfg.ai.baseUrl,
        cmd: cfg.modelServiceCmd,
      });
      line(r.ok ? 'ok' : 'bad', r.ok ? '已就绪' : '没起来', r.message);
      if (r.models && r.models.length) line('ok', '可用模型', r.models.join('、'));
      if (!r.ok) next('本机没装的话先装 Ollama：https://ollama.com/download');
      return;
    }
    if (action === 'stop') {
      section('停止本地模型服务');
      const r = await stopModelService({ rootDir: ROOT });
      line(r.ok ? 'ok' : 'warn', r.ok ? '已停止' : '没停', r.message);
      return;
    }
    const st = await modelServiceStatus({ rootDir: ROOT, baseUrl: cfg.ai.baseUrl });
    if (ctx.flag('json')) {
      json(st);
      return;
    }
    section('本地模型服务');
    for (const r of st.runners) {
      line(r.installed ? 'ok' : 'warn', r.name, r.installed ? '已安装' + (r.exe ? '（' + r.exe + '）' : '') : '未检测到');
    }
    line(st.online ? 'ok' : 'warn', '当前地址', st.baseUrl + (st.online ? ' 在线' : ' 连不上'));
    if (st.startedByUs) line('ok', '由 AutoChat 启动', 'pid ' + st.pid);
    if (!st.online) next('启动：autochat model service start');
    return;
  }

  if (sub === 'providers') {
    section('可以这样接模型');
    for (const g of groupedProviders()) {
      console.log('  ' + g.group);
      for (const p of g.items) {
        console.log('    ' + p.id + '  ' + p.name + '  ' + (p.baseUrl ? p.baseUrl : '（自己填）'));
      }
    }
    return;
  }

  const found = await discoverLocal();
  section('本机已启动的模型服务');
  if (!found.length) {
    line('warn', '没扫到', '本机没在跑 Ollama / LM Studio 之类的服务');
    next('启动：autochat model service start');
    return;
  }
  for (const f of found) line('ok', f.name, f.baseUrl);
}
