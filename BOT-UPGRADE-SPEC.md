# bot.js 擴充規格：查詢與刪除指令

> 給實作 session：這份規格由 2026-07-30 的審查 session 撰寫，其中標註「已驗證」的 API 行為都是當天實測過的，可直接信任；標註「未查證」的要先實測再用。實作完成後依「驗收條件」逐條自驗，再交 fresh-context verifier 驗收。

## 目標與動機

讓日常的「查詢」「刪除」走規則式程式，不經過 LLM。背景：2026-07-29 幫使用者管 Plane 的長壽 Claude session 發生幻覺事故（編造查詢結果、把刪除敘事講錯），結論是例行操作必須由決定性程式承擔。本 bot（純規則、無 LLM）六天零故障，是正確的載體。

## 現況（bot.js，單檔 337 行）

- `PLANE` 設定（apiBase／token／workspace `aeri`／project id）：`bot.js:18-23`
- `LABELS`（name → Plane label id → emoji 前綴）：`bot.js:28-40`
- 日期解析：`parseSingleDate`（`bot.js:62`，支援 今天/明天/後天/M/D/YYYY-MM-DD）、`parseDueInput`（`bot.js:101`，支援「A到B的每個禮拜X」週期）
- 建立 issue：`createPlaneIssue`（`bot.js:139`，POST + X-API-Key header）
- 對話狀態機：`sessions` Map（`bot.js:55`，userId → {step, name, dates, ...}）；`messageCreate` 處理流程在 `bot.js:227-302`，「取消／幫助」攔截在 `bot.js:236-242`
- label 選單用 StringSelectMenu，`interactionCreate` 處理在 `bot.js:304-331`（customId `plane_label`）
- `.env`：`DISCORD_TOKEN`、`PLANE_API_TOKEN`、`ALLOWED_USER_ID`（**目前是空的**）、`ALLOWED_CHANNEL_ID`

## 已驗證的 Plane API 行為（2026-07-29/30 實測）

- 列表：`GET {apiBase}/workspaces/aeri/projects/{project}/issues/?per_page=100&cursor=100:{page}:0`
  回應 `{ total_count, next_cursor, next_page_results, results[] }`；目前全庫 382 筆＝4 頁。`results[]` 內有 `id, name, target_date, created_at, labels`。
- 刪除：`DELETE .../issues/{id}/` 成功回 **204**。
- **地雷 1**：GET 已刪除的 issue 回 **403**（不是 404）——read-back 驗刪除時 403 視為「已刪除」。
- **地雷 2**：剛建立的 issue 立刻單筆 GET 可能回 `{"error": "Page not found."}`（索引延遲）——驗證剛建立的資料要用列表重抓，不要用單筆 GET。
- rate limit 60 req/min（`bot.js:25` 註解）；連續請求沿用現有 `sleep(400)` 模式。
- **未查證**：列表是否支援 `?target_date=...` 之類的伺服器端過濾。先實測；不支援就全量抓 4 頁＋本地過濾（已驗證可行，總量 ~476KB）。

## 需求規格

### A. 查詢指令

觸發：訊息符合 `^查\s+(.+)$`，**且該使用者沒有進行中的建立流程**（有 session 時不攔截，避免吃掉 desc 步驟的內容；使用者想中途查詢就先打「取消」）。攔截點放在 `bot.js:244`（取得 session 之後、`if (!session)` 之前不行——要放在取得 session 之前判斷「無 session 才攔截」，實作時注意順序）。

參數解析（依序嘗試）：
1. 範圍：`8/1到8/7`、`8/1~8/7` → 兩端用 `parseSingleDate(x, true)`
2. 單日：`8/1`、`今天`、`明天` → `parseSingleDate`，查該一天
3. 都不是 → 當作**名稱關鍵字**，對全庫 `name.includes(關鍵字)` 過濾

輸出格式（依 target_date 升冪）：
```
📋 8/1 ~ 8/7 共 N 筆：
08/01 古  [1b59fc2f]
08/01 💡 剪頭髮  [49025e0f]
08/05 💡 上ewant查 物理第六週測驗 deadline  [0935d51d]
```
- id 顯示前 8 碼即可（供刪除時核對）。
- 0 筆就明說「這個範圍沒有事件」。
- Discord 單訊息上限 2000 字：超過就截斷並附「共 N 筆，僅顯示前 M 筆，請縮小範圍」。

### B. 刪除指令

觸發：`^刪\s+(.+)$`，同樣只在無進行中流程時攔截。

**安全規則（硬性，不可省略）**：
1. `.env` 的 `ALLOWED_USER_ID` 為空時，刪除指令一律拒絕並提示「請先在 .env 設定 ALLOWED_USER_ID」。（查詢與建立不受影響；順帶提醒使用者把自己的 Discord user id 填進去。）
2. 絕不批次刪除：一次指令只能刪一筆。
3. 刪除前必須顯示目標的**完整名稱＋日期＋完整 id**，經按鈕確認才執行。

流程：
1. 參數解析同查詢（日期／範圍／關鍵字），對全庫過濾出候選。
2. 候選 0 筆 → 回「找不到」；候選 2 筆以上 → 用 StringSelectMenu 讓使用者選一筆（選單 label 放 `MM/DD 名稱`，value 放完整 id；候選超過 25 筆＝Discord 選單上限，要求縮小範圍）。
3. 鎖定一筆後，顯示確認訊息＋兩顆按鈕（ButtonBuilder，需新增 import）：
   ```
   ⚠️ 確定要刪除這筆嗎？
   名稱：古
   Due date：2026-08-01
   id：1b59fc2f-3bd2-4d82-9c04-91d2e0bd05f9
   [🗑️ 確認刪除] [取消]
   ```
   customId 建議 `plane_del_ok:<完整id>` / `plane_del_no`（UUID 36 字元，customId 上限 100 字元，放得下）。
4. 待確認狀態存進一個 pendingDeletes Map（userId → {id, name, due, expiresAt}），**60 秒過期**；過期後按鈕回「已過期，請重新下指令」。確認按鈕的 userId 必須等於下指令的 userId。
5. 確認後：`DELETE` → 期待 204 → **read-back**：單筆 GET 期待 403（見地雷 1）→ 回報：
   ```
   ✅ 已刪除：古（2026-08-01）
   id：1b59fc2f-...（read-back 確認：已不存在）
   ```
6. DELETE 非 204 或 read-back 仍撈得到 → 回報失敗＋實際 HTTP 狀態碼，不得宣稱成功。

### C. 幫助文字

`HELP_TEXT`（`bot.js:44-52`）補上兩個新指令的用法與範例。

## 不准動的部分

- 既有建立流程（名稱→due→label→desc）的行為與措辭完全不變。
- `.env` 裡的 token 不碰、不搬移、不印進 log。
- `start-bot.cmd` / `start-bot-hidden.vbs` 不動（ASCII-only 有歷史原因，見全域 lessons）。

## 驗收條件（逐條實測，貼輸出）

1. 「查 8/1」列出當天全部事件（實測日 Plane 上 8/1 至少有的事件都要出現），含 id 前 8 碼。
2. 「查 8/1到8/7」範圍查詢正確；「查 ewant」關鍵字查詢回 3 筆 ewant 提醒。
3. `ALLOWED_USER_ID` 為空時「刪 xxx」被拒絕且有設定提示；填入後恢復可用。
4. 刪除流程完整走過一次：**先用 bot 建一筆測試 issue**（名稱如 `__刪除測試__`）→「刪 刪除測試」→ 確認畫面顯示完整名稱/日期/id → 按確認 → 回報含 204 與 read-back 結果 → 用「查」確認它消失。全程不碰任何真實事件。
5. 確認按鈕放置 60 秒後再按 → 回「已過期」。
6. 建立流程回歸測試：走一次完整建立（含週期日期一筆、label 選單、desc 跳過），行為與改動前一致；測完把測試 issue 刪掉。
7. bot 重啟後（node bot.js）正常登入，`bot.log` 無新增錯誤。

## 交接備註

- 實作模型建議 sonnet 即可；完成後派 fresh-context verifier 依上面 7 條驗收。
- 全量抓取的 4 頁請求之間加 `sleep(400)`，避免踩 60 req/min。
- 查詢/刪除的全量抓取每次即時抓，不做快取（382 筆 ~2 秒可接受，快取反而引入一致性問題）。
