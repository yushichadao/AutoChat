import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeMessage, normalizeDbRow, dedupeKey } from '../protocol/normalize.js';
import { candidateDbs, buildPollSql, buildRowSql } from './poll-sql.js';

/**
 * 收消息的两条腿：
 *  1) webhook —— DLL 收到消息后 POST 到我们，延迟最低
 *  2) poll    —— 定时用 /QueryDB/execute 查库，覆盖不支持回调的 DLL
 * 两者共用一套去重，谁先到算谁的。
 *
 * 安全：默认只监听回环地址；配置了 token 时要求请求带上 token，
 * 避免同网段任意设备伪造「群友消息」触发 AI 回复（额度 + 封号风险）。
 */
export class Receiver extends EventEmitter {
  constructor({ cfg, hook, logger, pollPlan = [], selfFilter = null, contacts = null }) {
    super();
    this.cfg = cfg;
    this.hook = hook;
    this.log = logger;
    this.selfId = cfg.selfId || '';
    /** sender | id —— 见 bridge/self-filter.js */
    this.selfMode = cfg.selfMode || 'sender';
    this.selfFilter = selfFilter;
    /** 昵称缓存（wxid → 昵称 / 群名） */
    this.contacts = contacts;
    this.seen = new Map();
    this.seenLimit = 2000;
    this.server = null;
    this.pollTimer = null;
    this.polling = false;
    this.watchdog = null;
    this.lastWebhookAt = Date.now();
    this.fallbackAnnounced = false;
    this.stats = { webhook: 0, poll: 0, dropped: 0, rejected: 0, selfDropped: 0 };
    /** 按会话生成的轮询计划（每个会话一条 SQL） */
    this.pollPlan = pollPlan;
    /** 会话 → 已处理到的最大消息 id（增量水位），重启后要记住，否则会重复回旧消息 */
    this.watermark = new Map();
    this.wmFile = cfg.watermarkFile || '';
    this.wmDirty = false;
    this.loadWatermark();
  }

  /** 读回上次的水位（data/poll-state.json）。 */
  loadWatermark() {
    if (!this.wmFile || !fs.existsSync(this.wmFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.wmFile, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) {
        const n = Number(v);
        if (Number.isFinite(n)) this.watermark.set(k, n);
      }
    } catch (err) {
      this.log?.debug?.(`水位读取失败，忽略: ${err.message}`);
    }
  }

  /** 原子写：临时文件 + rename。 */
  saveWatermark() {
    if (!this.wmFile || !this.wmDirty) return;
    try {
      const obj = {};
      for (const [k, v] of this.watermark) obj[k] = v;
      fs.mkdirSync(path.dirname(this.wmFile), { recursive: true });
      const tmp = `${this.wmFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, this.wmFile);
      this.wmDirty = false;
    } catch (err) {
      this.log?.debug?.(`水位写入失败: ${err.message}`);
    }
  }

  remember(key) {
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now());
    if (this.seen.size > this.seenLimit) {
      const first = this.seen.keys().next().value;
      this.seen.delete(first);
    }
    return true;
  }

  emitMessage(msg, source) {
    if (!msg) return;
    // 纵深防御：即使归一化层漏了，这里再挡一次自己发的消息，
    // 防止「自己的回复被当成别人的消息」造成自问自答循环。
    if (this.selfFilter) {
      if (this.selfFilter.isSelfMessage(msg)) {
        this.stats.selfDropped += 1;
        return;
      }
    } else if (this.selfId && msg.senderId && msg.senderId === this.selfId) {
      this.stats.selfDropped += 1;
      return;
    }
    // 增量水位：比上次处理过的 id 更旧的，视为已处理（重启后也不会重复回）
    const wid = Number(msg.id);
    if (Number.isFinite(wid) && wid > 0) {
      const mark = this.watermark.get(msg.chatId) || 0;
      if (wid <= mark) {
        this.stats.dropped += 1;
        return;
      }
      this.watermark.set(msg.chatId, wid);
      this.wmDirty = true;
    }
    if (!this.remember(dedupeKey(msg))) {
      this.stats.dropped += 1;
      return;
    }
    this.stats[source] = (this.stats[source] || 0) + 1;
    this.emit('message', msg);
  }

  /** token 校验：优先请求头，其次查询参数（部分 DLL 只能带 URL）。 */
  checkToken(req, url) {
    const expected = this.cfg.webhookToken;
    if (!expected) return true;
    const header = req.headers['x-autochat-token'];
    const query = url.searchParams.get('token');
    return header === expected || query === expected;
  }

  /** 启动 webhook 服务；DLL 若支持 CallBackURL 就推到 /wechat。 */
  async startWebhook() {
    if (this.cfg.receiveMode === 'poll') return null;
    const port = this.cfg.webhookPort;
    const bind = this.cfg.webhookBind || '127.0.0.1';
    const token = this.cfg.webhookToken;

    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('autochat webhook');
        return;
      }
      if (!this.checkToken(req, url)) {
        this.stats.rejected += 1;
        this.log.warn('webhook 收到未通过 token 校验的请求，已拒绝');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"ret":-1,"msg":"unauthorized"}');
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ret":0}');
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) return;
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          this.log.warn('webhook 收到非 JSON 载荷，已忽略', text.slice(0, 120));
          return;
        }
        const selfId = this.selfId;
        const list = Array.isArray(body) ? body : [body];
        // 后台预热联系人缓存（群名/发言人），后续 webhook 消息即可与轮询通道一致地补全名字；
        // 同步 emit 时序保持不变，避免改变事件契约。
        if (this.contacts) {
          const ids = new Set();
          for (const item of list) {
            if (item?.senderId) ids.add(String(item.senderId));
            const cid = item?.chatId || item?.roomId || item?.fromChatroom;
            if (cid) ids.add(String(cid));
          }
          if (ids.size) this.contacts.lookup([...ids]).catch(() => {});
        }
        for (const item of list) {
          const msg = normalizeMessage(item, { selfId, selfMode: this.selfMode });
          if (!msg) continue;
          const senderName = this.contacts?.nameOf(msg.senderId);
          if (senderName) msg.senderName = senderName;
          const chatName = this.contacts?.nameOf(msg.chatId);
          if (chatName) msg.chatName = chatName;
          this.lastWebhookAt = Date.now();
          this.emitMessage(msg, 'webhook');
        }
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, bind, resolve);
    });
    this.log.info(
      `webhook 监听 http://${bind}:${port}/wechat${token ? '（已启用 token 鉴权）' : ''}`
    );
    return { port, bind };
  }

  async startPoll(force = false) {
    if (!force && this.cfg.receiveMode === 'webhook') return;
    // 优先用按会话生成的计划；没有就退回用户手写的一条 SQL
    const plan = this.pollPlan.length
      ? this.pollPlan
      : this.cfg.pollSql
        ? [{ chatId: '', db: this.cfg.pollDb || 'message_0.db', sql: this.cfg.pollSql }]
        : [];
    if (!plan.length) {
      this.log.warn('未配置 WX_POLL_SQL / WX_POLL_CHATS，跳过数据库轮询（只能依赖 DLL 回调）');
      return;
    }
    if (this.cfg.pollExcludeSelf && !this.selfId) {
      this.log.warn(
        '轮询已跳过：无法确认本机 wxid，MSG 表里自己发的消息会被当成他人消息导致自问自答。' +
          '请设置 WX_SELF_ID，或改用 webhook 接收'
      );
      return;
    }
    // 首次接管某个会话时，先把水位定到「当前最大 id」，
    // 否则历史消息会被当成新消息，机器人一上来就刷屏。
    await this.initWatermark(plan);

    const tick = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        for (const p of plan) {
          // 1) 轻量批次：只拿 local_id（hook 对「多列 + message_content + WHERE」查询会返回空）
          const idRows = await this.queryInAnyDb(buildPollSql(p.chatId, p.limit || 30), p.db);
          if (!idRows.length) continue;
          const mark = this.watermark.get(p.chatId) || 0;
          const newIds = idRows
            .map((r) => Number(r.local_id ?? r.msgid))
            .filter((id) => Number.isFinite(id) && id > mark)
            .sort((a, b) => a - b);
          if (!newIds.length) continue;

          // 2) 逐条按 local_id 取完整单行（正文 / 发送者在此获取；单行查询在 hook 下稳定）
          const rows = [];
          const rids = new Set();
          for (const id of newIds) {
            const rowSql = buildRowSql(p.chatId, id);
            if (!rowSql) continue;
            const rr = await this.queryInAnyDb(rowSql, p.db);
            if (rr.length) {
              rows.push(rr[0]);
              if (rr[0].rid != null) rids.add(String(rr[0].rid));
            }
          }
          if (!rows.length) continue;

          // 3) 批量把 real_sender_id 解析成 wxid（Name2Id 单独查，避免 JOIN 触发 hook 空返回）
          const nameMap = await this.resolveSenders([...rids]);

          const selfId = this.selfId;
          const selfMode = this.selfMode;
          if (this.contacts) {
            const ids = new Set();
            for (const r of rows) {
              const w = nameMap.get(String(r.rid));
              if (w) ids.add(String(w));
            }
            if (p.chatId) ids.add(p.chatId);
            await this.contacts.lookup([...ids]);
          }
          for (const r of rows) {
            r.roomid = p.chatId; // 在 JS 里补 roomid，避免 SQL 常量触发 hook 空返回
            r.wxid = nameMap.get(String(r.rid)) || '';
            const msg = normalizeDbRow(r, { selfId, selfMode });
            if (!msg) continue;
            const senderName = this.contacts?.nameOf(msg.senderId);
            if (senderName) msg.senderName = senderName;
            const chatName = this.contacts?.nameOf(msg.chatId);
            if (chatName) msg.chatName = chatName;
            this.emitMessage(msg, 'poll');
          }
        }
        this.saveWatermark();
      } catch (err) {
        this.log.debug('轮询失败', err.message);
      } finally {
        this.polling = false;
      }
    };
    await tick();
    this.pollTimer = setInterval(tick, this.cfg.pollIntervalMs);
    this.log.info(
      `数据库轮询已启动，间隔 ${this.cfg.pollIntervalMs}ms` +
        (this.pollPlan.length ? `，会话 ${this.pollPlan.map((p) => p.chatId).join(', ')}` : '')
    );
  }

  /**
   * 首次接管一个会话：把水位定到当前最大消息 id。
   * 没有这一步，重启后会把最近几十条旧消息当成新消息逐条回复。
   * 逐库回退：表不一定在 message_0.db，查不到就试下一个候选库。
   */
  async initWatermark(plan) {
    for (const p of plan) {
      if (!p.chatId || !p.table || this.watermark.has(p.chatId)) continue;
      const dbs = [p.db, ...candidateDbs(p.db).filter((d) => d !== p.db)];
      for (const db of dbs) {
        try {
          const res = await this.hook.queryDb(`SELECT MAX(local_id) AS msgid FROM ${p.table}`, db);
          const rows = Array.isArray(res?.data) ? res.data : [];
          const max = Number(rows?.[0]?.msgid || 0);
          if (Number.isFinite(max) && max > 0) {
            this.watermark.set(p.chatId, max);
            this.wmDirty = true;
            this.log.info(`会话 ${p.chatId} 水位初始化为 ${max}（只处理之后的新消息）`);
            break;
          }
        } catch (err) {
          this.log.debug(`水位初始化失败 ${p.chatId} ${db}: ${err.message}`);
        }
      }
    }
    this.saveWatermark();
  }

  /**
   * 在候选库里逐个执行同一条 SQL，返回第一个「有数据」的库的结果。
   * 微信把消息分表放在 message_0.db / message_1.db …，表不一定在第一个库，
   * 所以「查不到」就换下一个库再试。
   * @returns {Promise<any[]>}
   */
  async queryInAnyDb(sql, baseDb) {
    if (!sql) return [];
    const dbs = [baseDb, ...candidateDbs(baseDb).filter((d) => d !== baseDb)];
    let lastErr;
    for (const db of dbs) {
      try {
        const res = await this.hook.queryDb(sql, db);
        const arr = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : null;
        if (arr && arr.length) return arr;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) this.log.debug(`queryInAnyDb 全部失败: ${lastErr.message}`);
    return [];
  }

  /** 批量把 Name2Id.rowid 解析成真实 wxid（单表查询，hook 下稳定）。 */
  async resolveSenders(rids) {
    const map = new Map();
    const clean = [...new Set(rids.filter((x) => x != null && x !== '' && x !== '0'))];
    if (!clean.length) return map;
    const sql = `SELECT rowid, user_name FROM Name2Id WHERE rowid IN (${clean.join(',')})`;
    const rows = await this.queryInAnyDb(sql, 'message_0.db');
    for (const r of rows) map.set(String(r.rowid), r.user_name);
    return map;
  }

  /**
   * 运行时自愈：DLL 声称支持回调，但可能因为版本偏移或字段变化一直不推。
   * 只要配置了 pollSql，静默超过阈值就自己把轮询打开，不用人工盯着日志。
   */
  startWatchdog() {
    const idleMs = Number(this.cfg.webhookIdleFallbackMs || 0);
    const hasPoll = this.pollPlan.length > 0 || Boolean(this.cfg.pollSql);
    if (!idleMs || this.cfg.receiveMode !== 'webhook' || !hasPoll) return;
    if (this.cfg.pollExcludeSelf && !this.selfId) {
      this.log.warn('未配置 WX_SELF_ID，兜底轮询不会启用（避免自问自答）');
      return;
    }

    const tick = Math.max(100, Math.min(1000, Math.floor(idleMs / 4)));
    this.watchdog = setInterval(() => {
      if (this.pollTimer) return;
      if (Date.now() - this.lastWebhookAt < idleMs) return;
      if (!this.fallbackAnnounced) {
        this.fallbackAnnounced = true;
        this.log.warn(`webhook 已 ${Math.round(idleMs / 1000)}s 无消息，自动启用数据库轮询兜底`);
      }
      this.startPoll(true).catch((err) => this.log.warn('兜底轮询启动失败', err.message));
    }, tick);
    this.watchdog.unref?.();
  }

  async start() {
    if (this.cfg.receiveMode !== 'poll') {
      try {
        await this.startWebhook();
      } catch (err) {
        // auto 模式下 webhook 起不来就降级为仅轮询；webhook 模式也先告警再退守轮询
        this.log.warn(`webhook 启动失败，降级为仅轮询兜底: ${err.message}`);
      }
    }
    await this.startPoll();
    this.startWatchdog();
  }

  async stop() {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.saveWatermark();
    if (this.server) await new Promise((r) => this.server.close(r));
  }
}
