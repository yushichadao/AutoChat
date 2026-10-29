import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeMessage, normalizeDbRow, dedupeKey } from '../protocol/normalize.js';
import { candidateDbs, buildPollSql, buildRowSql } from './poll-sql.js';

/**
 * 兼容旧配置：手写 WX_POLL_SQL 里若写死 `local_type = 1`（只取文本），
 * 文件/图片/语音等消息就永远进不来。这里仅精确匹配该片段自动放宽，
 * 不动其它 WHERE 条件，并提示用户改成 IN (1,3,34,43,47,49)。
 */
function broadenPollSql(sql, log) {
  if (!sql || !/local_type\s*=\s*1\b/i.test(sql)) return sql;
  log?.warn(
    'WX_POLL_SQL 写死了 local_type = 1，已自动放宽到包含文件/图片/语音等类型；' +
      '建议显式改为 local_type IN (1,3,34,43,47,49)'
  );
  return sql.replace(/local_type\s*=\s*1\b/gi, 'local_type IN (1,3,34,43,47,49)');
}

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
    /** 昵称缓存（wxid → 昵称 / 群名），按账号隔离 */
    this.contacts = contacts;
    this.contacts?.setCurrentAccount?.(this.selfId);
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
    /** 把已知会话告诉 hook，使其能快速精准反推本机 wxid（换号也自动生效） */
    this.hook.chatIds = (pollPlan || []).map((p) => p.chatId).filter(Boolean);
    /** 会话 → 已处理到的最大消息 id（增量水位），重启后要记住，否则会重复回旧消息 */
    this.watermark = new Map();
    this.wmFile = cfg.watermarkFile || '';
    this.wmDirty = false;
    this.loadWatermark();
    /** 复检补答去重：本次会话内已派发过补答的 (chatId:local_id)，避免重复派发 */
    this.reconcileSeen = new Set();
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

  /**
   * 运行时替换轮询计划 —— 「加入新群不用重启」的关键。
   *
   * 服务是常驻进程，启动时生成的 pollPlan 只是一份快照。用户后来在界面里
   * 加入新群（config.json / WX_POLL_CHATS 变了），不重启就永远不会去查那个群的表，
   * 表现就是「群里怎么 @ 都不回，日志还干干净净」。
   *
   * 新增的会话会先做水位对齐（initWatermark），这样接管瞬间群里的历史消息
   * 不会被当成新消息一口气回一遍。
   *
   * @param {{chatId:string,db:string,table:string,limit?:number,sql:string}[]} plan
   * @returns {Promise<{added:string[], removed:string[]}>}
   */
  async setPlan(plan) {
    const next = Array.isArray(plan) ? plan.filter((p) => p && p.chatId) : [];
    const before = new Set(this.pollPlan.map((p) => p.chatId));
    const after = new Set(next.map((p) => p.chatId));
    const added = next.filter((p) => !before.has(p.chatId));
    const removed = [...before].filter((id) => !after.has(id));

    this.pollPlan = next;
    if (removed.length) {
      for (const id of removed) this.watermark.delete(id);
      this.wmDirty = true;
    }
    if (added.length) await this.initWatermark(added);
    if (added.length || removed.length) this.saveWatermark();
    return { added: added.map((p) => p.chatId), removed };
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
          if (ids.size) this.contacts.lookup([...ids], this.selfId).catch(() => {});
        }
        for (const item of list) {
          const msg = normalizeMessage(item, { selfId, selfMode: this.selfMode, fileStorageBase: this.cfg.wechat?.fileStorageBase || '' });
          if (!msg) continue;
          const senderName = this.contacts?.nameOf(msg.senderId, this.selfId);
          if (senderName) msg.senderName = senderName;
          const chatName = this.contacts?.nameOf(msg.chatId, this.selfId);
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
        ? [{ chatId: '', db: this.cfg.pollDb || 'message_0.db', sql: broadenPollSql(this.cfg.pollSql, this.log) }]
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
    // 否则历史消息会被当成新消息，助手一上来就刷屏。
    await this.initWatermark(plan);

    const tick = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        for (const p of plan) {
          // 两条取数路径：
          //   ① 自动计划（按会话生成）：先取 local_id，再逐条取完整行，最后解析发送者。
          //      分三步是因为 hook 对「多列 + message_content + WHERE」的批量查询会整批返回空。
          //   ② 用户手写的 WX_POLL_SQL：一条 SQL 直接返回完整行，按约定别名解析。
          //      这条路径**必须原样使用用户写的 SQL**，不能替换成自动生成的语句。
          const manual = !p.chatId;
          let rows = [];
          let nameMap = new Map();

          if (manual) {
            rows = await this.queryInAnyDb(p.sql, p.db);
            if (!rows.length) continue;
          } else {
            // 1) 轻量批次：只拿 local_id（hook 对「多列 + message_content + WHERE」查询会返回空）
            const idRows = await this.queryInAnyDb(buildPollSql(p.chatId, p.limit || 30), p.db);
            if (!idRows.length) continue;
            const mark = this.watermark.get(p.chatId) || 0;
            const newIds = idRows
              .map((r) => Number(r.local_id ?? r.msgid))
              .filter((id) => Number.isFinite(id) && id > mark)
              .sort((a, b) => a - b);
            if (!newIds.length) continue;
            // 首次接管兜底：加入会话的那一刻表可能还不存在（刚被拉进群、还没说过话），
            // initWatermark 就设不上水位。这里补一刀 —— 先把水位对齐到当前最新一条，
            // 本批历史只记账不投递，否则一进群就会把最近 30 条旧消息全部回一遍。
            if (!this.watermark.has(p.chatId)) {
              const top = newIds[newIds.length - 1];
              this.watermark.set(p.chatId, top);
              this.wmDirty = true;
              this.log.info(`会话 ${p.chatId} 首次接管，水位对齐到 ${top}（只处理之后的新消息）`);
              continue;
            }

            // 2) 逐条按 local_id 取完整单行（正文 / 发送者在此获取；单行查询在 hook 下稳定）
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
            nameMap = await this.resolveSenders([...rids]);
          }

          const selfId = this.selfId;
          const selfMode = this.selfMode;
          if (this.contacts) {
            const ids = new Set();
            for (const r of rows) {
              const w = nameMap.get(String(r.rid));
              if (w) ids.add(String(w));
            }
            if (p.chatId) ids.add(p.chatId);
            await this.contacts.lookup([...ids], this.selfId);
          }
          for (const r of rows) {
            r.roomid = p.roomid ?? p.chatId; // 在 JS 里补 roomid，避免 SQL 常量触发 hook 空返回
            if (!manual) r.wxid = nameMap.get(String(r.rid)) || '';
            const msg = normalizeDbRow(r, { selfId, selfMode, fileStorageBase: this.cfg.wechat?.fileStorageBase || '' });
            if (!msg) continue;
            const senderName = this.contacts?.nameOf(msg.senderId, this.selfId);
            if (senderName) msg.senderName = senderName;
            const chatName = this.contacts?.nameOf(msg.chatId, this.selfId);
            if (chatName) msg.chatName = chatName;
            this.emitMessage(msg, 'poll');
          }
        }
        this.saveWatermark();
      } catch (err) {
        // 轮询异常以前只记 debug，日志里根本看不到；升级为 warn 才能被察觉
        this.log.warn('轮询失败', err.message);
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
    let lastDesc = '';
    for (const db of dbs) {
      try {
        const res = await this.hook.queryDb(sql, db);
        const arr = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : null;
        if (arr && arr.length) {
          this.qFailStreak = 0;
          return arr;
        }
        // hook 常以 {status:-1, desc:'…'} 报失败（如「消息库打不开」）——它**不是异常**，
        // 以前完全不落日志，表现为「助手静默不回话、日志干干净净」，极难排查。这里必须留痕。
        const d = res && !Array.isArray(res) ? String(res.desc || res.message || '') : '';
        if (d) lastDesc = `${db}: ${d}`;
      } catch (err) {
        lastErr = err;
      }
    }
    const why = lastErr ? lastErr.message : lastDesc;
    if (why) {
      // 节流：轮询约 1.5s 一次，不能每次都刷屏；首次与之后每 40 次各报一次
      this.qFailStreak = (this.qFailStreak || 0) + 1;
      if (this.qFailStreak === 1 || this.qFailStreak % 40 === 0) {
        this.log.warn(
          `消息库查询失败（已连续 ${this.qFailStreak} 次）：${why}。` +
          '常见原因是微信重启 / 更新后 hook 拿不到消息库句柄：请完全退出微信（托盘也退）后重开，' +
          '或用「自动修复」重新部署 DLL。'
        );
      }
    }
    // 查不到行（正常无新消息）不算失败，不打扰
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
   * 漏接补偿扫描：对「最近 N 条消息」做回路复检，补答被自过滤误标 / 竞态跳过而漏掉的用户消息。
   *
   * 为什么需要它（对应「漏接消息」根因）：
   *   增量轮询只看水位以上的新消息，一旦某条被 markSent 误标为「自己发的」，
   *   emitMessage 的 selfFilter 会永久丢弃它，且水位已越过，再也不会被重新看到。
   *   这里直接按 DB 发送者重新判定（real_sender_id → wxid），绕过 selfFilter 被污染的 sent 集合，
   *   找出「其后没有 Bot 回复」的用户消息并补答。
   *
   * 防重复回复的关键约束：只复检「已越过水位」的消息（local_id <= watermark）。
   *   新消息（> watermark）由正常增量路径独占处理，二者不重叠，因此不会双重回复。
   *
   * 发送过快导致的竞态（直接原因）也能被兜住：即便 markSent 把一条用户消息误标，
   * 下一轮复检仍会因「它后面没有 Bot 回复」而补答。
   */
  async reconcile() {
    if (!this.cfg.reconcileEnabled) return;
    if (!this.pollPlan.length) return;
    const selfId = this.selfId;
    const window = Math.max(3, Math.min(50, Number(this.cfg.reconcileWindow) || 10));
    for (const p of this.pollPlan) {
      // 漏接补偿只补 always 群：never 群本就不回；mention 群需 @ 才回，而复检无法判定
      // 「是否 @ 了我们」，若补答会误回未 @ 的消息。私聊不受 groupReply 限制
      // （与增量路径一致：私聊消息本就当作明确提问）。
      const isGroup = (p.chatId || '').endsWith('@chatroom');
      const gr = p.groupReply || 'always';
      if (isGroup && gr !== 'always') continue;
      try {
        const mark = this.watermark.get(p.chatId) || 0;
        if (!mark) continue; // 还没接管过该会话，跳过
        const idRows = await this.queryInAnyDb(buildPollSql(p.chatId, window), p.db);
        if (!idRows.length) continue;
        // 只取已越过水位的 id（<= watermark），新消息交给正常增量路径
        const ids = idRows
          .map((r) => Number(r.local_id ?? r.msgid))
          .filter((n) => Number.isFinite(n) && n > 0 && n <= mark)
          .sort((a, b) => a - b);
        if (!ids.length) continue;

        const rows = [];
        const rids = new Set();
        for (const id of ids) {
          const rowSql = buildRowSql(p.chatId, id);
          if (!rowSql) continue;
          const rr = await this.queryInAnyDb(rowSql, p.db);
          if (rr.length) {
            rows.push(rr[0]);
            if (rr[0].rid != null) rids.add(String(rr[0].rid));
          }
        }
        if (!rows.length) continue;
        const nameMap = await this.resolveSenders([...rids]);

        // 时间正序：维护「最近一条用户消息」，遇到 Bot 自己的消息即视为已回答
        let pending = null;
        const toAnswer = [];
        for (const r of rows) {
          const wxid = nameMap.get(String(r.rid)) || '';
          const isSelf = !!wxid && wxid === selfId; // 直接按 DB 发送者判定，绕过 selfFilter 的污染 sent 集合
          if (isSelf) {
            pending = null; // Bot 已回复，前面的用户消息视为已答
          } else if (wxid) {
            if (pending) toAnswer.push(pending); // 上一条用户消息到本条之前都没有 Bot 回复 → 漏答
            pending = r;
          }
          // wxid 解析失败则跳过，不误判
        }
        if (pending) toAnswer.push(pending); // 最后一条用户消息之后无 Bot 回复

        for (const r of toAnswer) {
          const key = `${p.chatId}:${r.msgid}`;
          if (this.reconcileSeen.has(key)) continue; // 本次会话内已派发，避免重复
          this.reconcileSeen.add(key);
          r.roomid = p.roomid ?? p.chatId;
          r.wxid = nameMap.get(String(r.rid)) || '';
          const msg = normalizeDbRow(r, { selfId, selfMode: this.selfMode, fileStorageBase: this.cfg.wechat?.fileStorageBase || '' });
          if (!msg) continue;
          const senderName = this.contacts?.nameOf(msg.senderId, this.selfId);
          if (senderName) msg.senderName = senderName;
          const chatName = this.contacts?.nameOf(msg.chatId, this.selfId);
          if (chatName) msg.chatName = chatName;
          msg.reconcile = true; // 标记：绕过 selfFilter 的复检消息（air.handle 据此跳过 isSentId 校验）
          if (!this.remember(dedupeKey(msg))) continue; // 兜底去重
          this.log.info(`复检补答 ${p.chatId} #${r.msgid}：${String(r.content || '').slice(0, 30)}`);
          this.emit('message', msg);
        }
      } catch (err) {
        this.log.debug(`复检失败 ${p.chatId}: ${err.message}`);
      }
    }
  }

  /** 启动漏接补偿定时器（独立于轮询，两种接收模式都生效）。 */
  startReconcile() {
    if (!this.cfg.reconcileEnabled) return;
    const ms = Math.max(5000, Math.min(600000, Number(this.cfg.reconcileIntervalMs) || 20000));
    const window = Math.max(3, Math.min(50, Number(this.cfg.reconcileWindow) || 10));
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err) => this.log.debug(`复检异常: ${err.message}`));
    }, ms);
    this.reconcileTimer.unref?.();
    this.log.info(`漏接补偿已启动：每 ${ms}ms 复检最近 ${window} 条消息`);
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
    this.startReconcile();
  }

  async stop() {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.saveWatermark();
    if (this.server) await new Promise((r) => this.server.close(r));
  }
}
