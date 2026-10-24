import fs from 'node:fs';
import path from 'node:path';

/**
 * 接口方言：不同的 hook DLL 收同一个「发文本」请求，字段名并不一样。
 *
 *   wechat-hook  { wxidorgid: 'wxid_x', msg: 'hi' }
 *   某些封装      { wxid: 'wxid_x', content: 'hi' }
 *   另一些        { to: 'wxid_x', text: 'hi' }
 *   还有          { to_wxid: 'wxid_x', msg: 'hi' }
 *
 * 与其让用户一个个试，不如按顺序试、把成功的组合记下来。
 */

export const TEXT_DIALECTS = [
  { name: 'wxidorgid+msg', build: (to, text) => ({ wxidorgid: to, msg: text }) },
  { name: 'wxid+content', build: (to, text) => ({ wxid: to, content: text }) },
  { name: 'to+text', build: (to, text) => ({ to, text }) },
  { name: 'to_wxid+msg', build: (to, text) => ({ to_wxid: to, msg: text }) },
];

/** 发文本的候选路径，按常见程度排序。 */
export const TEXT_PATHS = ['/SendTextMsg', '/send_text', '/api/sendText', '/SendMsg', '/sendText'];

/** 图片/文件的路径候选。 */
export const IMAGE_PATHS = ['/SendImgMsg', '/send_image', '/api/sendImage', '/SendImageMsg'];
export const FILE_PATHS = ['/SendFileMsg', '/send_file', '/api/sendFile', '/SendFileMsg'];

export function dialectByName(name) {
  return TEXT_DIALECTS.find((d) => d.name === name) || null;
}

/**
 * 记住本机验证过的组合（方言 + 路径），下次直接命中，避免每次都从第一个开始试。
 * 只存一份扁平的 JSON，坏了就当没有。
 */
export class DialectStore {
  constructor(file, logger) {
    this.file = file;
    this.log = logger;
    this.data = { text: null, image: null, file: null };
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.data = { ...this.data, ...raw };
      }
    } catch (err) {
      this.log?.debug?.(`方言缓存读取失败，忽略: ${err.message}`);
    }
  }

  get(kind) {
    return this.data[kind] || null;
  }

  set(kind, entry) {
    if (!entry) return;
    const prev = this.data[kind];
    if (prev && prev.dialect === entry.dialect && prev.path === entry.path) return;
    this.data[kind] = entry;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      this.log?.info?.(`已记住 ${kind} 方言: ${entry.dialect} @ ${entry.path}`);
    } catch (err) {
      this.log?.debug?.(`方言缓存写入失败: ${err.message}`);
    }
  }
}

/** 把学到的组合排到最前面。 */
export function orderByLearned(all, learnedName) {
  if (!learnedName) return all;
  const idx = all.findIndex((d) => (d.name || d) === learnedName);
  if (idx <= 0) return all;
  const copy = all.slice();
  const [hit] = copy.splice(idx, 1);
  copy.unshift(hit);
  return copy;
}
