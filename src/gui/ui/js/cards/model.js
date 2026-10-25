/**
 * 卡片：接一个模型 + 本地模型服务。
 */
(function (g) {
  const W = g.W;
  const cards = g.cards ? g.cards : {};

  /** AI 卡：选来源 → 填地址/密钥/模型 → 现场测一次。 */
  cards.ai = function (state, form) {
    const a = state.config.ai;
    const f = form.ai;

    const sources = [];
    (f.options || []).forEach((o, i) => {
      sources.push('<button type="button" class="src-item' + (o.id === f.providerId ? ' on' : '') +
        '" data-src="' + W.esc(o.id) + '"><b>' + W.esc(o.name) + '</b>' +
        '<span>' + W.esc(o.baseUrl ? o.baseUrl : '自己填地址') + '</span>' +
        (o.online ? '<i class="tag rec">● 在线</i>' : '') + '</button>');
    });

    const review = (f.review || []).map((t) => '<span class="tag opt">' + W.esc(t.text) + '</span>').join(' ');

    const step1 = '<h3><span class="n">1</span>模型从哪来</h3><div class="srcs">' + sources.join('') + '</div>';
    const step2 = '<h3><span class="n">2</span>地址 / 密钥 / 模型名</h3><div class="grid">' +
      W.field('接口地址（一般到 /v1 为止）', f.base, 'aiBaseUrl', 'text', 'http://127.0.0.1:11434/v1', 'ai.base') +
      W.field('密钥（本地模型不用填）', '', 'aiApiKey', 'password', 'sk-…', 'ai.key') +
      W.field('模型名', f.model, 'aiModel', 'text', 'qwen2.5:7b', 'ai.model') +
      '</div>';
    const step3 = '<h3><span class="n">3</span>测一下能不能用</h3>' +
      '<div class="row">' +
      '<button class="btn" id="btnPullModels">拉取模型列表</button>' +
      '<button class="btn primary" id="btnTestAi">测试一下能不能用</button>' + review + '</div>' +
      (f.result ? '<p class="testres ' + (f.result.ok ? 'ok' : 'bad') + '">' +
        W.esc(f.result.ok ? '成功：' + f.result.reply : (f.result.title ? f.result.title + '：' + f.result.detail : f.result.detail)) +
        '</p>' : '');

    const adv = '<details class="adv"><summary>高级项（群策略、@ 称呼、限流…）</summary><div class="adv-body"><div class="grid">' +
      W.segRow({
        id: 'groupReply', bind: 'ai.groupReply',
        title: '群聊什么时候回',
        desc: '群里 @ 我才回（最省）/ 群里说的话都回 / 群里一律不回',
        value: a.groupReply,
        options: [
          { value: 'mention', label: '群里@我才回' },
          { value: 'always', label: '群里都回' },
          { value: 'never', label: '群里不回' },
        ],
      }) +
      W.field('群里 @ 我时认可的称呼（逗号分隔）', f.atNames, 'aiAtNames', 'text', '小助手,机器人', 'ai.atNames') +
      W.field('触发前缀（留空表示不需要）', f.triggerPrefix, 'aiTriggerPrefix', 'text', '小助手', 'ai.triggerPrefix') +
      W.numField('每小时最多回复条数', a.maxPerHour, 'aiMaxPerHour', 'ai.maxPerHour') +
      W.numField('同一会话最小间隔（毫秒）', a.cooldownMs, 'aiCooldownMs', 'ai.cooldownMs') +
      W.numField('最多同时处理几条', a.maxConcurrent, 'aiMaxConcurrent', 'ai.maxConcurrent') +
      '</div></details>';

    const tip = !a.baseUrl
      ? '还没选模型来源 —— 上面选一个，本机在跑的会自动排在最前。'
      : '测通了记得点「保存 AI 配置」。';

    return W.card('接一个模型', step1 + step2 + step3 + adv +
      '<div class="row end"><button class="btn primary big" id="btnSaveAi">保存 AI 配置</button></div>' +
      W.nextHint(tip), '必须');
  };

  /** 本地模型服务卡：本地可启停，云端只读。 */
  cards.modelService = function (state, ms) {
    if (!ms) return '';
    const rows = (ms.runners || []).map((r) => {
      const line = '<li class="dg-item ' + (r.installed ? 'ok' : 'warn') + '"><b>' + W.esc(r.name) + '</b>' +
        '<span>' + W.esc(r.installed ? '已安装' : '未检测到') + (r.exe ? '（' + W.esc(r.exe) + '）' : '') + '</span></li>';
      // 没装 Ollama：给一个"下载并安装"的按钮（自动拉官方安装包并静默安装，需联网）
      const installBtn = (!r.installed && r.id === 'ollama')
        ? W.actRow({
          title: '装一个本地模型引擎',
          desc: '推荐 Ollama：数据不出本机。点下面会自动下载并安装（需要联网）',
          label: '下载并安装 Ollama',
          action: 'model-service-install',
        })
        : '';
      return line + installBtn;
    }).join('');

    const act = ms.online
      ? W.actRow({
        title: '本地模型服务',
        desc: '地址 ' + W.esc(ms.baseUrl) + ' 在线' + (ms.startedByUs ? ' · 由 AutoChat 启动（pid ' + ms.pid + '）' : ''),
        label: '停止模型服务',
        action: 'model-service-stop',
        danger: true,
      })
      : W.actRow({
        title: '本地模型服务',
        desc: '地址 ' + W.esc(ms.baseUrl) + ' 连不上 —— 本机装了 Ollama 的话可以一键拉起来（无需联网）',
        label: '启动模型服务',
        action: 'model-service-start',
      });

    // 在线但里面没有模型：给一个"拉默认模型"的按钮（需联网，几百 MB～1GB）
    const noModelBtn = ms.online && (!ms.models || ms.models.length === 0)
      ? W.actRow({
        title: '还没有模型',
        desc: '本地模型引擎已起，但里面是空的。点下面拉一个最小可用的中文模型（需联网）',
        label: '拉取默认模型（qwen2.5:1.5b）',
        action: 'model-service-pull',
      })
      : '';

    const cloud = '<p class="hint">云端模型由服务商托管，我们只能检测连通性，不能替你启停。</p>';
    const hint = ms.online
      ? '模型就绪后，去「接一个模型」卡确认地址与模型名，点保存并重启助手即可生效。'
      : '本机没装就先点上面「下载并安装 Ollama」。';

    return W.card('模型服务', '<ul class="dg-list">' + rows + '</ul>' + act + noModelBtn + cloud +
      W.nextHint(hint), '推荐');
  };

  g.cards = cards;
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
