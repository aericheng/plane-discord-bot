// BOT-SMART-SPEC.md v4（A 改期／修改、B 時間地點、C 建立前查重）的純邏輯：不連網、不碰 Discord。
// bot.js 與 ai-intake.js 共用；selftest-smart.js 直接測這裡。
const logger = require('./log');
const { normalizeName, findSimilarIssues } = require('./e3-intake'); // 查重重用 E3 的名稱正規化與相似判定（不另寫一份）

// ===== B. 時間／地點 =====
const TIME_RE = /^(\d{1,2})[:：](\d{2})$/;

function normOneTime(s) {
  const m = String(s).trim().match(TIME_RE);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

// 'HH:MM' 或 'HH:MM~HH:MM'（Apps Script 解析器看得懂的兩種格式）；其他一律 null，不猜。
function normalizeTimeText(input) {
  if (typeof input !== 'string') return null;
  const parts = input.trim().split(/\s*[~～〜\-–—]\s*/);
  if (parts.length === 1) return normOneTime(parts[0]);
  if (parts.length === 2) {
    const a = normOneTime(parts[0]);
    const b = normOneTime(parts[1]);
    return a && b ? `${a}~${b}` : null;
  }
  return null;
}

function normalizeLocationText(input) {
  if (typeof input !== 'string') return null;
  const s = input.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return s || null;
}

// bot 端決定性組描述：時間：…／地點：…／其餘補充；沒有的行省略。
function buildDescText({ time, location, desc }) {
  const lines = [];
  if (time) lines.push(`時間：${time}`);
  if (location) lines.push(`地點：${location}`);
  if (desc && String(desc).trim()) lines.push(String(desc).trim());
  return lines.join('\n');
}

function escapeHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeEntities(t) {
  return t
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function descHtmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  );
}

// 從 description_html 讀出 時間：／地點： 兩行的值（取不到為 null）。
function extractTimeLocation(html) {
  const out = { time: null, location: null };
  for (const line of descHtmlToText(html).split('\n')) {
    let m = line.match(/^\s*時間[:：]\s*(.*?)\s*$/);
    if (m && out.time === null) out.time = m[1] || null;
    m = line.match(/^\s*地點[:：]\s*(.*?)\s*$/);
    if (m && out.location === null) out.location = m[1] || null;
  }
  return out;
}

const INLINE_TAG = '</?(?:strong|b|em|i|u|span|font|a)\\b[^>]*>'; // 不含 <br>（\b 擋掉 <br）

// 取代或插入 時間：／地點： 行，其他描述內容原樣保留。value 為 undefined/null 的欄位不動。
// 已有該行 → 就地取代值；沒有 → 新增在描述最前面（時間在前、地點在後）。
function applyTimeLocationToHtml(html, { time, location }) {
  let out = html ? String(html) : '';
  const inserts = [];
  for (const [key, value] of [['時間', time], ['地點', location]]) {
    if (value === undefined || value === null) continue;
    // 一「行」從區塊邊界（開頭／換行／<br>／<p>、<div>、<li> 等標籤）起算，行首可有空白、&nbsp; 與行內標籤
    // （<strong> 等），行尾到下一個邊界為止；命中就整行換成純文字「時間：值」，避免舊值與新值並存。
    const re = new RegExp(`(^|\\n|<br\\s*/?>|</?(?:p|div|li|h[1-6])\\b[^>]*>)(?:\\s|&nbsp;|${INLINE_TAG})*${key}[:：](?:[^<\\n]|${INLINE_TAG})*`, 'i');
    if (re.test(out)) out = out.replace(re, (_m, a) => `${a}${key}：${escapeHtml(value)}`);
    else inserts.push(`${key}：${escapeHtml(value)}`);
  }
  if (inserts.length) out = `<p>${inserts.join('<br/>')}</p>${out}`;
  return out;
}

// ===== A. 改期／修改 =====
function isoToUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function shiftIsoDate(iso, days) {
  const d = isoToUtc(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function weekdayZh(iso) {
  return '日一二三四五六'[isoToUtc(iso).getUTCDay()];
}

function dateWithWeekday(iso) {
  return iso ? `${iso}（${weekdayZh(iso)}）` : '（無日期）';
}

// 改名時保留原本開頭的 emoji／符號前綴（例：「💯 」）；新名稱自己帶了前綴就尊重它。
function keepEmojiPrefix(oldName, newName) {
  const nn = String(newName || '').trim();
  if (!nn) return oldName;
  const prefix = (String(oldName || '').match(/^[^\p{L}\p{N}]+/u) || [''])[0];
  if (!prefix || /^[^\p{L}\p{N}]/u.test(nn)) return nn;
  return prefix + nn;
}

// 依 issue 現況＋AI 的 changes 算出：PATCH body（只含有變的欄位）、read-back 要比對的 expected、確認卡的「舊 → 新」列。
function planUpdate(issue, changes) {
  const cur = extractTimeLocation(issue.description_html);
  let newDue = null;
  if (changes.due) newDue = changes.due;
  else if (changes.shift_days) {
    if (!issue.target_date) return { error: '這筆事件沒有日期，沒辦法用「往後幾天」改期，請直接說新的日期。' };
    newDue = shiftIsoDate(issue.target_date, changes.shift_days);
  }
  const newName = changes.name ? keepEmojiPrefix(issue.name, changes.name) : null;

  const patch = {};
  const expected = {};
  if (newName && newName !== issue.name) { patch.name = newName; expected.name = newName; }
  if (newDue && newDue !== issue.target_date) { patch.target_date = newDue; expected.target_date = newDue; }
  const timeChanged = changes.time && changes.time !== cur.time;
  const locChanged = changes.location && changes.location !== cur.location;
  if (timeChanged || locChanged) {
    patch.description_html = applyTimeLocationToHtml(issue.description_html, {
      time: timeChanged ? changes.time : undefined,
      location: locChanged ? changes.location : undefined,
    });
    if (timeChanged) expected.time = changes.time;
    if (locChanged) expected.location = changes.location;
  }

  const rows = [
    { field: '名稱', from: issue.name, to: newName || issue.name, changed: 'name' in patch },
    { field: '日期', from: dateWithWeekday(issue.target_date), to: dateWithWeekday(newDue || issue.target_date), changed: 'target_date' in patch },
    { field: '時間', from: cur.time || '（無）', to: (timeChanged ? changes.time : cur.time) || '（無）', changed: !!timeChanged },
    { field: '地點', from: cur.location || '（無）', to: (locChanged ? changes.location : cur.location) || '（無）', changed: !!locChanged },
  ];
  return { patch, expected, rows, noChange: Object.keys(patch).length === 0, newDue: newDue || issue.target_date };
}

function buildUpdateCardText(issue, plan) {
  const lines = ['✏️ 確定要修改這筆嗎？', `id：${issue.id}`];
  for (const r of plan.rows) {
    lines.push(r.changed ? `${r.field}：${r.from} → ${r.to}` : `${r.field}：${r.from}（不變）`);
  }
  return lines.join('\n');
}

// read-back：逐欄比對（列表重抓的 issue vs 預期新值），回傳不一致的欄位清單（空陣列＝全部一致）。
function verifyIssueFields(issue, expected) {
  const bad = [];
  if ('name' in expected && issue.name !== expected.name) bad.push({ field: '名稱', expected: expected.name, actual: issue.name });
  if ('target_date' in expected && issue.target_date !== expected.target_date) {
    bad.push({ field: '日期', expected: expected.target_date, actual: issue.target_date });
  }
  if ('time' in expected || 'location' in expected) {
    const cur = extractTimeLocation(issue.description_html);
    if ('time' in expected && cur.time !== expected.time) bad.push({ field: '時間', expected: expected.time, actual: cur.time });
    if ('location' in expected && cur.location !== expected.location) bad.push({ field: '地點', expected: expected.location, actual: cur.location });
  }
  return bad;
}

const PATCH_RECOVERY_WAITS_MS = [3000, 10000];

// PATCH 逾時／連線中斷時比照 createWithRecovery：不直接報失敗，重抓列表確認欄位是否已是新值。
// Plane 回 HTTP 錯誤碼（planeStatus）是明確失敗，照舊直接丟。
async function patchWithRecovery({ issueId, patch, expected }, { send, fetchAll, wait, log = logger.log }) {
  try {
    return { issue: await send(issueId, patch), recovered: false };
  } catch (err) {
    if (err.planeStatus) throw err;
    log(`[bot] update ${issueId} transport error (${err.name}: ${err.message}), checking Plane list`);
    for (const ms of PATCH_RECOVERY_WAITS_MS) {
      await wait(ms);
      let issues;
      try {
        issues = await fetchAll();
      } catch (listErr) {
        log(`[bot] update recovery list failed: ${listErr.message}`);
        continue;
      }
      const hit = issues.find((i) => i.id === issueId);
      if (hit && verifyIssueFields(hit, expected).length === 0) {
        log(`[bot] update recovered ${issueId} after ${err.name}`);
        return { issue: hit, recovered: true };
      }
    }
    const wrapped = new Error(`${err.message}（逾時後重查 Plane 列表兩次，欄位都還不是新值）`, { cause: err });
    wrapped.name = err.name;
    throw wrapped;
  }
}

// ===== C. 查重 =====
// 名稱用 e3-intake 的 normalizeName（去開頭 emoji、全形空白、連續空白、大小寫）＋ 同 target_date。
function findDuplicates(issues, { name, due }) {
  if (!due) return [];
  const key = normalizeName(name);
  return (issues || []).filter((i) => i && i.target_date === due && normalizeName(i.name) === key);
}

// 自然語言建卡用：同日「名稱相近但不同名」的既有事件（只警示、不擋）。同名由 findDuplicates 處理。
// 回傳 [{ issue, reason }]，reason 目前只會是 'similar-name'。
function findSimilar(issues, { name, due }) {
  return findSimilarIssues(issues, { name, due }).filter((x) => x.reason === 'similar-name');
}

// 同一批內互相查重用的 key：名稱正規化＋日期；沒有日期回 null（不比對）。
function dupKey(name, due) {
  return due ? `${normalizeName(name)}|${due}` : null;
}

module.exports = {
  dupKey,
  normalizeTimeText,
  normalizeLocationText,
  buildDescText,
  descHtmlToText,
  extractTimeLocation,
  applyTimeLocationToHtml,
  shiftIsoDate,
  weekdayZh,
  dateWithWeekday,
  keepEmojiPrefix,
  planUpdate,
  buildUpdateCardText,
  verifyIssueFields,
  patchWithRecovery,
  findDuplicates,
  findSimilar,
};
