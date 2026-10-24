/**
 * 通讯录缓存：wxid → 昵称 / 群名。
 *
 * 为什么需要：prompt 里必须告诉模型「在跟谁说话、在哪个群」。
 * 只给 wxid 的话，模型要么自问自答「wxid_qr6ni... 是谁」，
 * 要么把 wxid 原样抄进回复里（实测见过）。
 *
 * 查的是本地 contact.db，一个 SQL 就能批量取，不用逐个问。
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
    this.resolveCooldownMs = resolveCooldownMs ?? 5 * 60 * 1000;
    /** wxid -> 显示名 */
    this.cache = new Map();
    /** 查过但没查到的，避免每次都去问 */
    this.missing = new Map();
    this.lastQuery = 0;
  }

  static quote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
  }

  /**
   * 探测出真正可用的「库 + 表」组合。命中就锁定，失败就逐个试。
   * @returns {Promise<boolean>} 是否找到了可用的联系人表
   */
  async resolveTable() {
    if (this.activeDb && this.activeTable) return true;
    if (this.resolveFailedAt && Date.now() - this.resolveFailedAt < this.resolveCooldownMs) return false;
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

  /** 批量补齐昵称（只查没缓存过的）。 */
  async lookup(ids) {
    if (!this.hook) return;
    if (!(await this.resolveTable())) return;
    const now = Date.now();
    const want = [];
    for (const id of ids || []) {
      const wxid = String(id || '').trim();
      if (!wxid) continue;
      if (this.cache.has(wxid)) continue;
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
          if (r.username && name) this.cache.set(String(r.username), String(name));
        }
        for (const id of batch) {
          if (!this.cache.has(id)) this.missing.set(id, now);
        }
        this.lastQuery = now;
      } catch (err) {
        this.log?.debug?.(`通讯录查询失败: ${err.message}`);
        return;
      }
    }
  }

  /** 显示名（没有就返回空串）。 */
  nameOf(wxid) {
    if (!wxid) return '';
    return this.cache.get(String(wxid)) || '';
  }

  /** 缓存里的全部条目（给 GUI 展示用）。 */
  entries() {
    return [...this.cache.entries()].map(([wxid, name]) => ({ wxid, name }));
  }

  /**
   * 按关键字模糊搜索联系人（群名 / 昵称 / 备注 / 微信号）。
   * 命中后写入缓存，返回 [{ id, name }]。hook 不可达或没定位到通讯录表时返回空数组。
   * @param {string} keyword
   * @param {number} limit
   */
  async search(keyword, limit = 30) {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    await this.resolveTable();
    if (!this.activeDb || !this.activeTable) return [];
    // 转义单引号（防注入）与 LIKE 通配符（让用户输入的字面匹配，不被当通配）
    const safe = kw.replace(/'/g, "''").replace(/[\\%_]/g, (c) => '\\' + c);
    const sql =
      `SELECT username, nick_name, remark FROM ${this.activeTable} ` +
      `WHERE username LIKE '%${safe}%' OR nick_name LIKE '%${safe}%' OR remark LIKE '%${safe}%' ` +
      `LIMIT ${Number(limit) || 30}`;
    try {
      const res = await this.hook.queryDb(sql, this.activeDb);
      const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
      const out = [];
      for (const r of rows) {
        const id = r.username;
        if (!id) continue;
        const name = String(r.remark || r.nick_name || '').trim() || id;
        this.cache.set(String(id), String(name)); // 命中即缓存
        out.push({ id: String(id), name });
      }
      return out;
    } catch {
      return [];
    }
  }
}
