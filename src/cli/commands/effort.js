import { ROOT } from '../../core/paths.js';
import { loadConfig } from '../../core/config.js';
import { section, line, json, hint, next } from '../ui.js';
import { writeEditableEnv } from '../../tasks/config.js';
import {
  EFFORT_LEVELS,
  EFFORT_LABELS,
  REASONING_FORMATS,
  FORMAT_LABELS,
  explainReasoning,
} from '../../core/reasoning.js';

/**
 * autochat effort —— 思考强度（推理模型先想多久再回答）。
 *
 * 用法：
 *   autochat effort                       看当前设置（含这次到底会发什么字段）
 *   autochat effort high                  设为「高」（off / low / medium / high）
 *   autochat effort high --format qwen    手动指定该服务商的字段格式
 *   autochat effort --format auto         按模型名自动判断（默认就是 auto）
 *   autochat effort --budget 4096         思考预算 token（按 token 表达强弱的格式生效）
 *
 * 不同厂商的「思考参数」字段不一样（reasoning_effort / enable_thinking /
 * thinking.budget_tokens / thinking_budget / think…），
 * 所以除了档位，还可以选「按哪家的写法发」；默认 auto 会按模型名自动判断。
 *
 * 写进 .env 的 AI_REASONING_EFFORT / AI_REASONING_FORMAT / AI_REASONING_BUDGET，
 * 改完要重启助手服务才生效（跟其它模型参数一样）。
 */
export async function run(ctx) {
  const cfg = loadConfig({ rootDir: ROOT });
  const arg = (ctx.positional[0] || '').trim().toLowerCase();
  const fmt = (ctx.opt('format', '') || '').trim().toLowerCase();
  const budgetRaw = ctx.opt('budget', '');
  const wantsSet = Boolean(arg) || Boolean(fmt) || budgetRaw !== '';

  // 只想看状态
  if (!wantsSet) {
    const info = explainReasoning({
      effort: cfg.ai.reasoningEffort,
      format: cfg.ai.reasoningFormat,
      budget: cfg.ai.reasoningBudget,
      model: cfg.ai.model,
      baseUrl: cfg.ai.baseUrl,
    });
    if (ctx.flag('json')) {
      json({
        effort: info.effort,
        label: info.label,
        format: info.format,
        formatLabel: info.formatLabel,
        kind: info.kind,
        budget: info.budget,
        model: cfg.ai.model,
        params: info.params,
        describe: info.describe,
      });
      return;
    }
    section('思考强度');
    line(info.effort === 'off' ? 'warn' : 'ok', '当前档位', `${info.label}（${info.effort}）`);
    line('ok', '当前模型', cfg.ai.model || '(没填模型名)');
    line('ok', '参数格式', `${info.formatLabel}（${info.format}）`);
    if (info.kind === 'switch') {
      hint('这家模型只有「开 / 关」两种状态，低/中/高都会翻译成「开启」');
    }
    line(
      info.effort === 'off' ? 'warn' : 'ok',
      '这次会发的字段',
      info.describe ? info.describe : '（不带任何思考参数）'
    );
    hint('档位：' + EFFORT_LEVELS.map((e) => `${e}（${EFFORT_LABELS[e]}）`).join(' / '));
    hint('格式：' + REASONING_FORMATS.map((f) => `${f}（${FORMAT_LABELS[f]}）`).join(' / '));
    next('修改：autochat effort high');
    return;
  }

  if (arg && !EFFORT_LEVELS.includes(arg)) {
    line('bad', '不认识的档位', arg);
    hint('只能是：' + EFFORT_LEVELS.join(' / '));
    next('例如：autochat effort high');
    return;
  }
  if (fmt && !REASONING_FORMATS.includes(fmt)) {
    line('bad', '不认识的参数格式', fmt);
    hint('只能是：' + REASONING_FORMATS.join(' / '));
    return;
  }

  const updates = {};
  if (arg) updates.AI_REASONING_EFFORT = arg;
  if (fmt) updates.AI_REASONING_FORMAT = fmt;
  if (budgetRaw !== '') {
    const n = Number(budgetRaw);
    if (!Number.isInteger(n) || n < 0) {
      line('bad', '思考预算要是非负整数', budgetRaw);
      return;
    }
    updates.AI_REASONING_BUDGET = String(n);
  }

  const r = writeEditableEnv(updates, ROOT);
  const after = loadConfig({ rootDir: ROOT });
  const info = explainReasoning({
    effort: after.ai.reasoningEffort,
    format: after.ai.reasoningFormat,
    budget: after.ai.reasoningBudget,
    model: after.ai.model,
    baseUrl: after.ai.baseUrl,
  });
  if (ctx.flag('json')) {
    json({
      changed: r.changed,
      effort: info.effort,
      format: info.format,
      budget: info.budget,
      model: after.ai.model,
      params: info.params,
      describe: info.describe,
    });
    return;
  }
  section('思考强度');
  line('ok', '已更新', r.changed.join('、'));
  line('ok', '当前档位', `${info.label}（${info.effort}）`);
  line('ok', '参数格式', `${info.formatLabel}（${info.format}）`);
  line('ok', '这次会发的字段', info.describe ? info.describe : '（不带任何思考参数）');
  if (info.kind === 'switch') {
    hint('这家模型只有「开 / 关」两种状态，低/中/高都会翻译成「开启」');
  }
  hint('配置类改动要重启助手服务才生效');
  if (after.ai.reasoningEffort !== 'off') {
    next('验证：autochat model test（会带上同一套思考参数）');
  }
}

/**
 * 供向导 / 其它命令复用：把用户输入规整成合法档位（非法返回空串）。
 * 中文也认（「高」= high），新手不用背英文。
 */
export function parseEffort(input) {
  const s = String(input || '').trim().toLowerCase();
  const table = {
    off: 'off', none: 'off', '0': 'off', false: 'off', 关闭: 'off', 关: 'off',
    low: 'low', 低: 'low',
    medium: 'medium', mid: 'medium', 中: 'medium',
    high: 'high', 高: 'high',
  };
  return table[s] || '';
}

/** 供向导 / 其它命令复用：规整参数格式（非法返回空串）。 */
export function parseFormat(input) {
  const s = String(input || '').trim().toLowerCase();
  const table = {
    auto: 'auto', 自动: 'auto',
    standard: 'standard', 标准: 'standard', openai: 'standard',
    openrouter: 'openrouter',
    qwen: 'qwen', 通义: 'qwen', dashscope: 'qwen', qwen3: 'qwen', ernie: 'qwen',
    anthropic: 'anthropic', claude: 'anthropic',
    gemini: 'gemini', google: 'gemini',
    thinking: 'thinking', 开关: 'thinking', deepseek: 'thinking', glm: 'thinking', kimi: 'thinking',
    ollama: 'ollama',
  };
  return table[s] || '';
}
