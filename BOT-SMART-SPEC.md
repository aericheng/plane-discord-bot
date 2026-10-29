# bot.js 擴充規格 v4：改期修改、時間地點、建立前查重、行程摘要

> 延續 BOT-AI-INTAKE-SPEC.md（v2 AI 建立）與 BOT-AI-INTENT-SPEC.md（v3 查詢／刪除）。使用者 2026-10-29 選定四項全做。
> 實錄動機（2026-10-29）：
> - 「今天的桌球考試改到下禮拜同個時間」：bot 沒有改期能力，只能由 Claude session 手動 PATCH。
> - 「11/4（三）…假日營的老人驗 19:10 B02」：AI prompt 的 desc 一律給空字串，時間和地點沒有寫成日曆看得懂的格式；最後建出來的事件只有描述「19:10」，B02 沒存。
> - 同日 POST 逾時但 Plane 已建立（已由 50e2d63 的 createWithRecovery 處理）；建立前沒有查重，重送就會重複。

## 共同原則（沿用 v3，不准放寬）

- AI 只負責「理解使用者要什麼」並輸出參數；**所有寫入都走 bot 端的決定性管線**：候選過濾 → 確認卡（顯示完整名稱／日期／id）→ 按鈕確認 → API → read-back。AI 的說法不轉述成結果。
- 所有會寫入的按鈕都要有防連點鎖（key 用 message.id；處理中回 ephemeral「處理中」；finally 解鎖）。參考 `e3-intake.js` 的 inFlight。
- ALLOWED_USER_ID 閘門、單筆限定、確認卡 60 秒過期，和刪除一致。
- 前綴指令 `查`／`刪` 保持零 AI 延遲路徑，不受影響。
- 建立一律走 `createPlaneIssue`（含 50e2d63 的逾時重查），不准繞過。

## A. 改期／修改（intent=update）

**解析契約**（向下相容擴充 v3）：

```json
{
  "intent": "update",
  "query": { "start": "YYYY-MM-DD|null", "end": "YYYY-MM-DD|null", "keyword": "桌球|null" },
  "changes": {
    "due": "YYYY-MM-DD|null",
    "shift_days": 7,
    "name": "新名稱|null",
    "time": "19:10 或 13:20~17:00 或 null",
    "location": "B02|null"
  }
}
```

- `query` 描述「要改哪一筆」，規則同 delete。
- `due` 與 `shift_days` 擇一：使用者說了絕對日期就給 `due`；說「延一週／下禮拜同個時間／往後兩天」這類相對於**原事件**的改法就給 `shift_days`。AI 不知道原事件日期，所以不准自己算 due。bot 在找到目標後用原 `target_date + shift_days` 算新日期。兩者都給視為 AI 錯誤，轉成 questions。
- `changes` 至少要有一項非 null，否則轉 questions。
- `name` 改名時保留原本的 emoji 前綴（label 前綴規則不變）。
- `time`／`location` 改的是描述裡的 `時間：`／`地點：` 行（格式見 B）：有就取代，沒有就加在描述最前面，其他描述內容保留。

**管線**：
1. 用 query 走和刪除同一套候選過濾（共用入口，不准重寫一份過濾）：0 筆 → 回「找不到」並附查詢條件；多筆 → 下拉選單；1 筆 → 直接出確認卡。
2. 確認卡逐欄顯示「舊 → 新」（名稱、日期，日期附星期幾、時間、地點）＋ issue id，按鈕 ✅ 確認修改／❌ 取消。
3. 確認後 PATCH 只送有變的欄位（`name`、`target_date`、`description_html`），逾時比照 createWithRecovery 的精神：不直接報失敗，重抓列表確認欄位是否已是新值。
4. read-back：重抓列表，找到同 id，逐欄比對新值；不一致就明講哪一欄沒改到。
5. 回報：`✏️ 已修改：名稱｜舊日期 → 新日期｜連結`。

few-shot 至少加：「今天的桌球考試改到下禮拜同個時間」→ `{intent:"update", query:{start:今天,end:今天,keyword:"桌球"}, changes:{shift_days:7}}`。

## B. 自動帶時間地點（create 與 update 共用）

- 解析契約的 event 加兩欄：`"time": "19:10 或 13:20~17:00 或 null"`、`"location": "B02 或 null"`。AI 從原文抽，抽不到填 null，不准猜。`desc` 只放時間地點以外的補充（例如「希望老人們都可以來」這種可以不放；放與不放由 prompt 規則明定：只放對行程有用的資訊，像攜帶物品、報名連結）。
- bot 端組描述（決定性，不給 AI 組）：
  ```
  時間：19:10
  地點：B02
  <desc>
  ```
  沒有的行就省略。這是 Apps Script「Plane Calendar Sync」v3 看得懂的格式（時間 `HH:MM`／`HH:MM~HH:MM`、`地點：X`）。**實作前先用本機的同版解析器測試檔（memory plane-google-calendar-sync 提到「本機留有同版解析器測試檔」，找不到就回報，不要猜）驗證這三種輸入會被解析成定時事件和 location**；找不到測試檔時，至少用一筆 `__AI測試__` 事件建立後等整點同步，請使用者看 Google 日曆確認，測完刪除。
- 確認卡每筆事件多顯示 `🕒 19:10　📍 B02`（有才顯示）。
- 逐步建立模式不改。

## C. 建立前查重（AI 建立與逐步建立）

- 建立前呼叫一次 `fetchAllIssues()`（一批只抓一次），比對規則**重用** `e3-intake.js` 的名稱正規化（去開頭 emoji、全形空白轉半形、連續空白合併、不分大小寫）＋ 同 `target_date`。
- AI 確認卡：出卡前就比對，同名同日的那筆標 `⚠️ 已有同名同日（不會重複建立）`。按確認時再比對一次（中間可能有人建了），已有的跳過、回報列「已有」並附既有連結。
- 逐步建立（含週期最多 40 筆）：已存在的日期跳過，回報「建立 N 筆，略過 M 筆已有」。
- 抓列表失敗：不擋建立，但回報加一行「⚠️ 這次沒辦法查重」。

## D. 每日／每週行程摘要

- 由 bot 自己排時間（不新增 Windows 排程），時區 Asia/Taipei：
  - **每日 07:30**：今天＋明天的事件。今天和明天都沒有事件就不發。
  - **每週日 21:00**：下週一到週日的事件，依日期分組，標星期幾。
- 發到 ALLOWED_CHANNEL_ID 頻道。
- 內容：每筆一行 `emoji 名稱 🕒時間 📍地點`（時間地點從描述的 `時間：`／`地點：` 行或 Apps Script 能解析的樣式取，取不到就只列名稱）。💯 考試、📚 作業排在當天最前面。另列「已過期但未完成」的 💯／📚（最多 5 筆）。
- 排除已完成／已取消的 issue：先查 Plane 的 state 結構（`state` id 對應的 group，例如 completed／cancelled），用實測結果決定過濾方式並寫進註解；不確定就回報，不要猜。
- 補發：bot 重啟時若今天的每日摘要還沒發、且現在介於 07:30–12:00，就補發一次。已發日期寫進 `data/digest-state.json`（gitignore），避免重複發。
- log：發送成功寫一行 `[bot] digest daily sent date=YYYY-MM-DD items=N`（週摘要 `digest weekly sent week=YYYY-MM-DD items=N`），供健康檢查用。
- 健康檢查：在 `C:/Users/user/Desktop/dev/ops-audit/scripts/health-check.mjs` 的 LOG_MARKERS 加一項每日摘要，`dailyAt: '07:30'`。注意：沒事件的日子不發，所以 marker 要也比對「digest daily skipped date=… reason=empty」這行（請 bot 在不發時也寫這行），否則空日子會誤報。

## 測試與驗收（逐條實測，貼輸出）

1. 純邏輯 selftest（不連網、不打 Plane、不登入）：update 的 shift_days 計算、改名保留 emoji、描述時間地點行的取代／插入、查重正規化、摘要分組排序與空日子不發、補發判斷。加進 `npm run selftest`。
2. AI 解析：用真的 claude 呼叫跑至少這幾句並貼 JSON：「今天的桌球考試改到下禮拜同個時間」「老人驗改到 B03」「11/4（三）是假日營的老人驗 19:10 B02」「下週五交微積分作業」。
3. E2E 只准用 `__AI測試__` 前綴的自建事件：建立（含時間地點）→ 重送同句確認查重擋下 → 改期（shift）→ 改地點 → 刪除。真實事件只准驗到「確認卡出現且內容正確」就按取消。測試前後筆數相同、零殘留。
4. 摘要：用注入的假時間與假 issue 跑 selftest；真實發送只在測試頻道或用 dry-run 印出，不要在正式頻道連發。
5. 回歸：既有 selftest 全過；前綴 `查`／`刪` 仍無 claude spawn；eslint `no-undef` 乾淨（`npx --yes eslint@8 --no-eslintrc --env node,es2022 --parser-options=ecmaVersion:2022 --rule "no-undef:error" bot.js ai-intake.js e3-intake.js`）。
6. 重啟 bot：先列 PID 的完整 CommandLine 與父程序（父程序應為 `start-bot.cmd` 的 cmd.exe），只結束 `node bot.js` 那個，loop 會在 30 秒內重啟；看 bot.log 出現新的 `logged in as`。
7. 更新 README 與 HELP_TEXT（自然語言改期／時間地點範例、摘要時間）。

## 不准動

- `.env` 不改、token 不印；`start-bot.cmd` 不動；`require.main` 守門與 exports 模式保留。
- E3 候選卡流程與 `BOT-E3-INTAKE-SPEC.md` 契約不變。
- 只在使用者要求時 commit／push；commit 不加任何 Claude／AI trailer。
