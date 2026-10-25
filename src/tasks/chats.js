import { readChats, writeChats } from '../core/chats.js';
import { ROOT } from '../core/paths.js';

/**
 * 按会话配置任务（任务层）。
 *
 * 职责边界：**按会话配置的唯一入口**。CLI 与图形化配置器都调这里，
 * 避免两份实现各自维护 config.json 导致内容不一致。
 */

/** 列出全部按会话配置。 */
export function listChats(rootDir = ROOT) {
  return readChats(rootDir);
}

/** 覆盖写入全部按会话配置。 */
export function saveChats(chats, rootDir = ROOT) {
  return writeChats(chats || {}, rootDir);
}

/** 新增或更新一个会话。 */
export function upsertChat(id, patch = {}, rootDir = ROOT) {
  const chats = readChats(rootDir);
  chats[id] = { ...(chats[id] || {}), ...patch };
  writeChats(chats, rootDir);
  return chats[id];
}

/** 启用 / 停用一个会话。 */
export function setChatEnabled(id, enabled, rootDir = ROOT) {
  const chats = readChats(rootDir);
  chats[id] = { ...(chats[id] || {}), enabled: Boolean(enabled) };
  writeChats(chats, rootDir);
  return chats[id];
}

/** 移除一个会话。 */
export function removeChat(id, rootDir = ROOT) {
  const chats = readChats(rootDir);
  delete chats[id];
  writeChats(chats, rootDir);
  return chats;
}
