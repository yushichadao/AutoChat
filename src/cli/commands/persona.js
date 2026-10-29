import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { loadPersona, DEFAULT_PERSONA_NAME } from '../../ai/persona.js';
import { readEnvFile } from '../../core/env-file.js';
import { writeEditableEnv } from '../../tasks/config.js';
import { section, line, hint, json } from '../ui.js';

/**
 * autochat persona —— 看 / 建 / 改人设。
 *
 * 命令行不代劳改内容（人设是几百字的自然语言，用编辑器改才顺手），
 * 只负责把**文件的绝对路径**摆出来，并把它写进 .env 的 AI_PERSONA_FILE。
 */
export async function run(ctx) {
  const cfg = loadConfig({ rootDir: ROOT });
  const info = loadPersona(cfg, ROOT);
  const env = readEnvFile(path.join(ROOT, '.env'));

  if (ctx.flag('json')) {
    json({
      file: info.file || '',
      source: info.source,
      name: info.name,
      text: info.text,
      account: cfg.wechat.selfName || cfg.wechat.selfId || '',
    });
    return;
  }

  section('人设（AI 怎么说话、怎么介绍自己）');

  const srcLabel = info.source === 'file' ? '人设文件' : (info.source === 'inline' ? '.env 里的内联人设' : '内置默认人设');
  line('ok', '当前生效', srcLabel + (info.file ? '：' + info.file : ''));
  line('ok', '人设名', info.name || DEFAULT_PERSONA_NAME);
  line('ok', '账号名', cfg.wechat.selfName || cfg.wechat.selfId || '(没读到，用上面 WX_SELF_NAME 补)');
  console.log('');
  console.log('  身份三要素：账号名【' + (cfg.wechat.selfName || cfg.wechat.selfId || '未知账号') +
    '】 · 人设名 ' + (info.name || DEFAULT_PERSONA_NAME) +
    ' · 模型名 <' + (cfg.ai.model || 'unknown-model') + '>');
  console.log('');

  if (info.source === 'file' && info.missing) {
    line('bad', '配了人设文件但读不到', String(env.AI_PERSONA_FILE || '') + '（文件不存在，或不在本目录内）');
  }

  // 没有文件 → 帮用户生成一份，直接给绝对路径
  if (!info.file) {
    const dir = path.join(ROOT, 'data', 'persona');
    const file = path.join(dir, 'persona.txt');
    if (ctx.flag('init') || ctx.flag('yes')) {
      fs.mkdirSync(dir, { recursive: true });
      const head = [
        '# AutoChat 人设文件（# 开头是注释，不会发给模型）',
        '# 改完保存即可；重启助手后生效。',
        '# 可用占位：{account} 账号名、{persona} 人设名、{model} 模型名',
        '# 注意：无论这里怎么写，身份三要素（账号名 + 人设名 + 模型名）都必须在回答里说清楚，',
        '# 且不得冒充真人、不得冒充别家 AI —— 这两条写死在系统提示里，改不掉。',
        '',
      ].join('\n');
      fs.writeFileSync(file, head + info.text + '\n', 'utf8');
      writeEditableEnv({ AI_PERSONA_FILE: file }, ROOT);
      line('ok', '已生成人设文件', file);
      hint('用记事本 / VS Code 打开上面这个文件自己改，改完重启助手。');
      return;
    }
    hint('现在用的是内置默认人设（如实表明 AI 身份）。要自己写一份：');
    console.log('  autochat persona --init     生成 ' + file + ' 并写入 .env');
    console.log('  autochat persona --set <绝对路径>   已经有文件，直接指定');
    console.log('  autochat persona --name <人设名>    只改人设名（身份三要素之一）');
    console.log('');
    line('warn', '要改内容就改文件本身', '命令行不代劳写人设，直接用编辑器打开改。');
    return;
  }

  hint('改人设就改这个文件本身：');
  console.log('  ' + info.file);
  console.log('');
  console.log('  改完保存，再执行：autochat stop && autochat start --background');
  console.log('  （正在运行的助手不会自动重载人设文件）');

  const name = ctx.opt('name');
  if (name) {
    writeEditableEnv({ AI_PERSONA_NAME: name }, ROOT);
    line('ok', '人设名已改为', name + '（重启助手后生效）');
  }
  const set = ctx.opt('set');
  if (set) {
    writeEditableEnv({ AI_PERSONA_FILE: set }, ROOT);
    line('ok', '人设文件已改为', set + '（重启助手后生效）');
  }
}
