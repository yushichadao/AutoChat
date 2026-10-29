/**
 * 通讯录缓存：wxid → 昵称 / 群名。
 *
 * 为什么需要：prompt 里必须告诉模型「在跟谁说话、在哪个群」。
 * 只给 wxid 的话，模型要么自问自答「wxid_qr6ni... 是谁」，
 * 要么把 wxid 原样抄进回复里（实测见过）。
 *
 * 查的是本地 contact.db，一个 SQL 就能批量取，不用逐个问。
 *
 * 【账号维度隔离】同一台电脑先后登录不同微信号时，联系人 / 群名缓存
 * 按「当前登录账号(wxid)」隔离，避免换号后旧号数据串入新号
 * （信息泄露 / 显示错乱 / 误回复）。调用方须在 lookup/nameOf/search 时
 * 传入 account（当前登录 wxid）；未传则回落到 setCurrentAccount 设置的账号。
 */
export class ContactCache {
  constructor({ hook, db = 'contact.db', logger, ttlMs = 10 * 60 * 1000, dbCandidates, tableCandidates, resolveCooldownMs } = {}) {
    this.hook = hook;
    this.log = logger;
    this.ttlMs = ttlMs;
    /**
     * 联系人库/表名随微信版本漂移：
     *  · 新版：库 `contact.db`、表 `contact`
     *  · 老版：库 `MicroMsg.db`、表 `Contact`
     * 写死一个就可能在某个版本整张查空（群名/昵称全回退成 wxid），
     * 所以首次查询时自动探测「哪个库 + 哪个表真能查」，之后锁定复用。
     */
    this.dbCandidates = dbCandidates || [db, 'MicroMsg.db', 'MicroMsg.db.bak'];
    this.tableCandidates = tableCandidates || ['contact', 'Contact', 'contact_v1'];
    this.activeDb = null;
    this.activeTable = null;
    /** 探测全失败时记下时间，冷却期内不再反复探测（GUI 每次刷新都调，避免卡顿）。 */
    this.resolveFailedAt = 0;
    // 30 秒即可重试：5 分钟太久，用户刚启动助手后搜索会一直“没结果”，像是功能坏了
    this.resolveCooldownMs = resolveCooldownMs ?? 30 * 1000;
    /** account(wxid) -> Map(wxid -> name)，按账号隔离 */
    this.accounts = new Map();
    /** 当前账号（setCurrentAccount 设置；未设则回落全局） */
    this.current = '__global__';
    /** 查过但没查到的，避免每次都去问（跨账号共享防抖） */
    this.missing = new Map();
    this.lastQuery = 0;
  }

  /** 设置当前账号（当前登录的微信号 wxid），后续未显式传 account 的调用默认用此账号。 */
  setCurrentAccount(wxid) {
    this.current = wxid || '__global__';
    if (!this.accounts.has(this.current)) this.accounts.set(this.current, new Map());
    return this.current;
  }

  /** 清除某账号的缓存（换号时清旧号，避免旧数据残留）。 */
  invalidate(account) {
    this.accounts.delete(account || this.current);
  }

  _map(account) {
    const key = account || this.current;
    let m = this.accounts.get(key);
    if (!m) { m = new Map(); this.accounts.set(key, m); }
    return m;
  }

  static quote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
  }

  /**
   * 探测出真正可用的「库 + 表」组合。命中就锁定，失败就逐个试。
   * 库/表结构是账号无关的（同一微信安装目录），故全局单例缓存，不随账号变化。
   * @param {boolean} force 忽略失败冷却，立即重试（用户点了「搜索」时用）
   * @returns {Promise<boolean>} 是否找到了可用的联系人表
   */
  async resolveTable(force = false) {
    if (this.activeDb && this.activeTable) return true;
    if (!force && this.resolveFailedAt && Date.now() - this.resolveFailedAt < this.resolveCooldownMs) return false;
    if (force) this.resolveFailedAt = 0;
    for (const db of this.dbCandidates) {
      for (const table of this.tableCandidates) {
        try {
          const res = await this.hook.queryDb(
            `SELECT username, nick_name, remark FROM ${table} LIMIT 1`,
            db
          );
          // 与 lookup 同样的解析：能返回数组（哪怕空）就说明表存在
          const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : null;
          if (rows !== null) {
            this.activeDb = db;
            this.activeTable = table;
            this.log?.debug?.(`通讯录定位到 ${db}.${table}`);
            return true;
          }
        } catch {
          /* 这个库/表组合查不到，试下一个 */
        }
      }
    }
    this.resolveFailedAt = Date.now();
    this.log?.warn?.(
      '通讯录表未定位到（contact.db / MicroMsg.db 的 contact 表都无法查询），群名与昵称将不可用'
    );
    return false;
  }

  /** 批量补齐昵称（只查没缓存过的）。按 account 隔离。 */
  async lookup(ids, account) {
    if (!this.hook) return;
    if (!(await this.resolveTable())) return;
    const cache = this._map(account);
    const now = Date.now();
    const want = [];
    for (const id of ids || []) {
      const wxid = String(id || '').trim();
      if (!wxid) continue;
      if (cache.has(wxid)) continue;
      const missAt = this.missing.get(wxid) || 0;
      if (now - missAt < this.ttlMs) continue;
      want.push(wxid);
    }
    if (!want.length) return;

    // 别一次问太多，分批
    for (let i = 0; i < want.length; i += 100) {
      const batch = want.slice(i, i + 100);
      const sql =
        `SELECT username, nick_name, remark FROM ${this.activeTable} WHERE username IN (${batch
          .map((id) => ContactCache.quote(id))
          .join(',')})`;
      try {
        const res = await this.hook.queryDb(sql, this.activeDb);
        const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        for (const r of rows) {
          const name = r.remark || r.nick_name || '';
          if (r.username && name) cache.set(String(r.username), String(name));
        }
        for (const id of batch) {
          if (!cache.has(id)) this.missing.set(id, now);
        }
        this.lastQuery = now;
      } catch (err) {
        this.log?.debug?.(`通讯录查询失败: ${err.message}`);
        return;
      }
    }
  }

  /** 显示名（没有就返回空串）。按 account 隔离。 */
  nameOf(wxid, account) {
    if (!wxid) return '';
    return this._map(account).get(String(wxid)) || '';
  }

  /** 缓存里的全部条目（给 GUI 展示用）。按 account 隔离。 */
  entries(account) {
    return [...this._map(account).entries()].map(([wxid, name]) => ({ wxid, name }));
  }

  /**
   * 按关键字模糊搜索联系人（群名 / 昵称 / 备注 / 微信号）。
   * 关键字为空时列出前 N 个（让不知道怎么搜的人也能直接挑）。
   * 与 lookup 不同：这里**把失败原因带回去**，界面才能说清「为什么搜不到」。
   * @param {string} keyword
   * @param {number} limit
   * @param {{force?: boolean}} opts force=true 时忽略失败冷却、立即重探通讯录表
   * @param {string} [account] 当前登录账号；不传则用 setCurrentAccount 设置的账号
   * @returns {Promise<{ok:boolean, results:Array<{id:string,name:string}>, reason?:string, browse?:boolean}>}
   */
  async search(keyword, limit = 30, { force = false } = {}, account) {
    const kw = String(keyword || '').trim();
    const resolved = await this.resolveTable(force);
    if (!resolved) {
      return {
        ok: false,
        results: [],
        reason: '读不到通讯录表：这个 DLL 可能不支持 /QueryDB/execute，或微信版本不匹配',
      };
    }
    // 转义单引号（防注入）与 LIKE 通配符（让用户输入的字面匹配，不被当通配）
    const safe = kw.replace(/'/g, "''").replace(/[\\%_]/g, (c) => '\\' + c);
    const n = Math.max(1, Math.min(200, Number(limit) || 30));
    const where = kw
      ? `WHERE username LIKE '%${safe}%' OR nick_name LIKE '%${safe}%' OR remark LIKE '%${safe}%' `
      : '';
    const sql = `SELECT username, nick_name, remark FROM ${this.activeTable} ${where}LIMIT ${n}`;
    const cache = this._map(account);
    try {
      const res = await this.hook.queryDb(sql, this.activeDb);
      const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : null;
      if (rows === null) {
        return { ok: false, results: [], reason: '查询返回空（DLL 拒绝或表不存在），稍后可重试' };
      }
      const out = [];
      for (const r of rows) {
        const id = r.username;
        if (!id) continue;
        const name = String(r.remark || r.nick_name || '').trim() || id;
        cache.set(String(id), String(name)); // 命中即缓存（按账号隔离）
        out.push({ id: String(id), name });
      }
      return { ok: true, results: out, browse: !kw };
    } catch (err) {
      return { ok: false, results: [], reason: '查询通讯录失败：' + (err?.message || err) };
    }
  }
}
