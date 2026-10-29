/**
 * 模型卡的「别把用户已经配好的东西改掉」规则（纯函数，方便回归测试）。
 *
 * 背景：「明明配了 DeepSeek，却跑本机千问」这类事故，根因都是
 * 界面在用户不知情的情况下改写了地址和模型名。这里把判断拆成纯函数，
 * 一是让主程序只管取数渲染，二是能被测试直接盯住。
 */
(function (g) {
  /** 本机地址（不需要密钥，也不该留着云端 key）。 */
  function isLocalBase(base) {
    return /127\.0\.0\.1|localhost/i.test(String(base || ''));
  }

  /**
   * 选中的模型来源。
   * 已配的地址不在预设表里（自建网关 / 中转 / 端口改过）时必须落到「自定义」，
   * 绝不能默认选第一个 —— 第一个往往就是本机 Ollama，
   * 界面上会显示成本机千问，一保存就把云端配置悄悄换掉。
   */
  function pickProviderId(options, cfgBase) {
    const list = Array.isArray(options) ? options : [];
    if (!list.length) return '';
    const base = String(cfgBase || '').trim();
    const hit = list.find((o) => o && o.baseUrl && base && String(o.baseUrl).trim() === base);
    if (hit) return hit.id;
    return base ? 'custom' : list[0].id;
  }

  /**
   * 收集表单要写回 .env 的键值。
   * 密钥类字段在浏览器里永远是空的（不下发真值），留空＝保持原样；
   * 直接写空会把 .env 里已配好的密钥抹掉，助手当场 401。
   * 取不到值（undefined/null）的键一律不写 —— 宁可不写，也不能写成空串。
   */
  function collectEnvValues(pairs, secretKeys) {
    const out = {};
    const secrets = Array.isArray(secretKeys) ? secretKeys : [];
    for (const pair of pairs || []) {
      if (!pair || !pair[0]) continue;
      const envKey = pair[0];
      if (pair[1] === undefined || pair[1] === null) continue;
      const value = String(pair[1]);
      if (secrets.includes(envKey) && !value) continue;
      out[envKey] = value;
    }
    return out;
  }

  /**
   * 保存 AI 配置前的变更计划。
   * 返回要写的键值、是否发生了替换（用来弹确认）、以及「从什么换成什么」。
   */
  function planAiSave(input) {
    const src = input || {};
    const live = src.live || {};
    const base = String(src.base || '').trim();
    const model = String(src.model || '').trim();
    const key = src.key ? String(src.key) : '';
    const local = isLocalBase(base);

    const values = { AI_BASE_URL: base, AI_MODEL: model };
    if (local) {
      // 本机模型不需要密钥：把云端残留的 key 删掉，
      // 免得出现「云端密钥 + 本机地址」这种错配。
      values.AI_API_KEY = null;
    } else if (key) {
      values.AI_API_KEY = key;
    }

    const changed = Boolean(live.baseUrl) && (live.baseUrl !== base || live.model !== model);
    return {
      values,
      changed,
      needConfirm: changed,
      local,
      from: { base: live.baseUrl || '', model: live.model || '' },
      to: { base, model },
    };
  }

  g.aiRules = { isLocalBase, pickProviderId, collectEnvValues, planAiSave };
})(window.AutoChat = window.AutoChat ? window.AutoChat : {});
