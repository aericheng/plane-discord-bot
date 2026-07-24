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
].join('\n');

// ===== 對話狀態（每位使用者一個進行中的建立流程） =====
const sessions = new Map(); // userId -> { step: 'due'|'label'|'desc', name, dates, dueLabel, label }

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
    if (!interaction.isStringSelectMenu() || interaction.customId !== 'plane_label') return;
    if (process.env.ALLOWED_CHANNEL_ID && interaction.channelId !== process.env.ALLOWED_CHANNEL_ID) return;
    if (process.env.ALLOWED_USER_ID && interaction.user.id !== process.env.ALLOWED_USER_ID) {
      return interaction.reply({ content: '這個 bot 只服務它的主人 🙂', ephemeral: true });
    }

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
  } catch (err) {
    console.error('[bot] interactionCreate error:', err);
    sessions.delete(interaction.user.id);
    try {
      await interaction.followUp({ content: `❌ 出錯了：${err.message}`, ephemeral: true });
    } catch (_) {}
  }
});

if (!process.env.DISCORD_TOKEN || process.env.DISCORD_TOKEN === 'PUT_YOUR_DISCORD_BOT_TOKEN_HERE') {
  console.error('[bot] DISCORD_TOKEN not set in .env — get one from https://discord.com/developers/applications');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
