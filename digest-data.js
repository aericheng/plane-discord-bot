// 純函式匯出檔：給其他專案（daily-brief）取「今天＋明天」行程摘要，不啟動 Discord client、不寫狀態檔、不改 digest.js。
// 為什麼獨立成檔：bot.js 一 require 就會 login，不能拿來匯出；fetchAllIssues／fetchPlaneStates 是 bot.js 內部函式，
// 這裡複製一份唯讀版本（Plane 設定與 label id 同 bot.js 的 PLANE／LABELS，若那邊改了要同步）。
// 用法：
//   const { getDailyDigestData } = require('./digest-data');   // 以 library 載入（不會有任何輸出）
//   node digest-data.js                                         // CLI：最後一行 stdout 印 JSON {todayIso,text,items,empty}
// 讀 token：只載入本專案的 .env（dotenv 指定 path），值不印出。
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const digest = require('./digest');

const PLANE = {
  apiBase: 'https://api.plane.so/api/v1',
  workspace: 'aeri',
  project: '1b6c01b9-bc5a-4f45-932e-7456e33606ca',
};
const PRIORITY_LABEL_IDS = [
  'c7b2c20a-0054-4970-b9ee-4adf38a91c95', // test
  '005f30ad-8225-4b34-94d2-51d4f3cbd62c', // homework
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllIssues(token) {
  const all = [];
  for (let page = 0; ; page += 1) {
    const url = `${PLANE.apiBase}/workspaces/${PLANE.workspace}/projects/${PLANE.project}/issues/?per_page=100&cursor=100:${page}:0`;
    let res;
    try {
      res = await fetch(url, { headers: { 'X-API-Key': token }, signal: AbortSignal.timeout(25000) });
    } catch (err) {
      if (err.name !== 'TimeoutError') throw err;
      res = await fetch(url, { headers: { 'X-API-Key': token }, signal: AbortSignal.timeout(40000) });
    }
    if (!res.ok) throw new Error(`Plane API ${res.status}`);
    const j = await res.json();
    all.push(...(j.results || []));
    if (!j.next_page_results) break;
    await sleep(400);
  }
  return all;
}

async function fetchStates(token) {
  const res = await fetch(`${PLANE.apiBase}/workspaces/${PLANE.workspace}/projects/${PLANE.project}/states/`, {
    headers: { 'X-API-Key': token },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Plane API ${res.status}`);
  const j = await res.json();
  const map = {};
  for (const st of j.results || j || []) map[st.id] = st.group;
  return map;
}

// 回 { todayIso, text, items, empty }。text＝每日摘要中「今天／明天」兩段（不含「已過期但未完成」清單）。
async function getDailyDigestData({ nowMs = Date.now() } = {}) {
  const token = process.env.PLANE_API_TOKEN;
  if (!token) throw new Error('PLANE_API_TOKEN not set');
  const issues = await fetchAllIssues(token);
  let statesById = {};
  if (issues.some((i) => !i.state_group)) {
    try { statesById = await fetchStates(token); } catch (_) { /* state_group 通常夠用 */ }
  }
  const todayIso = digest.taipeiParts(nowMs).iso;
  const r = digest.buildDailyDigest({ issues, statesById, todayIso, priorityLabelIds: PRIORITY_LABEL_IDS });
  const cut = r.text.indexOf('\n\n⚠️ **已過期');
  return { todayIso, text: cut >= 0 ? r.text.slice(0, cut) : r.text, items: r.items, empty: r.empty };
}

module.exports = { getDailyDigestData };

if (require.main === module) {
  getDailyDigestData()
    .then((r) => { process.stdout.write(`${JSON.stringify(r)}\n`); })
    .catch((err) => {
      process.stderr.write(`digest-data failed: ${err && err.message ? err.message : err}\n`);
      process.exitCode = 1;
    });
}
