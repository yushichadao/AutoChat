import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * AutoChat 技能提供者（DSH Skills 子系统）。
 *
 * 技能正文放在 assets/autochat-console.md —— 它是「怎么用 AutoChat 才不会踩坑」的纪律，
 * 模型在动手前先读到它，就不会跳步、不会假装配好。
 */

/** 与 @deepseek-ai/dsh-skill 的内置技能 rank 保持一致（写死是为了不多一个依赖）。 */
const BUNDLED_SKILL_RANK = 600;

const PROVIDER_NAME = 'autochat';
const SKILL_BODY_URL = new URL('../assets/autochat-console.md', import.meta.url);
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
};

const CANDIDATE = {
  name: 'autochat-console',
  description:
    '操作 Windows 微信侧 AI 助手 AutoChat 的纪律与手册。涉及微信自动回复、hook DLL、群回复策略、' +
    'AutoChat 启停 / 体检 / 配置 / 日志时使用。核心：先看根本性配置七步，缺什么补什么，绝不跳步、绝不假装配好。',
  invocation: {
    modelInvocable: true,
    userInvocable: true,
  },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
};

const provider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get() {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: CANDIDATE.resourceBase,
      rank: CANDIDATE.rank,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    };
  },
};

/** 供 DSH 插件注册用的技能提供者。 */
export function createSkillProvider() {
  return provider;
}
