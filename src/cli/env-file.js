import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from '../config.js';

/**
 * .env 读写。
 *
 * 关键点：**保留注释与原有顺序**。
 * 用户在 .env 里写了大段说明（每行都是"这个参数是干嘛的"），
 * 用「重新序列化」的方式写回会把这些注释全抹掉 —— 那是灾难。
 * 所以这里按行改：命中 key 就替换那一行，其余原样保留。
 */

export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 更新 .env 里的若干键，保留注释与顺序。
 * @param {string} file
 * @param {Record<string,string|number|boolean|null>} updates  值为 null 表示删除该行
 * @returns {{changed:string[], file:string}}
 */
export function setEnvValues(file, updates) {
  const entries = Object.entries(updates || {});
  if (!entries.length) return { changed: [], file };

  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.length ? text.split(/\r?\n/) : [];
  const changed = [];

  for (const [key, rawValue] of entries) {
    const value = rawValue === null || rawValue === undefined ? null : String(rawValue);
    let hit = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      if (trimmed.slice(0, eq).trim().replace(/^export\s+/, '') !== key) continue;
      hit = true;
      if (value === null) {
        lines.splice(i, 1);
        i -= 1;
      } else {
        lines[i] = `${key}=${value}`;
      }
      break;
    }
    if (!hit && value !== null) {
      lines.push(`${key}=${value}`);
    }
    changed.push(key);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  return { changed, file };
}

/** 从模板生成一份 .env（安装向导用）。 */
export function writeEnvFromTemplate(templateFile, targetFile, overrides = {}) {
  const base = fs.existsSync(templateFile) ? fs.readFileSync(templateFile, 'utf8') : '';
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, base, 'utf8');
  return setEnvValues(targetFile, overrides);
}

/** 把 .env 里某个键的值读出来（没有就是空串）。 */
export function getEnvValue(file, key, fallback = '') {
  const env = readEnvFile(file);
  return env[key] === undefined ? fallback : env[key];
}
