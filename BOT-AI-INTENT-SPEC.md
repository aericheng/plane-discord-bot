# bot.js 擴充規格 v3：AI 意圖分類（自然語言查詢與刪除）

> 給實作 session：延續 BOT-AI-INTAKE-SPEC.md（v2，AI 建立已上線）。實錄動機（2026-07-30 使用者截圖）：「幫我刪掉8/1的古」被當成要**建立**事件而反問＋出建立確認卡；「告訴我8/1有哪些行程」回「看不出有事件」。根因：AI 解析只有 create 一種意圖。

## 目標與安全邊界

- AI 的 prompt 升級為**先分類意圖**：`create` / `query` / `delete` / `unknown`，並為 query/delete 抽取參數。
- **安全邊界完全不變**：
  - 查詢結果永遠來自既有的全量抓取＋本地過濾（AI 絕不產生查詢結果內容）。
  - 刪除永遠走既有管線：候選過濾 → 多筆選單 → 顯示完整名稱/日期/id → 按鈕確認 → DELETE → read-back 403 驗證。AI 只提供「使用者想刪什麼」的參數，碰不到刪除執行路徑。
  - ALLOWED_USER_ID 閘門、單筆限定、60 秒過期全部沿用。
- 前綴指令 `查 <x>`／`刪 <x>` **保持不經 AI**（零延遲路徑，攔截順序不變）。自然語言是補充不是取代。

## 解析契約 v2（向下相容）

```json
{
  "intent": "create" | "query" | "delete" | "unknown",
  "query": { "start": "YYYY-MM-DD" | null, "end": "YYYY-MM-DD" | null, "keyword": "古" | null },
  "events": [ { "name": "...", "due": "YYYY-MM-DD" | null, "label": "...", "desc": "" } ],
  "questions": ["..."]
}
```

- `intent=create` → `events` 照 v2 流程（確認卡→建立）。
- `intent=query`／`delete` → 用 `query` 物件；`start`/`end` 單日時相等；純關鍵字時兩者 null。
- 決定性驗證（bot 端，不信任 AI）：intent ∈ enum（非法→unknown）；query/delete 必須至少有 keyword 或日期之一，否則轉出 questions 問使用者；日期格式驗證同 v2。
- `intent=unknown` → 回「看不出你要建立、查詢還是刪除」＋一行用法提示。
- prompt 中給 3 個 few-shot 範例（建立/查詢/刪除各一），刪除範例就用「幫我刪掉8/1的古」。

## 管線接軌（不准重複實作過濾邏輯）

- AI 的 `query` 物件轉成既有內部查詢格式（`{type:'range',start,end}` 或 `{type:'keyword',keyword}`；**兩者兼有時**：先用日期範圍過濾再用關鍵字過濾，這是既有 parseQueryInput 做不到的新組合，實作在共用過濾函式內）。
- `intent=query` → 餵既有 `handleQuery` 的核心（抓取＋過濾＋buildListMessage），輸出格式一致。
- `intent=delete` → 餵既有 `handleDelete` 的核心（同一套候選/選單/確認/read-back）。必要時把 handleQuery/handleDelete 內部小幅重構出「接受結構化查詢物件」的共用入口，但行為與措辭不變（前綴路徑走原字串解析→同一入口）。
- 澄清（clarify）要保留意圖：v2 的 clarify 只帶原文重問，v3 起 clarify 的重新解析要把第一次的 intent 判斷結果一併帶進 prompt context，避免答完澄清後意圖漂移。

## HELP_TEXT

補一段：可以直接用自然語言，例如「幫我刪掉8/1的古」「告訴我8/1有哪些行程」「8/12有微積分考試」；前綴 `查`/`刪` 是快速通道（不用等 AI）。

## 不准動的部分

- 前綴 `查`/`刪` 的解析與輸出、逐步建立流程、v2 建立確認卡/dateFill/fallback 行為不變。
- `.env` 不改；token 不印；start 腳本不動；`require.main` 守門與 exports 模式保留。

## 驗收條件（逐條實測，貼輸出）

1. 「幫我刪掉8/1的古」→ intent=delete、參數含 8/1＋古 → 進入刪除確認流程。**絕不真的刪「古」**：對真實事件只驗證到「確認卡出現且內容正確」就取消；完整刪除 E2E 用自建的 `__AI測試__` 事件跑。
2. 「告訴我8/1有哪些行程」→ intent=query → 輸出與 `查 8/1` 完全一致（逐字元比對）。
3. 「8/12有微積分考試」→ intent=create → v2 確認卡照舊。
4. 前綴速度：`查 8/1` 與 `刪 xxx` 全程無 claude spawn（讀碼＋計時證明 <3 秒）。
5. 意圖模糊：丟「嗯」之類 → unknown 路徑的提示訊息。
6. 回歸：v2 驗收條件 1（單事件建立）與 4（fallback）重測通過；前綴查/刪重測通過。
7. 資料完整性：測試前實測基準筆數，結束後回到基準、零「測試」殘留。
8. `node --check` 兩檔；`require()` 不登入；重啟由主對話負責。

## 交接備註

- 實作 model：sonnet。測試 POST 只准 `__AI測試__` 前綴、測完即刪。claude CLI 實測會用掉額度，正常。
- 完成後主對話派 fresh-context verifier。
- 附帶修一個文案：確認卡 [❌ 取消] 按鈕的回覆「已取消，隨時再丟文字給我。」（bot.js:614）改成「已取消，這批不會建立。」——使用者截圖中它與「取消指令」的回覆同文案造成混淆。
