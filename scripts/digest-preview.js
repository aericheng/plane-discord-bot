// 行程摘要 dry-run：用真實 Plane 資料（唯讀 GET）把摘要印到 stdout。不發 Discord、不寫狀態檔、不登入。
// 用法：node scripts/digest-preview.js [--weekly] [--date YYYY-MM-DD]
//   預設印今天的每日摘要；--date 指定「今天」；--weekly 印 --date（預設今天）之後的下週一到週日。
const bot = require('../bot'); // 被 require 時不登入 Discord
const digest = require('../digest');

function parseArgs(argv) {
  const out = { weekly: false, date: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--weekly') out.weekly = true;
    else if (argv[i] === '--date') out.date = argv[++i];
    else throw new Error(`unknown arg: ${argv[i]}`);
  }
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error('--date 格式要 YYYY-MM-DD');
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const todayIso = args.date || digest.taipeiParts(Date.now()).iso;
  const issues = await bot.fetchAllIssues();
  let statesById = {};
  if (issues.some((i) => !i.state_group)) statesById = await bot.fetchPlaneStates();
  const priorityLabelIds = bot.LABELS.filter((l) => l.name === 'test' || l.name === 'homework').map((l) => l.id);
  const build = args.weekly ? digest.buildWeeklyDigest : digest.buildDailyDigest;
  const r = build({ issues, statesById, todayIso, priorityLabelIds });
  console.log(`# dry-run ${args.weekly ? 'weekly' : 'daily'} base-date=${todayIso} issues=${issues.length} items=${r.items} empty=${r.empty}`);
  console.log(r.text);
})().catch((e) => { console.error('digest-preview failed:', e.message); process.exit(1); });
