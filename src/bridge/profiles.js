/**
 * 微信版本档案。
 *
 * 微信平均 1~2 周发一个版本，hook DLL 依赖进程内偏移，版本一变就失效。
 * 所以这里不写死某个版本，而是维护一张「版本 → 已知方案」的表：
 * 每个条目记录来源、能力（能否收消息）、许可形态。
 *
 * 新增一个可用 DLL 时只改这张表，网关代码不动。
 */

export const PROFILES = [
  {
    wechat: '4.1.15.56',
    dll: 'miloira/wxhook（pywechat）',
    url: 'https://github.com/miloira/wxhook',
    license: 'MIT',
    send: true,
    recv: true,
    note: 'miloira/wxhook 开源仓库（MIT），官方描述支持 3.9.x 至 4.1.15.56 等大量版本；预编译 DLL 由使用者自行获取',
  },
  {
    wechat: '4.1.15.50',
    dll: 'miloira/wxhook（pywechat）',
    url: 'https://github.com/miloira/wxhook',
    license: 'MIT',
    send: true,
    recv: true,
    note: '同上',
  },
  {
    wechat: '4.1.10.27',
    dll: 'aixed/WeChat-Hook（main）',
    // 仅用于界面展示：本仓实际附带并部署的是这份自制 DLL（原名已按 AC-<微信版本> 规范改名）。
    // dll 字段保持原值 —— resolveBuiltinDll 靠 includes('aixed') 做版本匹配，不能改。
    dllLabel: 'version-ac-4.1.10.27.dll（本仓 tools/wxhook/ 自制）',
    url: 'https://github.com/aixed/WeChat-Hook',
    license: '源码公开',
    send: true,
    recv: false,
    note: 'main 分支已移除消息接收 hook 与 PB/CDN 相关代码，只能调用发送类接口；接收需靠 /QueryDB/execute 轮询（本项目 4.1.10.27 的自制 DLL 已改名为 version-ac-4.1.10.27.dll，见 tools/wxhook/）',
  },
  {
    wechat: '4.1.8.67',
    dll: 'lyx102/WeChatHook',
    url: 'https://github.com/lyx102/WeChatHook',
    license: 'MIT',
    send: true,
    recv: true,
    note: 'README 标注适配到 4.1.8',
  },
  {
    wechat: '3.9.10.16',
    dll: 'aixed/WeChat-Hook（old_version）',
    url: 'https://github.com/aixed/WeChat-Hook/tree/old_version',
    license: '源码公开',
    send: true,
    recv: true,
    note: '3.x 时代的完整版，收发齐全',
  },
  {
    wechat: '3.9.5.81',
    dll: 'miloira/wxhook（开源版）',
    url: 'https://github.com/miloira/wxhook',
    license: 'MIT',
    send: true,
    recv: true,
    note: '仓库当前开源代码对应的版本，接口最全',
  },
];

function parts(v) {
  return String(v || '')
    .split('.')
    .map((n) => Number(n) || 0);
}

function majorMinor(v) {
  const p = parts(v);
  return `${p[0]}.${p[1]}.${p[2]}`;
}

/**
 * 按版本找档案。
 * 精确命中 > 同三段（4.1.15.x）> 同主次版本（4.1.x）。
 * @returns {{level:'exact'|'patch'|'minor'|'none', profile:object|null, candidates:object[]}}
 */
export function resolveProfile(version) {
  if (!version) return { level: 'none', profile: null, candidates: [] };

  const exact = PROFILES.find((p) => p.wechat === version);
  if (exact) return { level: 'exact', profile: exact, candidates: [exact] };

  const mm = majorMinor(version);
  const samePatch = PROFILES.filter((p) => majorMinor(p.wechat) === mm);
  if (samePatch.length) return { level: 'patch', profile: samePatch[0], candidates: samePatch };

  const p = parts(version);
  const sameMinor = PROFILES.filter((q) => {
    const qp = parts(q.wechat);
    return qp[0] === p[0] && qp[1] === p[1];
  });
  if (sameMinor.length) return { level: 'minor', profile: sameMinor[0], candidates: sameMinor };

  return { level: 'none', profile: null, candidates: [] };
}

/** 给人看的一句话结论。level 必须带回 —— autoRepair 靠它区分「精确支持」与「要重装」。 */
export function describeSupport(version) {
  const r = resolveProfile(version);
  if (r.level === 'exact') {
    return {
      ok: true,
      level: 'exact',
      text: `精确匹配 ${r.profile.wechat} → ${r.profile.dllLabel || r.profile.dll}（${r.profile.license}）`,
      profile: r.profile,
    };
  }
  if (r.level === 'patch') {
    return {
      ok: false,
      level: 'patch',
      text:
        `${version} 没有精确方案；同系列只有 ${r.profile.wechat} → ${r.profile.dllLabel || r.profile.dll}（${r.profile.license}）。` +
        '补丁号不同，进程内偏移大概率已变，不能直接套用',
      profile: r.profile,
    };
  }
  if (r.level === 'minor') {
    return {
      ok: false,
      level: 'minor',
      text: `${version} 没有对应 DLL；最近的方案是 ${r.profile.wechat} → ${r.profile.dllLabel || r.profile.dll}`,
      profile: r.profile,
    };
  }
  return { ok: false, level: 'none', text: `没有 ${version} 的已知 hook 方案`, profile: null };
}

/** 当前 DLL 是否具备收消息能力（看档案，不看配置）。 */
export function canReceive(version) {
  const r = resolveProfile(version);
  return Boolean(r.profile?.recv);
}
