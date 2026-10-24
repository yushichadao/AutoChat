import fs from 'node:fs';
import path from 'node:path';

/**
 * 「这条消息是不是机器人自己发出去的」—— 两种判定模式。
 *
 * 场景 A（默认 sender）：手机上的号和电脑上的号是同一个，
 *   但群里说话的往往是**别人**。这时按 wxid 过滤最省事：
 *   凡是本机 wxid 发的一律不当成提问。
 *
 * 场景 B（id）：电脑微信必须扫码登录，所以电脑上的号 == 手机上的号，
 *   群里的对话记录里，**提问的人就是本机账号**。
 *   这时按 wxid 过滤会把用户的提问全丢掉，机器人永远不回话。
 *   只能改成「精确记住机器人自己发过哪几条」：
 *   发送后回查库拿到新写入的 local_id，登记下来，收到时按 id 排除。
 *
 * 两种模式都保留内容回声兜底（发出的文本短时间内原样回来 → 判定为自己发的）。
 */

export const SELF_MODE = { SENDER: 'sender', ID: 'id' };

export class SelfFilter {
  constructor({ mode = SELF_MODE.SENDER, selfId = '', file = '', logger } = {}) {
    this.mode = mode === SELF_MODE.ID ? SELF_MODE.ID : SELF_MODE.SENDER;
    this.selfId = selfId || '';
    this.file = file || '';
    this.log = logger;
    /** chatId -> Set<local_id> */
    this.sent = new Map();
    /** 最近发出去的文本：内容级回声兜底 */
    this.outbound = [];
    this.dirty = false;
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [chatId, ids] of Object.entries(raw || {})) {
        if (Array.isArray(ids)) this.sent.set(chatId, new Set(ids.map((n) => Number(n)).filter(Number.isFinite)));
      }
    } catch (err) {
      this.log?.debug?.(`已发消息记录读取失败: ${err.message}`);
    }
  }

  save() {
    if (!this.file || !this.dirty) return;
    try {
      const obj = {};
      for (const [chatId, ids] of this.sent) obj[chatId] = [...ids].sort((a, b) => a - b).slice(-500);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log?.debug?.(`已发消息记录写入失败: ${err.message}`);
    }
  }

  /** 登记机器人刚发出的消息 id。 */
  markSent(chatId, ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    if (!list.length) return;
    let set = this.sent.get(chatId);
    if (!set) {
      set = new Set();
      this.sent.set(chatId, set);
    }
    for (const id of list) set.add(id);
    this.dirty = true;
    this.save();
  }

  isSentId(chatId, id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return false;
    return this.sent.get(chatId)?.has(n) === true;
  }

  /** 记住发出去的文本（回声兜底）。 */
  rememberOutgoing(chatId, text) {
    const t = String(text || '').trim();
    if (!t) return;
    this.outbound.push({ chatId, text: t, at: Date.now() });
    if (this.outbound.length > 100) this.outbound.shift();
  }

  /**
   * 这条消息是不是机器人自己发的？
   * @param {{chatId:string, id:string, text:string, senderId:string}} msg
   */
  isSelfMessage(msg) {
    if (!msg) return false;
    if (this.mode === SELF_MODE.ID) {
      // id 模式：只认登记过的 id
      if (this.isSentId(msg.chatId, msg.id)) return true;
      return this.isEcho(msg);
    }
    // sender 模式：发送者是本机 wxid 就当自己发的
    if (this.selfId && msg.senderId && msg.senderId === this.selfId) return true;
    return this.isEcho(msg);
  }

  /** 内容回声：刚发出去的原文又被收回来了。 */
  isEcho(msg) {
    if (!msg?.text) return false;
    const now = Date.now();
    this.outbound = this.outbound.filter((o) => now - o.at < 120000);
    const text = String(msg.text).trim();
    if (!text) return false;
    return this.outbound.some((o) => o.text === text && (!o.chatId || o.chatId === msg.chatId));
  }
}
