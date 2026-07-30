# bot.js 擴充規格 v2：AI 自由文字建立事件

> 給實作 session：延續 BOT-UPGRADE-SPEC.md（查/刪已上線）。本規格新增「丟一段自由文字 → AI 抽取 → 確認 → 批次建立」。使用者已定調：全部走 AI（非指令訊息一律 AI 解析）、支援一段文字抽多筆事件。

## 目標與安全邊界（最重要）

- AI 的職責**只有解析**：吃使用者文字，產出結構化提案 JSON。
- **寫入永遠走既有的 `createPlaneIssue`**（決定性程式），且必經使用者按鈕確認。
- bot 回報的建立結果**只能來自 POST 回應**，絕不轉述 AI 的說法（2026-07-29 幻覺事故的教訓：AI 輸出不可當事實回報）。
- 不確定的細節（缺日期、年份模糊、多個候選日）→ 先問使用者再說，不要猜。

## 引擎：headless `claude -p`

- 參考實作：`C:\Users\user\Desktop\dev\claude code learning bot\src\claude-runner.js`——**必讀**，它已解掉三個 Windows 地雷：(a) prompt 一律走 stdin 不進 argv；(b) 空字串/含 `()&|<>^%` 的參數要補引號（shellQuoteArg）；(c) timeout 要殺整棵程序樹。
- **claude CLI 的絕對路徑**：排程任務的 PATH 不完整（已知地雷），bot 不能假設 `claude` 在 PATH 上。實作時用 `where claude` 查出絕對路徑寫進常數，並支援 `.env` 的 `CLAUDE_CLI_PATH` 覆寫。
- model：預設 `claude-haiku-4-5-20251001`（速度優先），`.env` 的 `PARSER_MODEL` 可覆寫。
- timeout 預設 90 秒（`.env` `PARSER_TIMEOUT_MS` 可覆寫），逾時/失敗走 fallback（見下）。
- 呼叫旗標參考：`claude -p --model <m> --output-format text`，不給任何工具權限（`--allowedTools ""` 的空字串地雷見 claude-runner）。

## 解析契約

prompt 必含：今天日期＋星期（bot 端計算，含 `Asia/Taipei` 時區意識）、LABELS 清單與語意（test=考試/測驗 💯、homework=作業/繳交 📚、presentation=報告/簡報 🗣️、remind=一般提醒 💡、competition=比賽 🏆）、使用者原文。要求**只輸出 JSON**（無 markdown fence、無說明文字）：

```json
{
  "events": [
    { "name": "交機率作業三", "due": "2026-08-05", "label": "homework", "desc": "" }
  ],
  "questions": ["原文提到『下次上課』，請問是哪一天？"]
}
```

bot 端的決定性驗證（不信任 AI 輸出）：
- `JSON.parse` 失敗 → 重試一次（prompt 加「上次輸出不是合法 JSON」）→ 再失敗走 fallback。輸出若包 ```json fence 要先剝掉再 parse（模型常見行為，剝 fence 屬容錯不屬信任）。
- `due` 必須是合法 `YYYY-MM-DD` 或 null；過去的日期保留但在確認卡標 ⚠️。
- `label` 必須 ∈ LABELS 的 key，否則設為 null；null label 在建立時 fallback 成 `remind` 並在確認卡標「(預設)」。
- `events` 為空且無 questions → 回「我看不出這段文字裡有事件」＋原文長度提示。

## 對話流程

1. 非指令訊息（不是 查/刪/取消/幫助、無進行中流程）→ 立即回「🤖 解析中…（約 10–20 秒）」的 placeholder，然後呼叫 AI，完成後 **edit 同一則訊息**成結果。
2. `questions` 非空 → 先列出問題等使用者回一則訊息（clarify 狀態存 Map，`取消` 可退出），把「原文＋問題＋使用者回答」重新丟 AI 解析。**最多一輪澄清**，之後有什麼給什麼。
3. `due` 為 null 的事件 → 確認卡列出但標「❓需要日期」，使用者按確認前 bot 逐筆問日期（用既有 `parseSingleDate`，決定性）。
4. 確認卡（依日期升冪）：
   ```
   🤖 從你的文字抽出 2 筆事件：
   1. 📚 交機率作業三 — 2026-08-05
   2. 💯 物理第六週測驗 — 2026-08-07
   [✅ 全部建立] [❌ 取消]
   ```
   customId `plane_ai_ok` / `plane_ai_no`；待確認狀態 userId → {events, expiresAt}，**120 秒過期**；按鈕 userId 必須等於發文者。
5. 確認後逐筆 `createPlaneIssue`（筆間 `sleep(400)`），emoji 前綴規則與既有建立流程一致；回報每筆的名稱/日期/id，全部來自 POST 回應。
6. 部分失敗要逐筆誠實回報（成功幾筆、失敗幾筆＋HTTP 碼）。

## Fallback（AI 不可用：spawn 失敗/逾時/二次 JSON 失敗）

- 原文 ≤ 40 字 → 自動轉入既有逐步流程（原文當事件名稱），並註明「AI 解析暫時不可用，改用逐步模式」。
- 原文 > 40 字 → 回覆 AI 暫時不可用，請稍後再試或改用逐步模式（直接傳簡短事件名稱）。
- 既有逐步流程的程式碼**保留不刪**（它就是 fallback）。

## 不准動的部分

- 查/刪指令、取消/幫助攔截、既有 `createPlaneIssue`/`parseDueInput` 行為不變。
- `.env` 既有值不動（只新增 key）；token 不印進任何輸出。
- `start-bot.cmd`/`start-bot-hidden.vbs` 不動。
- `require.main` 守門與 module.exports 模式保留，新增純函式一併 export 供測試。

## 併發與狀態

- 同一使用者同時只允許一個進行中的 AI 解析（進行中再丟文字 → 提示稍等或先取消）。
- clarify / 待確認 / 逐步 session 三種狀態互斥，`取消` 一律全清。

## 驗收條件（逐條實測，貼輸出）

1. 單事件：丟「下週三要交線代作業」→ 抽出 1 筆、due 為正確的下週三 ISO 日期（相對今天計算）、label=homework、確認卡格式正確 → 確認 → Plane 上真的出現（列表 API 重抓驗證）→ 清理。
2. 多事件：丟含 3 個 deadline 的一段文字 → 3 筆全列、日期升冪 → 批次建立 3 筆 → 驗證後清理。
3. 缺日期：丟「記得買生日禮物」→ 走 questions 澄清或 ❓需要日期路徑，補日期後可建立 → 清理。
4. Fallback：把 CLI 路徑設成不存在的檔案 → 短文字自動轉逐步流程、長文字得到明確錯誤訊息；還原路徑後恢復。
5. JSON 容錯：模擬（或實測誘發）帶 markdown fence 的輸出 → 剝 fence 後正常 parse。
6. 回歸：查 8/1、刪除全流程（測試 issue）、取消、幫助全部行為不變。
7. `node --check` 通過；`require()` 不觸發登入；重啟後登入正常、bot.log 無新錯誤（重啟由主對話做）。
8. 資料完整性：所有測試結束後 workspace 總筆數回到基準（實測起始值），無「測試」殘留。

## 交接備註

- 實作 model：sonnet。完成後派 fresh-context verifier。
- HELP_TEXT 要改寫成以 AI 模式為主、逐步模式為 fallback 的說明。
- 確認卡訊息若超過 2000 字（事件太多）→ 截斷顯示＋提示分段丟文字。
