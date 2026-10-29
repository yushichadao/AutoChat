import { readChats, writeChats } from '../core/chats.js';
import { ROOT } from '../core/paths.js';

/**
 * 按会话配置任务（任务层）。
 *
 * 职责边界：**按会话配置的唯一入口**。CLI 与图形化配置器都调这里，
 * 避免两份实现各自维护 config.json 导致内容不一致。
 */

/** 列出全部按会话配置（给定 wxid 时读该账号独立的 chats.json）。 */
export function listChats(rootDir = ROOT, wxid) {
  return readChats(rootDir, wxid);
}

/** 覆盖写入全部按会话配置。 */
export function saveChats(chats, rootDir = ROOT, wxid) {
  return writeChats(chats || {}, rootDir, wxid);
}

/** 新增或更新一个会话。 */
export function upsertChat(id, patch = {}, rootDir = ROOT, wxid) {
  const chats = readChats(rootDir, wxid);
  chats[id] = { ...(chats[id] || {}), ...patch };
  writeChats(chats, rootDir, wxid);
  return chats[id];
}

/** 启用 / 停用一个会话。 */
export function setChatEnabled(id, enabled, rootDir = ROOT, wxid) {
  const chats = readChats(rootDir, wxid);
  chats[id] = { ...(chats[id] || {}), enabled: Boolean(enabled) };
  writeChats(chats, rootDir, wxid);
  return chats[id];
}

/** 移除一个会话。 */
export function removeChat(id, rootDir = ROOT, wxid) {
  const chats = readChats(rootDir, wxid);
  delete chats[id];
  writeChats(chats, rootDir, wxid);
  return chats;
}
