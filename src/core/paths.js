import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 项目路径常量（核心层）。
 *
 * 职责边界：**只回答「某个东西在哪个路径」**，不读文件、不写文件、不判断状态。
 * 其它模块（配置、任务层、入口层）都从这里取路径，避免同一个路径在多处各写一遍。
 */

/** 项目根目录（仓库根，含 package.json）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 运行时数据目录：版本记忆、方言缓存、上下文记忆、pid、暂停哨兵、日志。 */
export function dataDir(rootDir = ROOT) {
  return path.join(rootDir, 'data');
}

/** .env 配置文件路径。 */
export function envFile(rootDir = ROOT) {
  return path.join(rootDir, '.env');
}

/** config.json 路径（按会话配置）。 */
export function jsonFile(rootDir = ROOT) {
  return path.join(rootDir, 'config.json');
}

/** 助手服务的 pid 文件路径（给「停止服务」用）。 */
export function pidFile(rootDir = ROOT) {
  return path.join(dataDir(rootDir), 'autochat.pid');
}

/** 暂停哨兵文件路径：存在即表示「自动回复已暂停」。 */
export function pausedFile(rootDir = ROOT) {
  return path.join(dataDir(rootDir), 'paused');
}

/** 后台运行时的日志文件（标准输出 / 标准错误）。 */
export function logFiles(rootDir = ROOT) {
  const dir = dataDir(rootDir);
  return {
    out: path.join(dir, 'autochat.out'),
    err: path.join(dir, 'autochat.err'),
  };
}

/** 本地模型服务的 pid 文件路径（记录「由我们启动」的进程，便于停止）。 */
export function modelServicePidFile(rootDir = ROOT) {
  return path.join(dataDir(rootDir), 'model-service.pid');
}
