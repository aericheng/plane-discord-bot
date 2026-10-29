// BOT-SMART-SPEC.md v4 §D：每日／每週行程摘要。
// 純邏輯（時間計算、分組排序、補發判斷）＋可注入依賴的 runner（fetch／send／時鐘／計時器／狀態檔都可換成假的），
// 所以 selftest 不連網、不登入 Discord、不碰 Plane。
//
// 時區：Asia/Taipei 固定 UTC+8（無日光節約），一律用「UTC 毫秒 + 8 小時」再以 getUTC* 取欄位，
// 不使用本機 TZ（new Date().getHours() 之類）——本機 TZ 不同結果必須相同。
//
// 完成／取消過濾（2026-10-29 實測）：
//   GET /api/v1/workspaces/aeri/projects/<project>/states/ 回 { results:[{id,name,group,default}], ... }
//   本 project 的 states：Weekly Done=completed、Backlog=backlog、Todo=unstarted(default)、In Progress=started、
//   Done=completed、Cancelled=cancelled。
//   列表 API 的每筆 issue 另帶 `state`（state id）與 `state_group`（該 state 的 group 字串），
//   所以優先用 issue.state_group；沒有時才用 states 對照表（state id → group）。
//   group 為 completed 或 cancelled 即排除；archived_at 有值、is_draft 的也排除。
const logger = require('./log');
const fs = require('node:fs');
const path = require('node:path');
const { splitMessage } = require('./discord-util');
const { extractTimeLocation, shiftIsoDate, weekdayZh, descHtmlToText } = require('./smart-edit');

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAILY_AT = { hour: 7, minute: 30 };
const WEEKLY_AT = { dow: 0, hour: 21, minute: 0 }; // 週日 21:00
const CATCHUP_FROM_MIN = 7 * 60 + 30; // 07:30
const CATCHUP_TO_MIN = 12 * 60; // 12:00（不含）
// 前一晚提醒（evening pass）：每天 20:00（環境變數 EVENING_AT=HH:MM 可改）發「明天」的考試／報告類事件；重啟補發窗到 23:00（不含）。
function parseEveningAt(v) {
  const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (m && Number(m[1]) < 23 && Number(m[2]) < 60) return { hour: Number(m[1]), minute: Number(m[2]) };
  return { hour: 20, minute: 0 };
}
const EVENING_AT = parseEveningAt(process.env.EVENING_AT);
const EVENING_FROM_MIN = EVENING_AT.hour * 60 + EVENING_AT.minute;
const EVENING_TO_MIN = 23 * 60;
const BRING_RE = /攜帶|準備|要帶|須帶|需帶|可帶|請帶/;
const EVENING_DESC_MAX = 200;
const MAX_OVERDUE = 5;
const DONE_GROUPS = new Set(['completed', 'cancelled']);
const PRIORITY_EMOJI = ['💯', '📚'];
const TICK_MS = 60_000; // 牆鐘 tick 間隔
const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000]; // 抓列表／發送失敗時的重試間隔（最多再試兩次）

// ===== 時間（與本機 TZ 無關） =====
function taipeiParts(nowMs) {
  const d = new Date(nowMs + TZ_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dow: d.getUTCDay(), // 0=日
    minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function isoToTaipeiMs(iso, hour, minute) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hour, minute) - TZ_OFFSET_MS;
}

// 嚴格晚於 nowMs 的下一個觸發點：每天 07:30（daily）與每週日 21:00（weekly）。
function nextTrigger(nowMs) {
  const today = taipeiParts(nowMs).iso;
  let best = null;
  for (let off = 0; off <= 8; off += 1) {
    const iso = shiftIsoDate(today, off);
    const cands = [{ kind: 'daily', atMs: isoToTaipeiMs(iso, DAILY_AT.hour, DAILY_AT.minute), iso }];
    if (taipeiParts(isoToTaipeiMs(iso, 12, 0)).dow === WEEKLY_AT.dow) {
      cands.push({ kind: 'weekly', atMs: isoToTaipeiMs(iso, WEEKLY_AT.hour, WEEKLY_AT.minute), iso });
    }
    for (const c of cands) if (c.atMs > nowMs && (!best || c.atMs < best.atMs)) best = c;
  }
  return best;
}

// 補發：現在（Taipei）在 07:30–12:00 之間，且今天的每日摘要還沒發過。
function shouldCatchUpDaily(nowMs, state) {
  const p = taipeiParts(nowMs);
  if (p.minutesOfDay < CATCHUP_FROM_MIN || p.minutesOfDay >= CATCHUP_TO_MIN) return false;
  return !(state && state.dailyDate === p.iso);
}

// ===== issue 過濾與分類 =====
function issueGroup(issue, statesById) {
  if (issue.state_group) return String(issue.state_group);
  if (statesById && issue.state && statesById[issue.state]) return String(statesById[issue.state]);
  return null;
}

function isOpenIssue(issue, statesById) {
  if (!issue || !issue.target_date) return false;
  if (issue.archived_at || issue.is_draft) return false;
  return !DONE_GROUPS.has(issueGroup(issue, statesById));
}

function isPriorityIssue(issue, priorityLabelIds = []) {
  const name = String(issue.name || '').trim();
  if (PRIORITY_EMOJI.some((e) => name.startsWith(e))) return true;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return labels.some((l) => priorityLabelIds.includes(typeof l === 'object' && l ? l.id : l));
}

// 「9:00」補成「09:00」再比，否則字串比較會把 9:00 排在 13:00 後面；沒時間或格式不明排最後。
function timeSortKey(t) {
  const m = String(t || '').match(/^\s*(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '99:99';
}

function sortDayItems(items) {
  return items.slice().sort((a, b) => {
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    const ta = timeSortKey(a.time);
    const tb = timeSortKey(b.time);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function toItem(issue, priorityLabelIds) {
  const { time, location } = extractTimeLocation(issue.description_html);
  return {
    date: issue.target_date,
    name: String(issue.name || '').trim() || '(無名稱)',
    time,
    location,
    priority: isPriorityIssue(issue, priorityLabelIds),
  };
}

function itemLine(item) {
  let s = `• ${item.name}`;
  if (item.time) s += ` 🕒${item.time}`;
  if (item.location) s += ` 📍${item.location.length > 40 ? item.location.slice(0, 40) + '…' : item.location}`;
  return s;
}

function mmdd(iso) {
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}

function dayLabel(iso) {
  return `${mmdd(iso)}（${weekdayZh(iso)}）`;
}

// 已過期但未完成的 💯／📚：只取最近的 MAX_OVERDUE 筆（越舊越可能是沒人在管的殘留），顯示時照日期由舊到新。
function collectOverdue(issues, statesById, todayIso, priorityLabelIds) {
  const all = issues
    .filter((i) => isOpenIssue(i, statesById) && i.target_date < todayIso && isPriorityIssue(i, priorityLabelIds))
    .map((i) => toItem(i, priorityLabelIds))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name < b.name ? -1 : 1));
  const shown = all.slice(-MAX_OVERDUE);
  return { shown, extra: all.length - shown.length };
}

function overdueLines(overdue) {
  if (!overdue.shown.length) return [];
  const lines = ['', '⚠️ **已過期但未完成**'];
  for (const it of overdue.shown) lines.push(`${itemLine(it)} — 原訂 ${dayLabel(it.date)}`);
  if (overdue.extra > 0) lines.push(`…另有 ${overdue.extra} 筆更早的`);
  return lines;
}

// ===== 組摘要 =====
// 回 { text, items, empty }。items＝今天＋明天（週摘要為該週）的事件數，不含逾期清單；items=0 → empty（不發）。
function buildDailyDigest({ issues, statesById, todayIso, priorityLabelIds }) {
  const tomorrowIso = shiftIsoDate(todayIso, 1);
  const open = issues.filter((i) => isOpenIssue(i, statesById));
  const day = (iso) => sortDayItems(open.filter((i) => i.target_date === iso).map((i) => toItem(i, priorityLabelIds)));
  const today = day(todayIso);
  const tomorrow = day(tomorrowIso);
  const lines = [`📅 **每日行程摘要　${dayLabel(todayIso)}**`];
  for (const [label, iso, list] of [['今天', todayIso, today], ['明天', tomorrowIso, tomorrow]]) {
    lines.push('', `**${label} ${dayLabel(iso)}**`);
    if (list.length) for (const it of list) lines.push(itemLine(it));
    else lines.push('（沒有行程）');
  }
  lines.push(...overdueLines(collectOverdue(issues, statesById, todayIso, priorityLabelIds)));
  const items = today.length + tomorrow.length;
  return { text: lines.join('\n'), items, empty: items === 0 };
}

// 週摘要：基準日（通常是週日）之後的下一個週一到週日。week＝該週週一的日期。
function nextWeekRange(fromIso) {
  const dow = taipeiParts(isoToTaipeiMs(fromIso, 12, 0)).dow;
  const daysToMonday = ((8 - dow) % 7) || 7;
  const monday = shiftIsoDate(fromIso, daysToMonday);
  return { monday, sunday: shiftIsoDate(monday, 6) };
}

function buildWeeklyDigest({ issues, statesById, todayIso, priorityLabelIds }) {
  const { monday, sunday } = nextWeekRange(todayIso);
  const open = issues.filter((i) => isOpenIssue(i, statesById));
  const lines = [`🗓️ **下週行程摘要　${dayLabel(monday)} ~ ${dayLabel(sunday)}**`];
  let items = 0;
  for (let k = 0; k < 7; k += 1) {
    const iso = shiftIsoDate(monday, k);
    const list = sortDayItems(open.filter((i) => i.target_date === iso).map((i) => toItem(i, priorityLabelIds)));
    if (!list.length) continue;
    items += list.length;
    lines.push('', `**${dayLabel(iso)}**`);
    for (const it of list) lines.push(itemLine(it));
  }
  lines.push(...overdueLines(collectOverdue(issues, statesById, todayIso, priorityLabelIds)));
  return { text: lines.join('\n'), items, empty: items === 0, week: monday };
}

// ===== 前一晚清單（明天的 💯／📚 事件，附描述中的攜帶／準備段落） =====
// 判定「考試／報告類」＝isPriorityIssue（名稱以 💯／📚 開頭，或 label 為 test／homework），與每日摘要的置頂排序同一套。
// 描述取法：扣掉 時間：／地點： 兩行（已另列）；有含「攜帶／準備／要帶…」的行就只列那些行，沒有就列整段前 200 字。
function eveningNote(html) {
  const lines = descHtmlToText(html)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^(時間|地點)[:：]/.test(l));
  if (!lines.length) return '';
  const hit = lines.filter((l) => BRING_RE.test(l));
  const text = (hit.length ? hit : lines).join(' ／ ');
  return text.length > EVENING_DESC_MAX ? text.slice(0, EVENING_DESC_MAX) + '…' : text;
}

// 前一晚另外納入 🗣️ presentation（報告）：名稱以 🗣️ 開頭，或 label 在 eveningLabelIds（含 presentation 的 id）。
function isEveningIssue(issue, priorityLabelIds = [], eveningLabelIds = []) {
  if (isPriorityIssue(issue, priorityLabelIds)) return true;
  if (String(issue.name || '').trim().startsWith('🗣️')) return true;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return labels.some((l) => eveningLabelIds.includes(typeof l === 'object' && l ? l.id : l));
}

function buildEveningDigest({ issues, statesById, todayIso, priorityLabelIds, eveningLabelIds }) {
  const tomorrowIso = shiftIsoDate(todayIso, 1);
  const picked = issues
    .filter((i) => isOpenIssue(i, statesById) && i.target_date === tomorrowIso && isEveningIssue(i, priorityLabelIds, eveningLabelIds))
    .map((i) => ({ item: toItem(i, priorityLabelIds), note: eveningNote(i.description_html) }));
  const sorted = sortDayItems(picked.map((p) => p.item)).map((it) => picked.find((p) => p.item === it));
  const lines = [`🌙 **明日提醒　${dayLabel(tomorrowIso)}**`, ''];
  for (const { item, note } of sorted) {
    const when = [item.time, item.location].filter(Boolean).join(' ') || '（時間地點未填）';
    lines.push(`• ${item.name}｜${when}｜${note || '（描述沒有內容）'}`);
  }
  return { text: lines.join('\n'), items: sorted.length, empty: sorted.length === 0, date: tomorrowIso };
}

// ===== 狀態檔（data/digest-state.json，已在 .gitignore） =====
const STATE_FILE = path.join(__dirname, 'data', 'digest-state.json');

function readStateFile(file = STATE_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) {
    return {};
  }
}

function writeStateFile(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// ===== runner =====
// deps：fetchAll() → issues；fetchStates() → { [stateId]: group }（失敗不致命，issue.state_group 通常夠用）；
//       send(text) → 發到頻道（內部自己切段；已送出部分段落後才失敗要丟 err.partial=true）；now() → ms；
//       readState()/writeState(s)；log(line)；setTimer(fn, ms)/clearTimer(h)；priorityLabelIds。
// 排程以牆鐘為準：每 TICK_MS 一次輕量 tick，用 now() 判斷是否已過今天的觸發時刻且尚未發；
// 電腦睡眠醒來後下一個 tick 就會對時補發（或寫 log 說明錯過），不依賴一個長計時器。
function createDigestRunner(deps) {
  const d = {
    now: () => Date.now(),
    readState: () => readStateFile(),
    writeState: (s) => writeStateFile(s),
    log: (line) => logger.log(line),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
    fetchStates: async () => ({}),
    priorityLabelIds: [],
    eveningLabelIds: [],
    ...deps,
  };
  const timers = new Set(); // tick 與重試計時器都追蹤，stop() 一次清掉
  let started = false;
  const sentMem = { daily: null, weekly: null, evening: null }; // 本 process 已發的期別（writeState 失敗時避免重發）
  const handled = { daily: null, weekly: null, evening: null }; // tick 已處理（已啟動／已判定錯過）的期別，同一期不再處理

  const nowIso = () => new Date(d.now()).toISOString();

  function schedule(fn, ms) {
    const h = d.setTimer(() => { timers.delete(h); return fn(); }, ms);
    timers.add(h);
    return h;
  }

  async function load() {
    const issues = await d.fetchAll();
    let statesById = {};
    // 只有 issue 缺 state_group 時才需要對照表，省一次 API 呼叫。
    if (issues.some((i) => !i.state_group)) {
      try { statesById = await d.fetchStates(); } catch (err) { d.log(`[bot] digest states fetch failed: ${err.message}`); }
    }
    return { issues, statesById };
  }

  // 送出後記錄期別：記憶體一定記；狀態檔寫失敗只記 log，不丟錯（丟錯會進重試而重發）。
  function recordSent(kind, key, field) {
    sentMem[kind] = key;
    try {
      d.writeState({ ...(d.readState() || {}), [field]: key });
    } catch (err) {
      d.log(`[bot] digest ${kind} state write failed (already sent, not retrying): ${err && err.message ? err.message : err}`);
    }
  }

  // 送出文字；有任何一段已送出後才失敗（err.partial）→ 記為已發、寫 log、不丟錯（整則重試會從第 1 段重送）。回 true＝完整送出。
  async function sendOnce(kind, key, field, text) {
    try {
      await d.send(text);
    } catch (err) {
      if (!(err && err.partial)) throw err;
      recordSent(kind, key, field);
      d.log(`[bot] digest ${kind} partially sent ${field === 'weeklyWeek' ? 'week' : 'date'}=${key} not retrying: ${err.message}`);
      return false;
    }
    recordSent(kind, key, field);
    return true;
  }

  async function runDaily() {
    const todayIso = taipeiParts(d.now()).iso;
    if (sentMem.daily === todayIso || (d.readState() || {}).dailyDate === todayIso) return 'already';
    const { issues, statesById } = await load();
    const r = buildDailyDigest({ issues, statesById, todayIso, priorityLabelIds: d.priorityLabelIds });
    if (r.empty) {
      d.log(`[bot] digest daily skipped date=${todayIso} reason=empty at=${nowIso()}`);
      return 'skipped';
    }
    if (!(await sendOnce('daily', todayIso, 'dailyDate', r.text))) return 'partial';
    d.log(`[bot] digest daily sent date=${todayIso} items=${r.items} at=${nowIso()}`);
    return 'sent';
  }

  async function runWeekly() {
    const p = taipeiParts(d.now());
    // 週摘要只在週日（21:00 起到 24:00 前）發；過了週一 00:00，nextWeekRange 會算成再下一週，所以直接放棄。
    if (p.dow !== WEEKLY_AT.dow) {
      d.log(`[bot] digest weekly missed date=${p.iso} reason=outside-sunday-window`);
      return 'missed';
    }
    const { monday } = nextWeekRange(p.iso);
    if (sentMem.weekly === monday || (d.readState() || {}).weeklyWeek === monday) return 'already';
    const { issues, statesById } = await load();
    const r = buildWeeklyDigest({ issues, statesById, todayIso: p.iso, priorityLabelIds: d.priorityLabelIds });
    if (r.empty) {
      d.log(`[bot] digest weekly skipped week=${monday} reason=empty at=${nowIso()}`);
      return 'skipped';
    }
    if (!(await sendOnce('weekly', monday, 'weeklyWeek', r.text))) return 'partial';
    d.log(`[bot] digest weekly sent week=${monday} items=${r.items} at=${nowIso()}`);
    return 'sent';
  }

  async function runEvening() {
    const todayIso = taipeiParts(d.now()).iso;
    if (sentMem.evening === todayIso || (d.readState() || {}).eveningDate === todayIso) return 'already';
    const { issues, statesById } = await load();
    const r = buildEveningDigest({ issues, statesById, todayIso, priorityLabelIds: d.priorityLabelIds, eveningLabelIds: d.eveningLabelIds });
    if (r.empty) {
      d.log(`[bot] digest evening skipped reason=empty date=${todayIso} at=${nowIso()}`);
      return 'skipped';
    }
    if (!(await sendOnce('evening', todayIso, 'eveningDate', r.text))) return 'partial';
    d.log(`[bot] digest evening sent n=${r.items} date=${todayIso} at=${nowIso()}`);
    return 'sent';
  }

  // 失敗（Plane 逾時、Discord 暫時不通）就依 RETRY_DELAYS_MS 再試；用盡才放棄並寫 log。
  function runWithRetry(kind, attempt = 0) {
    const fn = kind === 'weekly' ? runWeekly : kind === 'evening' ? runEvening : runDaily;
    return fn().catch((err) => {
      d.log(`[bot] digest ${kind} failed attempt=${attempt + 1}: ${err && err.message ? err.message : err}`);
      if (attempt < RETRY_DELAYS_MS.length) {
        schedule(() => { runWithRetry(kind, attempt + 1); }, RETRY_DELAYS_MS[attempt]);
      } else {
        d.log(`[bot] digest ${kind} gave up after attempt=${attempt + 1}`);
      }
    });
  }

  async function tick() {
    try {
      const p = taipeiParts(d.now());
      const state = d.readState() || {};
      // 每日：07:30 起到 12:00 前可發（含補發）；12:00 後才醒就不補。
      if (handled.daily !== p.iso && p.minutesOfDay >= CATCHUP_FROM_MIN) {
        handled.daily = p.iso;
        if (state.dailyDate === p.iso || sentMem.daily === p.iso) {
          // 今天已發過
        } else if (p.minutesOfDay < CATCHUP_TO_MIN) {
          if (p.minutesOfDay - CATCHUP_FROM_MIN >= 2) d.log('[bot] digest daily catch-up');
          await runWithRetry('daily');
        } else {
          d.log(`[bot] digest daily missed date=${p.iso} reason=after-12:00`);
        }
      }
      // 前一晚：EVENING_AT（預設 20:00）起到 23:00 前可發（含補發）；23:00 後才醒就不補。
      if (handled.evening !== p.iso && p.minutesOfDay >= EVENING_FROM_MIN) {
        handled.evening = p.iso;
        if (state.eveningDate === p.iso || sentMem.evening === p.iso) {
          // 今晚已發過
        } else if (p.minutesOfDay < EVENING_TO_MIN) {
          if (p.minutesOfDay - EVENING_FROM_MIN >= 2) d.log('[bot] digest evening catch-up');
          await runWithRetry('evening');
        } else {
          d.log(`[bot] digest evening missed date=${p.iso} reason=after-23:00`);
        }
      }
      // 每週：週日 21:00 起可發（窗到週一 00:00 前）；週一才發現沒發就不補。
      const weeklyFrom = WEEKLY_AT.hour * 60 + WEEKLY_AT.minute;
      if (p.dow === WEEKLY_AT.dow && p.minutesOfDay >= weeklyFrom && handled.weekly !== p.iso) {
        handled.weekly = p.iso;
        await runWithRetry('weekly');
      } else if (p.dow === (WEEKLY_AT.dow + 1) % 7 && handled.weekly !== p.iso && state.weeklyWeek !== p.iso && sentMem.weekly !== p.iso) {
        handled.weekly = p.iso;
        d.log(`[bot] digest weekly missed week=${p.iso} reason=after-sunday-window`);
      }
    } catch (err) {
      d.log(`[bot] digest tick error: ${err && err.message ? err.message : err}`);
    }
  }

  function scheduleTick() {
    schedule(async () => {
      if (!started) return;
      scheduleTick(); // 先排下一個再處理，處理失敗不會讓排程中斷
      await tick();
    }, TICK_MS);
  }

  // 啟動：立刻 tick 一次（必要時補發今天的每日摘要），之後每 TICK_MS 一次。可重複呼叫（只生效一次）。
  async function start() {
    if (started) return;
    started = true;
    const next = nextTrigger(d.now());
    d.log(`[bot] digest scheduler started next=${next.kind} at=${new Date(next.atMs).toISOString()}`);
    scheduleTick();
    await tick();
  }

  function stop() {
    for (const h of timers) d.clearTimer(h);
    timers.clear();
    started = false;
  }

  return { start, stop, tick, runDaily, runWeekly, runEvening };
}

// 發到頻道：超過 2000 字依 discord-util.splitMessage 分段依序送；不解析 @mention（事件名稱可能含 @）。
async function sendToChannel(channel, text) {
  const parts = splitMessage(text);
  for (let k = 0; k < parts.length; k += 1) {
    try {
      await channel.send({ content: parts[k], allowedMentions: { parse: [] } });
    } catch (err) {
      // 已有段落送出就標 partial，讓 runner 不整則重試（重試會從第 1 段重送）。
      if (k > 0) {
        err.partial = true;
        err.message = `part ${k + 1}/${parts.length} failed after ${k} sent: ${err.message}`;
      }
      throw err;
    }
  }
}

module.exports = {
  taipeiParts,
  nextTrigger,
  shouldCatchUpDaily,
  isOpenIssue,
  isPriorityIssue,
  buildDailyDigest,
  buildWeeklyDigest,
  buildEveningDigest,
  EVENING_AT,
  nextWeekRange,
  readStateFile,
  writeStateFile,
  createDigestRunner,
  sendToChannel,
  STATE_FILE,
};
