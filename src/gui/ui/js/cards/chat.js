/**
 * 卡片：上下文记忆 + 按会话配置。
 */
(function (g) {
  const W = g.W;
  const cards = g.cards ? g.cards : {};

  /** 上下文记忆卡。 */
  cards.context = function (state) {
    const a = state.config.ai;
    // 缺省兜底：即使 .env 里没写，也给出与 config.js 一致的默认值，避免输入框空白
    const pickNum = (val, d) =>
      (val === '' || val === null || val === undefined || !Number.isFinite(Number(val)) ? d : Number(val));
    const rows = (state.memory || []).map((m) =>
      '<tr><td><b>' + W.esc(m.name ? m.name : m.chatId) + '</b>' +
      (m.name ? ' <span class="dim">' + W.esc(m.chatId) + '</span>' : '') +
      '</td><td>' + m.messages + '</td><td>' +
      (m.updatedAt ? new Date(m.updatedAt).toLocaleString() : '-') + '</td><td>' +
      W.esc((m.last || []).map((x) => (x.role === 'user' ? '›' : '‹') + ' ' + x.content).join(' | ')) +
      '</td><td><button class="btn ghost" data-clear="' + W.esc(m.chatId) + '">清空</button></td></tr>').join('');

    return W.card('上下文记忆',
      '<div class="grid">' +
      W.numField('每个会话保留几轮', pickNum(a.contextTurns, 8), 'ctxTurns', 'ai.contextTurns') +
      W.numField('字符预算上限', pickNum(a.contextMaxChars, 6000), 'ctxChars', 'ai.contextMaxChars') +
      W.numField('闲置多久清空（毫秒）', pickNum(a.contextTtlMs, 30 * 60 * 1000), 'ctxTtl', 'ai.contextTtlMs') +
      '</div>' +
      '<div class="row end"><button class="btn primary" id="btnSaveCtx">保存记忆设置</button></div>' +
      '<table class="tbl"><thead><tr><th>会话</th><th>条数</th><th>最后更新</th><th>最近内容</th><th></th></tr></thead><tbody>' +
      (rows ? rows : '<tr><td colspan="5">还没有上下文记录</td></tr>') +
      '</tbody></table>' +
      '<div class="row end"><button class="btn danger ghost" id="btnClearAllCtx">清空全部上下文</button></div>' +
      W.nextHint('上下文是明文聊天记录，别同步到网盘'), '推荐');
  };

  /** 按会话配置卡：每个会话一个开关 + 策略分段；搜索到联系人可一键加入。 */
  cards.chats = function (state, chatForm) {
    const list = Object.keys(state.chats || {});
    const polled = (state.config && state.config.wechat && state.config.wechat.pollChats) || [];
    // 与运行期一致：WX_POLL_CHATS 为空时，启用的会话就是实际在监听的会话
    const effective = polled.length
      ? polled
      : list.filter((id) => (state.chats[id] || {}).enabled !== false);
    const rows = list.map((id) => {
      const c = state.chats[id] || {};
      // 没有名字时必须显示 wxid，否则用户根本认不出是哪个会话
      const title = c.name ? c.name : id;
      const listening = effective.includes(id);
      // G31：局部覆盖全局必须可见 —— 否则「全局是 A、这个群配了 B」到底用哪个，用户无从判断。
      // 悬停标签可看到「全局 X → 此会话 Y」的完整对照。
      const OVR = {
        model: '模型', baseUrl: '地址', apiKey: '密钥', personaFile: '人设',
        systemPrompt: '人设文本', reasoningEffort: '思考', triggerPrefix: '触发前缀',
        replyMode: '回复模式', webSearch: '联网搜索', aiTools: 'AI工具',
        modelRouting: '双模型路由', longTaskNotice: '长任务提示', docAnalysis: '文档解读',
      };
      const gai = (state.config && state.config.ai) || {};
      const gv = {
        model: gai.model, baseUrl: gai.baseUrl, apiKey: undefined,
        personaFile: gai.personaFile, systemPrompt: gai.systemPrompt,
        reasoningEffort: gai.reasoningEffort, triggerPrefix: gai.triggerPrefix,
        replyMode: gai.replyMode,
      };
      const ovrKeys = Object.keys(OVR).filter((k) => {
        const v = c[k];
        return v !== undefined && v !== null && String(v).trim() !== '';
      });
      const ovrTip = ovrKeys
        .map((k) => (gv[k] ? OVR[k] + '：全局 ' + gv[k] + ' → 此会话 ' + c[k] : OVR[k] + '：' + c[k] + '（全局未配）'))
        .join('\n');
      const ovrTag = ovrKeys.length
        ? '<span class="tag ovr" title="' + W.esc(ovrTip) + '">覆盖 ' + ovrKeys.length + ' 项：' +
          W.esc(ovrKeys.map((k) => OVR[k]).join('、')) + '</span>'
        : '';
      const head = '<div class="chatrow-head"><b>' + W.esc(title) + '</b>' +
        (c.name ? '<span class="dim">' + W.esc(id) + '</span>' : '') +
        '<span class="chatrow-tags">' +
        '<span class="tag opt">' + (id.endsWith('@chatroom') ? '群' : '好友') + '</span>' +
        (listening ? '<span class="tag rec">已在监听</span>' : '<span class="tag warn">未监听</span>') +
        ovrTag +
        '</span></div>';
      const sw = W.switchRow({
        id: 'chat-' + id,
        title: '参与自动回复',
        desc: '关掉后这个会话完全不参与（不回复、也不记上下文）',
        value: c.enabled !== false,
        effect: '立即生效',
      });
      const seg = W.segRow({
        id: 'chat-reply-' + id,
        bind: 'chat.' + id + '.groupReply',
        title: '这个会话什么时候回',
        desc: '跟随全局＝继承「接一个模型」里的群策略',
        value: c.groupReply ? c.groupReply : '',
        options: [
          { value: '', label: '跟随全局' },
          { value: 'always', label: '都回' },
          { value: 'mention', label: '@我才回' },
          { value: 'never', label: '不回' },
        ],
      });
      const persona = W.field('专属人设文件', c.personaFile ? c.personaFile : '', 'persona-' + id, 'text', './data/persona.md');
      const replySeg = W.segRow({
        id: 'chat-replymode-' + id,
        bind: 'chat.' + id + '.replyMode',
        title: '这个会话怎么回',
        desc: '跟随全局＝继承上方「全局回复模式」',
        value: c.replyMode ? c.replyMode : '',
        options: [
          { value: '', label: '跟随全局' },
          { value: 'single', label: '单条回复' },
          { value: 'batch', label: '多消息合批' },
        ],
      });
      const wsSeg = W.segRow({
        id: 'chat-ws-' + id,
        bind: 'chat.' + id + '.webSearch',
        title: '这个会话要不要联网搜索',
        desc: '跟随全局＝继承总开关；开＝仅此会话联网检索（查询发往第三方搜索服务）',
        value: c.webSearch === undefined ? '' : (c.webSearch ? '1' : '0'),
        options: [
          { value: '', label: '跟随全局' },
          { value: '1', label: '开' },
          { value: '0', label: '关' },
        ],
      });
      const toolsSeg = W.segRow({
        id: 'chat-tools-' + id,
        bind: 'chat.' + id + '.aiTools',
        title: '这个会话要不要 AI 工具调用',
        desc: '跟随全局＝继承总开关；开＝模型可在此会话调工具（联网搜索 / 计算 / 时间，受白名单约束）',
        value: c.aiTools === undefined ? '' : (c.aiTools ? '1' : '0'),
        options: [
          { value: '', label: '跟随全局' },
          { value: '1', label: '开' },
          { value: '0', label: '关' },
        ],
      });
      const routingSeg = W.segRow({
        id: 'chat-routing-' + id,
        bind: 'chat.' + id + '.modelRouting',
        title: '这个会话要不要按复杂度切换模型',
        desc: '跟随全局＝继承高级模式开关；开＝仅此会话启用双模型路由',
        value: c.modelRouting === undefined ? '' : (c.modelRouting ? '1' : '0'),
        options: [
          { value: '', label: '跟随全局' },
          { value: '1', label: '开' },
          { value: '0', label: '关' },
        ],
      });
      const noticeSeg = W.segRow({
        id: 'chat-notice-' + id,
        bind: 'chat.' + id + '.longTaskNotice',
        title: '这个会话长任务要不要先发提示',
        desc: '跟随全局＝继承总开关；开＝先发「正在…中」，结果另起一条新消息',
        value: c.longTaskNotice === undefined ? '' : (c.longTaskNotice ? '1' : '0'),
        options: [
          { value: '', label: '跟随全局' },
          { value: '1', label: '开' },
          { value: '0', label: '关' },
        ],
      });
      const docSeg = W.segRow({
        id: 'chat-doc-' + id,
        bind: 'chat.' + id + '.docAnalysis',
        title: '这个会话要不要解读文档附件',
        desc: '跟随全局＝继承总开关；开＝仅此会话抽取附件文本（纯本地解析）',
        value: c.docAnalysis === undefined ? '' : (c.docAnalysis ? '1' : '0'),
        options: [
          { value: '', label: '跟随全局' },
          { value: '1', label: '开' },
          { value: '0', label: '关' },
        ],
      });
      return '<div class="chatrow" data-chat="' + W.esc(id) + '">' + head + sw + seg + replySeg + wsSeg + toolsSeg + routingSeg + noticeSeg + docSeg + persona +
        '<div class="row end"><button class="btn ghost" data-chatdel="' + W.esc(id) + '">移除</button></div></div>';
    }).join('');

    // 全局回复模式（G33）：单条回复 vs 多消息合批。默认单条，按需给个别群开合批。
    const globalReply = W.segRow({
      id: 'globalReplyMode',
      bind: 'ai.replyMode',
      title: '全局回复模式',
      desc: '单消息回复＝每条独立回答；多消息合批＝攒 10 分钟内、近 10 条群消息，统一回答一次。建议保持「单消息回复」，只在需要总结的群单独开「合批」。',
      value: (state.config && state.config.ai && state.config.ai.replyMode) || 'single',
      options: [
        { value: 'single', label: '单消息回复' },
        { value: 'batch', label: '多消息合批' },
      ],
    });

    const results = (chatForm && chatForm.results) || [];
    const search = results.map((r) =>
      '<div class="sr-item"><span><b>' + W.esc(r.name ? r.name : r.id) + '</b>' +
      (r.name && r.name !== r.id ? '<span class="dim">' + W.esc(r.id) + '</span>' : '') + '</span>' +
      '<button type="button" class="btn sm primary" data-add="' + W.esc(r.id) + '">加入</button></div>').join('');
    const searchMsg = (chatForm && chatForm.searchMsg) || '';

    return W.card('按会话配置',
      globalReply +
      (rows ? rows : '<p class="hint">还没有单独配置的会话 —— 所有会话都用全局设置。</p>') +
      '<div class="chat-tools">' +
      '<div class="chat-search">' +
      '<input id="newChatId" class="grow" value="' + W.esc((chatForm && chatForm.query) || '') +
      '" placeholder="输入群名 / 昵称 / 微信号，回车搜索；留空则列出通讯录" autocomplete="off">' +
      '<button class="btn primary" id="btnSearchContacts">搜索联系人</button>' +
      '</div>' +
      '<div class="row chat-actions">' +
      '<button class="btn" id="btnAddChat">按 wxid 直接加入</button>' +
      '<button class="btn primary" id="btnSaveChats">保存全部会话</button>' +
      '<span class="chat-count">已监听 ' + effective.length + ' 个会话</span>' +
      '</div></div>' +
      (search ? '<div class="search-results">' + search + '</div>' : '') +
      (searchMsg ? '<p class="hint search-msg">' + W.esc(searchMsg) + '</p>' : '') +
      W.nextHint('加入后会自动写进「监听会话」，不用再手填；改完策略记得点「保存全部会话」'), '推荐');
  };

  /** 群可用性卡（HI7）：与「环境体检」卡分离，只看「哪些群在听」。 */
  cards.chatAvailability = function (state, avail) {
    if (!avail) return '';
    const items = avail.items || [];
    const rows = items.map((it) => {
      const lv = it.level === 'bad' ? 'bad' : it.level === 'warn' ? 'warn' : 'ok';
      const detail = W.esc(it.detail || '');
      const next = it.next ? '<div class="dim">' + W.esc(it.next) + '</div>' : '';
      return '<div class="check ' + lv + '"><span class="lv">' +
        (lv === 'ok' ? '✓' : lv === 'warn' ? '!' : '✗') +
        '</span><div><b>' + W.esc(it.name || '') + '</b> ' + detail + next + '</div></div>';
    }).join('');
    const bad = items.filter((i) => i.level === 'bad').length;
    return W.card('群可用性（哪些群在听）',
      (rows ? rows : '<p class="hint">没有可检查的会话</p>') +
      '<div class="row end">' +
      (bad ? '<span class="tag warn">' + bad + ' 项需处理</span>' : '<span class="tag opt">没有阻断项</span>') +
      '</div>' +
      W.nextHint('只看「群能否收到消息」，环境本身请去「环境体检」卡；本卡不会自动发现未配置的群'), '推荐');
  };

  g.cards = cards;
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
