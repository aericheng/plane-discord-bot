// Plane Discord Bot
// 對話式建立 Plane 事件：傳事件名稱 → 問 Due date → 問 label → 問 description → 建立 issue。
// Due date 支援單日（7/30、今天、明天）與週期（9/1到12/20的每個禮拜三 → 範圍內每個週三各建一筆）。
// label 對應的表情符號會加在事件名稱前（test 💯 / homework 📚 / presentation 🗣️ / remind 💡 / competition 🏆）。
// 建好的事件會出現在 Plane，並由既有的 Apps Script 每小時同步進 Google 日曆。

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { runAiParse, killActiveClaudeChildren, taipeiTodayInfo } = require('./ai-intake');

// ===== Plane 設定 =====
const PLANE = {
  apiBase: 'https://api.plane.so/api/v1',
  token: process.env.PLANE_API_TOKEN,
  workspace: 'aeri',
  project: '1b6c01b9-bc5a-4f45-932e-7456e33606ca',
};

const MAX_RECURRING = 40; // 週期建立上限（Plane API 60 req/min，留餘裕）

// label 名稱 → Plane label id 與名稱前綴 emoji（id 抓自 2026-07-24 的 workspace 現況）
const LABELS = [
  { name: 'test',         id: 'c7b2c20a-0054-4970-b9ee-4adf38a91c95', emoji: '💯' },
  { name: 'homework',     id: '005f30ad-8225-4b34-94d2-51d4f3cbd62c', emoji: '📚' },
  { name: 'presentation', id: 'd56611af-94a6-4397-91f9-40ff9ea965bc', emoji: '🗣️' },
  { name: 'remind',       id: '66c31e72-c4f2-44e4-a630-a7c9d1480d18', emoji: '💡' },
  { name: 'competition',  id: '3405ea85-9135-426f-9b4f-9d2d7d551d24', emoji: '🏆' },
  { name: 'work',         id: '501c83ce-fe04-415f-b31e-46aea26eb2a4', emoji: '' },
  { name: 'class',        id: '978cdc2f-adb1-4743-aa6a-f1dec468e8d7', emoji: '' },
  { name: 'lab',          id: '992c9da4-d196-48c6-a74b-39fc4bec6471', emoji: '' },
  { name: 'lesson',       id: '7450cb5a-b61c-4325-a63d-25c404d6c569', emoji: '' },
  { name: 'assistant',    id: '9fc2bcb2-6fdb-4121-bd56-d1c1dfcb9997', emoji: '' },
  { name: '不加label',    id: null,                                   emoji: '' },
];

const SKIP_WORDS = ['跳過', '無', '沒有', 'skip', 'no', '不用'];

const HELP_TEXT = [
  '**用法（AI 模式，預設）**：直接丟一段自由文字給我（可以一次講幾件事），我會用 AI 抽出裡面的事件，列出確認卡讓你按按鈕確認，才會真的寫進 Plane。',
  '- 也可以直接用自然語言查詢或刪除，例如「幫我刪掉8/1的古」「告訴我8/1有哪些行程」「8/12有微積分考試」；前綴 `查`/`刪` 是快速通道（不用等 AI）。',
  '- 缺日期的事件，按確認後我會逐筆問你。文字看不出明確內容時，我可能會先反問一次澄清（最多一輪）。',
  '- AI 暫時不可用時：短文字（40 字以內）會自動退回下面的「逐步模式」；長文字會請你稍後再試。',
  '',
  '**逐步模式（AI 不可用時的備援）**：依序問 Due date、label、description，然後建進 Plane。',
  '',
  '**Due date 格式**（逐步模式或補日期時用）：',
  '- 單日：`7/30`、`2026-07-30`、`今天`、`明天`、`後天`',
  '- 週期：`9/1到12/20的每個禮拜三`（範圍內每個週三各建一筆，僅逐步模式支援）',
  '',
  '逐步模式的 description 那步不想填就打 `跳過`。中途想放棄打 `取消`（會清掉所有進行中的流程）。',
  '',
  '**查詢**：`查 <日期/範圍/關鍵字>`（沒有進行中的流程時才會被當成查詢指令）',
  '- 範圍：`查 8/1到8/7`、`查 8/1~8/7`',
  '- 單日：`查 8/1`、`查 今天`',
  '- 關鍵字：`查 ewant`（比對事件名稱）',
  '',
  '**刪除**：`刪 <日期/範圍/關鍵字>`（語法同查詢）',
  '- 一次只刪一筆；找到多筆會先讓你選，選完顯示完整名稱／日期／id，按確認鈕才真的刪除，60 秒沒按會過期。',
  '- 需先在 `.env` 設定 `ALLOWED_USER_ID` 才能使用刪除。',
].join('\n');

// ===== 對話狀態（每位使用者一個進行中的建立流程） =====
const sessions = new Map(); // userId -> { step: 'due'|'label'|'desc', name, dates, dueLabel, label }

// ===== 查詢／刪除的暫存狀態 =====
// 刪除待確認（單筆鎖定後）：userId -> { id, name, due, expiresAt }
const pendingDeletes = new Map();
// 刪除候選清單（多筆待使用者用選單挑一筆）：userId -> { byId: Map(id -> issue), expiresAt }
const pendingDeleteLists = new Map();

// ===== AI 自由文字解析的暫存狀態（BOT-AI-INTAKE-SPEC.md） =====
// 進行中的 AI 呼叫鎖：userId -> true（同一使用者同時只能有一個 claude -p 在跑）。
const aiInFlight = new Set();
// 世代計數器：userId -> number。「取消」或重新起一輪解析時遞增，讓已經送出但還沒回來的
// 舊呼叫在 resolve 時能判斷自己已經過期，直接丟棄結果（不誤更新使用者看到的畫面）。
const aiGeneration = new Map();
function bumpAiGeneration(userId) {
  const next = (aiGeneration.get(userId) || 0) + 1;
  aiGeneration.set(userId, next);
  return next;
}
// 等待使用者輸入的三種 AI 流程狀態，userId -> 下列其中一種（phase 互斥，清除時務必連 aiInFlight 一起清）：
//   { phase: 'clarify', originalText, questions, expiresAt }                      —— 等待澄清回答
//   { phase: 'confirm', events, expiresAt }                                       —— 等待按確認卡按鈕
//   { phase: 'dateFill', events, pendingIndices, cursor, expiresAt }              —— 逐筆補缺的 due
const aiFlows = new Map();
function clearAiState(userId) {
  sessions.delete(userId);
  aiFlows.delete(userId);
  aiInFlight.delete(userId);
  bumpAiGeneration(userId);
}

// ===== 日期工具 =====
const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 解析單一日期字串為 Date；bumpPast=true 時，過去的 M/D 視為明年
function parseSingleDate(input, bumpPast) {
  const s = input.trim().toLowerCase();
  const today = new Date();
  const plus = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d;
  };

  if (s === '今天' || s === 'today') return plus(0);
  if (s === '明天' || s === 'tomorrow') return plus(1);
  if (s === '後天') return plus(2);

  let m = s.match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})[日號]?$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
    return d;
  }

  m = s.match(/^(\d{1,2})[\/\-月](\d{1,2})[日號]?$/);
  if (m) {
    const month = Number(m[1]), day = Number(m[2]);
    let d = new Date(today.getFullYear(), month - 1, day);
    if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (bumpPast && d < todayMidnight) d = new Date(today.getFullYear() + 1, month - 1, day);
    return d;
  }

  return null;
}

const WEEKDAY_MAP = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };

// 解析 Due date 輸入。回傳：
//   { dates: ['YYYY-MM-DD'], dueLabel: '2026-07-30' }（單日）
//   { dates: [...多個], dueLabel: '7/1~8/31 每週三，共 N 筆' }（週期）
//   { error: '訊息' } 或 null（看不懂）
function parseDueInput(input) {
  const s = input.trim();

  const m = s.match(/^(.+?)\s*(?:到|~|～)\s*(.+?)\s*的?\s*每個?\s*(?:禮拜|星期|週|周)([一二三四五六日天])$/);
  if (m) {
    const start = parseSingleDate(m[1], false);
    let end = parseSingleDate(m[2], false);
    if (!start || !end) return null;
    if (end < start) end = new Date(end.getFullYear() + 1, end.getMonth(), end.getDate()); // 跨年範圍
    const wd = WEEKDAY_MAP[m[3]];
    const dates = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === wd) dates.push(fmt(d));
    }
    if (dates.length === 0) return { error: '這個範圍內沒有任何符合的日期，請確認起訖日。' };
    if (dates.length > MAX_RECURRING) {
      return { error: `範圍內有 ${dates.length} 個日期，超過單次上限 ${MAX_RECURRING} 筆，請把範圍拆小一點。` };
    }
    return {
      dates,
      dueLabel: `${fmt(start)} ~ ${fmt(end)} 每${'禮拜' + m[3]}，共 ${dates.length} 筆（${dates[0]} ~ ${dates[dates.length - 1]}）`,
    };
  }

  const d = parseSingleDate(s, true);
  if (d) return { dates: [fmt(d)], dueLabel: fmt(d) };
  return null;
}

// 解析「查」「刪」指令的參數：依序嘗試 範圍 → 單日 → 關鍵字。
// 範圍／單日都正規化成 { type: 'range', start, end }（單日時 start === end），
// 都不是日期就當關鍵字 { type: 'keyword', keyword }。
function parseQueryInput(text) {
  const s = text.trim();

  const m = s.match(/^(.+?)\s*(?:到|~|～)\s*(.+)$/);
  if (m) {
    let start = parseSingleDate(m[1], true);
    let end = parseSingleDate(m[2], true);
    if (start && end) {
      if (end < start) { const t = start; start = end; end = t; }
      return { type: 'range', start: fmt(start), end: fmt(end) };
    }
  }

  const d = parseSingleDate(s, true);
  if (d) {
    const ds = fmt(d);
    return { type: 'range', start: ds, end: ds };
  }

  return { type: 'keyword', keyword: s };
}

function matchesQuery(issue, q) {
  if (q.type === 'range') {
    return !!issue.target_date && issue.target_date >= q.start && issue.target_date <= q.end;
  }
  if (q.type === 'both') {
    const inRange = !!issue.target_date && issue.target_date >= q.start && issue.target_date <= q.end;
    return inRange && issue.name.includes(q.keyword);
  }
  return issue.name.includes(q.keyword);
}

// AI 意圖分類（BOT-AI-INTENT-SPEC.md）的 query 物件（{start,end,keyword}）轉成上面 matchesQuery 吃的
// 既有內部格式。日期＋關鍵字兩者兼有時用新的 'both' type（先範圍後關鍵字，AND 過濾）——這是既有
// parseQueryInput 只會產生 range 或 keyword 其中一種所做不到的組合，過濾邏輯統一收在 matchesQuery 內，
// 不重複實作。回傳 null 代表兩者都沒有（正常不會走到，ai-intake.js 的決定性驗證已擋掉這種情況）。
function aiQueryToInternal(q) {
  const hasDate = !!(q && (q.start || q.end));
  const hasKeyword = !!(q && q.keyword);
  if (hasDate && hasKeyword) {
    return { type: 'both', start: q.start || q.end, end: q.end || q.start, keyword: q.keyword };
  }
  if (hasDate) {
    return { type: 'range', start: q.start || q.end, end: q.end || q.start };
  }
  if (hasKeyword) {
    return { type: 'keyword', keyword: q.keyword };
  }
  return null;
}

// 給訊息標題用的日期顯示（不補零，例：8/1 ~ 8/7）
function mdShort(dateStr) {
  if (!dateStr) return '--/--';
  const [, mo, da] = dateStr.split('-');
  return `${Number(mo)}/${Number(da)}`;
}

// 給清單每一行用的日期顯示（補零，例：08/01）
function mdPadded(dateStr) {
  if (!dateStr) return '--/--';
  const [, mo, da] = dateStr.split('-');
  return `${mo}/${da}`;
}

function describeQuery(q) {
  if (q.type === 'range') {
    return q.start === q.end ? mdShort(q.start) : `${mdShort(q.start)} ~ ${mdShort(q.end)}`;
  }
  if (q.type === 'both') {
    const dateLabel = q.start === q.end ? mdShort(q.start) : `${mdShort(q.start)} ~ ${mdShort(q.end)}`;
    return `${dateLabel}「${q.keyword}」`;
  }
  return `「${q.keyword}」`;
}

function byTargetDateAsc(a, b) {
  const da = a.target_date || '';
  const db = b.target_date || '';
  return da < db ? -1 : da > db ? 1 : 0;
}

// 把查詢結果組成單則訊息，超過 Discord 2000 字上限就截斷並附提示。
function buildListMessage(header, lines) {
  const full = [header, ...lines].join('\n');
  if (full.length <= 2000) return full;

  const shown = [];
  let len = header.length;
  for (const line of lines) {
    const add = line.length + 1;
    if (len + add > 1900) break; // 留餘裕給截斷提示
    shown.push(line);
    len += add;
  }
  const footer = `（共 ${lines.length} 筆，僅顯示前 ${shown.length} 筆，請縮小範圍）`;
  return [header, ...shown, footer].join('\n');
}

// ===== Plane API =====
function escapeHtml(t) {
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function createPlaneIssue({ name, due, label, desc }) {
  const body = { name, target_date: due };
  if (label && label.id) body.labels = [label.id];
  if (desc) body.description_html = `<p>${escapeHtml(desc).replace(/\r?\n/g, '<br/>')}</p>`;
  const res = await fetch(
    `${PLANE.apiBase}/workspaces/${PLANE.workspace}/projects/${PLANE.project}/issues/`,
    {
      method: 'POST',
      headers: { 'X-API-Key': PLANE.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Plane API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function issueUrl(issueId) {
  return `https://app.plane.so/${PLANE.workspace}/projects/${PLANE.project}/issues/${issueId}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 全量抓取整個 project 的 issues（查詢／刪除都要本地過濾，因為列表 API 不支援伺服器端日期過濾——
// 2026-07-30 實測：帶 target_date/target_date__gte 等參數，回應與不帶參數時完全相同，代表被忽略）。
// 382 筆＝4 頁，每頁之間 sleep(400) 避免踩 60 req/min。
async function fetchAllIssues() {
  const all = [];
  let page = 0;
  while (true) {
    const url = `${PLANE.apiBase}/workspaces/${PLANE.workspace}/projects/${PLANE.project}/issues/?per_page=100&cursor=100:${page}:0`;
    const res = await fetch(url, { headers: { 'X-API-Key': PLANE.token } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Plane API ${res.status}: ${text.slice(0, 300)}`);
    }
    const j = await res.json();
    all.push(...(j.results || []));
    if (!j.next_page_results) break;
    page += 1;
    await sleep(400);
  }
  return all;
}

async function deletePlaneIssue(issueId) {
  const res = await fetch(
    `${PLANE.apiBase}/workspaces/${PLANE.workspace}/projects/${PLANE.project}/issues/${issueId}/`,
    { method: 'DELETE', headers: { 'X-API-Key': PLANE.token } }
  );
  return res.status;
}

// 單筆 GET，回傳 HTTP 狀態碼（不解析 body）。用於刪除後 read-back：
// 已刪除的 issue 會回 403（不是 404，2026-07-29 實測地雷）。
async function getPlaneIssue(issueId) {
  const res = await fetch(
    `${PLANE.apiBase}/workspaces/${PLANE.workspace}/projects/${PLANE.project}/issues/${issueId}/`,
    { headers: { 'X-API-Key': PLANE.token } }
  );
  return res.status;
}

// ===== label 選單 =====
function labelMenu() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('plane_label')
    .setPlaceholder('選一個 label');
  for (const l of LABELS) {
    const opt = new StringSelectMenuOptionBuilder().setLabel(l.name).setValue(l.name);
    if (l.emoji) opt.setEmoji(l.emoji);
    menu.addOptions(opt);
  }
  return new ActionRowBuilder().addComponents(menu);
}

function askDescText(session) {
  const label = session.label;
  return [
    `🏷️ label：${label.id ? `${label.emoji ? label.emoji + ' ' : ''}${label.name}` : '（無）'}`,
    `📝 要加 description 嗎？直接輸入內容（可多行），不用就打 \`跳過\`。`,
  ].join('\n');
}

// ===== 建立（desc 步驟完成後呼叫） =====
async function finishCreate(session, desc, replyFn) {
  const label = session.label;
  const finalName = label.emoji ? `${label.emoji} ${session.name}` : session.name;

  const created = [];
  for (const due of session.dates) {
    const issue = await createPlaneIssue({ name: finalName, due, label, desc });
    created.push({ due, id: issue.id });
    if (session.dates.length > 1) await sleep(400);
  }

  const lines = [`✅ 已建立 ${created.length} 個事件：**${finalName}**`];
  if (created.length === 1) {
    lines.push(`📅 Due date：${created[0].due}`);
    lines.push(`🔗 ${issueUrl(created[0].id)}`);
  } else {
    const shown = created.map((c) => c.due);
    lines.push(`📅 日期：${shown.length <= 12 ? shown.join('、') : `${shown[0]} ~ ${shown[shown.length - 1]}`}`);
    lines.push(`🔗 第一筆：${issueUrl(created[0].id)}`);
  }
  lines.push(`🏷️ label：${label.id ? label.name : '（無）'}`);
  if (desc) lines.push(`📝 description：已寫入`);
  lines.push('', 'Google 日曆會在整點同步時出現（最慢 1 小時）。');
  return replyFn(lines.join('\n'));
}

// ===== AI 自由文字建立（BOT-AI-INTAKE-SPEC.md） =====

// 逐步模式的起手式（原本是「非指令訊息」的預設行為，AI 上線後改為 AI 解析失敗時的 fallback）。
function startStepwiseSession(userId, text) {
  sessions.set(userId, { step: 'due', name: text });
  const now = new Date();
  const todayLabel = `${now.getMonth() + 1}/${now.getDate()}（週${'日一二三四五六'[now.getDay()]}）`;
  return [
    `要建立事件「**${text}**」。`,
    `📅 Due date 是哪天？（今天是 ${todayLabel}）`,
    '單日：`7/30`、`2026-07-30`、`今天`、`明天`',
    '週期：`9/1到12/20的每個禮拜三`',
  ].join('\n');
}

// AI 不可用（spawn 失敗／逾時／二次 JSON 修復仍失敗）時的 fallback：短文字轉逐步模式，長文字請重試。
function aiFallbackContent(userId, originalText) {
  if (originalText.length <= 40) {
    return ['⚠️ AI 解析暫時不可用，改用逐步模式。', startStepwiseSession(userId, originalText)].join('\n');
  }
  return '⚠️ AI 解析暫時不可用，請稍後再試，或改用逐步模式（傳簡短事件名稱，40 字以內）。';
}

// 依日期升冪排序；沒有日期（❓需要日期）排最後。
function sortEventsForCard(events) {
  return [...events].sort((a, b) => {
    const da = a.due || '9999-99-99';
    const db = b.due || '9999-99-99';
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

function labelInfoFor(labelName) {
  return LABELS.find((l) => l.name === labelName) || LABELS.find((l) => l.name === 'remind');
}

function cardLineFor(ev, idx, todayIso) {
  const info = labelInfoFor(ev.label || 'remind');
  const labelSuffix = ev.label ? '' : '（預設）';
  let dueDisplay;
  if (!ev.due) dueDisplay = '❓需要日期';
  else if (ev.due < todayIso) dueDisplay = `⚠️ ${ev.due}（已過去）`;
  else dueDisplay = ev.due;
  return `${idx + 1}. ${info.emoji ? info.emoji + ' ' : ''}${ev.name} — ${dueDisplay}${labelSuffix}`;
}

// 組確認卡文字。若顯示不完整（超過 Discord 2000 字上限）不做截斷顯示——寧可拒絕也不能讓使用者
// 在沒看到全部內容的情況下按下確認鈕，回傳 tooLong 讓呼叫端改請使用者分段丟文字。
function buildConfirmCard(events) {
  const sorted = sortEventsForCard(events);
  const todayIso = taipeiTodayInfo().iso;
  const header = `🤖 從你的文字抽出 ${events.length} 筆事件：`;
  const lines = sorted.map((e, i) => cardLineFor(e, i, todayIso));
  const text = [header, ...lines].join('\n');
  if (text.length > 1900) return { tooLong: true, events: sorted };
  return { tooLong: false, text, events: sorted };
}

function buildAiConfirmRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`plane_ai_ok:${userId}`).setLabel('✅ 全部建立').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`plane_ai_no:${userId}`).setLabel('❌ 取消').setStyle(ButtonStyle.Secondary)
  );
}

// 確認後逐筆建立（依日期升冪）；emoji 前綴規則與既有建立流程一致；筆間 sleep(400)。
// 結果只憑 POST 回應判斷成功/失敗，不轉述 AI 的說法。
async function createAiEvents(events) {
  const sorted = sortEventsForCard(events);
  const results = [];
  for (const ev of sorted) {
    const label = labelInfoFor(ev.label || 'remind');
    const finalName = label.emoji ? `${label.emoji} ${ev.name}` : ev.name;
    try {
      const issue = await createPlaneIssue({ name: finalName, due: ev.due, label, desc: ev.desc || '' });
      // 成功回報一律取 POST 回應的欄位（不用 AI 事件物件），失敗回報才用送出值描述目標
      results.push({ ok: true, name: issue.name, due: issue.target_date, id: issue.id });
    } catch (err) {
      results.push({ ok: false, name: finalName, due: ev.due, error: err.message });
    }
    if (sorted.length > 1) await sleep(400);
  }
  return results;
}

function buildAiCreateReport(results) {
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const lines = [`✅ 已建立 ${okCount}/${results.length} 筆事件：`];
  for (const r of results) {
    lines.push(r.ok ? `- ${r.name} — ${r.due}｜${issueUrl(r.id)}` : `- ❌ ${r.name} — ${r.due}｜失敗：${r.error}`);
  }
  if (failCount > 0) lines.push('', `⚠️ ${failCount} 筆失敗，請人工確認 Plane 上的實際狀態。`);
  lines.push('', 'Google 日曆會在整點同步時出現（最慢 1 小時）。');
  return lines.join('\n');
}

// AI 解析成功、沒有需要澄清的問題之後：events 為空 → 明確告知；否則出確認卡。
async function presentAiConfirmOrEmpty(placeholder, userId, events, originalText) {
  if (events.length === 0) {
    aiFlows.delete(userId);
    return placeholder.edit(
      `🤖 我看不出這段文字裡有事件（原文共 ${originalText.length} 字）。可以換個說法，或直接傳簡短事件名稱走逐步模式。`
    );
  }
  const card = buildConfirmCard(events);
  if (card.tooLong) {
    aiFlows.delete(userId);
    return placeholder.edit(
      `🤖 抽出 ${events.length} 筆事件，但確認卡太長顯示不完整——為了不讓你在沒看到全部內容的情況下按確認，這次先不繼續，麻煩把文字拆成幾段分別丟給我。`
    );
  }
  aiFlows.set(userId, { phase: 'confirm', events: card.events, expiresAt: Date.now() + 120_000 });
  return placeholder.edit({ content: card.text, components: [buildAiConfirmRow(userId)] });
}

// 依 intent 分派到既有的決定性管線（BOT-AI-INTENT-SPEC.md §管線接軌）：
// query/delete 只餵「使用者想查/刪什麼」的參數給既有核心，AI 完全碰不到查詢結果內容與刪除執行路徑；
// create 走 v2 的確認卡流程；unknown 給一句提示。originalMsg 必須是使用者本人發的訊息物件
// （runAiDelete 需要正確的 author.id 來鍵值 pendingDeletes/pendingDeleteLists）。
async function dispatchByIntent(placeholder, originalMsg, userId, normalized, originalText) {
  const { intent, query, events } = normalized;
  if (intent === 'query') return runAiQuery(placeholder, query);
  if (intent === 'delete') return runAiDelete(placeholder, originalMsg, query);
  if (intent === 'unknown') {
    return placeholder.edit(
      ['🤖 看不出你要建立、查詢還是刪除。', '可以說「幫我刪掉8/1的古」「告訴我8/1有哪些行程」「8/12有微積分考試」。'].join('\n')
    );
  }
  return presentAiConfirmOrEmpty(placeholder, userId, events, originalText);
}

// AI 解析結果：questions 非空 → 進入澄清狀態等回答（連同這輪判斷的 intent 一併存起來，避免澄清後
// 重新解析時意圖漂移）；否則直接依 intent 分派。
async function handleAiOutcome(placeholder, originalMsg, userId, normalized, originalText) {
  const { intent, questions } = normalized;
  if (questions.length > 0) {
    aiFlows.set(userId, { phase: 'clarify', originalText, questions, intent, expiresAt: Date.now() + 120_000 });
    const qList = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    return placeholder.edit(
      ['🤖 有幾個地方要跟你確認：', qList, '', '請直接回覆（一則訊息即可）；輸入 `取消` 可放棄本次。'].join('\n')
    );
  }
  return dispatchByIntent(placeholder, originalMsg, userId, normalized, originalText);
}

// 非指令訊息的預設路徑：立即回 placeholder → 呼叫 AI → edit 同一則訊息成結果。
async function startAiParse(msg, text) {
  const userId = msg.author.id;
  const myGen = bumpAiGeneration(userId);
  aiInFlight.add(userId);
  const placeholder = await msg.reply('🤖 解析中…（約 10–20 秒）');
  const result = await runAiParse({ userText: text });
  aiInFlight.delete(userId);
  if (aiGeneration.get(userId) !== myGen) return; // 已被取消或有新一輪蓋過，捨棄這次結果

  if (!result.ok) {
    console.error('[bot] AI 解析失敗:', result.error);
    return placeholder.edit(aiFallbackContent(userId, text));
  }
  return handleAiOutcome(placeholder, msg, userId, result, text);
}

// 澄清回答（phase: 'clarify'）：原文＋問題＋這次回答＋第一輪的 intent 重新丟 AI，最多一輪，之後不管
// 有什麼都直接依 intent 分派，不再反問。
async function handleClarifyAnswer(msg, flow) {
  const userId = msg.author.id;
  if (Date.now() > flow.expiresAt) {
    aiFlows.delete(userId);
    return msg.reply('⌛ 已過期，請重新傳一次原文。');
  }
  aiFlows.delete(userId);
  const myGen = bumpAiGeneration(userId);
  aiInFlight.add(userId);
  const placeholder = await msg.reply('🤖 解析中…（約 10–20 秒）');
  const result = await runAiParse({
    userText: flow.originalText,
    clarify: { questions: flow.questions, answer: msg.content.trim(), intent: flow.intent },
  });
  aiInFlight.delete(userId);
  if (aiGeneration.get(userId) !== myGen) return;

  if (!result.ok) {
    console.error('[bot] AI 澄清解析失敗:', result.error);
    return placeholder.edit(aiFallbackContent(userId, flow.originalText));
  }
  return dispatchByIntent(placeholder, msg, userId, result, flow.originalText);
}

// 逐筆補缺日期（phase: 'dateFill'，按下確認鈕之後才會進入）：用既有 parseSingleDate 決定性解析。
async function handleDateFillAnswer(msg, flow) {
  const userId = msg.author.id;
  if (Date.now() > flow.expiresAt) {
    aiFlows.delete(userId);
    return msg.reply('⌛ 已過期，請重新傳一次原文。');
  }
  const text = msg.content.trim();
  const idx = flow.pendingIndices[flow.cursor];
  const d = parseSingleDate(text, true);
  if (!d) {
    return msg.reply('看不懂這個日期 😅 可用：`7/30`、`2026-07-30`、`今天`、`明天`，或輸入 `取消`。');
  }
  flow.events[idx].due = fmt(d);
  flow.cursor += 1;

  if (flow.cursor < flow.pendingIndices.length) {
    flow.expiresAt = Date.now() + 120_000;
    const nextIdx = flow.pendingIndices[flow.cursor];
    return msg.reply(`📅 「${flow.events[nextIdx].name}」是哪天？（可用 7/30、2026-07-30、今天、明天）`);
  }

  aiFlows.delete(userId);
  await msg.reply(`⏳ 建立 ${flow.events.length} 筆中…`);
  const results = await createAiEvents(flow.events);
  return msg.reply(buildAiCreateReport(results));
}

// 三種等待中的 AI 流程狀態的訊息分派（confirm 階段是按鈕驅動，文字訊息只提醒去按鈕）。
function handleAiFlowMessage(msg, flow) {
  if (flow.phase === 'clarify') return handleClarifyAnswer(msg, flow);
  if (flow.phase === 'dateFill') return handleDateFillAnswer(msg, flow);
  if (flow.phase === 'confirm') {
    return msg.reply('請按上面的「✅ 全部建立」或「❌ 取消」按鈕，或輸入 `取消` 放棄。');
  }
  return msg.reply('狀態異常，已重置，請重新傳文字給我。'); // 防禦性，理論上不會走到
}

// 按下確認卡「✅ 全部建立」：若有缺日期的事件先逐筆問，問完才真正建立。
async function handleAiConfirmOk(interaction) {
  const authorId = interaction.customId.slice('plane_ai_ok:'.length);
  if (interaction.user.id !== authorId) {
    return interaction.reply({ content: '這張確認卡不是給你的。', ephemeral: true });
  }
  const flow = aiFlows.get(authorId);
  if (!flow || flow.phase !== 'confirm' || Date.now() > flow.expiresAt) {
    aiFlows.delete(authorId);
    return interaction.update({ content: '已過期，請重新傳一次原文。', components: [] });
  }

  const missingIdx = flow.events.map((e, i) => (e.due ? -1 : i)).filter((i) => i !== -1);
  if (missingIdx.length > 0) {
    aiFlows.set(authorId, { phase: 'dateFill', events: flow.events, pendingIndices: missingIdx, cursor: 0, expiresAt: Date.now() + 120_000 });
    const firstIdx = missingIdx[0];
    return interaction.update({
      content: `✅ 收到，還有 ${missingIdx.length} 筆缺日期。\n📅 「${flow.events[firstIdx].name}」是哪天？（可用 7/30、2026-07-30、今天、明天）`,
      components: [],
    });
  }

  aiFlows.delete(authorId);
  await interaction.update({ content: `⏳ 建立 ${flow.events.length} 筆中…`, components: [] });
  const results = await createAiEvents(flow.events);
  return interaction.editReply(buildAiCreateReport(results));
}

async function handleAiConfirmNo(interaction) {
  const authorId = interaction.customId.slice('plane_ai_no:'.length);
  if (interaction.user.id !== authorId) {
    return interaction.reply({ content: '這張確認卡不是給你的。', ephemeral: true });
  }
  aiFlows.delete(authorId);
  return interaction.update({ content: '已取消，這批不會建立。', components: [] });
}

// ===== 查詢（`查 ...` 與 AI intent=query 共用核心） =====
// 抓取＋過濾＋組訊息文字，回傳字串本身（不送出），呼叫端決定要 msg.reply 還是 placeholder.edit——
// 這樣前綴路徑與 AI 路徑餵同一個 q 物件時輸出保證逐字元一致（BOT-AI-INTENT-SPEC.md 驗收條件 2）。
async function buildQueryReplyContent(q) {
  try {
    const issues = await fetchAllIssues();
    const matched = issues.filter((i) => matchesQuery(i, q)).sort(byTargetDateAsc);
    const headerLabel = describeQuery(q);

    if (matched.length === 0) {
      if (q.type === 'keyword') return `📋 「${q.keyword}」沒有符合的事件。`;
      if (q.type === 'both') return `📋 ${headerLabel} 沒有符合的事件。`;
      return `📋 ${headerLabel} 這個範圍沒有事件。`;
    }

    const lines = matched.map((i) => `${mdPadded(i.target_date)} ${i.name}  [${i.id.slice(0, 8)}]`);
    const header = `📋 ${headerLabel} 共 ${matched.length} 筆：`;
    return buildListMessage(header, lines);
  } catch (err) {
    console.error('[bot] handleQuery error:', err);
    return `❌ 查詢失敗：${err.message}`;
  }
}

async function handleQuery(msg, argText) {
  const content = await buildQueryReplyContent(parseQueryInput(argText));
  return msg.reply(content);
}

// AI intent=query：把 AI 的 query 物件轉成內部格式，餵同一個核心，edit 掉「解析中」placeholder。
async function runAiQuery(placeholder, aiQuery) {
  const q = aiQueryToInternal(aiQuery) || { type: 'keyword', keyword: '' };
  const content = await buildQueryReplyContent(q);
  return placeholder.edit(content);
}

// ===== 刪除（`刪 ...`） =====
function buildDeleteConfirmRow(issueId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`plane_del_ok:${issueId}`).setLabel('🗑️ 確認刪除').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('plane_del_no').setLabel('取消').setStyle(ButtonStyle.Secondary)
  );
}

function presentDeleteConfirm(msg, issue) {
  pendingDeletes.set(msg.author.id, {
    id: issue.id,
    name: issue.name,
    due: issue.target_date,
    expiresAt: Date.now() + 60_000,
  });
  return msg.reply({
    content: [
      '⚠️ 確定要刪除這筆嗎？',
      `名稱：${issue.name}`,
      `Due date：${issue.target_date}`,
      `id：${issue.id}`,
    ].join('\n'),
    components: [buildDeleteConfirmRow(issue.id)],
  });
}

function presentDeleteChoices(msg, issues) {
  const byId = new Map(issues.map((i) => [i.id, i]));
  pendingDeleteLists.set(msg.author.id, { byId, expiresAt: Date.now() + 60_000 });

  const menu = new StringSelectMenuBuilder()
    .setCustomId('plane_del_pick')
    .setPlaceholder('選一筆要刪除的事件');
  for (const i of issues) {
    const label = `${mdPadded(i.target_date)} ${i.name}`.slice(0, 100);
    menu.addOptions(new StringSelectMenuOptionBuilder().setLabel(label).setValue(i.id));
  }
  return msg.reply({
    content: `🔍 找到 ${issues.length} 筆符合的事件，請選一筆要刪除的：`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

// 抓取＋過濾＋排序（查詢與刪除的候選比對邏輯共用，不重複實作）。
async function resolveDeleteMatches(q) {
  const issues = await fetchAllIssues();
  return issues.filter((i) => matchesQuery(i, q)).sort(byTargetDateAsc);
}

async function handleDelete(msg, argText) {
  if (!process.env.ALLOWED_USER_ID) {
    return msg.reply('⚠️ 刪除功能目前停用：請先在 `.env` 設定 `ALLOWED_USER_ID`（填入你的 Discord user id）後再試一次。');
  }

  try {
    const q = parseQueryInput(argText);
    const matched = await resolveDeleteMatches(q);

    if (matched.length === 0) {
      return msg.reply(`🔍 找不到符合「${argText}」的事件。`);
    }
    if (matched.length === 1) {
      return presentDeleteConfirm(msg, matched[0]);
    }
    if (matched.length > 25) {
      return msg.reply(`🔍 找到 ${matched.length} 筆符合的事件，超過選單上限 25 筆，請縮小範圍再試一次。`);
    }
    return presentDeleteChoices(msg, matched);
  } catch (err) {
    console.error('[bot] handleDelete error:', err);
    return msg.reply(`❌ 刪除流程出錯：${err.message}`);
  }
}

// AI intent=delete：候選/選單/確認/read-back 全部沿用既有核心（presentDeleteConfirm/presentDeleteChoices
// 走的就是 pendingDeletes/pendingDeleteLists 那套 60 秒過期＋按鈕確認＋DELETE 後 read-back），AI 只碰得到
// 「篩出候選」這一步，碰不到刪除執行路徑本身。originalMsg 必須是使用者本人發的訊息物件（不能傳 placeholder，
// 否則 presentDeleteConfirm 內部用來鍵值 pendingDeletes 的 msg.author.id 會變成 bot 自己的 id）。
async function runAiDelete(placeholder, originalMsg, aiQuery) {
  if (!process.env.ALLOWED_USER_ID) {
    return placeholder.edit('⚠️ 刪除功能目前停用：請先在 `.env` 設定 `ALLOWED_USER_ID`（填入你的 Discord user id）後再試一次。');
  }
  const q = aiQueryToInternal(aiQuery) || { type: 'keyword', keyword: '' };
  const label = describeQuery(q);
  try {
    const matched = await resolveDeleteMatches(q);
    if (matched.length === 0) {
      return placeholder.edit(`🔍 找不到符合「${label}」的事件。`);
    }
    if (matched.length > 25) {
      return placeholder.edit(`🔍 找到 ${matched.length} 筆符合的事件，超過選單上限 25 筆，請縮小範圍再試一次。`);
    }
    await placeholder.edit(`🔍 找到符合「${label}」的事件，請看下面：`);
    if (matched.length === 1) return presentDeleteConfirm(originalMsg, matched[0]);
    return presentDeleteChoices(originalMsg, matched);
  } catch (err) {
    console.error('[bot] handleDelete error:', err);
    return placeholder.edit(`❌ 刪除流程出錯：${err.message}`);
  }
}

// 選單挑一筆之後（多候選情境）：鎖定該筆、進入確認畫面
async function handleDeletePick(interaction) {
  const pending = pendingDeleteLists.get(interaction.user.id);
  pendingDeleteLists.delete(interaction.user.id);
  if (!pending || Date.now() > pending.expiresAt) {
    return interaction.update({ content: '已過期，請重新下指令。', components: [] });
  }

  const id = interaction.values[0];
  const issue = pending.byId.get(id);
  if (!issue) {
    return interaction.update({ content: '找不到這筆資料，請重新下指令。', components: [] });
  }

  pendingDeletes.set(interaction.user.id, {
    id: issue.id,
    name: issue.name,
    due: issue.target_date,
    expiresAt: Date.now() + 60_000,
  });
  return interaction.update({
    content: [
      '⚠️ 確定要刪除這筆嗎？',
      `名稱：${issue.name}`,
      `Due date：${issue.target_date}`,
      `id：${issue.id}`,
    ].join('\n'),
    components: [buildDeleteConfirmRow(issue.id)],
  });
}

// 按下「確認刪除」：DELETE → 期待 204 → read-back GET → 期待 403（已刪除）
async function handleDeleteConfirm(interaction) {
  const targetId = interaction.customId.slice('plane_del_ok:'.length);
  const pending = pendingDeletes.get(interaction.user.id);

  if (!pending || pending.id !== targetId || Date.now() > pending.expiresAt) {
    pendingDeletes.delete(interaction.user.id);
    return interaction.update({ content: '已過期，請重新下指令。', components: [] });
  }
  pendingDeletes.delete(interaction.user.id);

  await interaction.update({ content: `⏳ 刪除中…（${pending.name}）`, components: [] });

  let delStatus;
  try {
    delStatus = await deletePlaneIssue(pending.id);
  } catch (err) {
    return interaction.editReply(`❌ 刪除失敗：${err.message}`);
  }
  if (delStatus !== 204) {
    return interaction.editReply(`❌ 刪除失敗：Plane 回應 HTTP ${delStatus}，未確認刪除成功。`);
  }

  await sleep(400);
  let checkStatus;
  try {
    checkStatus = await getPlaneIssue(pending.id);
  } catch (err) {
    return interaction.editReply(`⚠️ 已送出刪除（204），但 read-back 檢查出錯：${err.message}，請人工確認 Plane 上的實際狀態。`);
  }

  if (checkStatus === 403) {
    return interaction.editReply(
      [`✅ 已刪除：${pending.name}（${pending.due}）`, `id：${pending.id}（read-back 確認：已不存在）`].join('\n')
    );
  }
  return interaction.editReply(
    `⚠️ DELETE 回 204，但 read-back 檢查回 HTTP ${checkStatus}（預期 403＝已刪除），請人工確認 Plane 上的實際狀態，不確定是否真的刪除成功。`
  );
}

async function handleDeleteCancel(interaction) {
  pendingDeletes.delete(interaction.user.id);
  return interaction.update({ content: '已取消刪除。', components: [] });
}

// ===== Discord client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.on('clientReady', () => {
  console.log(`[bot] logged in as ${client.user.tag} at ${new Date().toISOString()}`);
});

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (process.env.ALLOWED_CHANNEL_ID && msg.channelId !== process.env.ALLOWED_CHANNEL_ID) return;
    if (process.env.ALLOWED_USER_ID && msg.author.id !== process.env.ALLOWED_USER_ID) return;

    const text = msg.content.trim();
    if (!text) return;

    if (text === '取消' || text.toLowerCase() === 'cancel') {
      clearAiState(msg.author.id);
      return msg.reply('已取消，隨時再丟文字給我。');
    }
    if (text === '幫助' || text.toLowerCase() === 'help') {
      return msg.reply(HELP_TEXT);
    }

    // 逐步模式（既有 due/label/desc 流程，行為不變；現在只透過 AI fallback 進入）優先處理，
    // 因為它一旦開始，接下來的每則訊息都是該流程的輸入值。
    const session = sessions.get(msg.author.id);
    if (session) {
      if (session.step === 'due') {
        const parsed = parseDueInput(text);
        if (!parsed) {
          return msg.reply(
            '看不懂這個日期 😅 可用：`7/30`、`2026-07-30`、`今天`、`明天`，或 `9/1到12/20的每個禮拜三`，或打 `取消`。'
          );
        }
        if (parsed.error) return msg.reply(`⚠️ ${parsed.error}`);
        session.dates = parsed.dates;
        session.dueLabel = parsed.dueLabel;
        session.step = 'label';
        return msg.reply({
          content: `📅 Due date：**${parsed.dueLabel}**\n🏷️ 要掛哪個 label？（也可以直接打字，例如 \`test\`）`,
          components: [labelMenu()],
        });
      }

      if (session.step === 'label') {
        const typed = LABELS.find((l) => l.name.toLowerCase() === text.toLowerCase());
        if (!typed) {
          return msg.reply(
            `沒有「${text}」這個 label。可用：${LABELS.map((l) => l.name).join('、')}，或用上面的選單選。`
          );
        }
        session.label = typed;
        session.step = 'desc';
        return msg.reply(askDescText(session));
      }

      if (session.step === 'desc') {
        const desc = SKIP_WORDS.includes(text.toLowerCase()) ? '' : msg.content.trim();
        sessions.delete(msg.author.id);
        if (session.dates.length > 1) {
          await msg.reply(`⏳ 建立 ${session.dates.length} 筆中…`);
        }
        return finishCreate(session, desc, (content) => msg.reply(content));
      }
      return; // 防禦性，理論上不會走到（session.step 只會是上述三值之一）
    }

    // AI 流程等待使用者輸入的三種狀態（clarify/confirm/dateFill）優先於「查」「刪」與新一輪解析。
    const flow = aiFlows.get(msg.author.id);
    if (flow) return handleAiFlowMessage(msg, flow);

    // 已有一輪 AI 呼叫在跑，還沒回來——不要再開一輪，避免重複呼叫 claude -p。
    if (aiInFlight.has(msg.author.id)) {
      return msg.reply('⏳ 上一段還在解析中，請稍等一下下（約 10–20 秒），或輸入 `取消` 中止。');
    }

    // 「查」「刪」只在沒有任何進行中流程時才攔截，避免吃掉其他狀態的輸入。
    const queryMatch = text.match(/^查\s+(.+)$/);
    if (queryMatch) return handleQuery(msg, queryMatch[1].trim());

    const delMatch = text.match(/^刪\s+(.+)$/);
    if (delMatch) return handleDelete(msg, delMatch[1].trim());

    // 預設路徑：非指令訊息一律走 AI 解析（BOT-AI-INTAKE-SPEC.md）。
    return startAiParse(msg, text);
  } catch (err) {
    console.error('[bot] messageCreate error:', err);
    clearAiState(msg.author.id);
    try {
      await msg.reply(`❌ 建立失敗：${err.message}\n請重新傳一次再試。`);
    } catch (_) {}
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    const isLabelSelect = interaction.isStringSelectMenu() && interaction.customId === 'plane_label';
    const isDeletePick = interaction.isStringSelectMenu() && interaction.customId === 'plane_del_pick';
    const isDeleteOk = interaction.isButton() && interaction.customId.startsWith('plane_del_ok:');
    const isDeleteNo = interaction.isButton() && interaction.customId === 'plane_del_no';
    const isAiOk = interaction.isButton() && interaction.customId.startsWith('plane_ai_ok:');
    const isAiNo = interaction.isButton() && interaction.customId.startsWith('plane_ai_no:');
    if (!isLabelSelect && !isDeletePick && !isDeleteOk && !isDeleteNo && !isAiOk && !isAiNo) return;

    if (process.env.ALLOWED_CHANNEL_ID && interaction.channelId !== process.env.ALLOWED_CHANNEL_ID) return;
    if (process.env.ALLOWED_USER_ID && interaction.user.id !== process.env.ALLOWED_USER_ID) {
      return interaction.reply({ content: '這個 bot 只服務它的主人 🙂', ephemeral: true });
    }

    if (isLabelSelect) {
      const session = sessions.get(interaction.user.id);
      if (!session || session.step !== 'label') {
        return interaction.reply({ content: '這個選單已過期，請重新傳事件名稱給我。', ephemeral: true });
      }

      session.label = LABELS.find((l) => l.name === interaction.values[0]) || LABELS[LABELS.length - 1];
      session.step = 'desc';
      await interaction.deferUpdate();
      await interaction.editReply({
        content: `📅 Due date：**${session.dueLabel}**\n${askDescText(session)}`,
        components: [],
      });
      return;
    }

    if (isDeletePick) return handleDeletePick(interaction);
    if (isDeleteOk) return handleDeleteConfirm(interaction);
    if (isDeleteNo) return handleDeleteCancel(interaction);
    if (isAiOk) return handleAiConfirmOk(interaction);
    if (isAiNo) return handleAiConfirmNo(interaction);
  } catch (err) {
    console.error('[bot] interactionCreate error:', err);
    sessions.delete(interaction.user.id);
    pendingDeletes.delete(interaction.user.id);
    pendingDeleteLists.delete(interaction.user.id);
    aiFlows.delete(interaction.user.id);
    try {
      await interaction.followUp({ content: `❌ 出錯了：${err.message}`, ephemeral: true });
    } catch (_) {}
  }
});

// 只有直接執行（node bot.js / start-bot.cmd）才登入 Discord；被 require() 進測試腳本時不觸發連線，
// 讓下面純函式（日期解析、查詢過濾、訊息組字）可以被單獨測試。
if (require.main === module) {
  if (!process.env.DISCORD_TOKEN || process.env.DISCORD_TOKEN === 'PUT_YOUR_DISCORD_BOT_TOKEN_HERE') {
    console.error('[bot] DISCORD_TOKEN not set in .env — get one from https://discord.com/developers/applications');
    process.exit(1);
  }
  client.login(process.env.DISCORD_TOKEN);

  // v1（AI intake）：Windows shell:true 呼叫 claude -p 的子行程不會跟著父行程一起死，
  // Ctrl+C／關機時主動收割，避免殭屍行程吃記憶體與訂閱額度（learning bot 2026-07-09 實案教訓）。
  process.on('SIGINT', () => {
    killActiveClaudeChildren();
    process.exit(0);
  });
}

module.exports = {
  parseSingleDate,
  parseDueInput,
  parseQueryInput,
  matchesQuery,
  describeQuery,
  mdShort,
  mdPadded,
  byTargetDateAsc,
  buildListMessage,
  fetchAllIssues, // 唯讀；日後測試/驗收可直接用真實 API 跑分頁與過濾邏輯
  handleQuery,
  handleDelete,
  handleDeleteConfirm, // 測試用：模擬按下「確認刪除」按鈕，走完整 DELETE + read-back 流程
  createPlaneIssue, // 測試用：建立測試 issue 供刪除流程驗收
  deletePlaneIssue, // 測試用：清理測試資料
  pendingDeletes, // 測試用：可直接操作 expiresAt 驗證 60 秒過期邏輯，不用真的等 60 秒
  client, // 測試用：可直接 client.emit(...) 觸發真正註冊的 messageCreate/interactionCreate handler 做回歸測試
  // ↓ AI intake（BOT-AI-INTAKE-SPEC.md）新增匯出，供測試/驗收使用
  sortEventsForCard,
  buildConfirmCard,
  createAiEvents, // 測試用：走真實 Plane API 建立/驗證多筆事件
  buildAiCreateReport,
  startStepwiseSession,
  aiFallbackContent,
  clearAiState,
  aiFlows, // 測試用：可直接操作 expiresAt 驗證 120 秒過期邏輯，不用真的等
  aiInFlight,
  aiGeneration,
  // ↓ AI 意圖分類（BOT-AI-INTENT-SPEC.md）新增匯出，供測試/驗收使用
  aiQueryToInternal,
  buildQueryReplyContent,
  resolveDeleteMatches,
  runAiQuery,
  runAiDelete,
  dispatchByIntent,
  handleAiOutcome,
};
