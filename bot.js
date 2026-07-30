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
  '**用法**：直接傳「事件名稱」給我，我會依序問 Due date、label、description，然後建進 Plane。',
  '',
  '**Due date 格式**：',
  '- 單日：`7/30`、`2026-07-30`、`今天`、`明天`、`後天`',
  '- 週期：`9/1到12/20的每個禮拜三`（範圍內每個週三各建一筆）',
  '',
  'description 那步不想填就打 `跳過`。中途想放棄打 `取消`。',
  '',
  '**查詢**：`查 <日期/範圍/關鍵字>`（沒有進行中的建立流程時才會被當成查詢指令）',
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
  return issue.name.includes(q.keyword);
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

// ===== 查詢（`查 ...`） =====
async function handleQuery(msg, argText) {
  try {
    const q = parseQueryInput(argText);
    const issues = await fetchAllIssues();
    const matched = issues.filter((i) => matchesQuery(i, q)).sort(byTargetDateAsc);
    const headerLabel = describeQuery(q);

    if (matched.length === 0) {
      return msg.reply(
        q.type === 'keyword'
          ? `📋 「${q.keyword}」沒有符合的事件。`
          : `📋 ${headerLabel} 這個範圍沒有事件。`
      );
    }

    const lines = matched.map((i) => `${mdPadded(i.target_date)} ${i.name}  [${i.id.slice(0, 8)}]`);
    const header = `📋 ${headerLabel} 共 ${matched.length} 筆：`;
    return msg.reply(buildListMessage(header, lines));
  } catch (err) {
    console.error('[bot] handleQuery error:', err);
    return msg.reply(`❌ 查詢失敗：${err.message}`);
  }
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

async function handleDelete(msg, argText) {
  if (!process.env.ALLOWED_USER_ID) {
    return msg.reply('⚠️ 刪除功能目前停用：請先在 `.env` 設定 `ALLOWED_USER_ID`（填入你的 Discord user id）後再試一次。');
  }

  try {
    const q = parseQueryInput(argText);
    const issues = await fetchAllIssues();
    const matched = issues.filter((i) => matchesQuery(i, q)).sort(byTargetDateAsc);

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
      sessions.delete(msg.author.id);
      return msg.reply('已取消，隨時再傳事件名稱給我。');
    }
    if (text === '幫助' || text.toLowerCase() === 'help') {
      return msg.reply(HELP_TEXT);
    }

    const session = sessions.get(msg.author.id);

    if (!session) {
      // 「查」「刪」只在沒有進行中的建立流程時才攔截，避免吃掉 due/label/desc 步驟的輸入
      // （使用者若想中途查詢／刪除，要先打「取消」）。
      const queryMatch = text.match(/^查\s+(.+)$/);
      if (queryMatch) return handleQuery(msg, queryMatch[1].trim());

      const delMatch = text.match(/^刪\s+(.+)$/);
      if (delMatch) return handleDelete(msg, delMatch[1].trim());

      sessions.set(msg.author.id, { step: 'due', name: text });
      return msg.reply(
        [
          `要建立事件「**${text}**」。`,
          '📅 Due date 是哪天？',
          '單日：`7/30`、`2026-07-30`、`今天`、`明天`',
          '週期：`9/1到12/20的每個禮拜三`',
        ].join('\n')
      );
    }

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
  } catch (err) {
    console.error('[bot] messageCreate error:', err);
    sessions.delete(msg.author.id);
    try {
      await msg.reply(`❌ 建立失敗：${err.message}\n請重新傳事件名稱再試一次。`);
    } catch (_) {}
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    const isLabelSelect = interaction.isStringSelectMenu() && interaction.customId === 'plane_label';
    const isDeletePick = interaction.isStringSelectMenu() && interaction.customId === 'plane_del_pick';
    const isDeleteOk = interaction.isButton() && interaction.customId.startsWith('plane_del_ok:');
    const isDeleteNo = interaction.isButton() && interaction.customId === 'plane_del_no';
    if (!isLabelSelect && !isDeletePick && !isDeleteOk && !isDeleteNo) return;

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
  } catch (err) {
    console.error('[bot] interactionCreate error:', err);
    sessions.delete(interaction.user.id);
    pendingDeletes.delete(interaction.user.id);
    pendingDeleteLists.delete(interaction.user.id);
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
};
