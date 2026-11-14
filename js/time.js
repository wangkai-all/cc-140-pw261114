// 时区与时间工具：把各机场当地时间统一换算为 UTC 毫秒，跨午夜通过日期滚动处理。
// 全部函数为纯函数，浏览器与 Node 通用。

const dtfCache = new Map();

function getDtf(tz) {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, dtf);
  }
  return dtf;
}

/** 某 UTC 时刻在指定时区的偏移（毫秒，local - utc）。 */
export function tzOffsetMs(tz, utcMs) {
  const parts = getDtf(tz).formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = Number(map.hour) % 24; // en-CA 午夜可能给出 24
  const asUtc = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    hour, Number(map.minute), Number(map.second)
  );
  return asUtc - utcMs;
}

/**
 * 把 "YYYY-MM-DD" + "HH:MM" 的当地时间解释为指定时区的 UTC 毫秒。
 * 迭代修正偏移量以覆盖 DST 边界。
 */
export function localToUtc(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  let utc = naive;
  for (let i = 0; i < 4; i++) {
    const corrected = naive - tzOffsetMs(tz, utc);
    if (corrected === utc) break;
    utc = corrected;
  }
  return utc;
}

/** 把 UTC 毫秒格式化为指定时区的 "YYYY-MM-DD HH:MM"。 */
export function fmtInTz(utcMs, tz) {
  const parts = getDtf(tz).formatToParts(new Date(utcMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = String(Number(map.hour) % 24).padStart(2, '0');
  return `${map.year}-${map.month}-${map.day} ${hour}:${map.minute}`;
}

/** 只取 HH:MM（指定时区）。 */
export function fmtTimeInTz(utcMs, tz) {
  return fmtInTz(utcMs, tz).slice(11);
}

/** UTC 毫秒 → "YYYY-MM-DD HH:MM"（UTC）。 */
export function fmtUtc(utcMs) {
  return fmtInTz(utcMs, 'UTC');
}

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** 分钟数 → "+95" / "-10" 形式。 */
export function fmtDelay(min) {
  if (min == null || Number.isNaN(min)) return '—';
  const r = Math.round(min);
  return r > 0 ? `+${r}` : String(r);
}
