/**
 * 卡片：接一个模型 + 本地模型服务。
 */
(function (g) {
  const W = g.W;
  const cards = g.cards ? g.cards : {};

  /** AI 卡：先看本机服务 → 选来源 / 点选模型 → 现场测一次。 */
  cards.ai = function (state, form, ms) {
    const a = state.config.ai;
    const f = form.ai;
    const providerId = f.providerId || '';
    const current = (f.options || []).find((o) => o.id === providerId);
    const isCustom = providerId === 'custom';
    // 数值缺省兜底：没配置时也给出默认数字，别让小白面对空框
    const num = (v, d) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));
    const models = Array.isArray(f.models) ? f.models : [];
    const nameOf = (m) => (typeof m === 'string' ? m : (m && m.name ? String(m.name) : String(m)));
    const svcModels = ms && Array.isArray(ms.models) ? ms.models : [];
    const svcOnline = ms ? Boolean(ms.online) : null;
    // 本机来源（预设/发现的本机服务）才需要看「服务是否在线」
    const localCtx = !current || current.online !== undefined || /127\.0\.0\.1|localhost/i.test(current.baseUrl || '');

    // 步骤 1：先看本机服务是否在线，再选来源 —— 小白卡住的九成是服务没启动
    const menu = (f.options || []).map((o) =>
      '<li class="dd-item' + (o.id === providerId ? ' on' : '') + '" data-src="' + W.esc(o.id) + '">' +
      '<b>' + W.esc(o.name) + '</b><span>' + W.esc(o.baseUrl ? o.baseUrl : '自定义地址') + '</span>' +
      (o.online ? '<i class="tag rec">● 在线</i>' : '') + '</li>').join('');
    const ddLabel = current ? current.name : (isCustom ? '自定义…' : '请选择模型来源…');
    const banner = !localCtx ? '' : svcOnline === true
      ? '<div class="svc-banner ok">✓ 本机模型服务在线' + (ms.baseUrl ? ' · ' + W.esc(ms.baseUrl) : '') +
        ' · ' + (svcModels.length ? svcModels.length + ' 个模型可用' : '还没有模型，点下面「拉取默认模型」') + '</div>'
      : svcOnline === false
        ? '<div class="svc-banner bad">✗ 本机模型服务没启动 —— 本地模型「调取不了」九成是这个原因</div>'
        : '';
    const svcBtns = !localCtx ? '' : '<div class="row model-actions">' +
      (svcOnline === false ? '<button class="btn primary" data-act="model-service-start">启动模型服务</button>' : '') +
      (svcOnline === true && !svcModels.length ? '<button class="btn" data-act="model-service-pull">拉取默认模型</button>' : '') +
      '<button class="btn" id="btnRediscover">重新检测本机服务</button>' +
      '</div>';
    // 当前真正生效的配置（以 .env 为准）：必须摆在最前面。
    // 否则用户看到的是下拉框的预选值，保存时却把真正在跑的配置换掉了。
    const liveLine = '<p class="hint">当前生效：<b>' +
      (a.baseUrl ? W.esc(a.baseUrl) + '</b> · 模型 <b>' + W.esc(a.model || '未填') + '</b>'
        : '还没配置（下面选好要保存才生效）') +
      ' · 视觉模型 <b>' + W.esc(a.visionModel || '同主模型') + '</b></p>';
    const secretHint = '<p class="hint">密钥填了立即自动保存并替换旧的；想删就清空再失焦（会二次确认）。</p>';
    // 密钥类：默认就显示「有没有、是什么」（本人本机，不外发）
    const sec = (state.secrets && state.secrets.aiApiKey) || { present: false, value: '' };

    const step1 = '<h3><span class="n">1</span>模型从哪来（先看本机服务）</h3>' + liveLine + banner +
      '<div class="dropdown" data-dd="provider">' +
      '<button type="button" class="dd-toggle" data-dd-toggle><span>' + W.esc(ddLabel) +
      '</span><span class="caret">▾</span></button>' +
      '<ul class="dd-menu">' + menu +
      '<li class="dd-item' + (isCustom ? ' on' : '') + '" data-src="custom"><b>自定义…</b>' +
      '<span>自己填接口地址 / 模型名 / 密钥</span></li></ul></div>' + svcBtns;

    // 步骤 2：确认 / 填写来源与模型名；模型名始终可填，且能直接点选已拉到的模型
    const modelField = W.field('模型名（也可在下面列表点选）', f.model, 'aiModel', 'text', 'qwen2.5:7b', 'ai.model');
    let step2inner;
    if (isCustom) {
      step2inner = '<div class="grid">' +
        W.field('接口地址（一般到 /v1 为止）', f.base, 'aiBaseUrl', 'text', 'http://127.0.0.1:11434/v1', 'ai.base') +
        W.secretField('密钥（本地模型不用填，云端模型才需要）', sec.value, 'aiApiKey', 'ai.key', sec.present, 'sk-…') +
        '</div>' + modelField;
    } else if (current) {
      step2inner = '<p class="hint">已选：<b>' + W.esc(current.name) + '</b> · ' + W.esc(current.baseUrl || '') +
        (current.model ? ' · 预设模型 ' + W.esc(current.model) : '') + '</p>' +
        (current.needsKey
          ? W.secretField('密钥（' + current.name + ' 需要）', sec.value, 'aiApiKey', 'ai.key', sec.present, 'sk-…')
          : '<p class="hint">该来源无需密钥。</p>') +
        modelField;
    } else {
      step2inner = '<p class="hint">先在上面选择一个模型来源（也可以直接在下面填模型名）。</p>' + modelField;
    }
    const modelChips = models.length
      ? '<div class="picks-title">点选模型（共 ' + models.length + ' 个）</div><div class="chips">' +
        models.map((m) => {
          const nm = nameOf(m);
          return '<button type="button" class="chip' + (nm === f.model ? ' on' : '') +
            '" data-model="' + W.esc(nm) + '">' + W.esc(nm) + '</button>';
        }).join('') + '</div>'
      : '';
    const offlineGuide = localCtx && svcOnline === false
      ? '<div class="svc-banner bad">服务没起来时，拉模型列表和测试都会失败。先点上面「启动模型服务」。</div>'
      : '';
    const step2 = '<h3><span class="n">2</span>确认来源与模型</h3>' + offlineGuide + step2inner + secretHint + modelChips;

    // 步骤 3：测一次，失败时直接给排查顺序
    const step3 = '<h3><span class="n">3</span>测一下能不能用</h3>' +
      '<div class="row">' +
      '<button class="btn" id="btnPullModels">拉取模型列表</button>' +
      '<button class="btn primary" id="btnTestAi">测试一下能不能用</button>' +
      '</div>' +
      (f.result ? '<p class="testres ' + (f.result.ok ? 'ok' : 'bad') + '">' +
        W.esc(f.result.ok ? '成功：' + f.result.reply : (f.result.title ? f.result.title + '：' + f.result.detail : f.result.detail)) +
        '</p>' : '') +
      (f.result && !f.result.ok
        ? '<p class="hint">排查顺序：① 本机服务是否在线 → ② 模型名是否在列表里 → ③ 点「重新检测本机服务」</p>'
        : '');

    const adv = '<details class="adv" data-adv="ai-adv"><summary>高级项（群策略、思考强度、限流…）</summary><div class="adv-body"><div class="grid">' +
      W.field('视觉模型（带图消息用它来「看图」；留空＝同上面的主模型）', f.visionModel, 'aiVisionModel', 'text', 'gpt-4o', 'ai.visionModel') +
      W.segRow({
        id: 'reasoningEffort',
        bind: 'ai.reasoningEffort',
        title: '思考强度',
        desc: '推理模型先想多久再回答：关闭最省、越高越准但更慢更贵（模型不支持会自动去掉参数重试）',
        value: a.reasoningEffort || 'off',
        options: [
          { value: 'off', label: '关闭' },
          { value: 'low', label: '低' },
          { value: 'medium', label: '中' },
          { value: 'high', label: '高' },
        ],
      }) +
      W.selectRow({
        id: 'reasoningFormat',
        bind: 'ai.reasoningFormat',
        title: '思考参数格式',
        desc: '各家模型的思考字段不一样：自动＝按接口地址/模型名判断；也可以手动指定（模型不认会自动去掉参数重试）',
        value: a.reasoningFormat || 'auto',
        options: [
          { value: 'auto', label: '自动（按接口地址 / 模型名判断）' },
          { value: 'standard', label: '标准 reasoning_effort（OpenAI o/gpt-5、Grok、多数网关）' },
          { value: 'openrouter', label: 'OpenRouter reasoning.effort' },
          { value: 'qwen', label: '通义 enable_thinking（Qwen3、QwQ、百度 ERNIE）' },
          { value: 'anthropic', label: 'Claude thinking.budget_tokens' },
          { value: 'gemini', label: 'Gemini thinking_budget' },
          { value: 'thinking', label: '思考开关 thinking.type（DeepSeek、智谱、Kimi、混元）' },
          { value: 'ollama', label: 'Ollama think（本地 gpt-oss、llama3.x）' },
        ],
      }) +
      W.numField('思考预算 token（按 token 表达强弱的格式生效，0＝按档位自动）', num(a.reasoningBudget, 0), 'aiReasoningBudget', 'ai.reasoningBudget') +
      '<p class="hint" id="reasoningPreview">当前模型 ' + W.esc(f.model || '(没填模型名)') +
      ' → 将发送：' + W.esc(a.reasoningPreview || '（不带任何思考参数）') +
      (a.reasoningKind === 'switch' ? '（这家只有开 / 关，低/中/高都会翻译成「开启」）' : '') + '</p>' +
      W.segRow({
        id: 'groupReply', bind: 'ai.groupReply',
        title: '群聊什么时候回',
        desc: '群里 @ 我才回（最省）/ 群里说的话都回 / 群里一律不回',
        value: a.groupReply || 'mention',
        options: [
          { value: 'mention', label: '群里@我才回' },
          { value: 'always', label: '群里都回' },
          { value: 'never', label: '群里不回' },
        ],
      }) +
      W.field('群里 @ 我时认可的称呼（逗号分隔）', f.atNames, 'aiAtNames', 'text', '小助手,助手', 'ai.atNames') +
      W.field('触发前缀（留空表示不需要）', f.triggerPrefix, 'aiTriggerPrefix', 'text', '小助手', 'ai.triggerPrefix') +
      W.numField('每小时最多回复条数', num(a.maxPerHour, 120), 'aiMaxPerHour', 'ai.maxPerHour') +
      W.numField('同一会话最小间隔（毫秒）', num(a.cooldownMs, 3000), 'aiCooldownMs', 'ai.cooldownMs') +
      W.numField('最多同时处理几条', num(a.maxConcurrent, 2), 'aiMaxConcurrent', 'ai.maxConcurrent') +
      '</div></details>';

    // ── 联网搜索与 AI 工具调用（Skills，§16.2 / §16.4）──
    const localSearch = a.webSearch && /(^|\/\/)(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)(:|\/|$)/i.test(a.baseUrl || f.baseUrl || '');
    const wsLocalWarn = localSearch
      ? '<div class="svc-banner bad">本地模型开启联网搜索：查询文本会发往第三方搜索服务商，打破「数据不出机」的本地隐私预期。确认接受再开。</div>'
      : '';
    const wsTools = '<details class="adv" data-adv="ws-tools"><summary>联网搜索与 AI 工具（Skills）</summary><div class="adv-body"><div class="grid">' +
      W.switchRow({ id: 'webSearch', bind: 'ai.webSearch', title: '联网搜索（Web Search）', desc: '让 AI 按需检索网页（新闻 / 天气 / 股价 / 实时事实）。', value: a.webSearch, effect: '开启后查询会发往第三方搜索服务（隐私 / 离线优先，默认关）' }) +
      W.selectRow({ id: 'webSearchProvider', bind: 'ai.webSearchProvider', title: '搜索服务商', desc: 'tavily / serpapi / bing / custom', value: a.webSearchProvider || 'tavily', options: [
        { value: 'tavily', label: 'Tavily' },
        { value: 'serpapi', label: 'SerpAPI' },
        { value: 'bing', label: 'Bing' },
        { value: 'custom', label: '自建 / 其它' },
      ] }) +
      W.secretField('搜索服务商密钥（tavily / serpapi / bing 需要）', a.webSearchKey, 'aiWebSearchKey', 'ai.webSearchKey', Boolean(a.webSearchKey), 'tavily 的 key') +
      W.segRow({ id: 'webSearchMode', bind: 'ai.webSearchMode', title: '触发方式', desc: 'always＝每条都搜；auto＝时间敏感 / 显式检索词命中才搜；prefix＝仅 /web 前缀', value: a.webSearchMode || 'auto', options: [
        { value: 'always', label: '每条都搜' },
        { value: 'auto', label: '智能判断' },
        { value: 'prefix', label: '仅 /web' },
      ] }) +
      W.field('前缀触发词（prefix 模式）', a.webSearchTrigger || '/web', 'aiWebSearchTrigger', 'text', '/web', 'ai.webSearchTrigger') +
      W.numField('结果条数上限', num(a.webSearchMaxResults, 5), 'aiWebSearchMaxResults', 'ai.webSearchMaxResults') +
      W.numField('单条结果字符上限', num(a.webSearchMaxChars, 4000), 'aiWebSearchMaxChars', 'ai.webSearchMaxChars') +
      '</div>' + wsLocalWarn + '<div class="grid">' +
      W.switchRow({ id: 'aiTools', bind: 'ai.aiTools', title: 'AI 工具调用（Skills）', desc: '让模型自己决定调工具：联网搜索 / 计算 / 时间…', value: a.aiTools, effect: '需模型支持 function calling；白名单 + 最大轮次护栏' }) +
      W.field('工具白名单（留空＝全部内置）', a.aiToolsAllow || '', 'aiToolsAllow', 'text', 'web_search,calculator,time', 'ai.aiToolsAllow') +
      W.numField('单轮最大工具调用轮次', num(a.aiToolsMaxRounds, 3), 'aiToolsMaxRounds', 'ai.aiToolsMaxRounds') +
      '</div></div></details>';

    // ── 双模型路由（§16.5 高级模式）──
    // 默认一个模型（用户设的）；开启后按复杂度在两个「都由用户指定」的模型间切换。
    const routing = '<details class="adv" data-adv="model-routing"><summary>双模型路由（高级）</summary><div class="adv-body"><div class="grid">' +
      W.switchRow({ id: 'modelRouting', bind: 'ai.modelRouting', title: '按复杂度切换模型', desc: '关闭＝始终用主模型（默认）；开启＝简单任务走轻量模型、复杂任务走主模型。', value: a.modelRouting, effect: '两个模型都由你指定；复杂度用规则判定，不额外调一次模型，因此不增加延迟' }) +
      W.field('轻量模型名称（简单任务用）', a.lightModel || '', 'lightModel', 'text', 'gpt-4o-mini', 'ai.lightModel') +
      W.field('轻量模型地址（留空＝与主模型同地址）', a.lightBaseUrl || '', 'lightBaseUrl', 'text', 'http://localhost:11434/v1', 'ai.lightBaseUrl') +
      W.secretField('轻量模型密钥（留空＝与主模型同密钥）', a.lightApiKey, 'aiLightApiKey', 'ai.lightApiKey', Boolean(a.lightApiKey), '留空则复用主模型密钥') +
      '</div><div class="grid">' +
      W.switchRow({ id: 'longTaskNotice', bind: 'ai.longTaskNotice', title: '长任务先发「正在…中」提示', desc: '默认开：判定为长任务（联网检索 / 工具调用 / 文档解析 / 写代码长文）就先发一条提示。', value: a.longTaskNotice, effect: '微信不支持对已发消息原地替换，所以提示与结果是两条真消息' }) +
      '</div><div class="grid">' +
      W.switchRow({ id: 'docAnalysis', bind: 'ai.docAnalysis', title: '文档解读（基础办公）', desc: '群里发的附件抽取成文本再回答：txt/md/csv 与 docx/xlsx/pptx/pdf。', value: a.docAnalysis, effect: '抽取纯本地完成（零依赖解析，不发往外部），与联网搜索是两回事' }) +
      W.numField('单份文档抽取字符上限', num(a.docMaxChars, 12000), 'docMaxChars', 'ai.docMaxChars') +
      W.field('生成文档的输出目录（沙箱）', a.docOutDir || '', 'docOutDir', 'text', './data/outbox', 'ai.docOutDir') +
      '</div></div></details>';

    // ── 人设（全局）：正文可换，底层围栏不可换 ──
    const personaSrc = a.personaSource === 'file'
      ? '人设文件'
      : (a.personaSource === 'inline' ? '配置里的内联人设文本' : '内置默认人设');
    const personaMissing = a.personaMissing
      ? '<div class="svc-banner bad">配了人设文件但读不到（文件不存在，或不在本目录内）—— 现在跑的是内置默认人设。</div>'
      : '';
    const personaBox = (title, text, cls) =>
      '<div class="pbox ' + (cls || '') + '">' +
      '<div class="pbox-t">' + title + '</div>' +
      '<pre class="pbox-b">' + W.esc(text || '（空）') + '</pre>' +
      '</div>';
    const personaStep = '<div class="wiz-step">' +
      '<h3><span class="n">4</span>人设（AI 怎么说话、怎么介绍自己）</h3>' +
      '<p class="hint">全局人设，所有会话共用一份。下面是<b>现在实际会发给模型的内容</b>：' +
      '人设正文可以换成你自己的文件，但底下那段围栏永远在。</p>' +
      personaMissing +
      '<p class="hint">当前生效：<b>' + W.esc(personaSrc) + '</b>' +
      (a.personaFileResolved ? ' · ' + W.esc(a.personaFileResolved) : '') + '</p>' +
      '<div class="grid">' +
      // 标签保持一行（长说明挪到下面的 hint），否则左列标签换行会把输入框压下去，两列控件对不齐
      W.field('人设名',
        f.personaName !== undefined ? f.personaName : (a.personaName || ''),
        'aiPersonaName', 'text', 'AutoChat助手', 'ai.personaName') +
      W.uploadRow({
        id: 'aiPersonaFile',
        label: '人设文件（.txt，绝对路径）',
        value: f.personaFile !== undefined ? f.personaFile : (a.personaFile || ''),
        bind: 'ai.personaFile',
        button: '上传文件…',
        placeholder: '留空＝用内置默认人设',
        accept: '.txt',
      }) +
      '</div>' +
      '<p class="hint">人设名是身份三要素之一；留空＝用人设文件名，再没有就是「AutoChat助手」。</p>' +
      personaBox('人设正文（可用 {account} {persona} {model} 占位）', a.personaText || '') +
      personaBox('底层围栏 · 不可关闭（无论用什么人设，这段都追加在最后）', a.personaFence || '', 'fence') +
      '<div class="row pbtns" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<button class="btn" id="btnExportPersona">导出成 .txt 自己改</button>' +
      '<button class="btn ghost" id="btnPreviewPersona">预览人设文件</button>' +
      '<button class="btn" id="btnResetPersona">恢复默认人设</button>' +
      '</div>' +
      '<pre id="personaPreview" style="display:none;max-height:260px;overflow:auto;white-space:pre-wrap;background:#f7f7f8;border:1px solid #e2e5ea;border-radius:8px;padding:10px;font-size:13px"></pre>' +
      '</div>';

    const tip = !a.baseUrl
      ? '还没选模型来源 —— 上面选一个，本机在跑的会自动排在最前。'
      : svcOnline === false
        ? '本机模型服务还没启动，先点「启动模型服务」，否则测试一定失败。'
        : !f.model
          ? '还没填模型名 —— 点「拉取模型列表」后在上面的标签里点一个即可。'
          : '测通了记得点「保存 AI 配置」，然后重启助手才会生效。';

    // G31：全局被按会话覆盖时必须说清楚 —— 否则「全局 A、某个群 B」用户不知道到底谁生效
    const ovrN = Object.values((state && state.chats) || {}).filter(
      (c) => c && (c.model || c.baseUrl || c.apiKey || c.personaFile || c.systemPrompt || c.reasoningEffort)
    ).length;
    const ovrBanner = ovrN
      ? '<p class="hint">有 <b>' + ovrN + '</b> 个会话在「按会话配置」里单独配了模型 / 人设 / 思考 —— ' +
        '这些会话用自己的配置（会话行会标「覆盖 N 项」），不跟随本卡；下面的设置只对没单独配的会话生效。</p>'
      : '';

    // 每步独立成块：步骤之间统一虚线分隔 + 14px 间距，避免标题紧贴上一个控件
    return W.card('接一个模型',
      ovrBanner +
      '<div class="wiz-step">' + step1 + '</div>' +
      '<div class="wiz-step">' + step2 + '</div>' +
      '<div class="wiz-step">' + step3 + '</div>' + personaStep + adv + wsTools + routing +
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
