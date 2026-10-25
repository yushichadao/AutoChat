import { detectWeChat } from '../bridge/process.js';
import { resolveBuiltinDll } from './install.js';
import { ROOT } from '../core/paths.js';

/**
 * hook DLL 自动匹配任务（任务层）。
 *
 * 职责边界：**只回答「本机微信版本对应哪个内置 DLL」**，
 * 不负责写入配置（写配置由 setup / install 任务做）。
 */

/** 检测本机微信版本，并匹配项目内置的 hook DLL。 */
export async function detectBuiltinDll(rootDir = ROOT) {
  const wechat = await detectWeChat('').catch(() => null);
  const version = wechat?.version || '';
  const path = version ? resolveBuiltinDll(version, rootDir) : null;
  return { version, path, installDir: wechat?.dir || '' };
}
