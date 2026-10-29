// BOT-SMART-SPEC.md v4（A 改期／修改、B 時間地點、C 查重）純邏輯自測：不連網、不登入 Discord、不呼叫 claude、不碰 Plane。
// global.fetch 全部以假的取代；smartHooks 注入假的 fetchAll／wait。
process.env.ALLOWED_USER_ID = process.env.ALLOWED_USER_ID || 'u-selftest';
const smart = require('./smart-edit');
const { normalizeAiResult, normalizeAiChanges, buildParsePrompt } = require('./ai-intake');
const bot = require('./bot');

let n = 0;
function ok(cond, name) {
  n += 1;
  if (!cond) { console.error('FAIL ' + name); process.exit(1); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);

const USER = process.env.ALLOWED_USER_ID;

// ---------- B. 時間地點 ----------
eq(smart.normalizeTimeText('19:10'), '19:10', 'time 19:10');
eq(smart.normalizeTimeText('9:05'), '09:05', 'time 補零');
eq(smart.normalizeTimeText('13:20~17:00'), '13:20~17:00', 'time 範圍');
eq(smart.normalizeTimeText('13:20-17:00'), '13:20~17:00', 'time 範圍 dash 正規化');
eq(smart.normalizeTimeText('25:00'), null, 'time 非法小時');
eq(smart.normalizeTimeText('下午七點'), null, 'time 非格式 → null（不猜）');
eq(smart.normalizeTimeText(null), null, 'time null');
eq(smart.normalizeLocationText('  B02 '), 'B02', 'location trim');
eq(smart.normalizeLocationText(''), null, 'location 空字串 → null');

eq(smart.buildDescText({ time: '19:10', location: 'B02', desc: '' }), '時間：19:10\n地點：B02', 'desc 時間+地點');
eq(smart.buildDescText({ time: null, location: 'B02', desc: '帶學生證' }), '地點：B02\n帶學生證', 'desc 省略沒有的行');
eq(smart.buildDescText({ time: '13:20~17:00', location: null, desc: '' }), '時間：13:20~17:00', 'desc 只有時間');
eq(smart.buildDescText({}), '', 'desc 全空');

// 描述行取代／插入、其他內容保留
eq(smart.extractTimeLocation('<p>時間：19:10<br/>地點：B02<br/>帶學生證</p>'), { time: '19:10', location: 'B02' }, 'extract 兩行');
eq(smart.extractTimeLocation('<p>上課時間：9:00</p>'), { time: null, location: null }, 'extract 不誤抓「上課時間」');
eq(smart.extractTimeLocation(null), { time: null, location: null }, 'extract null');
eq(
  smart.applyTimeLocationToHtml('<p>時間：19:10<br/>地點：B02<br/>帶學生證</p>', { location: 'B03' }),
  '<p>時間：19:10<br/>地點：B03<br/>帶學生證</p>',
  'location 取代既有行、其他保留'
);
eq(
  smart.applyTimeLocationToHtml('<p>帶學生證</p>', { time: '19:30', location: 'B03' }),
  '<p>時間：19:30<br/>地點：B03</p><p>帶學生證</p>',
  '沒有就插在最前面、其他保留'
);
eq(smart.applyTimeLocationToHtml('', { time: '19:30' }), '<p>時間：19:30</p>', '空描述插入');
eq(
  smart.applyTimeLocationToHtml('<p>地點：B02</p>', { time: '08:00', location: 'C1' }),
  '<p>時間：08:00</p><p>地點：C1</p>',
  '一行取代、一行插入'
);
eq(smart.applyTimeLocationToHtml('<p>地點：B02 &amp; C</p>', { location: 'A<1>' }), '<p>地點：A&lt;1&gt;</p>', '值會 escape');

// ---------- A. 改期 ----------
eq(smart.shiftIsoDate('2026-10-29', 7), '2026-11-05', 'shift +7');
eq(smart.shiftIsoDate('2026-12-30', 3), '2027-01-02', 'shift 跨年');
eq(smart.shiftIsoDate('2026-03-01', -1), '2026-02-28', 'shift 負數跨月');
eq(smart.weekdayZh('2026-10-29'), '四', '星期');
eq(smart.keepEmojiPrefix('💯 桌球考試', '桌球期中考'), '💯 桌球期中考', '改名保留 emoji');
eq(smart.keepEmojiPrefix('🗣️ 專題報告', '期末報告'), '🗣️ 期末報告', '改名保留 🗣️（含 variation selector）');
eq(smart.keepEmojiPrefix('桌球考試', '桌球期中考'), '桌球期中考', '原本沒 emoji');
eq(smart.keepEmojiPrefix('💯 桌球考試', '📚 桌球作業'), '📚 桌球作業', '新名稱自帶 emoji 尊重它');

const ISSUE = {
  id: 'id-1', name: '💯 桌球考試', target_date: '2026-10-29',
  description_html: '<p>時間：19:10<br/>地點：B02<br/>帶學生證</p>',
};
let plan = smart.planUpdate(ISSUE, { due: null, shift_days: 7, name: null, time: null, location: null });
eq(plan.patch, { target_date: '2026-11-05' }, 'shift_days → PATCH 只送 target_date');
eq(plan.expected, { target_date: '2026-11-05' }, 'shift expected');
ok(!plan.noChange, 'shift 有變動');
plan = smart.planUpdate(ISSUE, { due: '2026-11-02', shift_days: null, name: '桌球期末考', time: '08:00', location: 'B02' });
eq(Object.keys(plan.patch).sort(), ['description_html', 'name', 'target_date'], '多欄位 PATCH 欄位');
eq(plan.patch.name, '💯 桌球期末考', 'PATCH 名稱保留 emoji');
eq(plan.patch.description_html, '<p>時間：08:00<br/>地點：B02<br/>帶學生證</p>', 'PATCH 描述只換時間');
eq(plan.expected, { name: '💯 桌球期末考', target_date: '2026-11-02', time: '08:00' }, '地點未變不進 expected');
plan = smart.planUpdate(ISSUE, { due: '2026-10-29', shift_days: null, name: null, time: '19:10', location: null });
ok(plan.noChange && Object.keys(plan.patch).length === 0, '值相同 → noChange，不送 PATCH');
plan = smart.planUpdate({ ...ISSUE, target_date: null }, { due: null, shift_days: 7, name: null, time: null, location: null });
ok(/沒有日期/.test(plan.error), '原事件無日期 + shift_days → 錯誤');
const text = smart.buildUpdateCardText(ISSUE, smart.planUpdate(ISSUE, { due: null, shift_days: 7, name: null, time: null, location: 'B03' }));
ok(text.includes('日期：2026-10-29（四） → 2026-11-05（四）') && text.includes('地點：B02 → B03') && text.includes('名稱：💯 桌球考試（不變）') && text.includes('id：id-1'), '確認卡「舊 → 新」列');

eq(smart.verifyIssueFields({ ...ISSUE, target_date: '2026-11-05' }, { target_date: '2026-11-05' }), [], 'read-back 一致');
const bad = smart.verifyIssueFields(ISSUE, { target_date: '2026-11-05', location: 'B03', name: '💯 桌球考試' });
eq(bad.map((b) => b.field), ['日期', '地點'], 'read-back 指出沒改到的欄位');

// ---------- A. 解析正規化 ----------
const base = { intent: 'update', query: { start: '2026-10-29', end: '2026-10-29', keyword: '桌球' }, events: [], questions: [] };
let r = normalizeAiResult({ ...base, changes: { shift_days: 7 } });
eq([r.intent, r.changes.shift_days, r.changes.due, r.questions.length], ['update', 7, null, 0], 'update shift_days 通過');
r = normalizeAiResult({ ...base, changes: { due: '2026-11-05', shift_days: 7 } });
ok(r.questions.length === 1 && /確定的日期|相對/.test(r.questions[0]), 'due 與 shift_days 都給 → questions');
r = normalizeAiResult({ ...base, changes: { due: null, shift_days: null, name: null, time: null, location: null } });
ok(r.questions.length === 1, '沒有任何變更 → questions');
r = normalizeAiResult({ ...base, changes: { time: '下午七點' } });
ok(r.questions.length === 1 && r.changes.time === null, '非法 time 被丟掉 → 變成沒有變更 → questions');
r = normalizeAiResult({ ...base, changes: { shift_days: '7' } });
eq(r.changes.shift_days, 7, 'shift_days 字串數字轉整數');
r = normalizeAiResult({ ...base, changes: { shift_days: 3.5 } });
eq(r.changes.shift_days, null, 'shift_days 非整數 → null');
r = normalizeAiResult({ ...base, query: { start: null, end: null, keyword: null }, changes: { location: 'B03' } });
ok(r.questions.length === 1, 'update 沒有 query 條件 → questions');
r = normalizeAiResult({ intent: 'create', query: {}, events: [{ name: '老人驗', due: '2026-11-04', label: 'test', desc: '', time: '19:10', location: ' B02 ' }, { name: 'x', time: '亂', location: 5 }], questions: [] });
eq([r.events[0].time, r.events[0].location, r.events[1].time, r.events[1].location], ['19:10', 'B02', null, null], 'event time/location 正規化');
r = normalizeAiResult({ intent: 'create', events: [{ name: 'a', changes: 1 }], questions: [] });
eq(r.changes, { due: null, shift_days: null, name: null, time: null, location: null }, '非 update 的 changes 全 null');
const prompt = buildParsePrompt({ userText: '今天的桌球考試改到下禮拜同個時間' });
ok(prompt.includes('"shift_days":7') && prompt.includes('intent=update') && prompt.includes('"location":"B03"') && prompt.includes('"time":"19:10"'), 'prompt 含 update 與 time/location few-shot');

// ---------- C. 查重 ----------
const EXIST = [
  { id: 'a', name: '💯 老人驗', target_date: '2026-11-04' },
  { id: 'b', name: '老人驗', target_date: '2026-11-11' },
];
eq(smart.findDuplicates(EXIST, { name: '💯 老人驗', due: '2026-11-04' }).map((i) => i.id), ['a'], '同名同日');
eq(smart.findDuplicates(EXIST, { name: '老人驗', due: '2026-11-04' }).map((i) => i.id), ['a'], 'emoji 不影響');
eq(smart.findDuplicates(EXIST, { name: '老人驗', due: '2026-11-05' }), [], '不同日不算');
eq(smart.findDuplicates([{ id: 'c', name: '💯  Calculus　Exam', target_date: '2026-11-04' }], { name: 'calculus exam', due: '2026-11-04' }).length, 1, '全形空白／連續空白／大小寫');
eq(smart.findDuplicates(EXIST, { name: '老人驗', due: null }), [], '無日期不比對');

// ---------- patchWithRecovery（假 send／fetchAll） ----------
async function recoveryTests() {
  const transportErr = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  const waits = [];
  const wait = async (ms) => { waits.push(ms); };
  const log = () => {};
  // 逾時但實際已生效 → 重查找到 → 成功
  let res = await smart.patchWithRecovery(
    { issueId: 'id-1', patch: { target_date: '2026-11-05' }, expected: { target_date: '2026-11-05' } },
    { send: async () => { throw transportErr; }, fetchAll: async () => [{ ...ISSUE, target_date: '2026-11-05' }], wait, log }
  );
  ok(res.recovered && res.issue.target_date === '2026-11-05' && waits.length === 1, '逾時後重查：已是新值 → 視為成功');
  // 逾時且沒生效 → 兩次重查都沒有 → 丟錯
  waits.length = 0;
  let threw = false;
  try {
    await smart.patchWithRecovery(
      { issueId: 'id-1', patch: { target_date: '2026-11-05' }, expected: { target_date: '2026-11-05' } },
      { send: async () => { throw transportErr; }, fetchAll: async () => [ISSUE], wait, log }
    );
  } catch (e) { threw = /重查/.test(e.message); }
  ok(threw && waits.length === 2, '逾時後重查兩次都不是新值 → 丟錯');
  // HTTP 錯誤碼 → 不重查
  let fetched = 0;
  threw = false;
  try {
    await smart.patchWithRecovery(
      { issueId: 'id-1', patch: {}, expected: {} },
      { send: async () => { throw Object.assign(new Error('Plane API 400'), { planeStatus: 400 }); }, fetchAll: async () => { fetched += 1; return []; }, wait, log }
    );
  } catch (e) { threw = e.planeStatus === 400; }
  ok(threw && fetched === 0, 'HTTP 錯誤碼 → 直接丟，不重查');
}

// ---------- bot 端整合（假 fetch） ----------
function fakeMsg(content, id = 'm1') {
  const m = { id, content, author: { id: USER, bot: false }, channelId: 'c', replies: [] };
  m.reply = async (x) => { m.replies.push(x); return m; };
  return m;
}
function fakePlaceholder() {
  const p = { edits: [] };
  p.edit = async (x) => { p.edits.push(x); return p; };
  return p;
}
function fakeInteraction(customId, { messageId = 'btn1', values } = {}) {
  const it = { customId, user: { id: USER }, message: { id: messageId }, values, updates: [], replies: [], edits: [] };
  it.update = async (x) => { it.updates.push(x); };
  it.reply = async (x) => { it.replies.push(x); };
  it.editReply = async (x) => { it.edits.push(x); };
  return it;
}

async function botTests() {
  bot.smartHooks.wait = async () => {};
  const realFetch = global.fetch;
  const calls = [];
  const store = [
    { id: 'id-1', name: '💯 桌球考試', target_date: '2026-10-29', description_html: '<p>時間：19:10<br/>帶學生證</p>' },
    { id: 'id-2', name: '💯 桌球訓練', target_date: '2026-10-29', description_html: '' },
  ];
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url, body });
    if (method === 'PATCH') {
      const id = url.split('/issues/')[1].replace(/\/$/, '');
      Object.assign(store.find((i) => i.id === id), body);
      return { ok: true, status: 200, json: async () => store.find((i) => i.id === id) };
    }
    if (method === 'POST') {
      const created = { id: `new-${calls.length}`, name: body.name, target_date: body.target_date, description_html: body.description_html || '' };
      store.push(created);
      return { ok: true, status: 201, json: async () => created };
    }
    return { ok: true, status: 200, json: async () => ({ results: store.map((i) => ({ ...i })), next_page_results: false }) };
  };
  bot.smartHooks.fetchAll = async () => store.map((i) => ({ ...i }));

  try {
    // 候選 2 筆 → 選單；挑一筆 → 確認卡「舊 → 新」；按確認 → PATCH 只送變動欄位 → read-back
    const ph = fakePlaceholder();
    const msg = fakeMsg('今天的桌球考試改到下禮拜同個時間');
    await bot.runAiUpdate(ph, msg, { query: { start: '2026-10-29', end: '2026-10-29', keyword: '桌球' }, changes: { due: null, shift_days: 7, name: null, time: null, location: 'B03' } });
    const menuReply = msg.replies[0];
    const pickId = menuReply.components[0].components[0].data.custom_id;
    ok(pickId.startsWith('plane_upd_pick:'), '多筆候選 → 下拉選單');
    ok(menuReply.components[0].components[0].options.length === 2, '選單用和刪除同一套過濾（兩筆桌球）');
    const pick = fakeInteraction(pickId, { values: ['id-1'] });
    await bot.handleUpdatePick(pick);
    const card = pick.updates[0];
    ok(card.content.includes('日期：2026-10-29（四） → 2026-11-05（四）') && card.content.includes('地點：（無） → B03') && card.content.includes('id：id-1'), '確認卡顯示舊 → 新與 id');
    const okId = card.components[0].components[0].data.custom_id;
    ok(okId.startsWith('plane_upd_ok:') && card.components[0].components[1].data.custom_id.startsWith('plane_upd_no:'), '確認／取消按鈕');

    // 連點兩下（同 message.id）→ 只 PATCH 一次
    calls.length = 0;
    const c1 = fakeInteraction(okId, { messageId: 'same' });
    const c2 = fakeInteraction(okId, { messageId: 'same' });
    await Promise.all([bot.handleUpdateConfirm(c1), bot.handleUpdateConfirm(c2)]);
    const patches = calls.filter((c) => c.method === 'PATCH');
    ok(patches.length === 1, `連點兩下只 PATCH 一次（實際 ${patches.length}）`);
    eq(Object.keys(patches[0].body).sort(), ['description_html', 'target_date'], 'PATCH 只送變動欄位');
    ok(patches[0].body.description_html === '<p>地點：B03</p><p>時間：19:10<br/>帶學生證</p>', 'PATCH 描述：插入地點、保留原內容');
    ok(c2.replies.length === 1 && /處理中/.test(c2.replies[0].content), '第二次回 ephemeral 處理中');
    ok(/^✏️ 已修改：💯 桌球考試｜2026-10-29 → 2026-11-05｜/.test(c1.edits[0]) && /read-back 確認/.test(c1.edits[0]), '回報格式 + read-back');
    ok(store[0].target_date === '2026-11-05', 'store 實際已改');

    // 過期
    const ph2 = fakePlaceholder();
    const msg2 = fakeMsg('x');
    await bot.runAiUpdate(ph2, msg2, { query: { start: null, end: null, keyword: '桌球訓練' }, changes: { due: null, shift_days: 1, name: null, time: null, location: null } });
    const oid = msg2.replies[0].components[0].components[0].data.custom_id;
    bot.pendingUpdates.get(oid.split(':')[1]).expiresAt = Date.now() - 1;
    const exp = fakeInteraction(oid, { messageId: 'e1' });
    calls.length = 0;
    await bot.handleUpdateConfirm(exp);
    ok(/已過期/.test(exp.updates[0].content) && calls.length === 0, '確認卡 60 秒過期 → 不 PATCH');

    // 找不到 → 回「找不到」附查詢條件
    const ph3 = fakePlaceholder();
    await bot.runAiUpdate(ph3, fakeMsg('x'), { query: { start: null, end: null, keyword: '不存在的事' }, changes: { due: null, shift_days: 1, name: null, time: null, location: null } });
    ok(/找不到符合「「不存在的事」」|找不到符合「.*不存在的事.*」/.test(ph3.edits[0]), '0 筆 → 找不到＋條件');

    // 已經是想要的樣子 → 不出卡
    const ph4 = fakePlaceholder();
    const msg4 = fakeMsg('x');
    await bot.runAiUpdate(ph4, msg4, { query: { start: null, end: null, keyword: '桌球考試' }, changes: { due: '2026-11-05', shift_days: null, name: null, time: null, location: null } });
    ok(/不需要修改/.test(msg4.replies[0].content) && !msg4.replies[0].components, '值相同 → 不出確認卡');

    // 取消
    const ph5 = fakePlaceholder();
    const msg5 = fakeMsg('x');
    await bot.runAiUpdate(ph5, msg5, { query: { start: null, end: null, keyword: '桌球考試' }, changes: { due: null, shift_days: null, name: null, time: '20:00', location: null } });
    const oid5 = msg5.replies[0].components[0].components[0].data.custom_id;
    const noId = msg5.replies[0].components[0].components[1].data.custom_id;
    const cancel = fakeInteraction(noId);
    await bot.handleUpdateCancel(cancel);
    ok(/已取消/.test(cancel.updates[0].content) && !bot.pendingUpdates.has(oid5.split(':')[1]), '取消 → 卡片作廢');

    // ----- B+C：AI 建立（時間地點進描述；查重） -----
    calls.length = 0;
    const events = [
      { name: '老人驗', due: '2026-11-04', label: 'test', desc: '', time: '19:10', location: 'B02' },
      { name: '桌球考試', due: '2026-11-05', label: 'test', desc: '', time: null, location: null }, // 與 store[0] 同名同日（改期後）
    ];
    const cardRes = bot.buildConfirmCard(events, { existing: store, dupCheckFailed: false });
    ok(cardRes.text.includes('🕒 19:10　📍 B02') && cardRes.text.includes('⚠️ 已有同名同日（不會重複建立）'), '確認卡顯示 🕒📍 與重複標示');
    ok(bot.buildConfirmCard(events, { existing: null, dupCheckFailed: true }).text.includes('這次沒辦法查重'), '抓列表失敗 → 卡上警告');
    const results = await bot.createAiEvents(events);
    const posts = calls.filter((c) => c.method === 'POST');
    ok(posts.length === 1, `只建立不重複的那筆（POST ${posts.length}）`);
    ok(posts[0].body.description_html === '<p>時間：19:10<br/>地點：B02</p>', '描述 = 時間／地點行');
    ok(calls.filter((c) => c.method === 'GET').length === 0, '查重走 smartHooks（一批只抓一次，這裡由 hook 提供）');
    ok(results[1].skipped && !results[0].skipped, '重複的標 skipped');
    const report = bot.buildAiCreateReport(results);
    ok(report.includes('建立 1 筆，略過 1 筆已有') && report.includes('⏭️ 已有：'), '回報：建立 N 筆，略過 M 筆已有');

    // 按確認時再比對一次：剛建立的老人驗已經在 store → 重送被擋
    calls.length = 0;
    const again = await bot.createAiEvents(events);
    ok(calls.filter((c) => c.method === 'POST').length === 0 && again.every((x) => x.skipped), '重送同句 → 全部被查重擋下，零 POST');

    // 抓列表失敗：不擋建立，回報加警告
    bot.smartHooks.fetchAll = async () => { throw new Error('boom'); };
    const origErr = console.error;
    console.error = () => {};
    calls.length = 0;
    const failRes = await bot.createAiEvents([{ name: '新事件', due: '2026-12-01', label: null, desc: '補充', time: null, location: null }]);
    console.error = origErr;
    ok(calls.filter((c) => c.method === 'POST').length === 1 && failRes.dupCheckFailed, '抓列表失敗 → 仍建立');
    ok(bot.buildAiCreateReport(failRes).includes('⚠️ 這次沒辦法查重'), '回報有「沒辦法查重」警告');
    bot.smartHooks.fetchAll = async () => store.map((i) => ({ ...i }));

    // ----- 逐步建立（含週期）查重 -----
    calls.length = 0;
    const replies = [];
    await bot.finishCreate(
      { name: '老人驗', dates: ['2026-11-04', '2026-11-18'], label: bot.LABELS.find((l) => l.name === 'test') },
      '',
      async (c) => { replies.push(c); }
    );
    ok(calls.filter((c) => c.method === 'POST').length === 1, '週期：已存在的日期跳過，只建一筆');
    ok(/建立 1 筆，略過 1 筆已有/.test(replies[0]), '週期回報「建立 N 筆，略過 M 筆已有」');
  } finally {
    global.fetch = realFetch;
  }
}


// ---------- 修正輪（驗收員 5 點）純邏輯 ----------
// (1) 衝突時 normalizeAiChanges 清掉衝突欄位（其餘欄位保留）並產生 questions
{
  const c = normalizeAiChanges({ due: '2026-11-05', shift_days: 7, location: 'B03' });
  eq([c.changes.due, c.changes.shift_days, c.changes.location, c.questions.length], [null, null, 'B03', 1], 'fix1 衝突清掉 due＋shift_days、保留 location、產生 question');
  const r1 = normalizeAiResult({ intent: 'update', query: { keyword: '桌球' }, changes: { due: '2026-11-05', shift_days: 7 }, events: [], questions: [] });
  ok(!r1.changes.due && !r1.changes.shift_days && r1.questions.length === 1, 'fix1 normalizeAiResult 衝突後不留 due／shift_days');
  ok(!!bot.aiUnusableHelpText('update', r1.changes), 'fix1 衝突清掉後 changes 全空 → 判不合法');
  ok(bot.aiUnusableHelpText('update', { due: '2026-11-05', shift_days: 7 }) !== null, 'fix1 就算漏網 due＋shift_days 並存也判不合法');
  eq(bot.aiUnusableHelpText('update', { due: null, shift_days: 7, name: null, time: null, location: null }), null, 'fix1 合法 changes 不擋');
}

// (2) 行首有行內標籤／&nbsp;／全形空白 → 同一行整行取代
eq(smart.applyTimeLocationToHtml('<p><strong>時間：</strong>19:10</p>', { time: '20:00' }), '<p>時間：20:00</p>', 'fix2 行首 <strong> 整行取代，不出現 20:0019:10');
eq(smart.applyTimeLocationToHtml('<p>&nbsp;時間：19:10<br/>地點：B02</p>', { time: '20:00' }), '<p>時間：20:00<br/>地點：B02</p>', 'fix2 行首 &nbsp; 整行取代、不另插一行');
eq(smart.applyTimeLocationToHtml('<p>　<b>地點：</b><span>B02</span></p><p>帶學生證</p>', { location: 'C1' }), '<p>地點：C1</p><p>帶學生證</p>', 'fix2 全形空白＋多個行內標籤');
eq(smart.applyTimeLocationToHtml('<p>上課時間：9:00</p>', { time: '20:00' }), '<p>時間：20:00</p><p>上課時間：9:00</p>', 'fix2 「上課時間」不被當成同一行');
eq(smart.extractTimeLocation('<p><strong>時間：</strong>19:10</p><p>&nbsp;地點：B02</p>'), { time: '19:10', location: 'B02' }, 'fix2 extract 辨識標籤／&nbsp; 行');

// (5) AI 不可用 + 改期關鍵字 → 不進建立模式
for (const t of ['桌球考試改到下週三', '老人驗改成B03', '作業延到週五', '作業延後兩天', '報告提前一天', '課程換到週四', '幫我改期']) {
  const out = bot.aiFallbackContent('u-fb', t);
  ok(/AI 暫時不可用，改期請稍後再試，或到 Plane 手動修改/.test(out) && !/Due date/.test(out), `fix5 改期文字不進建立模式：${t}`);
}
ok(/Due date/.test(bot.aiFallbackContent('u-fb', '微積分期中考')), 'fix5 一般短文字仍走逐步模式（有問 Due date）');

async function fixTests() {
  const realFetch = global.fetch;
  const calls = [];
  const store = [];
  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url, body });
    if (method === 'POST') {
      const created = { id: `fx-${calls.length}`, name: body.name, target_date: body.target_date, description_html: body.description_html || '' };
      store.push(created);
      return { ok: true, status: 201, json: async () => created };
    }
    return { ok: true, status: 200, json: async () => ({ results: store.map((i) => ({ ...i })), next_page_results: false }) };
  };
  const hooksFetch = bot.smartHooks.fetchAll;
  bot.smartHooks.fetchAll = async () => store.map((i) => ({ ...i }));
  try {
    // (1) 澄清後仍不合法：不出確認卡、不碰 Plane，回說明（update／query／delete 三路徑）
    const bothSet = { intent: 'update', query: { start: null, end: null, keyword: '桌球' }, changes: { due: '2026-11-05', shift_days: 7, name: null, time: null, location: null }, events: [], questions: [] };
    let ph = fakePlaceholder();
    await bot.dispatchByIntent(ph, fakeMsg('x'), USER, bothSet, '桌球改到11/5或往後七天');
    ok(ph.edits.length === 1 && /看不懂要改哪一筆、改成什麼/.test(ph.edits[0]) && /今天的桌球考試改到下禮拜同個時間/.test(ph.edits[0]), 'fix1 due＋shift_days 並存 → 說明＋用法範例');
    const emptyQ = { start: null, end: null, keyword: null };
    ph = fakePlaceholder();
    await bot.dispatchByIntent(ph, fakeMsg('x'), USER, { ...bothSet, query: emptyQ, changes: { due: null, shift_days: 7, name: null, time: null, location: null } }, 'x');
    ok(/看不懂要改哪一筆/.test(ph.edits[0]), 'fix1 update 的 query 全空 → 說明');
    ph = fakePlaceholder();
    await bot.dispatchByIntent(ph, fakeMsg('x'), USER, { ...bothSet, changes: { due: null, shift_days: null, name: null, time: null, location: null } }, 'x');
    ok(/看不懂要改哪一筆/.test(ph.edits[0]), 'fix1 update 的 changes 全 null → 說明');
    ph = fakePlaceholder();
    await bot.dispatchByIntent(ph, fakeMsg('x'), USER, { intent: 'delete', query: emptyQ, changes: {}, events: [], questions: [] }, 'x');
    ok(/看不懂要刪哪一筆/.test(ph.edits[0]), 'fix1 delete 的 query 全空 → 說明，不比對全部事件');
    ph = fakePlaceholder();
    await bot.dispatchByIntent(ph, fakeMsg('x'), USER, { intent: 'query', query: emptyQ, changes: {}, events: [], questions: [] }, 'x');
    ok(/看不懂要查哪一筆/.test(ph.edits[0]), 'fix1 query 的 query 全空 → 說明，不列出全部事件');
    ok(calls.length === 0, 'fix1 以上路徑完全沒碰 Plane（無 fetch）');

    // (3) 同一張卡內兩筆同名同日：卡片標示、只建一筆
    const dupEvents = [
      { name: '老人驗', due: '2026-11-04', label: 'test', desc: '', time: null, location: null },
      { name: ' 老人驗 ', due: '2026-11-04', label: 'test', desc: '', time: '19:10', location: null },
      { name: '老人驗', due: '2026-11-05', label: 'test', desc: '', time: null, location: null },
    ];
    const card = bot.buildConfirmCard(dupEvents, { existing: [], dupCheckFailed: false });
    ok((card.text.match(/與上面同名同日（只會建立一筆）/g) || []).length === 1, 'fix3 卡片只在第二筆標示同卡重複（第三筆不同日不標）');
    calls.length = 0;
    const res = await bot.createAiEvents(dupEvents);
    ok(calls.filter((c) => c.method === 'POST').length === 2, 'fix3 同卡兩筆同名同日只 POST 一次（共 2 次 POST）');
    ok(res.filter((r) => r.skipped).length === 1 && res.filter((r) => r.ok && !r.skipped).length === 2, 'fix3 一筆略過、兩筆建立');
    ok(res.find((r) => r.skipped).id === res.find((r) => !r.skipped && r.due === '2026-11-04').id, 'fix3 略過那筆附第一筆的 id');
    ok(/建立 2 筆，略過 1 筆已有/.test(bot.buildAiCreateReport(res)), 'fix3 回報「建立 2 筆，略過 1 筆已有」');

    // (4) interactionCreate 的 catch 清掉該使用者的 pendingUpdates（別人的不動）
    bot.pendingUpdates.clear();
    bot.pendingUpdates.set('mine1', { userId: USER, expiresAt: Date.now() + 60000 });
    bot.pendingUpdates.set('mine2', { userId: USER, byId: new Map(), expiresAt: Date.now() + 60000 });
    bot.pendingUpdates.set('other', { userId: 'someone-else', expiresAt: Date.now() + 60000 });
    const boom = {
      customId: 'plane_upd_ok:mine1', user: { id: USER }, message: { id: 'boom1' }, channelId: process.env.ALLOWED_CHANNEL_ID,
      isButton: () => { throw new Error('boom in handler'); }, // 同步丟錯才會進 interactionCreate 的 catch（handler 的 return promise 沒 await）
      followUp: async () => {},
    };
    const origErr2 = console.error;
    console.error = () => {};
    bot.client.emit('interactionCreate', boom);
    await new Promise((r) => setTimeout(r, 30));
    console.error = origErr2;
    eq([...bot.pendingUpdates.keys()], ['other'], 'fix4 catch 清掉該使用者的 pendingUpdates，其他人的不動');
    bot.pendingUpdates.clear();
  } finally {
    global.fetch = realFetch;
    bot.smartHooks.fetchAll = hooksFetch;
  }
}

(async () => {
  await recoveryTests();
  await fixTests();
  await botTests();
  console.log(`selftest-smart: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
