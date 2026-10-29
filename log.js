// 統一 log 出口：每行加 [YYYY-MM-DDTHH:mm:ss+08:00] 前綴（本機時區），之後才是原本的內容。
// 為什麼：bot.log 以前多數行沒時間戳，算不出 7 天成功率；前綴放行首，ops-audit 的 marker 正則（不含行首錨點）仍匹配。
// debug() 只在 BOT_DEBUG=1 時輸出（例如 discord.js 的 shard resumed 噪音）。
const pad = (n, w = 2) => String(n).padStart(w, '0');

function stamp(date = new Date()) {
  const off = -date.getTimezoneOffset(); // 分鐘，東八區 = +480
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const prefix = () => `[${stamp()}]`;
const log = (...args) => console.log(prefix(), ...args);
const warn = (...args) => console.warn(prefix(), ...args);
const error = (...args) => console.error(prefix(), ...args);
const debug = (...args) => { if (process.env.BOT_DEBUG === '1') console.log(prefix(), '[debug]', ...args); };

module.exports = { log, warn, error, debug, stamp };
