/**
 * 卡片：上下文记忆 + 按会话配置。
 */
(function (g) {
  const W = g.W;
  const cards = g.cards ? g.cards : {};

  /** 上下文记忆卡。 */
  cards.context = function (state) {
    const a = state.config.ai;
    const rows = (state.memory || []).map((m) =>
      '<tr><td><b>' + W.esc(m.name ? m.name : m.chatId) + '</b>' +
      (m.name ? ' <span class="dim">' + W.esc(m.chatId) + '</span>' : '') +
      '</td><td>' + m.messages + '</td><td>' +
      (m.updatedAt ? new Date(m.updatedAt).toLocaleString() : '-') + '</td><td>' +
      W.esc((m.last || []).map((x) => (x.role === 'user' ? '›' : '‹') + ' ' + x.content).join(' | ')) +
      '</td><td><button class="btn ghost" data-clear="' + W.esc(m.chatId) + '">清空</button></td></tr>').join('');

    return W.card('上下文记忆',
      '<div class="grid">' +
      W.numField('每个会话保留几轮', a.contextTurns, 'ctxTurns', 'ai.contextTurns') +
      W.numField('字符预算上限', a.contextMaxChars, 'ctxChars', 'ai.contextMaxChars') +
      W.numField('闲置多久清空（毫秒）', a.contextTtlMs, 'ctxTtl', 'ai.contextTtlMs') +
      '</div>' +
      '<div class="row end"><button class="btn primary" id="btnSaveCtx">保存记忆设置</button></div>' +
      '<table class="tbl"><thead><tr><th>会话</th><th>条数</th><th>最后更新</th><th>最近内容</th><th></th></tr></thead><tbody>' +
      (rows ? rows : '<tr><td colspan="5">还没有上下文记录</td></tr>') +
      '</tbody></table>' +
      '<div class="row end"><button class="btn danger ghost" id="btnClearAllCtx">清空全部上下文</button></div>' +
      W.nextHint('上下文是明文聊天记录，别同步到网盘'), '推荐');
  };

  /** 按会话配置卡：每个会话一个开关 + 策略分段。 */
  cards.chats = function (state, chatForm) {
    const list = Object.keys(state.chats || {});
    const rows = list.map((id) => {
      const c = state.chats[id] || {};
      const title = c.name ? c.name : (id.endsWith('@chatroom') ? '群' : '好友');
      const sw = W.switchRow({
        id: 'chat-' + id,
        title: title,
        desc: '关掉后这个会话完全不参与（' + (id.endsWith('@chatroom') ? '群' : '好友') + '）',
        value: c.enabled !== false,
        effect: '立即生效',
      });
      const seg = W.segRow({
        id: 'chat-reply-' + id,
        bind: 'chat.' + id + '.groupReply',
        title: '群策略',
        desc: '这个会话什么时候回（跟随全局＝继承上面的设置）',
        value: c.groupReply ? c.groupReply : '',
        options: [
          { value: '', label: '跟随全局' },
          { value: 'always', label: '都回' },
          { value: 'mention', label: '@我才回' },
          { value: 'never', label: '不回' },
        ],
      });
      const persona = W.field('专属人设文件', c.personaFile ? c.personaFile : '', 'persona-' + id, 'text', './data/persona.md');
      return '<div class="chatrow" data-chat="' + W.esc(id) + '">' + sw + seg + persona +
        '<div class="row end"><button class="btn ghost" data-chatdel="' + W.esc(id) + '">移除</button></div></div>';
    }).join('');

    const search = (chatForm && chatForm.results ? chatForm.results : []).map((r) =>
      '<button type="button" class="chip' + (chatForm.picked && chatForm.picked.id === r.id ? ' on' : '') +
      '" data-add="' + W.esc(r.id) + '">' + W.esc(r.name ? r.name : r.id) + '<i>' + W.esc(r.id) + '</i></button>').join('');

    return W.card('按会话配置',
      (rows ? rows : '<p class="hint">还没有单独配置的会话 —— 所有会话都用全局设置。</p>') +
      '<div class="row"><input id="newChatId" placeholder="新会话 wxid，或输入群名/昵称关键字搜索">' +
      '<button class="btn ghost" id="btnSearchContacts">搜索联系人</button>' +
      '<button class="btn" id="btnAddChat">按 wxid 加入</button>' +
      '<button class="btn primary" id="btnSaveChats">保存会话表</button></div>' +
      (search ? '<div class="chips">' + search + '</div>' : '') +
      W.nextHint('加了会话还要把它的 wxid 填进「监听会话」，否则收不到消息'), '推荐');
  };

  g.cards = cards;
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
