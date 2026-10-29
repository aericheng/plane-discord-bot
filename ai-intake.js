// ai-intake.js
// AI 自由文字解析引擎：呼叫 headless `claude -p` 把使用者的一段自由文字抽成結構化事件提案。
// 職責邊界（BOT-AI-INTAKE-SPEC.md）：這個模組只負責「解析」，不寫入 Plane。
//
// Windows 陷阱與收尾邏輯照抄 `claude code learning bot` 的 src/claude-runner.js（已解掉三個地雷）：
// 1. claude 在 Windows 上用 shell:true 呼叫（.exe 或 .cmd 都吃）。
// 2. prompt 一律走 stdin，argv 只放旗標；空字串/含 ()&|<>^% 的旗標值要補引號。
// 3. timeout 要先 taskkill /T 殺整棵樹（趁根行程還活著才走訪得到孫行程），10 秒保險絲防孤兒行程卡死 close。

const fs = require('node:fs');
const { spawn, execSync } = require('node:child_process');
const { normalizeTimeText, normalizeLocationText } = require('./smart-edit');

// 存活中的 claude 子行程 PID，供 bot.js 在關機時收割，避免殭屍行程（learning bot 2026-07-09 實案教訓）。
const activePids = new Set();

function killActiveClaudeChildren() {
  for (const pid of activePids) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // 行程可能已經結束，忽略
    }
  }
  activePids.clear();
}

// spawn(..., {shell:true}) 在 Windows 上只是把 command 與每個 arg 用空白 join 丟給 cmd.exe，
// 不會幫每個 arg 自動加引號。PURE_TEXT_FLAGS 的 --tools 固定傳空字串（不給任何工具），空字串會被
// cmd.exe 吞掉造成「argument missing」，所以空字串或含 cmd 特殊字元的值要補雙引號。
function shellQuoteArg(value) {
  const str = String(value);
  if (str === '' || /[\s()&|<>^%]/.test(str)) {
    return `"${str}"`;
  }
  return str;
}

// 排程/服務環境的 PATH 常不完整，不能假設 claude 在 PATH 上（learning bot 2026-07-12 實案教訓）。
// 預設值來自本機 `where claude` 的實測結果，.env 的 CLAUDE_CLI_PATH 可覆寫；用 getter 讀取，
// 讓 process.env 的變動（測試時）能立刻反映，不用重啟 process。
const DEFAULT_CLAUDE_CLI_PATH = 'C:\\Users\\user\\.local\\bin\\claude.exe';
// 2026-10-11 從 claude-haiku-4-5-20251001 換成 Haiku 5.5：20 則代表性訊息兩者都 20/20，
// 官方價每則約 $0.0007 對 $0.0087、平均 6.1 秒對 13.6 秒。
const DEFAULT_PARSER_MODEL = 'claude-haiku-5-5';
const DEFAULT_PARSER_TIMEOUT_MS = 90 * 1000;

function getCliPath() {
  return process.env.CLAUDE_CLI_PATH || DEFAULT_CLAUDE_CLI_PATH;
}
function getParserModel() {
  return process.env.PARSER_MODEL || DEFAULT_PARSER_MODEL;
}
function getParserTimeoutMs() {
  const n = Number(process.env.PARSER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PARSER_TIMEOUT_MS;
}

// v6.2 風格失敗分類：額度用盡特徵 / 逾時 / exit code。
const USAGE_LIMIT_REGEX = /usage limit|limit reached|rate limit/i;
function classifyFailure({ exitCode, resultText, stderr }) {
  const primary = (resultText ?? '').trim() || (stderr ?? '').trim();
  const errorExcerpt = primary.slice(0, 300);
  const combined = `${resultText ?? ''}\n${stderr ?? ''}`;
  const errorCode = USAGE_LIMIT_REGEX.test(combined) ? 'usage_limit' : exitCode === 'is_error' ? 'is_error' : `exit_code_${exitCode}`;
  const error = errorExcerpt ? `${errorCode}: ${errorExcerpt}` : errorCode;
  return { errorCode, error };
}

// 計費路徑（2026-10-10，與 e3-course-watch／gmail-watch 同款）：.env 有 AUTOMATION_ANTHROPIC_API_KEY 時
// 優先走 API（吃 Max 方案每月附的 API credits；綁定的 Console org 不加卡、不開 auto-reload，額度用完只會
// 被拒絕、不會扣款）。API 回額度／帳務／金鑰／速率類錯誤就改用訂閱重跑，並暫停 API 一小時（bot 是常駐，
// 用時間冷卻而非整個 process 停用）。沒設 key 時行為不變。
// 刻意不用 ANTHROPIC_API_KEY 這個標準名稱：dotenv 載入後會被這個 process 的所有子程序繼承。
// 2026-10-11 起改用 --output-format json（為了取 total_cost_usd 記帳）：優先看 envelope 的 api_error_status，
// 拿不到（例如 CLI 沒輸出 envelope）才比對錯誤文字（實測無效 key 輸出「Invalid API key」）。
// envelope 的 api_error_status：401/403 金鑰、402 帳務、429 速率或 spend limit（2026-10-10 實測無效 key → 401）
const API_FALLBACK_STATUSES = new Set([401, 402, 403, 429]);
const API_BILLING_ERROR_RE = /credit balance|billing|insufficient|spend[ _-]?limit|invalid[ _-]?(x-)?api[ _-]?key|authentication|unauthorized|permission_error|rate[ _-]?limit|\b40[123]\b|\b429\b/i;
let apiDisabledUntil = 0;

// 精簡模式（同 e3-course-watch 的 PURE_TEXT_FLAGS）：不載入使用者層設定／MCP／工具／slash commands，
// 搭配 CLAUDE_CODE_DISABLE_CLAUDE_MDS=1，前綴從完整 Claude Code（~45K token）降到只剩解析 prompt。
// spawn 用 shell:true，每個參數都要經 shellQuoteArg；system prompt 不可含雙引號。
const PURE_TEXT_FLAGS = [
  '--setting-sources', 'project',
  '--strict-mcp-config',
  '--tools', '',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--system-prompt', 'You are a concise assistant. Follow the user instructions exactly and reply only in the requested format.',
];

function getAutomationApiKey() {
  return (process.env.AUTOMATION_ANTHROPIC_API_KEY || '').trim();
}

// API 花費帳本（claude status 的 Discord 儀表板按額度週期加總顯示）；寫入失敗不影響主流程
const API_LEDGER_PATH = process.env.AUTOMATION_API_LEDGER || 'C:/Users/user/Desktop/dev/claude status/api-ledger.jsonl';
function appendApiLedger(entry) {
  try {
    fs.appendFileSync(API_LEDGER_PATH, `${JSON.stringify({ ts: new Date().toISOString(), project: 'plane-discord-bot', label: 'parse', ...entry })}\n`);
  } catch {
    // 帳本只是儀表板估算用，寫不進去就算了
  }
}

/** --output-format json 的 stdout 是單一 envelope；解析失敗（或非 envelope）就把整段 stdout 當回覆文字。 */
function parseEnvelope(stdout) {
  try {
    const envelope = JSON.parse(stdout);
    if (envelope && typeof envelope.result === 'string') {
      return {
        result: envelope.result,
        usage: envelope.usage || null,
        isError: envelope.is_error === true,
        apiErrorStatus: typeof envelope.api_error_status === 'number' ? envelope.api_error_status : null,
        costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : null,
        costBasis: Object.values(envelope.modelUsage || {}).map((m) => m && m.costBasis).filter(Boolean),
      };
    }
  } catch {
    // 不是合法 JSON envelope，當純文字處理
  }
  return { result: stdout, usage: null, isError: false, apiErrorStatus: null, costUsd: null, costBasis: [] };
}

// CLI 不認得的新 model 會回 modelUsage.costBasis = 'unknown' 並套錯單價（2026-10-11 實測 Haiku 5.5 被高估約 40 倍），
// 這時改用 usage × 官方單價自己算。單位：USD / 百萬 token；cache write 5 分鐘 1.25x、1 小時 2x，cache read 0.1x。
// 價格來源：claude-api skill shared/models.md（Haiku 5.5：prompt ≤100K 時 $0.10 / $0.50）。
const OFFICIAL_PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
};
function estimateCostUsd(model, usage) {
  const price = OFFICIAL_PRICES[model];
  if (!price || !usage) return null;
  const cc = usage.cache_creation_input_tokens ?? 0;
  const cc1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cc5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? (cc - cc1h);
  const inputUnits = (usage.input_tokens ?? 0) + cc5m * 1.25 + cc1h * 2 + (usage.cache_read_input_tokens ?? 0) * 0.1;
  return (inputUnits * price.input + (usage.output_tokens ?? 0) * price.output) / 1e6;
}
function ledgerCost(model, env) {
  if (env.costBasis.includes('unknown')) {
    const est = estimateCostUsd(model, env.usage);
    if (est != null) return { cost: est, source: 'official_price' };
  }
  return { cost: env.costUsd, source: 'cli' };
}

/** API 路徑的失敗是否該改走訂閱（額度用完、帳務、金鑰無效、API 速率限制）；逾時等其他錯誤不算。 */
function isApiBillingError(result) {
  if (!result || result.ok || result.errorCode === 'timeout' || result.errorCode === 'spawn_error') return false;
  if (API_FALLBACK_STATUSES.has(result.apiErrorStatus)) return true;
  return API_BILLING_ERROR_RE.test(`${result.error || ''}\n${result.resultText || ''}`);
}


// 共用 API 冷卻檔（2026-10-11）：e3／gmail／plane／lab-slack 共用同一把 key 與同一個 credit 池，
// 排程型專案每次都是新 process、記憶體冷卻會歸零，所以冷卻狀態落檔共用（api-cooldown.json）。
// 內嵌實作，邏輯與常數需與其他專案一致。讀失敗＝沒冷卻；寫失敗只 log，絕不影響主流程。
const API_COOLDOWN_PROJECT = 'plane-discord-bot';
const API_CREDIT_CYCLE_DAY = 10;
const API_CREDIT_RE = /credit balance|insufficient|billing|spend[ _-]?limit/i;
const API_AUTH_RE = /invalid[ _-]?(x-)?api[ _-]?key|authentication|unauthorized|permission_error/i;

function apiCooldownPath() {
  return process.env.AUTOMATION_API_COOLDOWN || 'C:/Users/user/Desktop/dev/claude status/api-cooldown.json';
}

/** 下一個額度週期起點（每月 10 號 00:00 UTC）；剛過起點 3 天內（10–12 號）額度可能還沒發 → now + 6 小時。 */
function nextCreditUntil(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDate();
  if (day < API_CREDIT_CYCLE_DAY) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), API_CREDIT_CYCLE_DAY);
  if (day < API_CREDIT_CYCLE_DAY + 3) return now + 6 * 60 * 60 * 1000;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, API_CREDIT_CYCLE_DAY);
}

/** API 失敗分類 → { reason: 'credit'|'auth'|'rate', until: 毫秒時間戳 }；status 優先，沒有才看文字，都不中 → rate。 */
function classifyApiFailure(result, now = Date.now()) {
  const status = typeof result?.apiErrorStatus === 'number' ? result.apiErrorStatus : null;
  const text = `${result?.error || ''}\n${result?.resultText || ''}`;
  let reason;
  if (status === 402) reason = 'credit';
  else if (status === 401 || status === 403) reason = 'auth';
  else if (status === 429) reason = 'rate';
  else if (API_CREDIT_RE.test(text)) reason = 'credit';
  else if (API_AUTH_RE.test(text)) reason = 'auth';
  else reason = 'rate';
  const until = reason === 'credit' ? nextCreditUntil(now) : reason === 'auth' ? now + 24 * 60 * 60 * 1000 : now + 60 * 60 * 1000;
  return { reason, until };
}

/** 讀冷卻檔；不存在／壞掉／until 解析失敗 → { until: 0, reason: null }。 */
function readApiCooldown() {
  try {
    const j = JSON.parse(fs.readFileSync(apiCooldownPath(), 'utf8'));
    const until = Date.parse(j?.until);
    if (Number.isFinite(until)) return { until, reason: j.reason ?? null };
  } catch {
    /* 沒有冷卻檔或壞檔 → 視為沒有冷卻 */
  }
  return { until: 0, reason: null };
}

/** API 失敗時寫冷卻檔（已有較晚的 until 不覆蓋）；回傳實際生效的 until（毫秒）。寫檔失敗只 log。 */
function writeApiCooldown(result, now = Date.now()) {
  const { reason, until } = classifyApiFailure(result, now);
  const prev = readApiCooldown();
  if (prev.until >= until) return prev.until;
  const file = apiCooldownPath();
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    const status = typeof result?.apiErrorStatus === 'number' ? result.apiErrorStatus : null;
    fs.writeFileSync(tmp, JSON.stringify({ until: new Date(until).toISOString(), reason, status, project: API_COOLDOWN_PROJECT, set_at: new Date(now).toISOString() }));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.log(`[ai-intake] ${`API 冷卻檔寫入失敗（不影響主流程）：${err.message}`}`);
    try { fs.unlinkSync(tmp); } catch { /* 暫存檔可能不存在 */ }
  }
  return until;
}

/**
 * 執行 `claude -p` 呼叫（JSON envelope 輸出、回傳其中的回覆文字；不給工具權限）。
 * 有 API key 且不在冷卻期 → 先走 API；API 額度／帳務類失敗 → 改走訂閱重跑一次。
 * @param {object} opts
 * @param {string} opts.prompt - 送進 stdin 的 prompt 全文
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.cwd]
 * @returns {Promise<{ok:boolean, resultText:string, raw:{stdout:string,stderr:string}, durationMs:number, error:string|null, errorCode:string|null, billing:string}>}
 */
async function runClaude(opts) {
  if (getAutomationApiKey()) {
    const cd = readApiCooldown();
    const until = Math.max(apiDisabledUntil, cd.until);
    if (Date.now() < until) {
      console.log(`[ai-intake] API 冷卻中: reason=${cd.reason ?? 'memory'} until=${new Date(until).toISOString()}，直接走訂閱`);
    } else {
      const viaApi = await runClaudeOnce(opts, 'api');
      if (!isApiBillingError(viaApi)) return viaApi;
      apiDisabledUntil = writeApiCooldown(viaApi);
      console.log(`[ai-intake] billing fallback: API 失敗（status=${viaApi.apiErrorStatus ?? '-'} ${String(viaApi.resultText || viaApi.error).trim().slice(0, 160)}），改走訂閱，API 暫停至 ${new Date(apiDisabledUntil).toISOString()}`);
    }
  }
  return runClaudeOnce(opts, 'subscription');
}

/** 執行一次 `claude -p`；billing='api' 帶 API key，'subscription' 清掉所有 API 憑證、只用 CLI 的訂閱登入。 */
function runClaudeOnce({ prompt, model, timeoutMs, cwd }, billing) {
  const resolvedModel = model || getParserModel();
  const resolvedTimeout = timeoutMs || getParserTimeoutMs();

  return new Promise((resolveRaw) => {
    const resolve = (r) => resolveRaw({ ...r, billing });
    const startedAt = Date.now();
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', resolvedModel,
      ...PURE_TEXT_FLAGS.map(shellQuoteArg),
    ];
    const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
    delete env.AUTOMATION_ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (billing === 'api') env.ANTHROPIC_API_KEY = getAutomationApiKey();

    let child;
    try {
      child = spawn(getCliPath(), args, { cwd: cwd || process.cwd(), shell: true, env });
      if (child.pid) activePids.add(child.pid);
    } catch (err) {
      resolve({
        ok: false,
        resultText: '',
        raw: { stdout: '', stderr: '' },
        durationMs: Date.now() - startedAt,
        error: `spawn_error: ${err.message}`,
        errorCode: 'spawn_error',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // 先 taskkill 整棵樹（趁根行程還活著才走訪得到孫行程），再 kill 直接子行程。
      if (process.platform === 'win32' && child.pid) {
        try {
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          // 行程可能已經結束，忽略
        }
      }
      try {
        child.kill();
      } catch {
        // 行程可能已經結束，忽略
      }
      // 保險絲：就算仍有孤兒行程握著 stdio 讓 close 不來，10 秒後強制結案。
      setTimeout(() => {
        if (settled) return;
        try { child.stdout?.destroy(); } catch { /* 忽略 */ }
        try { child.stderr?.destroy(); } catch { /* 忽略 */ }
        if (settled) return;
        settled = true;
        if (child.pid) activePids.delete(child.pid);
        resolve({
          ok: false,
          resultText: '',
          raw: { stdout, stderr },
          durationMs: Date.now() - startedAt,
          error: 'timeout',
          errorCode: 'timeout',
        });
      }, 10 * 1000);
    }, resolvedTimeout);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      if (child.pid) activePids.delete(child.pid);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        resultText: '',
        raw: { stdout, stderr },
        durationMs: Date.now() - startedAt,
        error: `spawn_error: ${err.message}`,
        errorCode: 'spawn_error',
      });
    });

    child.on('close', (code) => {
      if (child.pid) activePids.delete(child.pid);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        resolve({ ok: false, resultText: '', raw: { stdout, stderr }, durationMs, error: 'timeout', errorCode: 'timeout' });
        return;
      }
      // --output-format json：取 envelope.result 當回覆文字；解析失敗就退回整段 stdout（與 text 模式相同）
      const env = parseEnvelope(stdout);
      if (billing === 'api' && env.costUsd != null) {
        const { cost, source } = ledgerCost(resolvedModel, env);
        appendApiLedger({ model: resolvedModel, ok: code === 0 && !env.isError, cost_usd: cost, cost_source: source, input: env.usage?.input_tokens ?? 0, output: env.usage?.output_tokens ?? 0 });
      }
      if (code === 0 && !env.isError) {
        resolve({ ok: true, resultText: env.result, raw: { stdout, stderr }, durationMs, error: null, errorCode: null, apiErrorStatus: null });
        return;
      }
      // exit 0 但 envelope 標 is_error 時，錯誤碼標成 is_error 而非容易誤會的 exit_code_0
      const failure = classifyFailure({ exitCode: code === 0 ? 'is_error' : code, resultText: env.result, stderr });
      resolve({ ok: false, resultText: env.result, raw: { stdout, stderr }, durationMs, error: failure.error, errorCode: failure.errorCode, apiErrorStatus: env.apiErrorStatus });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// 從 start（必為 '{'）起找出平衡大括號子字串（跳過字串常值內的大括號與跳脫字元）。
function balancedBraceSlice(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// JSON 抽取加固（照抄 claude-runner.js 的 v6.3 邏輯）：
// (a) 逐一嘗試所有 ```json / ``` fenced block；(b) 逐一掃描每個 `{` 起點的平衡大括號子字串。
// requiredKey 存在時，只接受含該欄位的物件（避免抓到答案裡不相關的 JSON 片段）。
function extractJson(resultText, requiredKey) {
  if (!resultText) return null;
  const qualifies = (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (!requiredKey || Object.prototype.hasOwnProperty.call(value, requiredKey));
  const tryParse = (candidate) => {
    try {
      const value = JSON.parse(candidate);
      return qualifies(value) ? value : null;
    } catch {
      return null;
    }
  };

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenceRegex.exec(resultText)) !== null) {
    const parsed = tryParse(match[1].trim());
    if (parsed) return parsed;
  }

  for (let i = 0; i < resultText.length; i += 1) {
    if (resultText[i] !== '{') continue;
    const slice = balancedBraceSlice(resultText, i);
    if (slice === null) continue;
    const parsed = tryParse(slice);
    if (parsed) return parsed;
  }

  return null;
}

// ===== 解析契約（BOT-AI-INTAKE-SPEC.md §解析契約，v3 起見 BOT-AI-INTENT-SPEC.md） =====
const AI_LABEL_NAMES = ['test', 'homework', 'presentation', 'remind', 'competition'];
const AI_INTENTS = ['create', 'query', 'delete', 'update', 'unknown'];

// 今天日期＋星期，Asia/Taipei 時區意識（不依賴機器本身的系統時區設定）。
function taipeiTodayInfo() {
  const now = new Date();
  const taipeiLocal = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const iso = `${taipeiLocal.getFullYear()}-${String(taipeiLocal.getMonth() + 1).padStart(2, '0')}-${String(taipeiLocal.getDate()).padStart(2, '0')}`;
  const weekdayZh = '日一二三四五六'[taipeiLocal.getDay()];
  return { iso, weekdayZh, dateObj: taipeiLocal };
}

// 實測發現（2026-07-30）：haiku 心算「下週三」之類的相對星期換算時錯誤率約六成（5 次試驗 3 次算錯，
// 差一天算成星期四）。修法是把接下來三週的「日期→星期」對照表直接列給模型查表，不要它自己心算。
function upcomingCalendarLines(days = 21) {
  const { dateObj } = taipeiTodayInfo();
  const lines = [];
  for (let i = 1; i <= days; i += 1) {
    const d = new Date(dateObj);
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const weekdayZh = '日一二三四五六'[d.getDay()];
    lines.push(`${iso}(週${weekdayZh})`);
  }
  return lines;
}

function buildParsePrompt({ userText, clarify }) {
  const { iso, weekdayZh } = taipeiTodayInfo();
  const lines = [
    `你是行事曆助理。今天是 ${iso}（星期${weekdayZh}，Asia/Taipei 時區）。先判斷使用者這句話的意圖，再依意圖抽取對應的參數。`,
    '',
    '接下來 21 天的日期→星期對照表（換算「下週三」「這週五」之類的相對日期時，直接查這張表比對星期，',
    '不要自己心算星期幾，心算容易差一天）：',
    upcomingCalendarLines(21).join('、'),
    '',
    '可用的事件分類 label（選最貼切的一個，看不出來就填 null，不要亂猜）：',
    '- test：考試、測驗 💯',
    '- homework：作業、繳交 📚',
    '- presentation：報告、簡報 🗣️',
    '- remind：一般提醒 💡',
    '- competition：比賽 🏆',
    '',
    '意圖分類（intent，五選一）：',
    '- create：使用者在描述一件未來要做/要交/要考的具體事，例如「8/12有微積分考試」「記得買生日禮物」→ 用 events 抽出來，query 三個欄位都填 null。',
    '- query：使用者要問/看某個日期或關鍵字底下有哪些既有行程，例如「告訴我8/1有哪些行程」「8月有沒有作業」→ 用 query 物件描述查詢條件，events 給空陣列。',
    '- delete：使用者要刪除/取消某個日期或關鍵字對應的既有行程，例如「幫我刪掉8/1的古」→ 用 query 物件描述要刪除的目標，events 給空陣列。',
    '- update：使用者要改某筆既有行程的日期（改期）、名稱、時間或地點，例如「今天的桌球考試改到下禮拜同個時間」「老人驗改到 B03」→ query 描述「要改哪一筆」（規則同 delete），changes 描述要改成什麼，events 給空陣列。',
    '- unknown：看不出是上述哪一種（純聊天、打招呼、內容太模糊），query 與 events 都留空。',
    '',
    'query 物件的填法（intent 是 query、delete 或 update 時才要填；create/unknown 時三個欄位都填 null）：',
    '- keyword 只填事件名稱裡真正代表內容的關鍵詞（例如「古」「作業」），不要把整句話塞進去；只有日期沒有關鍵字就把 keyword 填 null。',
    '- 只有關鍵字沒有日期，start 跟 end 都填 null。',
    '- 只有單一天，start 跟 end 填同一個日期；一段範圍才分別填首尾日期。',
    '- 日期跟關鍵字都看不出來（真的無法判斷要查/刪/改什麼）→ 在 questions 提出來問清楚，不要瞎猜。',
    '',
    'changes 物件的填法（只有 intent=update 才要填，其他 intent 五個欄位都填 null）：',
    '- due：使用者給「絕對日期」（例如「改到 11/5」）時才填，格式 YYYY-MM-DD。',
    '- shift_days：使用者說「相對於原事件」的改法時填整數天數：「下禮拜同個時間」「延一週」＝7、「往後兩天」＝2、「提前一天」＝-1。你不知道原事件的日期，所以這種情況絕對不要自己算 due。',
    '- due 與 shift_days 只能擇一，不能兩個都填；沒有要改日期兩個都填 null。',
    '- name：要改成的新名稱（不用加 emoji）；沒要改名填 null。',
    '- time：要改成的新時間，格式 "HH:MM" 或 "HH:MM~HH:MM"（24 小時制）；沒要改填 null。',
    '- location：要改成的新地點；沒要改填 null。',
    '- changes 至少要有一項非 null；使用者沒講清楚要改什麼 → 在 questions 問，不要瞎猜。',
    '- query 描述的是「原本那筆」的日期／關鍵字，不是改完以後的日期。',
    '',
    'events 裡每筆事件的 time / location（intent=create）：',
    '- time：原文提到的時間，格式 "HH:MM" 或 "HH:MM~HH:MM"（24 小時制，下午 7 點 10 分 → "19:10"）；沒提到填 null，不准猜。',
    '- location：原文提到的地點或教室（例如 "B02"）；沒提到填 null，不准猜。',
    '- desc：只放時間地點以外、對行程有用的資訊（例如攜帶物品、報名連結）；沒有就填空字串。時間和地點不要重複寫進 desc。',
    '',
    '使用者原文：',
    '"""',
    userText,
    '"""',
  ];

  if (clarify) {
    lines.push(
      '',
      `（澄清資訊）你上一輪判斷的意圖是「${clarify.intent || 'unknown'}」，除非這次回答明確顯示不同，否則維持這個意圖。`,
      '你上一輪問了以下問題：',
      clarify.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
      '使用者的回答：',
      '"""',
      clarify.answer,
      '"""',
      '請結合原文與這次回答，重新輸出完整結果。這是最後一輪澄清，之後不管訊息夠不夠清楚都不要再問（questions 一律給空陣列），依你的最佳判斷輸出。'
    );
  }

  lines.push(
    '',
    '範例（few-shot，格式必須完全照這樣輸出一個 JSON 物件，不要有多餘文字）：',
    '- 原文「8/12有微積分考試」→ {"intent":"create","query":{"start":null,"end":null,"keyword":null},"changes":{"due":null,"shift_days":null,"name":null,"time":null,"location":null},"events":[{"name":"微積分考試","due":"2026-08-12","label":"test","desc":"","time":null,"location":null}],"questions":[]}',
    '- 原文「11/4（三）是假日營的老人驗 19:10 B02」→ {"intent":"create","query":{"start":null,"end":null,"keyword":null},"changes":{"due":null,"shift_days":null,"name":null,"time":null,"location":null},"events":[{"name":"假日營的老人驗","due":"2026-11-04","label":"test","desc":"","time":"19:10","location":"B02"}],"questions":[]}',
    '- 原文「告訴我8/1有哪些行程」→ {"intent":"query","query":{"start":"2026-08-01","end":"2026-08-01","keyword":null},"changes":{"due":null,"shift_days":null,"name":null,"time":null,"location":null},"events":[],"questions":[]}',
    '- 原文「幫我刪掉8/1的古」→ {"intent":"delete","query":{"start":"2026-08-01","end":"2026-08-01","keyword":"古"},"changes":{"due":null,"shift_days":null,"name":null,"time":null,"location":null},"events":[],"questions":[]}',
    `- 原文「今天的桌球考試改到下禮拜同個時間」→ {"intent":"update","query":{"start":"${iso}","end":"${iso}","keyword":"桌球"},"changes":{"due":null,"shift_days":7,"name":null,"time":null,"location":null},"events":[],"questions":[]}`,
    '- 原文「老人驗改到 B03」→ {"intent":"update","query":{"start":null,"end":null,"keyword":"老人驗"},"changes":{"due":null,"shift_days":null,"name":null,"time":null,"location":"B03"},"events":[],"questions":[]}',
    '',
    '請依上述規則抽取（可能有多筆事件，也可能一筆都沒有）。只輸出 JSON，不要有 markdown fence、不要有任何說明文字或前後贅字，格式如下：',
    '{',
    '  "intent": "create" 或 "query" 或 "delete" 或 "update" 或 "unknown",',
    '  "query": { "start": "YYYY-MM-DD 或 null", "end": "YYYY-MM-DD 或 null", "keyword": "關鍵字或 null" },',
    '  "changes": { "due": "YYYY-MM-DD 或 null", "shift_days": 整數或 null, "name": "新名稱或 null", "time": "HH:MM 或 HH:MM~HH:MM 或 null", "location": "新地點或 null" },',
    '  "events": [',
    '    { "name": "事件名稱", "due": "YYYY-MM-DD 或 null", "label": "test/homework/presentation/remind/competition 之一或 null", "desc": "", "time": "HH:MM 或 HH:MM~HH:MM 或 null", "location": "地點或 null" }',
    '  ],',
    '  "questions": ["需要使用者澄清的問題，沒有就給空陣列"]',
    '}',
    '',
    '規則：',
    '- due 用相對今天日期換算出的絕對日期，算不出來就填 null，不要瞎猜年份或日期。',
    '- label 只能是上面 5 個之一，不確定就填 null。',
    '- intent=create 時，原文看不出任何具體事件（純聊天、無法判斷）→ events 給空陣列。',
    '- 不要輸出 JSON 以外的任何文字。'
  );

  return lines.join('\n');
}

function isValidIsoDate(s) {
  if (typeof s !== 'string') return false;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

// query 物件的決定性驗證：start/end 必為合法 YYYY-MM-DD 或 null，keyword 必為非空字串或 null。
function normalizeAiQuery(rawQuery) {
  const start = isValidIsoDate(rawQuery?.start) ? rawQuery.start : null;
  const end = isValidIsoDate(rawQuery?.end) ? rawQuery.end : null;
  const keyword = typeof rawQuery?.keyword === 'string' && rawQuery.keyword.trim() ? rawQuery.keyword.trim() : null;
  return { start, end, keyword };
}

// bot 端決定性驗證（不信任 AI 輸出）：due 必為合法 YYYY-MM-DD 或 null；label 必為五個 key 之一或 null；
// 沒有名稱的事件視為抽取失敗直接捨棄。intent 必為 enum 之一，非法值一律降級為 unknown（BOT-AI-INTENT-SPEC.md）。
// intent=query/delete 卻連 keyword 與日期都沒有 → 這是 AI 抽取失敗，轉成一個 clarify 問題問使用者，不猜。
// changes 物件（intent=update，BOT-SMART-SPEC.md §A）的決定性驗證。
// due 與 shift_days 擇一（兩者都給視為 AI 錯誤）；至少要有一項變更。回傳 { changes, questions }。
function normalizeAiChanges(raw) {
  const due = isValidIsoDate(raw?.due) ? raw.due : null;
  const sd = typeof raw?.shift_days === 'string' && /^-?\d+$/.test(raw.shift_days.trim()) ? Number(raw.shift_days) : raw?.shift_days;
  const shift_days = Number.isInteger(sd) && sd !== 0 && Math.abs(sd) <= 366 ? sd : null;
  const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  const time = normalizeTimeText(raw?.time);
  const location = normalizeLocationText(raw?.location);
  const questions = [];
  // 衝突時把衝突欄位清掉（不讓 due＋shift_days 帶進下游繞過驗證），其餘欄位保留。
  let finalDue = due;
  let finalShift = shift_days;
  if (due && shift_days) {
    finalDue = null;
    finalShift = null;
    questions.push('你是要改到某個確定的日期，還是相對原本日期往後／往前幾天？');
  } else if (!due && !shift_days && !name && !time && !location) {
    questions.push('要把這筆改成什麼？（新日期、新時間、新地點或新名稱）');
  }
  return { changes: { due: finalDue, shift_days: finalShift, name, time, location }, questions };
}

function normalizeAiResult(json) {
  const rawEvents = Array.isArray(json?.events) ? json.events : [];
  const questions = Array.isArray(json?.questions)
    ? json.questions.filter((q) => typeof q === 'string' && q.trim())
    : [];
  const events = rawEvents
    .map((e) => ({
      name: typeof e?.name === 'string' ? e.name.trim() : '',
      due: isValidIsoDate(e?.due) ? e.due : null,
      label: AI_LABEL_NAMES.includes(e?.label) ? e.label : null,
      desc: typeof e?.desc === 'string' ? e.desc : '',
      time: normalizeTimeText(e?.time),
      location: normalizeLocationText(e?.location),
    }))
    .filter((e) => e.name);

  const intent = AI_INTENTS.includes(json?.intent) ? json.intent : 'unknown';
  const query = normalizeAiQuery(json?.query);
  const finalQuestions = [...questions];
  if ((intent === 'query' || intent === 'delete') && !query.start && !query.end && !query.keyword) {
    finalQuestions.push(intent === 'delete' ? '要刪除的是哪一天，或關鍵字是什麼？' : '要查詢的是哪一天，或關鍵字是什麼？');
  }

  let changes = { due: null, shift_days: null, name: null, time: null, location: null };
  if (intent === 'update') {
    if (!query.start && !query.end && !query.keyword) finalQuestions.push('要改的是哪一天的事件，或關鍵字是什麼？');
    const c = normalizeAiChanges(json?.changes);
    changes = c.changes;
    finalQuestions.push(...c.questions);
  }

  return { intent, query, changes, events, questions: finalQuestions };
}

/**
 * 對外主入口：解析一段自由文字（或澄清後的原文＋回答），回傳決定性驗證過的結果。
 * @param {object} opts
 * @param {string} opts.userText
 * @param {{questions:string[], answer:string, intent?:string}} [opts.clarify] - intent 是上一輪判斷的意圖，
 *   帶進 prompt context 避免澄清後意圖漂移（BOT-AI-INTENT-SPEC.md §管線接軌）。
 * @returns {Promise<{ok:true, intent:string, query:object, changes:object, events:object[], questions:string[]} | {ok:false, error:string, errorCode:string}>}
 */
async function runAiParse({ userText, clarify }) {
  const prompt = buildParsePrompt({ userText, clarify });
  const first = await runClaude({ prompt });
  if (!first.ok) {
    return { ok: false, error: first.error, errorCode: first.errorCode || 'run_failed' };
  }

  let json = extractJson(first.resultText, 'events');
  if (!json) {
    const repairPrompt = `${prompt}\n\n（提醒：你上一次的輸出不是合法 JSON。請重新輸出一個 \`\`\`json fenced block，內容為完整結果 JSON，前後不要有任何其他文字。）`;
    const second = await runClaude({ prompt: repairPrompt });
    if (!second.ok) {
      return { ok: false, error: second.error, errorCode: second.errorCode || 'run_failed' };
    }
    json = extractJson(second.resultText, 'events');
    if (!json) {
      return { ok: false, error: 'json_unparseable', errorCode: 'json_unparseable' };
    }
  }

  const normalized = normalizeAiResult(json);
  return { ok: true, intent: normalized.intent, query: normalized.query, changes: normalized.changes, events: normalized.events, questions: normalized.questions };
}

module.exports = {
  normalizeAiChanges,
  runAiParse,
  runClaude,
  estimateCostUsd,
  ledgerCost,
  parseEnvelope,
  classifyApiFailure,
  nextCreditUntil,
  readApiCooldown,
  writeApiCooldown,
  isApiBillingError,
  extractJson,
  buildParsePrompt,
  normalizeAiResult,
  isValidIsoDate,
  taipeiTodayInfo,
  AI_LABEL_NAMES,
  AI_INTENTS,
  killActiveClaudeChildren,
  getCliPath,
  getParserModel,
  getParserTimeoutMs,
};
