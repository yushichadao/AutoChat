import { ROOT } from '../../core/paths.js';
import { section, line, json, hint, next, ok } from '../ui.js';
import { createPrompter } from '../prompts.js';
import { evaluateSteps, summarize } from '../../tasks/setup.js';
import { lockWeChatUpdate } from '../../tasks/lock.js';
import { detectBuiltinDll } from '../../tasks/autodll.js';
import { writeEditableEnv } from '../../tasks/config.js';
import { writeChats } from '../../core/chats.js';
import { discoverLocal, groupedProviders, listModels, testChat } from '../../tasks/model.js';
import { parseEffort } from './effort.js';

/**
 * autochat setup —— 唯一的初始化向导（CLI 与图形化配置器共用同一套判断）。
 *
 * 流程：先给每一步的现状 → 缺什么补什么 → 最后给启动建议。
 * 支持 --only <步骤> 只跑某一步；--non-interactive 只体检不提问（脚本/CI 用）。
 */
export async function run(ctx) {
  const only = ctx.opt('only', '');
  const nonInteractive = ctx.flag('non-interactive');

  let steps = await evaluateSteps({ rootDir: ROOT });
  if (only) {
    steps = steps.filter((s) => s.id === only);
    if (!steps.length) {
      line('bad', '没有这一步', only);
      return;
    }
  }

  if (ctx.flag('json')) {
    json({ steps, summary: summarize(steps) });
    return;
  }

  section('初始化向导');
  for (const s of steps) {
    line(s.level, s.title, s.detail);
    if (s.next) hint('→ ' + s.next);
  }

  if (nonInteractive) {
    const sum = summarize(steps);
    hint('体检结果：还差 ' + (sum.bad + sum.warn) + ' 步（--non-interactive 不会自动修改）');
    return;
  }

  const prompter = await createPrompter();
  try {
    for (const s of steps) {
      if (s.level === 'ok') continue;
      if (!s.action) {
        if (s.level === 'bad') next(s.next);
        continue;
      }
      if (s.action.kind === 'lock') {
        const r = await lockWeChatUpdate();
        line(r.ok ? 'ok' : 'bad', '锁定微信版本', r.ok ? '已锁定' : r.detail);
      } else if (s.action.kind === 'autodll') {
        const d = await detectBuiltinDll(ROOT);
        if (d.path) {
          const w = writeEditableEnv({ WX_DLL_PATH: d.path }, ROOT);
          line('ok', '已写入 hook DLL', w.changed.join('、') + ' → ' + d.path);
        } else {
          line('warn', '没匹配到内置 DLL', '发布包自带适配 DLL，请确认 WX_INSTALL_DIR 指对了微信安装目录，或该微信版本暂无适配');
        }
      } else if (s.action.kind === 'model') {
        await configureModel(prompter);
      } else if (s.action.kind === 'start') {
        next('启动：autochat start（需要管理员权限时加 --elevate）');
      }
    }
  } finally {
    prompter.close();
  }

  const after = await evaluateSteps({ rootDir: ROOT });
  section('现在的状态');
  for (const s of after) line(s.level, s.title, s.detail);
  const sum = summarize(after);
  if (sum.ready) {
    ok('配置齐了，可以启动：autochat start');
  } else {
    next('还差 ' + sum.bad + ' 个阻断项，按上面提示处理');
  }
}

/** 选模型来源 → 填地址/密钥/模型名 → 现场测一次 → 保存。 */
async function configureModel(prompter) {
  const found = await discoverLocal();
  const groups = groupedProviders();
  const options = [];
  for (const f of found) {
    options.push({ name: '本机 ' + f.name + '（已启动）', baseUrl: f.baseUrl, model: (f.models && f.models[0]) || '', models: f.models || [] });
  }
  for (const g of groups) {
    for (const p of g.items) {
      if (found.some((f) => f.baseUrl === p.baseUrl)) continue;
      options.push({ name: p.name, baseUrl: p.baseUrl, model: p.model || '', models: [], needsKey: p.needsKey, keyHint: p.keyHint, keyUrl: p.keyUrl, steps: p.steps });
    }
  }

  section('接一个模型');
  if (!options.length) {
    line('warn', '没有可选的模型来源', '可以先启动本机模型服务：autochat model service start');
    return;
  }
  options.forEach((o, i) => {
    console.log('  ' + (i + 1) + ') ' + o.name + '  ' + (o.baseUrl || '（自己填地址）'));
  });
  const pick = await prompter.ask('  选哪个（输入编号）', '1');
  const idx = Number(pick) - 1;
  const chosen = options[idx >= 0 && idx < options.length ? idx : 0];
  if (chosen.steps && chosen.steps.length) {
    hint('怎么开始：');
    for (const st of chosen.steps) hint('· ' + st);
  }

  let base = chosen.baseUrl;
  let model = chosen.model;
  let key = '';
  if (chosen.needsKey) {
    if (chosen.keyUrl) hint('密钥申请地址：' + chosen.keyUrl);
    key = await prompter.ask('  把密钥粘进来（没有就先回车跳过）');
  }

  if (!model) {
    const list = await listModels({ baseUrl: base, apiKey: key }).catch(() => ({ ok: false, models: [] }));
    if (list.ok && list.models && list.models.length) {
      list.models.slice(0, 8).forEach((m, i) => console.log('    ' + (i + 1) + ') ' + m));
      const p = await prompter.ask('  选哪个模型（输入编号）', '1');
      const mi = Number(p) - 1;
      model = list.models[mi >= 0 && mi < list.models.length ? mi : 0];
    } else {
      model = await prompter.ask('  模型名（不知道就先回车）');
    }
  }

  if (base && model) {
    hint('正在测试能不能用…');
    const t = await testChat({ baseUrl: base, apiKey: key, model });
    if (t.ok) {
      line('ok', '测试通过', '耗时 ' + t.ms + ' 毫秒');
    } else {
      line('warn', '还没测通', t.title ? t.title + '：' + t.detail : t.detail);
      const go = await prompter.confirm('  先保存下来，之后再改？', true);
      if (!go) return;
    }
  }

  // 思考强度：推理模型想多久再回答。想省 token 就留空（关闭）。
  // 只在真人交互时问 —— 管道喂输入的脚本不该多消耗一行输入。
  let effort = '';
  if (prompter.isTty) {
    const effortRaw = await prompter.ask('  思考强度（off/低/中/高，回车=关闭）', '');
    effort = parseEffort(effortRaw);
    if (effortRaw && !effort) hint('看不懂这个值，按「关闭」处理');
  }

  const updates = { AI_BASE_URL: base, AI_MODEL: model, AI_ENABLED: '1' };
  if (key) updates.AI_API_KEY = key;
  if (effort) updates.AI_REASONING_EFFORT = effort;
  const w = writeEditableEnv(updates, ROOT);
  line('ok', '已保存', w.changed.join('、'));
}
