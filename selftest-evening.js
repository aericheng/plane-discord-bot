// A5 log 前綴＋L2 前一晚清單自測：不連網、不登入、不碰 Plane／Discord；時鐘、issues、send、狀態檔全注入假的。
const dg = require('./digest');
const logger = require('./log');

let n = 0;
function ok(cond, name) { n += 1; if (!cond) { console.error('FAIL ' + name); process.exit(1); } }
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`);
const tp = (iso, hh, mm) => Date.parse(`${iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);

// (1) log 前綴格式
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(logger.stamp()), 'stamp 格式 YYYY-MM-DDTHH:mm:ss+HH:MM');
{
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(['log', a]);
  console.warn = (...a) => lines.push(['warn', a]);
  console.error = (...a) => lines.push(['error', a]);
  const dbg = process.env.BOT_DEBUG;
  delete process.env.BOT_DEBUG;
  try {
    logger.log('[bot] hello'); logger.warn('w'); logger.error('e', 1); logger.debug('hidden');
    process.env.BOT_DEBUG = '1'; logger.debug('shown');
  } finally {
    Object.assign(console, orig);
    if (dbg === undefined) delete process.env.BOT_DEBUG; else process.env.BOT_DEBUG = dbg;
  }
  const PFX = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\]$/;
  eq(lines.map((l) => l[0]), ['log', 'warn', 'error', 'log'], 'log/warn/error 各走對應的 console；debug 只在 BOT_DEBUG=1 輸出');
  ok(lines.every((l) => PFX.test(l[1][0])), '每一行第一個參數都是 ISO 時間戳前綴');
  eq(lines[0][1].slice(1), ['[bot] hello'], '原內容在前綴之後');
  eq(lines[2][1].slice(1), ['e', 1], 'error 多參數保留');
  // (3) ops-audit health-check.mjs:71 的 marker 正則，加前綴後仍匹配
  const HEALTH = /\[bot\] digest daily (sent|skipped) /;
  const line = `${logger.stamp()} [bot] digest daily sent date=2026-10-29 items=3 at=2026-10-29T23:30:00.000Z`;
  ok(HEALTH.test(line), '加前綴後 digest daily sent 仍匹配 health-check 正則');
  ok(HEALTH.test(`${logger.stamp()} [bot] digest daily skipped date=2026-10-29 reason=empty at=x`), 'skipped 仍匹配');
}

// (2) evening pass
const LABEL_TEST = 'label-test';
const mk = (id, name, date, o = {}) => ({ id, name, target_date: date, state_group: 'unstarted', description_html: o.html || '', labels: o.labels || [] });
function makeRunner(nowMs, issues, state = {}) {
  const ctx = { sent: [], logs: [], state: { ...state } };
  ctx.runner = dg.createDigestRunner({
    now: () => nowMs,
    fetchAll: async () => issues,
    send: async (t) => { ctx.sent.push(t); },
    readState: () => ({ ...ctx.state }),
    writeState: (s) => { ctx.state = { ...s }; },
    log: (l) => ctx.logs.push(l),
    setTimer: () => ({}),
    clearTimer: () => {},
    priorityLabelIds: [LABEL_TEST],
    eveningLabelIds: ['label-pres'],
  });
  return ctx;
}
const TODAY = '2026-11-01';
const TOMORROW = '2026-11-02';
(async () => {
  const exam = mk('e1', '📚 計算機圖學期中考', TOMORROW, { html: '<p>時間：13:20~15:10<br/>地點：資訊 B02<br/>範圍 ch1-5<br/>可攜帶 A4 雙面小抄一張，要帶學生證</p>' });
  const normal = mk('e2', '💡 看牙醫', TOMORROW, { html: '<p>時間：09:00<br/>地點：診所<br/>帶健保卡</p>' });
  const todayExam = mk('e3', '💯 今天的考試', TODAY, {});
  {
    const c = makeRunner(tp(TODAY, 20, 0), [exam, normal, todayExam]);
    eq(await c.runner.runEvening(), 'sent', '20:00 有明天考試 → sent');
    eq(c.sent.length, 1, '只發一則');
    ok(c.sent[0].includes('計算機圖學期中考') && !c.sent[0].includes('看牙醫') && !c.sent[0].includes('今天的考試'), '只含明天的考試／報告類事件');
    ok(c.sent[0].includes('13:20~15:10') && c.sent[0].includes('資訊 B02'), '含時間地點');
    ok(c.sent[0].includes('可攜帶 A4 雙面小抄一張，要帶學生證'), '含攜帶段落');
    ok(!c.sent[0].includes('範圍 ch1-5'), '有攜帶段落時不列其他描述行');
    ok(c.logs.some((l) => /^\[bot\] digest evening sent n=1 /.test(l)), 'log: digest evening sent n=1');
    eq(c.state.eveningDate, TODAY, '狀態寫入 eveningDate');
    eq(await c.runner.runEvening(), 'already', '同一天不重發');
  }
  {
    const c = makeRunner(tp(TODAY, 20, 0), [normal, todayExam]);
    eq(await c.runner.runEvening(), 'skipped', '明天沒有考試 → skipped');
    eq(c.sent.length, 0, 'skipped 不發送');
    ok(c.logs.some((l) => /^\[bot\] digest evening skipped reason=empty/.test(l)), 'log: digest evening skipped reason=empty');
    ok(c.state.eveningDate === undefined, 'skipped 不寫狀態');
  }
  {
    // 沒有攜帶字樣 → 整段描述前 200 字
    const longDesc = '範圍很多'.repeat(80);
    const c = makeRunner(tp(TODAY, 20, 0), [mk('e4', '💯 期末', TOMORROW, { html: `<p>${longDesc}</p>` })]);
    await c.runner.runEvening();
    ok(c.sent[0].includes('範圍很多'.repeat(50)) && !c.sent[0].includes('範圍很多'.repeat(51)) && c.sent[0].includes('…'), '無攜帶字樣 → 列描述前 200 字');
  }
  {
    // label 判定：名稱無 emoji 但 label id 命中
    const c = makeRunner(tp(TODAY, 20, 0), [mk('e5', '資料結構 quiz', TOMORROW, { labels: [LABEL_TEST] })]);
    eq(await c.runner.runEvening(), 'sent', 'label id 命中也算考試／報告類');
  }
  {
    const c = makeRunner(tp(TODAY, 20, 0), [mk('p1', '🗣️ RL 論文報告', TOMORROW, { html: '<p>時間：10:00<br/>地點：D101<br/>準備投影片</p>' }), normal]);
    eq(await c.runner.runEvening(), 'sent', '明天有 🗣️ 報告 → 發');
    ok(c.sent[0].includes('RL 論文報告') && c.sent[0].includes('準備投影片') && !c.sent[0].includes('看牙醫'), '🗣️ 報告內容正確、一般事件不列');
    const c2 = makeRunner(tp(TODAY, 20, 0), [mk('p2', '言論自由課報告', TOMORROW, { labels: ['label-pres'] })]);
    eq(await c2.runner.runEvening(), 'sent', 'presentation label id 命中也發');
    const c3 = makeRunner(tp(TODAY, 20, 0), [mk('p3', '🗣️ 後天的報告', '2026-11-03', {})]);
    eq(await c3.runner.runEvening(), 'skipped', '🗣️ 事件在後天 → 不發');
  }
  {
    // tick：19:59 不發、20:00 發；22:59 補發、23:00 後不補；daily 窗外不受影響
    const W = '2026-10-28'; // 週三（避開週日 21:00 的週摘要）
    const examW = mk('e6', '💯 週四考試', '2026-10-29', {});
    const before = makeRunner(tp(W, 19, 59), [examW], { dailyDate: W });
    await before.runner.tick();
    eq(before.sent.length, 0, '19:59 不發');
    const at = makeRunner(tp(W, 20, 0), [examW], { dailyDate: W });
    await at.runner.tick();
    eq(at.sent.length, 1, '20:00 tick 發送');
    const late = makeRunner(tp(W, 22, 59), [examW], { dailyDate: W });
    await late.runner.tick();
    eq(late.sent.length, 1, '22:59 補發');
    ok(late.logs.some((l) => l === '[bot] digest evening catch-up'), '補發寫 catch-up log');
    const miss = makeRunner(tp(W, 23, 0), [examW], { dailyDate: W });
    await miss.runner.tick();
    eq(miss.sent.length, 0, '23:00 後不補');
    ok(miss.logs.some((l) => /digest evening missed/.test(l)), '23:00 後寫 missed log');
    const done = makeRunner(tp(W, 21, 0), [examW], { dailyDate: W, eveningDate: W });
    await done.runner.tick();
    eq(done.sent.length, 0, '狀態檔已記今晚發過 → 重啟不重發');
  }
  console.log(`selftest-evening: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
