// e3-intake.js
// E3 候選期限確認卡的解析與寫入端（契約：BOT-E3-INTAKE-SPEC.md）。
// e3-course-watch 用本 bot 的 token 在 #e3-bot 貼「候選卡」（embed＋三顆按鈕），使用者按了按鈕後才由這裡
// 讀回 embed 欄位、去重、寫進 Plane。卡片本身就是資料載體：不讀任何跨專案檔案、不輪詢、bot 重啟不會遺失。
//
// 職責邊界：純邏輯（解析、正規化、去重決策、表單驗證、embed／modal 組裝）都是純函式，方便 selftest-e3-intake.js
// 不連 Discord、不打 Plane 就能回歸；只有 handleE3Interaction 會碰 interaction 與 deps 裡的 Plane API。
// 所有結果宣稱只憑 API 回應（issue.name／target_date／id），不憑送出值。

const logger = require('./log');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const E3_BUTTON_OK = 'plane_e3_ok';
const E3_BUTTON_EDIT = 'plane_e3_edit';
const E3_BUTTON_SKIP = 'plane_e3_skip';
const E3_BUTTON_FORCE = 'plane_e3_force'; // 「仍要建立」：相似事件警告卡上的按鈕，按了才真的 create
const E3_MODAL_ID = 'plane_e3_modal';
const E3_BUTTON_IDS = new Set([E3_BUTTON_OK, E3_BUTTON_EDIT, E3_BUTTON_SKIP, E3_BUTTON_FORCE]);

// 契約「顏色」節：完成改綠、略過改灰
const COLOR_DONE = 0x57f287;
const COLOR_SKIP = 0x99aab5;

const DEFAULT_LABEL_NAME = 'remind';
const STATUS_FIELD = '狀態';
const FIELD_DUE = '截止';
const FIELD_LABEL = '類型';
const FIELD_DESC = '描述';
// 兩種上游卡共用同一套 custom_id 與 handler：e3-course-watch（candidateId 形如 e3:…）與 gmail-watch（gmail:…）
const FOOTER_PREFIXES = ['e3-course-watch · ', 'gmail-watch · '];

// Discord 上限（embed title 256、field value 1024、modal text input value 4000、placeholder 100）
const MAX_TITLE = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_INPUT_VALUE = 4000;
const MAX_PLACEHOLDER = 100;

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

// ===== 判別 =====
function isE3Interaction(interaction) {
  if (!interaction) return false;
  if (typeof interaction.isButton === 'function' && interaction.isButton()) {
    return E3_BUTTON_IDS.has(interaction.customId);
  }
  if (typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit()) {
    return interaction.customId === E3_MODAL_ID;
  }
  return false;
}

// ===== 解析 =====
// 真正的日曆日期才算（2026-13-45 這種符合格式但不存在的日子視為無法解析，走 ✏️）
function isIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

function fieldValue(embed, name) {
  const fields = (embed && embed.fields) || [];
  const f = fields.find((x) => x && String(x.name).trim() === name);
  return f && f.value != null ? String(f.value) : '';
}

function findLabel(LABELS, name) {
  const key = String(name || '').trim().toLowerCase();
  return key ? LABELS.find((l) => l.name.toLowerCase() === key) : undefined;
}

// 從卡片 embed（discord.js Embed 或 plain object 都可）取出建立 issue 需要的欄位。
// 只依賴契約列出的 title／fields／url／footer，不依賴顏色或 description 文字。
// 「類型」對不上 LABELS → remind（契約規定的退路）。
function parseCardEmbed(embed, LABELS) {
  const name = String((embed && embed.title) || '').trim();
  const dueRaw = fieldValue(embed, FIELD_DUE).trim();
  const head = dueRaw.slice(0, 10);
  const dueDate = isIsoDate(head) ? head : null;
  const labelRaw = fieldValue(embed, FIELD_LABEL).trim();
  const label = findLabel(LABELS || [], labelRaw);
  const desc = fieldValue(embed, FIELD_DESC).trim();
  const url = (embed && embed.url) || null;
  const footer = (embed && embed.footer && embed.footer.text) || '';
  const prefix = FOOTER_PREFIXES.find((p) => footer.startsWith(p));
  const candidateId = prefix ? footer.slice(prefix.length).trim() || null : null;
  return { name, dueDate, dueRaw, labelName: label ? label.name : DEFAULT_LABEL_NAME, desc, url, candidateId };
}

// 同名比對用：去掉開頭 emoji／符號／空白、全形空白→半形、連續空白合併、trim、小寫。
// 「📚 強化學習專論 LAB1 - 2048」與「強化學習專論  LAB1 - 2048」要視為同一個名字。
function normalizeName(s) {
  return String(s == null ? '' : s)
    .replace(/　/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ===== 相似事件判定（Plane 建立出口的最後一道防線） =====
// 同 target_date 且符合任一條才算相似：
//   (a) 正規化名稱相同（reason 'same-name'）
//   (b) 名稱去 emoji 前綴後，CJK bigram＋英文／數字 token 的 Jaccard ≥ 0.5（'similar-name'）
//   (c) 候選卡 candidateId 為 e3:<courseId>:… 且既有事件描述含同課程前綴 e3:<courseId>:（'same-source'）
//       描述裡的 candidateId 由 createPlaneIssue 在末尾寫一行 `source: <candidateId>`。
const SIMILAR_THRESHOLD = 0.5;

// CJK 連續字串取 bigram（單字成串就取單字）；英文與數字分開成 token（Lab4 → lab、4）
function nameTokens(name) {
  const text = normalizeName(name);
  const tokens = new Set();
  for (const m of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const run = m[0];
    if (run.length === 1) tokens.add(run);
    else for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  for (const m of text.matchAll(/[a-z]+|\d+/g)) tokens.add(m[0]);
  return tokens;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function e3CoursePrefix(candidateId) {
  const m = /^(e3:[^:\s]+:)/.exec(String(candidateId || ''));
  return m ? m[1] : null;
}

function issueDescText(issue) {
  return [issue.description_html, issue.description_stripped, typeof issue.description === 'string' ? issue.description : '']
    .filter(Boolean)
    .join('\n');
}

// 回傳 [{ issue, reason }]（reason 優先序：same-name > same-source > similar-name）；沒有日期或沒有名稱 → []
function findSimilarIssues(issues, { name, due, candidateId }) {
  if (!due) return [];
  const key = normalizeName(name);
  const tokens = nameTokens(name);
  const prefix = e3CoursePrefix(candidateId);
  const out = [];
  for (const issue of issues || []) {
    if (!issue || issue.target_date !== due) continue;
    if (key && normalizeName(issue.name) === key) out.push({ issue, reason: 'same-name' });
    else if (prefix && issueDescText(issue).includes(prefix)) out.push({ issue, reason: 'same-source' });
    else if (jaccard(tokens, nameTokens(issue.name)) >= SIMILAR_THRESHOLD) out.push({ issue, reason: 'similar-name' });
  }
  return out;
}

const REASON_TEXT = {
  'same-name': '同名',
  'same-source': '同一門課的候選',
  'similar-name': '名稱相近',
};

// ===== 去重決策 =====
// name 已含 emoji 前綴（finalName）；existingIssues 為 fetchAllIssues() 的原始 API 回應。
// 同名 0 筆 → 再找同日相似事件：有 → similar（不建，等使用者按「仍要建立」）、沒有 → create；
// 1 筆同日 → skipDuplicate；1 筆異日 → update；≥2 筆 → ambiguous（不自動處理）。
// similar 時 matches 為相似的 issue 陣列，reasons 與之同序。candidateId 選填（啟用 E3 同課程判定）。
function decideAction({ name, dueDate, existingIssues, candidateId }) {
  const key = normalizeName(name);
  const matches = (existingIssues || []).filter((issue) => issue && normalizeName(issue.name) === key);
  if (matches.length === 0) {
    const similar = findSimilarIssues(existingIssues, { name, due: dueDate, candidateId });
    if (similar.length > 0) return { action: 'similar', matches: similar.map((x) => x.issue), reasons: similar.map((x) => x.reason) };
    return { action: 'create', matches };
  }
  if (matches.length >= 2) return { action: 'ambiguous', matches };
  return { action: matches[0].target_date === dueDate ? 'skipDuplicate' : 'update', matches };
}

// ===== ✏️ 表單驗證 =====
// 名稱必填；截止日交給 bot.js 的 parseSingleDate（bumpPast=true，YYYY-MM-DD／M/D／今天／明天都吃）再 fmt；
// 類型空白 → remind、對不上 → 錯誤並列出可用名稱；描述可空。
function validateModalInput({ name, dueInput, labelInput, desc }, { parseSingleDate, fmt, LABELS }) {
  const finalName = String(name == null ? '' : name).trim();
  if (!finalName) return { ok: false, error: '名稱不能空白。' };

  const dueStr = String(dueInput == null ? '' : dueInput).trim();
  const d = dueStr ? parseSingleDate(dueStr, true) : null;
  if (!d) {
    return { ok: false, error: `看不懂截止日「${dueStr}」，請用 YYYY-MM-DD、M/D、今天、明天。` };
  }

  const labelStr = String(labelInput == null ? '' : labelInput).trim();
  const label = labelStr ? findLabel(LABELS, labelStr) : findLabel(LABELS, DEFAULT_LABEL_NAME);
  if (!label) {
    return { ok: false, error: `類型「${labelStr}」不在清單裡，可用：${LABELS.map((l) => l.name).join('／')}。` };
  }

  return {
    ok: true,
    value: { name: finalName, dueDate: fmt(d), label, desc: String(desc == null ? '' : desc).trim() },
  };
}

// ===== 結果卡 =====
// 以 EmbedBuilder.from 複製原卡，加／替換「狀態」欄位、改色；有傳 name／dueDate／labelName／desc 就同步替換
// title／截止／類型／描述（desc 為空字串時移除「描述」欄位，讓之後再按 ✅ 時解析結果與使用者輸入一致）。
function buildResultEmbed(originalEmbed, { status, color, name, dueDate, labelName, desc }) {
  const eb = EmbedBuilder.from(originalEmbed);
  const fields = [...((eb.data && eb.data.fields) || [])];

  const setField = (fieldName, value, inline) => {
    const idx = fields.findIndex((f) => f.name === fieldName);
    const trimmed = String(value == null ? '' : value).trim();
    if (!trimmed) {
      if (idx !== -1) fields.splice(idx, 1);
      return;
    }
    const clipped = clip(trimmed, MAX_FIELD_VALUE);
    if (idx === -1) fields.push({ name: fieldName, value: clipped, inline: Boolean(inline) });
    else fields[idx] = { ...fields[idx], value: clipped };
  };

  if (name) eb.setTitle(clip(String(name).trim(), MAX_TITLE));
  if (dueDate) setField(FIELD_DUE, dueDate, true);
  if (labelName) setField(FIELD_LABEL, labelName, true);
  if (desc !== undefined) setField(FIELD_DESC, desc, false);
  if (status) setField(STATUS_FIELD, status, false);

  eb.setFields(fields);
  if (color != null) eb.setColor(color);
  return eb;
}

// ===== ✏️ modal =====
function buildEditModal(parsed) {
  const nameInput = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('名稱')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(MAX_TITLE);
  if (parsed.name) nameInput.setValue(clip(parsed.name, MAX_TITLE));

  const dueInput = new TextInputBuilder()
    .setCustomId('due')
    .setLabel('截止日（YYYY-MM-DD，或 M/D、今天、明天）')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20);
  if (parsed.dueDate) {
    dueInput.setValue(parsed.dueDate);
  } else {
    dueInput.setPlaceholder(clip(parsed.dueRaw ? `無法解析，原文：${parsed.dueRaw}` : 'YYYY-MM-DD', MAX_PLACEHOLDER));
  }

  const labelInput = new TextInputBuilder()
    .setCustomId('label')
    .setLabel('類型（label 名稱，留空＝remind）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(45);
  if (parsed.labelName) labelInput.setValue(parsed.labelName);

  const descInput = new TextInputBuilder()
    .setCustomId('desc')
    .setLabel('描述（選填）')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(MAX_INPUT_VALUE);
  if (parsed.desc) descInput.setValue(clip(parsed.desc, MAX_INPUT_VALUE));

  return new ModalBuilder()
    .setCustomId(E3_MODAL_ID)
    .setTitle('修改後加入 Plane')
    .addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(dueInput),
      new ActionRowBuilder().addComponents(labelInput),
      new ActionRowBuilder().addComponents(descInput)
    );
}

// ===== 互動處理 =====
// 同一張卡處理中（message id）的第二次互動直接擋掉。2026-10-15 實測：按 ✅ 後要先抓完 Plane 全部列表（數秒）
// 才建立，期間按鈕還在，連點兩下 → 兩次去重都看不到對方 → 建出兩筆同名事件。
const inFlight = new Set();

async function handleE3Interaction(interaction, deps) {
  // ✏️ 只開 modal、不動資料，不上鎖（showModal 必須是第一個回應）
  if (interaction.isButton() && interaction.customId === E3_BUTTON_EDIT) return handleE3InteractionInner(interaction, deps);
  const key = interaction.message && interaction.message.id;
  if (key && inFlight.has(key)) {
    (deps.log || logger.log)(`[bot] e3 duplicate interaction ignored (message ${key})`);
    await interaction.deferUpdate();
    return interaction.followUp({ content: '⏳ 這張卡正在處理中，請勿重複按。', ephemeral: true });
  }
  if (key) inFlight.add(key);
  try {
    return await handleE3InteractionInner(interaction, deps);
  } finally {
    if (key) inFlight.delete(key);
  }
}

// 前置：呼叫端（bot.js）已做 ALLOWED_USER_ID 檢查；本模組不做頻道閘門（卡片在 #e3-bot，不在 #plane）。
// 按鈕先 deferUpdate；✏️ 例外——showModal 必須是第一個回應。modal submit 用 isFromMessage 確認後 deferUpdate，
// 原卡片用 interaction.message。成功／略過 → 改卡片並拿掉按鈕；同名多筆或 API 失敗 → 按鈕保留、followUp ephemeral。
async function handleE3InteractionInner(interaction, deps) {
  const { LABELS, log = logger.log } = deps;

  if (interaction.isButton()) {
    const embed = interaction.message && interaction.message.embeds && interaction.message.embeds[0];

    if (interaction.customId === E3_BUTTON_EDIT) {
      if (!embed) return interaction.reply({ content: '❌ 這則訊息沒有卡片內容，無法修改。', ephemeral: true });
      return interaction.showModal(buildEditModal(parseCardEmbed(embed, LABELS)));
    }

    await interaction.deferUpdate();
    if (!embed) return interaction.followUp({ content: '❌ 這則訊息沒有卡片內容，無法處理。', ephemeral: true });
    const parsed = parseCardEmbed(embed, LABELS);

    if (interaction.customId === E3_BUTTON_SKIP) {
      log(`[bot] e3 skip: ${parsed.name} (${parsed.candidateId || 'no id'})`);
      await interaction.message.edit({
        embeds: [buildResultEmbed(embed, { status: '❌ 已略過', color: COLOR_SKIP })],
        components: [],
      });
      return;
    }

    if (!parsed.dueDate) {
      return interaction.followUp({
        content: `⚠️ 這張卡的截止日無法解析（${parsed.dueRaw || '空白'}），請改按「✏️ 修改後加入」手動填日期。`,
        ephemeral: true,
      });
    }
    const label = findLabel(LABELS, parsed.labelName) || findLabel(LABELS, DEFAULT_LABEL_NAME);
    const force = interaction.customId === E3_BUTTON_FORCE;
    return applyCandidate(interaction, embed, { name: parsed.name, dueDate: parsed.dueDate, label, desc: parsed.desc }, deps, false, force);
  }

  if (interaction.isModalSubmit()) {
    if (!interaction.isFromMessage()) {
      return interaction.reply({ content: '❌ 這個表單不是從候選卡開的，無法處理。', ephemeral: true });
    }
    await interaction.deferUpdate();
    const embed = interaction.message && interaction.message.embeds && interaction.message.embeds[0];
    if (!embed) return interaction.followUp({ content: '❌ 找不到原本的卡片內容，無法處理。', ephemeral: true });

    const checked = validateModalInput(
      {
        name: interaction.fields.getTextInputValue('name'),
        dueInput: interaction.fields.getTextInputValue('due'),
        labelInput: interaction.fields.getTextInputValue('label'),
        desc: interaction.fields.getTextInputValue('desc'),
      },
      deps
    );
    if (!checked.ok) return interaction.followUp({ content: `❌ ${checked.error}`, ephemeral: true });
    return applyCandidate(interaction, embed, checked.value, deps, true, false);
  }
}

// 相似事件警告卡的按鈕列：「仍要建立」「略過」（略過沿用 plane_e3_skip）
function buildSimilarRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(E3_BUTTON_FORCE).setLabel('仍要建立').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(E3_BUTTON_SKIP).setLabel('略過').setStyle(ButtonStyle.Secondary)
  );
}

// 建立／更新／去重的共同流程（✅ 與 ✏️ submit 都走這裡）。edited=true 時把卡片欄位改成使用者修改後的值。
// force=true（按「仍要建立」）：相似事件不再擋，直接 create；同名同日仍照舊 skipDuplicate。
async function applyCandidate(interaction, embed, { name, dueDate, label, desc }, deps, edited, force = false) {
  const { createPlaneIssue, updatePlaneIssue, fetchAllIssues, issueUrl, log = logger.log } = deps;
  const finalName = label.emoji ? `${label.emoji} ${name}` : name;
  const edits = edited ? { name, dueDate, labelName: label.name, desc } : { labelName: label.name };

  let existing;
  try {
    existing = await fetchAllIssues();
  } catch (err) {
    log(`[bot] e3 fetchAllIssues failed: ${err.message}`);
    return interaction.followUp({ content: `❌ 讀取 Plane 現有事件失敗：${err.message}\n卡片保留，可再按一次。`, ephemeral: true });
  }

  const candidateId = parseCardEmbed(embed, deps.LABELS).candidateId;
  const decided = decideAction({ name: finalName, dueDate, existingIssues: existing, candidateId });
  const { matches } = decided;
  const action = force && decided.action === 'similar' ? 'create' : decided.action;
  log(`[bot] e3 ${force ? 'force' : edited ? 'edit' : 'ok'}: ${action} "${finalName}" ${dueDate} (matches=${matches.length})`);

  if (action === 'similar') {
    const found = matches[0];
    const why = REASON_TEXT[decided.reasons[0]] || '相似';
    const more = matches.length > 1 ? `（另有 ${matches.length - 1} 筆相似）` : '';
    const status = `⚠️ Plane 同日已有「${found.name}」（${why}），可能是同一件事${more}
[開啟 issue](${issueUrl(found.id)})
要照樣建立請按「仍要建立」，否則按「略過」。`;
    await interaction.message.edit({ embeds: [buildResultEmbed(embed, { status, ...edits })], components: [buildSimilarRow()] });
    return interaction.followUp({
      content: `⚠️ Plane ${dueDate} 已有「${found.name}」，跟「${finalName}」可能是同一件事；沒有建立。要建立請按卡片上的「仍要建立」。`,
      ephemeral: true,
    });
  }

  if (action === 'ambiguous') {
    const status = `⚠️ Plane 有 ${matches.length} 筆同名事件，請手動處理`;
    await interaction.message.edit({ embeds: [buildResultEmbed(embed, { status, ...edits })] });
    return interaction.followUp({
      content: `⚠️ Plane 有 ${matches.length} 筆「${finalName}」，不自動建立或更新；請到 Plane 手動處理後再按按鈕。`,
      ephemeral: true,
    });
  }

  let status;
  try {
    if (action === 'create') {
      const issue = await createPlaneIssue({ name: finalName, due: dueDate, label, desc, source: candidateId });
      status = `✅ 已加入 Plane：${issue.name}（${issue.target_date}）\n[開啟 issue](${issueUrl(issue.id)})`;
    } else if (action === 'skipDuplicate') {
      const found = matches[0];
      status = `ℹ️ Plane 已有「${found.name}」（${found.target_date}），未重複建立\n[開啟 issue](${issueUrl(found.id)})`;
    } else {
      const found = matches[0];
      const updated = await updatePlaneIssue(found.id, { target_date: dueDate });
      const newDue = updated && updated.target_date != null ? updated.target_date : '（API 回應未含 target_date）';
      const newName = updated && updated.name ? updated.name : found.name;
      status = `🔁 已更新「${newName}」期限：${found.target_date} → ${newDue}\n[開啟 issue](${issueUrl(found.id)})`;
    }
  } catch (err) {
    log(`[bot] e3 ${action} failed: ${err.message}`);
    return interaction.followUp({ content: `❌ Plane 寫入失敗：${err.message}\n卡片保留，可再按一次。`, ephemeral: true });
  }

  await interaction.message.edit({
    embeds: [buildResultEmbed(embed, { status, color: COLOR_DONE, ...edits })],
    components: [],
  });
}

module.exports = {
  E3_BUTTON_OK,
  E3_BUTTON_EDIT,
  E3_BUTTON_SKIP,
  E3_BUTTON_FORCE,
  E3_MODAL_ID,
  COLOR_DONE,
  COLOR_SKIP,
  isE3Interaction,
  parseCardEmbed,
  normalizeName,
  decideAction,
  findSimilarIssues,
  REASON_TEXT,
  validateModalInput,
  buildResultEmbed,
  buildEditModal,
  handleE3Interaction,
};
