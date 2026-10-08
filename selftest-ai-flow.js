// 確認卡／澄清／補日期的過期行為自測（純 node、不連網、不呼叫 claude -p、不碰 Plane API）
const bot = require('./bot');
const { client, aiFlows, pendingCards, aiInFlight, presentAiConfirmOrEmpty, handleAiConfirmOk, handleAiConfirmNo, clearAiState } = bot;

let n = 0;
function ok(cond, name) {
  n++;
  if (!cond) { console.error('FAIL ' + name); process.exit(1); }
}

const USER = process.env.ALLOWED_USER_ID || 'u-selftest';
const CHANNEL = process.env.ALLOWED_CHANNEL_ID || 'c-selftest';

function fakePlaceholder() {
  const p = { edited: null };
  p.edit = async (x) => { p.edited = x; return p; };
  return p;
}
function fakeInteraction(customId, userId = USER) {
  const it = { customId, user: { id: userId }, updated: null, replied: null };
  it.update = async (x) => { it.updated = x; };
  it.reply = async (x) => { it.replied = x; };
  it.editReply = async (x) => { it.edited = x; };
  return it;
}
function fakeMsg(content) {
  const m = { content, author: { id: USER, bot: false }, channelId: CHANNEL, replies: [] };
  m.reply = async (x) => { m.replies.push(typeof x === 'string' ? x : x.content); return m; };
  return m;
}
const customIdsOf = (edited) => edited.components[0].components.map((b) => b.data.custom_id);
const emitMessage = async (msg) => {
  for (const h of client.listeners('messageCreate')) await h(msg);
};

async function run() {
  clearAiState(USER);

  // 1. 確認卡：不佔 aiFlows、customId 帶 cardId、有效期 24 小時
  const ph = fakePlaceholder();
  await presentAiConfirmOrEmpty(ph, USER, [{ name: '測試事件', due: null }], '測試事件');
  const [okId, noId] = customIdsOf(ph.edited);
  const cardId = okId.split(':')[2];
  ok(okId === `plane_ai_ok:${USER}:${cardId}` && noId === `plane_ai_no:${USER}:${cardId}`, 'customId 帶 userId 與 cardId');
  ok(pendingCards.has(cardId), '卡片已登記');
  ok(!aiFlows.has(USER), '確認卡不佔 aiFlows（不擋下一則訊息）');
  const ttl = pendingCards.get(cardId).expiresAt - Date.now();
  ok(ttl > 23.9 * 3600_000 && ttl <= 24 * 3600_000, '確認卡有效期 24 小時');

  // 2. 卡片過了 2 分鐘（舊版會過期）仍可按；缺日期 → 進補日期，卡片被消耗
  pendingCards.get(cardId).expiresAt = Date.now() + 22 * 3600_000;
  let it = fakeInteraction(okId);
  await handleAiConfirmOk(it);
  ok(/缺日期/.test(it.updated.content), '晚按仍有效，進入補日期');
  ok(!pendingCards.has(cardId), '按過即消耗');
  ok(aiFlows.get(USER).phase === 'dateFill', 'dateFill 狀態已建立');
  const fillTtl = aiFlows.get(USER).expiresAt - Date.now();
  ok(fillTtl > 9 * 60_000 && fillTtl <= 10 * 60_000, '補日期等 10 分鐘');

  // 3. 再按一次同一張卡 → 失效訊息，不會重建
  it = fakeInteraction(okId);
  await handleAiConfirmOk(it);
  ok(/已失效/.test(it.updated.content), '連按第二次 → 失效');

  // 4. 補日期未過期時，下一則訊息被當成回答
  let m = fakeMsg('看不懂的字');
  await emitMessage(m);
  ok(m.replies.length === 1 && /看不懂這個日期/.test(m.replies[0]), '未過期：訊息當補日期回答');

  // 5. 補日期過期後，下一則訊息不回「已過期」，而是當新輸入往下走
  //    （用 aiInFlight 擋在 AI 解析前，確認確實走到新輸入路徑且不呼叫 claude -p）
  aiFlows.get(USER).expiresAt = Date.now() - 1;
  aiInFlight.add(USER);
  m = fakeMsg('10/10 13:30剪頭髮');
  await emitMessage(m);
  ok(m.replies.length === 1 && /上一段還在解析中/.test(m.replies[0]), '過期：訊息當新輸入處理');
  ok(!m.replies.some((r) => /已過期/.test(r)), '過期：不再回「已過期」');
  ok(!aiFlows.has(USER), '過期的流程已清掉');
  aiInFlight.delete(USER);

  // 6. 澄清過期同理
  aiFlows.set(USER, { phase: 'clarify', originalText: 'x', questions: ['q'], intent: 'create', expiresAt: Date.now() - 1 });
  aiInFlight.add(USER);
  m = fakeMsg('下禮拜三 北友會宵夜局');
  await emitMessage(m);
  ok(/上一段還在解析中/.test(m.replies[0]) && !aiFlows.has(USER), '澄清過期：訊息當新輸入處理');
  aiInFlight.delete(USER);

  // 7. 過了 24 小時的卡 → 失效
  const ph2 = fakePlaceholder();
  await presentAiConfirmOrEmpty(ph2, USER, [{ name: 'B', due: '2099-01-01' }], 'B');
  const [okId2] = customIdsOf(ph2.edited);
  pendingCards.get(okId2.split(':')[2]).expiresAt = Date.now() - 1;
  it = fakeInteraction(okId2);
  await handleAiConfirmOk(it);
  ok(/已失效/.test(it.updated.content), '超過 24 小時 → 失效');

  // 8. 改版前發出的舊卡（customId 沒有 cardId）→ 失效，不誤建
  it = fakeInteraction(`plane_ai_ok:${USER}`);
  await handleAiConfirmOk(it);
  ok(/已失效/.test(it.updated.content), '舊格式 customId → 失效');

  // 9. 別人按 → 拒絕；❌ 取消會移除卡片；「取消」指令清掉該使用者所有卡
  const ph3 = fakePlaceholder();
  await presentAiConfirmOrEmpty(ph3, USER, [{ name: 'C', due: '2099-01-01' }], 'C');
  const [okId3, noId3] = customIdsOf(ph3.edited);
  it = fakeInteraction(okId3, 'someone-else');
  await handleAiConfirmOk(it);
  ok(/不是給你的/.test(it.replied.content) && pendingCards.has(okId3.split(':')[2]), '別人按 → 拒絕且卡片保留');
  it = fakeInteraction(noId3);
  await handleAiConfirmNo(it);
  ok(/已取消/.test(it.updated.content) && !pendingCards.has(okId3.split(':')[2]), '❌ 取消移除卡片');
  const ph4 = fakePlaceholder();
  await presentAiConfirmOrEmpty(ph4, USER, [{ name: 'D', due: '2099-01-01' }], 'D');
  clearAiState(USER);
  ok(![...pendingCards.values()].some((c) => c.userId === USER), '「取消」清掉該使用者的卡');

  // 10. 有進行中的補日期／澄清或 AI 解析時，按缺日期的卡 → 卡片保留、不覆蓋既有流程
  const mkCard = async (name, due) => {
    const p = fakePlaceholder();
    await presentAiConfirmOrEmpty(p, USER, [{ name, due }], name);
    return customIdsOf(p.edited)[0];
  };
  const okA = await mkCard('A', null);
  const okB = await mkCard('B', null);
  await handleAiConfirmOk(fakeInteraction(okA));
  ok(aiFlows.get(USER).events[0].name === 'A', 'A 進入補日期');
  it = fakeInteraction(okB);
  await handleAiConfirmOk(it);
  ok(it.replied && it.replied.ephemeral && /進行中/.test(it.replied.content), 'B 被擋下並提示');
  ok(aiFlows.get(USER).events[0].name === 'A', 'A 的補日期沒被 B 蓋掉');
  ok(pendingCards.has(okB.split(':')[2]), 'B 卡保留，之後還能按');
  aiFlows.delete(USER);
  aiInFlight.add(USER);
  it = fakeInteraction(okB);
  await handleAiConfirmOk(it);
  ok(it.replied && /進行中/.test(it.replied.content) && pendingCards.has(okB.split(':')[2]), 'AI 解析中 → B 被擋下、卡保留');
  aiInFlight.delete(USER);
  await handleAiConfirmOk(fakeInteraction(okB));
  ok(aiFlows.get(USER).events[0].name === 'B' && !pendingCards.has(okB.split(':')[2]), '空閒時 B 正常進入補日期');

  // 11. 偽造 customId（自己的 id 配別人的 cardId）→ 拒絕且不消耗別人的卡
  aiFlows.delete(USER);
  const okC = await mkCard('C2', '2099-01-01');
  const cId = okC.split(':')[2];
  pendingCards.get(cId).userId = 'someone-else';
  it = fakeInteraction(`plane_ai_ok:${USER}:${cId}`);
  await handleAiConfirmOk(it);
  ok(/已失效/.test(it.updated.content) && pendingCards.has(cId), '偽造 customId → 失效且不消耗別人的卡');
  pendingCards.delete(cId);

  // 12. messageCreate 出錯時的重置不作廢確認卡
  const okD = await mkCard('D2', '2099-01-01');
  clearAiState(USER, { keepCards: true });
  ok(pendingCards.has(okD.split(':')[2]), 'keepCards：錯誤重置不清卡');
  clearAiState(USER);

  console.log(`selftest-ai-flow: ${n} checks passed`);
  process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
