// BOT-SMART-SPEC.md v4 §D 摘要 + E（interactionCreate 非同步錯誤進 catch）自測：不連網、不登入、不碰 Plane、不發 Discord。
// 時間、issues、states、send、計時器、狀態檔全部注入假的。
process.env.ALLOWED_USER_ID = process.env.ALLOWED_USER_ID || 'u-selftest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dg = require('./digest');
const bot = require('./bot');

let n = 0;
function ok(cond, name) {
  n += 1;
  if (!cond) { console.error('FAIL ' + name); process.exit(1); }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);

// Taipei 時刻 → UTC ms（UTC+8）
const tp = (iso, hh, mm) => Date.parse(`${iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);
const iso = (ms) => new Date(ms).toISOString();

// ---------- 下一次觸發時間 ----------
eq(iso(dg.nextTrigger(tp('2026-10-29', 7, 29)).atMs), iso(tp('2026-10-29', 7, 30)), '07:29 → 今天 07:30');
eq(dg.nextTrigger(tp('2026-10-29', 7, 29)).kind, 'daily', '07:29 kind=daily');
eq(iso(dg.nextTrigger(tp('2026-10-29', 7, 30)).atMs), iso(tp('2026-10-30', 7, 30)), '剛好 07:30 → 嚴格晚於，明天 07:30');
eq(iso(dg.nextTrigger(tp('2026-10-29', 23, 59)).atMs), iso(tp('2026-10-30', 7, 30)), '跨日：23:59 → 隔天 07:30');
eq(iso(dg.nextTrigger(tp('2026-12-31', 22, 0)).atMs), iso(tp('2027-01-01', 7, 30)), '跨年');
// 2026-11-01 是週日
eq(dg.nextTrigger(tp('2026-11-01', 8, 0)).kind, 'weekly', '週日 08:00 → 下一個是週日 21:00');
eq(iso(dg.nextTrigger(tp('2026-11-01', 8, 0)).atMs), iso(tp('2026-11-01', 21, 0)), '週日 21:00 時間');
eq(dg.nextTrigger(tp('2026-11-01', 21, 0)).kind, 'daily', '週日 21:00 整點 → 下一個是週一 07:30');
eq(iso(dg.nextTrigger(tp('2026-11-01', 21, 0)).atMs), iso(tp('2026-11-02', 7, 30)), '週一 07:30');
eq(dg.nextTrigger(tp('2026-10-31', 7, 31)).kind, 'daily', '週六 07:31 → 週日 07:30（daily）');
eq(iso(dg.nextTrigger(tp('2026-10-31', 7, 31)).atMs), iso(tp('2026-11-01', 7, 30)), '週日 07:30');
// Taipei 00:30 = UTC 前一天 16:30：日期必須是 Taipei 的
eq(dg.taipeiParts(tp('2026-10-29', 0, 30)).iso, '2026-10-29', 'Taipei 00:30 的日期是 10/29（不是 UTC 的 10/28）');
eq(iso(dg.nextTrigger(tp('2026-10-29', 0, 30)).atMs), iso(tp('2026-10-29', 7, 30)), 'Taipei 凌晨 → 當天 07:30');

// 本機 TZ 不同結果相同：在子行程用不同 TZ 重算同一批輸入
{
  const { execFileSync } = require('node:child_process');
  const code = `const d=require(${JSON.stringify(path.join(__dirname, 'digest.js'))});` +
    `const out=[];for(const ms of [Date.parse('2026-10-29T07:29:00+08:00'),Date.parse('2026-11-01T08:00:00+08:00'),Date.parse('2026-12-31T23:30:00+08:00'),Date.parse('2026-10-29T00:30:00+08:00')]){` +
    `const t=d.nextTrigger(ms);out.push([t.kind,t.atMs,d.taipeiParts(ms).iso,d.taipeiParts(ms).dow,d.shouldCatchUpDaily(ms,{})]);}console.log(JSON.stringify(out));`;
  const outs = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati'].map((TZ) =>
    execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' }).trim());
  ok(outs.every((o) => o === outs[0]), `本機 TZ 不同結果相同\n${outs.join('\n')}`);
  eq(JSON.parse(outs[0])[0][0], 'daily', 'TZ 子行程結果有效');
}

// ---------- 假資料 ----------
const TEST_ID = 'label-test';
const HW_ID = 'label-hw';
const PRIO = [TEST_ID, HW_ID];
const html = (time, loc) => `<p>${time ? `時間：${time}<br/>` : ''}${loc ? `地點：${loc}` : ''}</p>`;
let seq = 0;
function mk(name, date, o = {}) {
  seq += 1;
  return { id: `i${seq}`, name, target_date: date, state: o.state || 's-todo', state_group: o.group, description_html: o.html || '', labels: o.labels || [], ...(o.extra || {}) };
}
const STATES = { 's-todo': 'unstarted', 's-done': 'completed', 's-cancel': 'cancelled', 's-prog': 'started' };

// ---------- 完成／取消過濾 ----------
ok(dg.isOpenIssue(mk('a', '2026-10-29', { group: 'unstarted' }), STATES), 'unstarted 保留');
ok(!dg.isOpenIssue(mk('a', '2026-10-29', { group: 'completed' }), STATES), 'state_group=completed 排除');
ok(!dg.isOpenIssue(mk('a', '2026-10-29', { group: 'cancelled' }), STATES), 'state_group=cancelled 排除');
ok(!dg.isOpenIssue(mk('a', '2026-10-29', { state: 's-done' }), STATES), '沒有 state_group 時用 states 對照表：completed 排除');
ok(!dg.isOpenIssue(mk('a', '2026-10-29', { state: 's-cancel' }), STATES), '對照表：cancelled 排除');
ok(dg.isOpenIssue(mk('a', '2026-10-29', { state: 's-prog' }), STATES), '對照表：started 保留');
ok(!dg.isOpenIssue(mk('a', null, { group: 'unstarted' }), STATES), '無 target_date 排除');
ok(!dg.isOpenIssue(mk('a', '2026-10-29', { group: 'unstarted', extra: { archived_at: '2026-10-01' } }), STATES), 'archived 排除');

// ---------- 每日摘要 ----------
const TODAY = '2026-10-29'; // 週四
{
  const issues = [
    mk('📚 微積分作業', TODAY, { group: 'unstarted', labels: [HW_ID] }),
    mk('💡 看牙醫', TODAY, { group: 'unstarted', html: html('09:00', '診所') }),
    mk('💯 桌球考試', TODAY, { group: 'unstarted', html: html('13:20~17:00', 'B02') }),
    mk('🏆 比賽', TODAY, { group: 'unstarted', html: html('08:00', null) }),
    mk('💡 無時間事件', TODAY, { group: 'unstarted' }),
    mk('💡 已完成的', TODAY, { group: 'completed' }),
    mk('💡 已取消的', TODAY, { group: 'cancelled' }),
    mk('💡 明天的事', '2026-10-30', { group: 'unstarted', html: html(null, 'C1') }),
    mk('💡 後天的事', '2026-10-31', { group: 'unstarted' }),
  ];
  const r = dg.buildDailyDigest({ issues, statesById: STATES, todayIso: TODAY, priorityLabelIds: PRIO });
  eq(r.items, 6, '每日只含今天＋明天（5+1），不含後天與完成／取消');
  ok(!r.empty, '非空');
  const lines = r.text.split('\n');
  const idx = (s) => lines.findIndex((l) => l.includes(s));
  ok(idx('後天的事') === -1, '後天不出現');
  ok(idx('已完成的') === -1 && idx('已取消的') === -1, '完成／取消不出現');
  ok(idx('桌球考試') < idx('比賽') && idx('微積分作業') < idx('比賽'), '💯／📚 排當天最前（早於 08:00 的 🏆）');
  ok(idx('桌球考試') < idx('看牙醫') && idx('微積分作業') < idx('看牙醫'), '💯／📚 排在 09:00 的事件前');
  ok(idx('比賽') < idx('看牙醫'), '非優先事件依時間排序（08:00 在 09:00 前）');
  ok(idx('無時間事件') > idx('看牙醫'), '沒時間的排在有時間的後面');
  ok(lines[idx('桌球考試')] === '• 💯 桌球考試 🕒13:20~17:00 📍B02', '時間地點顯示格式: ' + lines[idx('桌球考試')]);
  ok(lines[idx('比賽')] === '• 🏆 比賽 🕒08:00', '只有時間只顯示時間');
  ok(lines[idx('明天的事')] === '• 💡 明天的事 📍C1', '只有地點只顯示地點');
  ok(lines[idx('無時間事件')] === '• 💡 無時間事件', '取不到就只列名稱');
  ok(r.text.includes('今天 10/29（四）') && r.text.includes('明天 10/30（五）'), '標示今天／明天與星期');
}
// 3. 時間排序：9:00 要排在 13:00 前（字串比較會反過來），顯示格式不變
{
  const issues = [
    mk('下午', TODAY, { group: 'unstarted', html: html('13:00', null) }),
    mk('早上', TODAY, { group: 'unstarted', html: html('9:00', null) }),
    mk('午前', TODAY, { group: 'unstarted', html: html('10:30~11:00', null) }),
    mk('沒時間', TODAY, { group: 'unstarted' }),
  ];
  const r = dg.buildDailyDigest({ issues, statesById: STATES, todayIso: TODAY, priorityLabelIds: PRIO });
  const lines = r.text.split('\n');
  const idx = (s) => lines.findIndex((l) => l.includes(s));
  ok(idx('早上') < idx('午前') && idx('午前') < idx('下午') && idx('下午') < idx('沒時間'), '9:00 < 10:30 < 13:00 < 沒時間: ' + r.text);
  ok(lines[idx('早上')] === '• 早上 🕒9:00', '顯示格式不變（仍是 9:00）');
}
// 今天沒事、明天有事：仍發，今天標沒有行程
{
  const r = dg.buildDailyDigest({ issues: [mk('x', '2026-10-30', { group: 'unstarted' })], statesById: STATES, todayIso: TODAY, priorityLabelIds: PRIO });
  ok(!r.empty && r.items === 1 && r.text.includes('（沒有行程）'), '今天空但明天有 → 發');
}
// 空日子：只有逾期、完成事件 → empty
{
  const r = dg.buildDailyDigest({
    issues: [mk('💯 舊考試', '2026-10-20', { group: 'unstarted' }), mk('💡 做完了', TODAY, { group: 'completed' })],
    statesById: STATES, todayIso: TODAY, priorityLabelIds: PRIO,
  });
  ok(r.empty && r.items === 0, '今天明天都沒事（逾期不算）→ empty');
}
// 逾期未完成 💯／📚 最多 5 筆（取最近 5 筆），💡 不列、已完成不列
{
  const issues = [mk('💡 今天', TODAY, { group: 'unstarted' })];
  for (let k = 1; k <= 8; k += 1) issues.push(mk(`💯 逾期${k}`, `2026-10-${String(10 + k).padStart(2, '0')}`, { group: 'unstarted' }));
  issues.push(mk('📚 逾期但完成', '2026-10-25', { group: 'completed' }));
  issues.push(mk('💡 逾期提醒', '2026-10-25', { group: 'unstarted' }));
  issues.push(mk('逾期標籤作業', '2026-10-26', { group: 'unstarted', labels: [HW_ID] }));
  const r = dg.buildDailyDigest({ issues, statesById: STATES, todayIso: TODAY, priorityLabelIds: PRIO });
  const od = r.text.split('\n').filter((l) => l.includes('原訂'));
  eq(od.length, 5, '逾期最多 5 筆');
  ok(r.text.includes('已過期但未完成') && r.text.includes('另有 4 筆更早的'), '逾期標題與 extra 計數（9 筆符合 − 5）');
  ok(!r.text.includes('逾期但完成') && !r.text.includes('逾期提醒'), '逾期清單不含完成與非 💯／📚');
  ok(od.some((l) => l.includes('逾期標籤作業')), '用 label id 辨識 📚 作業（名稱沒 emoji 也算）');
  ok(!od.some((l) => l.includes('逾期1 ')), '最舊的被截掉');
  eq(r.items, 1, '逾期不計入 items');
}

// ---------- 週摘要 ----------
{
  // 2026-11-01 週日 → 下週 11/2(一)~11/8(日)
  const SUN = '2026-11-01';
  eq(dg.nextWeekRange(SUN), { monday: '2026-11-02', sunday: '2026-11-08' }, '週日 → 下週一到週日');
  eq(dg.nextWeekRange('2026-10-29'), { monday: '2026-11-02', sunday: '2026-11-08' }, '週四 → 下週一');
  eq(dg.nextWeekRange('2026-11-02'), { monday: '2026-11-09', sunday: '2026-11-15' }, '週一 → 再下一週一');
  const issues = [
    mk('💡 週日的事', '2026-11-08', { group: 'unstarted' }),
    mk('💡 週三的事', '2026-11-04', { group: 'unstarted', html: html('19:10', 'B02') }),
    mk('📚 週三作業', '2026-11-04', { group: 'unstarted', labels: [HW_ID] }),
    mk('💯 週一考試', '2026-11-02', { group: 'unstarted' }),
    mk('💡 這週日（不算）', '2026-11-01', { group: 'unstarted' }),
    mk('💡 下下週一（不算）', '2026-11-09', { group: 'unstarted' }),
    mk('💡 週三取消', '2026-11-04', { group: 'cancelled' }),
  ];
  const r = dg.buildWeeklyDigest({ issues, statesById: STATES, todayIso: SUN, priorityLabelIds: PRIO });
  eq(r.week, '2026-11-02', 'week = 週一日期');
  eq(r.items, 4, '週摘要 4 筆（不含範圍外與取消）');
  const lines = r.text.split('\n');
  const idx = (s) => lines.findIndex((l) => l.includes(s));
  ok(r.text.includes('**11/2（一）**') && r.text.includes('**11/4（三）**') && r.text.includes('**11/8（日）**'), '依日期分組並標星期');
  ok(!r.text.includes('11/3（二）'), '沒有事件的日子不列標題');
  ok(idx('**11/2（一）**') < idx('**11/4（三）**') && idx('**11/4（三）**') < idx('**11/8（日）**'), '日期遞增');
  ok(idx('週三作業') < idx('週三的事'), '週摘要同樣 📚 排當天最前');
  ok(lines[idx('週三的事')] === '• 💡 週三的事 🕒19:10 📍B02', '週摘要時間地點');
  ok(!r.text.includes('不算') && !r.text.includes('週三取消'), '範圍外／取消不出現');
  const empty = dg.buildWeeklyDigest({ issues: [], statesById: STATES, todayIso: SUN, priorityLabelIds: PRIO });
  ok(empty.empty, '下週沒事 → empty');
}

// ---------- 補發判斷 ----------
ok(dg.shouldCatchUpDaily(tp(TODAY, 7, 30), {}), '07:30 整點、今天未發 → 補');
ok(dg.shouldCatchUpDaily(tp(TODAY, 11, 59), { dailyDate: '2026-10-28' }), '11:59、只發過昨天 → 補');
ok(!dg.shouldCatchUpDaily(tp(TODAY, 7, 29), {}), '07:29 → 不補（排程會發）');
ok(!dg.shouldCatchUpDaily(tp(TODAY, 12, 0), {}), '12:00 → 不補');
ok(!dg.shouldCatchUpDaily(tp(TODAY, 15, 0), {}), '下午 → 不補');
ok(!dg.shouldCatchUpDaily(tp(TODAY, 9, 0), { dailyDate: TODAY }), '今天已發 → 不重發');

// ---------- runner（假時鐘／假計時器／假狀態） ----------
function makeRunner({ nowMs, issues, state = {}, sendFail = 0, fetchFail = 0, writeFail = false }) {
  const ctx = { now: nowMs, sent: [], logs: [], state: { ...state }, timers: [], fetchCalls: 0, sendCalls: 0 };
  ctx.runner = dg.createDigestRunner({
    now: () => ctx.now,
    fetchAll: async () => { ctx.fetchCalls += 1; if (ctx.fetchCalls <= fetchFail) throw new Error('plane down'); return issues; },
    fetchStates: async () => STATES,
    send: async (t) => { ctx.sendCalls += 1; if (ctx.sendCalls <= sendFail) throw new Error('discord down'); ctx.sent.push(t); },
    readState: () => ({ ...ctx.state }),
    writeState: (s) => { if (writeFail) throw new Error('disk full'); ctx.state = { ...s }; },
    log: (l) => ctx.logs.push(l),
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; ctx.timers.push(h); return h; },
    clearTimer: (h) => { h.cleared = true; },
    priorityLabelIds: PRIO,
  });
  return ctx;
}
const todays = [mk('💯 桌球考試', TODAY, { group: 'unstarted', html: html('13:20', 'B02') })];

(async () => {
  const TICK_MS = 60_000;
  const fireTick = async (c) => {
    const t = c.timers.filter((x) => x.ms === TICK_MS && !x.cleared).pop();
    ok(!!t, 'fireTick：有未清掉的 tick 計時器');
    await t.fn();
  };
  const HEALTH_RE = /\[bot\] digest (daily|weekly) (sent|skipped) /; // ops-audit 健康檢查用的正則（簡化）
  const noHealthMatch = (c, name) => ok(!c.logs.some((l) => HEALTH_RE.test(l)), `${name}：不應寫出會被健康檢查當成功的 log\n${c.logs.join('\n')}`);

  // 07:45 啟動、今天未發 → 補發一次，寫 sent log 與狀態，並排好下一個 tick
  {
    const c = makeRunner({ nowMs: tp(TODAY, 7, 45), issues: todays });
    await c.runner.start();
    eq(c.sent.length, 1, '補發：送出一次');
    ok(c.logs.some((l) => /^\[bot\] digest daily sent date=2026-10-29 items=1 at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(l)), 'sent log 格式: ' + c.logs.join(' | '));
    eq(c.state.dailyDate, TODAY, '補發後狀態檔寫入日期');
    eq(c.timers.length, 1, '排好下一個 tick');
    eq(c.timers[0].ms, TICK_MS, 'tick 間隔 60 秒');
    await c.runner.start();
    eq(c.timers.length, 1, 'start 重複呼叫不重排');
    // 再次啟動（模擬 bot 重啟、狀態檔保留）→ 不重發
    const c2 = makeRunner({ nowMs: tp(TODAY, 9, 0), issues: todays, state: c.state });
    await c2.runner.start();
    eq(c2.sent.length, 0, '重啟時今天已發 → 不重發');
  }
  // 1. 睡過 07:30、08:10 醒來 → 下一個 tick 補發一次；同一天多次 tick 只發一次
  {
    const c = makeRunner({ nowMs: tp(TODAY, 6, 0), issues: todays });
    await c.runner.start();
    eq(c.sent.length, 0, '06:00 啟動不補發');
    await fireTick(c); // 仍 06:00 → 不發
    eq(c.sent.length, 0, '07:30 前 tick 不發');
    c.now = tp(TODAY, 7, 30);
    await fireTick(c);
    eq(c.sent.length, 1, '睡眠：07:30 的 tick 發出');
    c.now = tp(TODAY, 7, 31);
    await fireTick(c);
    c.now = tp(TODAY, 9, 0);
    await fireTick(c);
    eq(c.sent.length, 1, '同一天多次 tick 只發一次');
  }
  {
    const c = makeRunner({ nowMs: tp(TODAY, 6, 0), issues: todays });
    await c.runner.start();
    c.now = tp(TODAY, 8, 10); // 電腦睡過 07:30，08:10 才醒
    await fireTick(c);
    eq(c.sent.length, 1, '睡過 07:30、08:10 醒來 → 補發一次');
    ok(c.logs.includes('[bot] digest daily catch-up'), '補發有 catch-up log');
    eq(c.state.dailyDate, TODAY, '補發寫狀態');
    await fireTick(c);
    await fireTick(c);
    eq(c.sent.length, 1, '補發後再 tick 不重發');
  }
  // 13:00 醒來 → 不補、寫一行 log 說明錯過（且該行不可被健康檢查誤當成功）
  {
    const c = makeRunner({ nowMs: tp(TODAY, 6, 0), issues: todays });
    await c.runner.start();
    c.now = tp(TODAY, 13, 0);
    await fireTick(c);
    eq(c.sent.length, 0, '13:00 醒來不補發');
    eq(c.fetchCalls, 0, '錯過時不打 Plane');
    eq(c.logs.filter((l) => l.startsWith('[bot] digest daily missed date=2026-10-29')).length, 1, '寫一行 missed log');
    await fireTick(c);
    eq(c.logs.filter((l) => l.includes('digest daily missed')).length, 1, 'missed log 同一天只寫一次');
    noHealthMatch(c, '錯過');
    // 隔天 07:30 仍正常運作（todays 只有 10/29 的事件，所以這裡是 skipped 而非 sent）
    c.now = tp('2026-10-30', 7, 30);
    await fireTick(c);
    eq(c.fetchCalls, 1, '隔天 07:30 照常處理（今天有事件的話會發）');
  }
  // 空日子：不發、寫 skipped log、不寫 dailyDate；之後的 tick 不重抓
  {
    const c = makeRunner({ nowMs: tp(TODAY, 7, 30), issues: [mk('x', '2026-11-20', { group: 'unstarted' })] });
    const res = await c.runner.runDaily();
    eq(res, 'skipped', '空日子 → skipped');
    eq(c.sent.length, 0, '空日子不發');
    ok(c.logs.some((l) => /^\[bot\] digest daily skipped date=2026-10-29 reason=empty at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(l)), 'skipped log 格式: ' + c.logs.join(' | '));
    eq(c.state.dailyDate, undefined, '空日子不寫已發');
    const c2 = makeRunner({ nowMs: tp(TODAY, 7, 30), issues: [mk('x', '2026-11-20', { group: 'unstarted' })] });
    await c2.runner.start();
    await fireTick(c2);
    await fireTick(c2);
    eq(c2.fetchCalls, 1, '空日子同一天 tick 不重複抓列表');
  }
  // 週摘要：週日 21:00 的 tick 發送；週日 22:30 才醒也補發；週一 00:30 才醒不補、寫 log
  {
    const c = makeRunner({ nowMs: tp('2026-11-01', 20, 0), issues: [mk('💯 週一考試', '2026-11-02', { group: 'unstarted' })], state: { dailyDate: '2026-11-01', eveningDate: '2026-11-01' } });
    await c.runner.start();
    eq(c.sent.length, 0, '週日 20:00 不發週摘要');
    c.now = tp('2026-11-01', 21, 0);
    await fireTick(c);
    ok(c.logs.some((l) => /^\[bot\] digest weekly sent week=2026-11-02 items=1 at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(l)), 'weekly sent log 格式: ' + c.logs.join(' | '));
    eq(c.state.weeklyWeek, '2026-11-02', '週狀態寫入');
    ok(c.sent[0].includes('下週行程摘要'), '送出的是週摘要');
    c.now = tp('2026-11-01', 21, 1);
    await fireTick(c);
    eq(await c.runner.runWeekly(), 'already', '同一週不重發');
    eq(c.sent.length, 1, '週摘要同一週 tick 只發一次');
    c.runner.stop();
    ok(c.timers[c.timers.length - 1].cleared, 'stop 清掉未觸發的 tick 計時器');
  }
  {
    const wk = [mk('💯 週一考試', '2026-11-02', { group: 'unstarted' })];
    const c = makeRunner({ nowMs: tp('2026-11-01', 20, 0), issues: wk, state: { dailyDate: '2026-11-01', eveningDate: '2026-11-01' } });
    await c.runner.start();
    c.now = tp('2026-11-01', 22, 30); // 睡過 21:00，22:30 醒來
    await fireTick(c);
    eq(c.sent.length, 1, '週日 22:30 醒來 → 補發週摘要');
    ok(c.sent[0].includes('11/2（一） ~ 11/8（日）'), '補發的是正確的下一週（11/2~11/8）: ' + c.sent[0].split('\n')[0]);

    const m = makeRunner({ nowMs: tp('2026-11-01', 20, 0), issues: [mk('x', '2026-11-09', { group: 'unstarted' }), ...wk], state: { dailyDate: '2026-11-01', eveningDate: '2026-11-01' } });
    await m.runner.start();
    m.now = tp('2026-11-02', 0, 30); // 週一 00:30 才醒：窗已過
    await fireTick(m);
    eq(m.sent.length, 0, '週一 00:30 醒來不補發週摘要（修前會誤發再下一週）');
    eq(m.fetchCalls, 0, '錯過週窗不打 Plane');
    eq(m.logs.filter((l) => l.startsWith('[bot] digest weekly missed week=2026-11-02')).length, 1, '週摘要錯過寫一行 log');
    await fireTick(m);
    eq(m.logs.filter((l) => l.includes('digest weekly missed')).length, 1, '週摘要 missed log 只寫一次');
    noHealthMatch(m, '週摘要錯過');
    // 直接呼叫 runWeekly（例如週日 23:58 失敗、重試在週一 00:03 才跑）也不可發再下一週
    const r = makeRunner({ nowMs: tp('2026-11-02', 0, 3), issues: wk });
    eq(await r.runner.runWeekly(), 'missed', '週一 runWeekly → missed');
    eq(r.sent.length, 0, '週一 runWeekly 不送');
    noHealthMatch(r, 'runWeekly missed');
  }
  // 失敗重試：抓列表失敗一次 → 5 分鐘後重試成功
  {
    const c = makeRunner({ nowMs: tp(TODAY, 7, 30), issues: todays, fetchFail: 1 });
    await c.runner.start(); // 07:30 整點啟動 → 補發
    ok(c.logs.some((l) => l.startsWith('[bot] digest daily failed attempt=1')), '失敗有 log');
    const retry = c.timers[c.timers.length - 1];
    eq(retry.ms, 5 * 60_000, '5 分鐘後重試');
    await retry.fn();
    await new Promise((r) => setImmediate(r));
    eq(c.sent.length, 1, '重試成功後送出');
  }
  // 5. 最後一次放棄要明說；放棄的 log 不可被健康檢查當成功
  {
    const c = makeRunner({ nowMs: tp(TODAY, 7, 30), issues: todays, fetchFail: 99 });
    await c.runner.start();
    await c.timers[c.timers.length - 1].fn();
    await new Promise((r) => setImmediate(r));
    eq(c.timers[c.timers.length - 1].ms, 15 * 60_000, '第二次重試間隔 15 分鐘');
    await c.timers[c.timers.length - 1].fn();
    await new Promise((r) => setImmediate(r));
    ok(c.logs.includes('[bot] digest daily gave up after attempt=3'), '放棄 log: ' + c.logs.join(' | '));
    eq(c.timers.filter((t) => t.ms !== TICK_MS).length, 2, '放棄後不再排重試');
    noHealthMatch(c, '放棄');
    await fireTick(c);
    eq(c.fetchCalls, 3, '放棄後同一天 tick 不再重打');
  }
  // 4. stop() 要清掉重試計時器
  {
    const c = makeRunner({ nowMs: tp(TODAY, 7, 30), issues: todays, fetchFail: 1 });
    await c.runner.start();
    const retry = c.timers.find((t) => t.ms === 5 * 60_000);
    ok(retry && !retry.cleared, 'stop 前重試計時器在');
    c.runner.stop();
    ok(c.timers.every((t) => t.cleared), 'stop 清掉所有計時器（含重試）');
  }
  // 2a. send 成功但 writeState 丟錯 → 不重試、不重發，記憶體記住今天已發
  {
    const c = makeRunner({ nowMs: tp(TODAY, 7, 45), issues: todays, writeFail: true });
    await c.runner.start();
    eq(c.sent.length, 1, 'writeState 失敗：已送出一次');
    ok(!c.logs.some((l) => l.includes('failed attempt')), 'writeState 失敗不進重試: ' + c.logs.join(' | '));
    ok(c.logs.some((l) => l.includes('digest daily state write failed')), 'writeState 失敗有 log');
    ok(c.logs.some((l) => /^\[bot\] digest daily sent date=2026-10-29 items=1 /.test(l)), '仍寫 sent log');
    eq(c.timers.filter((t) => t.ms !== TICK_MS).length, 0, '沒有重試計時器');
    c.now = tp(TODAY, 7, 50);
    await fireTick(c);
    eq(c.sent.length, 1, '同一 process 後續 tick 不重發（狀態檔沒寫成）');
    eq(await c.runner.runDaily(), 'already', '記憶體記住今天已發');
  }
  // 2b. 分段訊息第 2 段失敗：已有段落送出 → 不整則重試（否則從第 1 段重送）
  {
    const chanSends = [];
    let failSecond = true;
    const chan = { send: async (o) => { chanSends.push(o.content); if (chanSends.length === 2 && failSecond) throw new Error('discord 503'); } };
    const long = ('x'.repeat(100) + '\n').repeat(60);
    let caught = null;
    try { await dg.sendToChannel(chan, long); } catch (e) { caught = e; }
    ok(caught && caught.partial === true, '第 2 段失敗 → err.partial');
    const chan1 = { send: async () => { throw new Error('first part down'); } };
    let c1 = null;
    try { await dg.sendToChannel(chan1, long); } catch (e) { c1 = e; }
    ok(c1 && !c1.partial, '第 1 段就失敗 → 非 partial（可整則重試）');

    chanSends.length = 0;
    const c = makeRunner({ nowMs: tp(TODAY, 7, 45), issues: todays });
    c.runner = dg.createDigestRunner({
      now: () => c.now, fetchAll: async () => todays, fetchStates: async () => STATES,
      send: (t) => dg.sendToChannel(chan, t.repeat(30)),
      readState: () => ({ ...c.state }), writeState: (s) => { c.state = { ...s }; },
      log: (l) => c.logs.push(l),
      setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; c.timers.push(h); return h; },
      clearTimer: (h) => { h.cleared = true; },
      priorityLabelIds: PRIO,
    });
    const res = await c.runner.runDaily();
    eq(res, 'partial', '部分送出 → partial');
    eq(chanSends.length, 2, '只送了 2 次（第 1 段成功、第 2 段失敗），沒有從頭重送');
    eq(c.state.dailyDate, TODAY, '部分送出也記為今天已發');
    ok(c.logs.some((l) => l.startsWith('[bot] digest daily partially sent date=2026-10-29')), '部分送出有 log: ' + c.logs.join(' | '));
    noHealthMatch(c, '部分送出');
    eq(c.timers.length, 0, '部分送出不排重試');

    // 完全沒送出才重試
    const f = makeRunner({ nowMs: tp(TODAY, 7, 45), issues: todays, sendFail: 1 });
    await f.runner.start();
    ok(f.timers.some((t) => t.ms === 5 * 60_000), '完全沒送出 → 排重試');
  }
  // 超過 2000 字分段
  {
    const parts = [];
    const chan = { send: async (o) => { parts.push(o); } };
    await dg.sendToChannel(chan, ('x'.repeat(100) + '\n').repeat(60));
    ok(parts.length >= 3 && parts.every((p) => p.content.length <= 2000), '長訊息分段每段 ≤ 2000');
    ok(parts.every((p) => JSON.stringify(p.allowedMentions) === '{"parse":[]}'), '不解析 mention');
  }
  // 狀態檔讀寫（暫存目錄，不碰 data/）
  {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'digest-')), 'sub', 'state.json');
    eq(dg.readStateFile(f), {}, '狀態檔不存在 → {}');
    dg.writeStateFile({ dailyDate: TODAY }, f);
    eq(dg.readStateFile(f), { dailyDate: TODAY }, '狀態檔寫入再讀回');
    fs.writeFileSync(f, '{broken');
    eq(dg.readStateFile(f), {}, '壞檔 → {}');
  }

  // ---------- E. interactionCreate：handler 非同步丟錯要進 catch ----------
  {
    const followUps = [];
    bot.pendingUpdates.clear();
    bot.pendingUpdates.set('mine1', { userId: process.env.ALLOWED_USER_ID, expiresAt: Date.now() + 60000 });
    const ix = {
      customId: 'plane_del_no', // → handleDeleteCancel → interaction.update（這裡讓它非同步 reject）
      user: { id: process.env.ALLOWED_USER_ID },
      channelId: process.env.ALLOWED_CHANNEL_ID,
      message: { id: 'async-boom' },
      isStringSelectMenu: () => false,
      isButton: () => true,
      update: async () => { throw new Error('async boom'); },
      followUp: async (o) => { followUps.push(o); },
    };
    const origErr = console.error;
    console.error = () => {};
    bot.client.emit('interactionCreate', ix);
    await new Promise((r) => setTimeout(r, 50));
    console.error = origErr;
    eq(followUps.length, 1, 'E：非同步錯誤進 catch → 回覆錯誤');
    ok(String(followUps[0].content).includes('async boom'), 'E：回覆內容含錯誤訊息');
    eq(followUps[0].ephemeral, true, 'E：錯誤回覆為 ephemeral');
    eq([...bot.pendingUpdates.keys()], [], 'E：catch 清掉該使用者狀態');
  }

  // ---------- messageCreate：handler 非同步丟錯要進 catch（return 要 await） ----------
  {
    const uid = process.env.ALLOWED_USER_ID;
    const errLogs = [];
    const origErr = console.error;
    console.error = (...a) => { errLogs.push(a.map(String).join(' ')); };
    const replies = [];
    bot.aiFlows.clear();
    bot.aiFlows.set(uid, { phase: 'bogus', expiresAt: Date.now() + 60000 }); // → handleAiFlowMessage → msg.reply
    const msg = {
      author: { id: uid, bot: false },
      channelId: String(process.env.ALLOWED_CHANNEL_ID || '').trim(),
      content: '隨便一句',
      reply: async (c) => { replies.push(c); await new Promise((r) => setImmediate(r)); throw new Error('reply async boom'); },
    };
    bot.client.emit('messageCreate', msg);
    await new Promise((r) => setTimeout(r, 50));
    console.error = origErr;
    ok(errLogs.some((l) => l.includes('[bot] messageCreate error:')), 'messageCreate：非同步錯誤進 catch\n' + errLogs.join('\n'));
    ok(replies.length >= 2, 'messageCreate：catch 內會再嘗試回覆使用者（原回覆 + 錯誤回覆）: ' + replies.length);
    bot.aiFlows.clear();
  }

  // ---------- ALLOWED_CHANNEL_ID 只有空白 → 視為沒設 ----------
  {
    const saved = process.env.ALLOWED_CHANNEL_ID;
    process.env.ALLOWED_CHANNEL_ID = '   ';
    eq(bot.allowedChannelId(), '', '全空白 → 空字串（視為沒設）');
    process.env.ALLOWED_CHANNEL_ID = '  123  ';
    eq(bot.allowedChannelId(), '123', '前後空白 trim');
    process.env.ALLOWED_CHANNEL_ID = '   ';
    const uid = process.env.ALLOWED_USER_ID;
    const replies = [];
    bot.aiFlows.clear();
    bot.aiFlows.set(uid, { phase: 'bogus', expiresAt: Date.now() + 60000 });
    bot.client.emit('messageCreate', {
      author: { id: uid, bot: false }, channelId: 'any-other-channel', content: 'hi',
      reply: async (c) => { replies.push(c); },
    });
    await new Promise((r) => setTimeout(r, 50));
    eq(replies.length, 1, '空白 ALLOWED_CHANNEL_ID 不擋任何頻道（修前會因 "   " 為真而全擋）');
    bot.aiFlows.clear();
    if (saved === undefined) delete process.env.ALLOWED_CHANNEL_ID; else process.env.ALLOWED_CHANNEL_ID = saved;
  }

  console.log(`selftest-digest: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
