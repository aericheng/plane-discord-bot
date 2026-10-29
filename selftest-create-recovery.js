// createWithRecovery 自測（純 node、不連網）：POST 逾時但 Plane 其實已建立時，要回報成功而不是失敗。
// require('./bot') 不會登入（見 selftest-e3-intake.js 開頭說明）。
const { createWithRecovery, buildAiCreateReport } = require('./bot');
let n = 0;
function ok(cond, name) {
  n++;
  if (!cond) { console.error('FAIL ' + name); process.exit(1); }
}

const NOW = Date.parse('2026-10-29T07:30:20Z');
const payload = { name: '💡 假日營老人驗', due: '2026-11-04' };
// 和 AbortSignal.timeout 一樣丟 DOMException（message 唯讀）
const timeoutErr = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
const issue = (over) => ({ id: 'id-new', name: payload.name, target_date: payload.due, created_at: '2026-10-29T07:30:38.996934Z', ...over });

function deps(over) {
  const calls = { post: 0, fetchAll: 0, waits: [] };
  const post = (over && over.post) || (async () => { throw timeoutErr(); });
  const fetchAll = (over && over.fetchAll) || (async () => [issue()]);
  const d = {
    post: async (p) => { calls.post++; return post(p); },
    fetchAll: async () => { calls.fetchAll++; return fetchAll(); },
    wait: async (ms) => { calls.waits.push(ms); },
    now: () => NOW,
    log: () => {},
    excludeIds: (over && over.excludeIds) || new Set(),
  };
  return { d, calls };
}

(async () => {
  // 1. POST 成功：不重查
  {
    const { d, calls } = deps({ post: async () => issue({ id: 'id-direct' }) });
    const r = await createWithRecovery(payload, d);
    ok(r.id === 'id-direct' && !r.recoveredAfterError && calls.fetchAll === 0, 'direct success');
  }
  // 2. 逾時、列表第一次就找到：回成功並帶旗標（Plane 的 6 位小數 created_at 要能解析）
  {
    const { d, calls } = deps();
    const r = await createWithRecovery(payload, d);
    ok(r.id === 'id-new' && /timeout/.test(r.recoveredAfterError), 'recovered on first list');
    ok(calls.post === 1 && calls.fetchAll === 1, 'no re-POST, one list');
  }
  // 3. 第一次列表還沒出現、第二次才出現
  {
    let k = 0;
    const { d, calls } = deps({ fetchAll: async () => (k++ === 0 ? [] : [issue()]) });
    const r = await createWithRecovery(payload, d);
    ok(r.id === 'id-new' && calls.waits.length === 2, 'recovered on second list');
  }
  // 4. 兩次都沒有：丟原錯誤並註明已重查
  {
    const { d, calls } = deps({ fetchAll: async () => [] });
    let err;
    try { await createWithRecovery(payload, d); } catch (e) { err = e; }
    ok(err && err.name === 'TimeoutError' && /重查 Plane 列表兩次都沒找到/.test(err.message), 'not found -> throw');
    ok(err.cause instanceof DOMException, 'original error kept as cause');
    ok(calls.post === 1 && calls.fetchAll === 2, 'two lists, still no re-POST');
  }
  // 5. 同名同日但是很久以前建的（舊事件）不算
  {
    const { d } = deps({ fetchAll: async () => [issue({ id: 'old', created_at: '2026-10-20T00:00:00Z' })] });
    let err;
    try { await createWithRecovery(payload, d); } catch (e) { err = e; }
    ok(err, 'old same-name issue is not a match');
  }
  // 6. 名稱或日期不同不算
  {
    const { d } = deps({ fetchAll: async () => [issue({ name: '💡 假日營一籌' }), issue({ target_date: '2026-11-05' })] });
    let err;
    try { await createWithRecovery(payload, d); } catch (e) { err = e; }
    ok(err, 'different name/date is not a match');
  }
  // 7. Plane 回 HTTP 錯誤碼：明確失敗，不重查
  {
    const { d, calls } = deps({ post: async () => { throw Object.assign(new Error('Plane API 400: bad'), { planeStatus: 400 }); } });
    let err;
    try { await createWithRecovery(payload, d); } catch (e) { err = e; }
    ok(err && err.planeStatus === 400 && calls.fetchAll === 0, 'HTTP error -> no recovery');
  }
  // 8. 重查時列表本身失敗：不炸，繼續下一次
  {
    let k = 0;
    const { d } = deps({ fetchAll: async () => { if (k++ === 0) throw new Error('list timeout'); return [issue()]; } });
    const r = await createWithRecovery(payload, d);
    ok(r.id === 'id-new', 'list error then recovered');
  }
  // 8b. 同批前一筆同名同日（已在 excludeIds）不能被當成這一筆
  {
    const { d } = deps({ excludeIds: new Set(['id-new']) });
    let err;
    try { await createWithRecovery(payload, d); } catch (e) { err = e; }
    ok(err, 'same-batch earlier issue excluded');
  }
  // 9. 回報文字：recovered 那筆要標示，且整體不出現「失敗」
  {
    const text = buildAiCreateReport([{ ok: true, name: payload.name, due: payload.due, id: 'id-new', recovered: true }]);
    ok(/1\/1/.test(text) && /重查確認已建立/.test(text) && !/失敗/.test(text), 'report marks recovered');
  }
  console.log(`selftest-create-recovery: ${n} checks passed`);
  process.exit(0);
})();
