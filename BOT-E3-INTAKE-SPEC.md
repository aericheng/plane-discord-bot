# E3 → Plane 候選期限確認卡（跨專案契約）

> 2026-09-17 建立。本檔是 `e3-course-watch`（每天 08:00 跑一次的巡檢腳本，產生候選）與
> `plane-discord-bot`（常駐 Discord bot，處理按鈕並寫入 Plane）之間的**唯一契約**。
> 兩邊改任何欄位都要同步改本檔。實作細節各自看各自的程式碼註解。

## 目標與安全邊界

- e3-course-watch 巡檢到「有截止日的新東西」（新作業、作業期限變更、公告內文推斷的日期）時，
  **不直接寫 Plane**，而是用 Plane助理 bot 的 token 在 Discord 貼一張「候選卡」（embed＋三顆按鈕）。
- 使用者按 ✅ 或 ✏️ 之後，才由 plane-discord-bot 走既有的決定性函式 `createPlaneIssue` 寫入。
  沒按就永遠不會進 Plane。AI 推斷的日期一律在卡片上標示，且與程式抓的日期用不同顏色區分。
- 卡片本身就是資料載體：plane-discord-bot 只從 `interaction.message.embeds[0]` 讀回欄位，
  不需要任何跨專案檔案、輪詢或 HTTP server；bot 重啟也不會遺失待確認的卡片。

## 為什麼要用 Plane助理的 token 貼卡

Discord 的按鈕互動只會送到「建立那則訊息的 application」。e3-course-watch 平常用的是
ClaudeLearningBot（另一個 application），若用它貼卡，Plane助理永遠收不到點擊事件。
因此 e3-course-watch 的 `.env` 多一個 `PLANE_BOT_DISCORD_TOKEN`（＝plane-discord-bot 的
`DISCORD_TOKEN`），只用來 POST 這種卡片，其餘日報照舊用 `DISCORD_TOKEN`。

## 卡片格式（e3-course-watch 產生，plane-discord-bot 解析）

REST：`POST https://discord.com/api/v10/channels/{PLANE_CARD_CHANNEL_ID}/messages`
（`PLANE_CARD_CHANNEL_ID` 預設等於 e3 的 `DISCORD_CHANNEL_ID`，即 `#e3-bot`，卡片緊跟在日報後面）。

```json
{
  "embeds": [{
    "title": "強化學習專論 LAB1 - 2048",
    "url": "https://e3p.nycu.edu.tw/mod/assign/view.php?id=235967",
    "description": "📌 E3 發現新作業，要加進 Plane 嗎？",
    "color": 5793266,
    "fields": [
      { "name": "截止",     "value": "2026-09-27（週日）23:59", "inline": true },
      { "name": "類型",     "value": "homework",              "inline": true },
      { "name": "課程",     "value": "強化學習專論",           "inline": true },
      { "name": "描述",     "value": "課程：強化學習專論（535517）\n截止：2026年 09月 27日(週日) 23:59\nE3：https://e3p.nycu.edu.tw/mod/assign/view.php?id=235967" },
      { "name": "日期來源", "value": "程式自 E3 作業頁抓取" }
    ],
    "footer": { "text": "e3-course-watch · e3:25866:235967:2026-09-27" }
  }],
  "components": [{ "type": 1, "components": [
    { "type": 2, "style": 3, "label": "加入 Plane",   "emoji": { "name": "✅" }, "custom_id": "plane_e3_ok" },
    { "type": 2, "style": 1, "label": "修改後加入",   "emoji": { "name": "✏️" }, "custom_id": "plane_e3_edit" },
    { "type": 2, "style": 2, "label": "略過",         "emoji": { "name": "❌" }, "custom_id": "plane_e3_skip" }
  ]}]
}
```

欄位規則（解析端只依賴這些，不依賴顏色或描述文字）：

| 位置 | 意義 | 規則 |
|------|------|------|
| `embeds[0].title` | 建到 Plane 的 issue 名稱（**不含** emoji 前綴；emoji 由 label 決定，建立時套） | 命名慣例 `${課程名稱} ${作業名稱}`，對齊使用者既有手動建立的 `📚 強化學習專論 Lab 0`。≤ 256 字 |
| `embeds[0].url` | 來源頁（E3 作業頁／公告） | 可省略 |
| `fields[name="截止"]` | 截止日 | **前 10 字必為 `YYYY-MM-DD`**（台北日期），後面可接 `（週X）HH:mm` 純顯示用（實作輸出 `（週日）` 這種寫法）。日期無法解析時 value 以 `❓` 開頭（例 `❓ 無法解析：11/5 前`），✅ 會被拒絕、只能走 ✏️ |
| `fields[name="類型"]` | Plane label 名稱 | 必須是 plane-discord-bot `LABELS` 的 `name`（test／homework／presentation／remind／competition／work／class／lab／lesson／assistant／不加label）；解析端對不上就退回 `remind` |
| `fields[name="課程"]` | 顯示用 | 不進 Plane 欄位 |
| `fields[name="描述"]` | Plane `description_html` 的純文字來源 | 可省略；≤ 1024 字（Discord 上限） |
| `fields[name="日期來源"]` | 顯示用 | `程式自 E3 作業頁抓取` 或 `⚠️ AI 從公告內文推斷，請核對` |
| `footer.text` | 候選 id（e3 端去重用） | `e3-course-watch · <candidateId>`；解析端不使用 |

顏色：程式抓取 `0x5865F2`（藍）、期限變更 `0xE67E22`（橘）、AI 推斷 `0xFEE75C`（黃）。
完成後由 bot 改色：已加入／已更新 `0x57F287`（綠）、略過 `0x99AAB5`（灰）。

三種 `description` 開頭：`📌 E3 發現新作業`／`📌 E3 作業期限變更：<舊> → <新>`／`📌 AI 在公告內文看到日期`。

## 候選來源（e3-course-watch 端）

| 來源 | 條件 | 類型 | candidateId |
|------|------|------|-------------|
| `diff.newAssignments` | 有 `detail.dueDateIso`（或 `dueText` 可用 `parseTaipeiChineseDateTime` 解析） | `homework` | `e3:<courseId>:<cmid>:<YYYY-MM-DD>` |
| `diff.changedAssignments` | `before` 與 `after` 的 `detail.dueDateText ?? dueText` 不同且新值可解析 | `homework` | 同上（日期不同 → id 不同 → 會再貼一張） |
| courseAgent 回的 item | `type ∈ {announcement, announcementUpdate, action}`、`due != null`、`url` 不在 `dueLookup`（＝不是程式抓的作業） | 標題含 考／exam／quiz／期中／期末 → `test`；否則 `remind` | `e3:<courseId>:llm:<sha1(url|title|due) 前 12 碼>` |

- 沒有截止日的作業／公告不產生候選。
- 去重：`data/plane-posted.json`（`{ [candidateId]: { postedAt, messageId } }`）。已貼過的 id 不再貼；
  貼卡失敗（非 2xx）不記錄，下次再試。
- 只在**正式執行**（非 `--dry-run`、非 `--baseline`）且日報已成功發送後貼卡；dry-run 只把候選印到 console／log。
- 貼卡失敗不影響日報與快照落地，只記 log 與 notes。
- `.env` 沒有 `PLANE_BOT_DISCORD_TOKEN` → 功能停用，log 一行說明，其他流程照舊。

## 互動處理（plane-discord-bot 端）

- customId：`plane_e3_ok`／`plane_e3_edit`／`plane_e3_skip`（按鈕）、`plane_e3_modal`（modal submit）。
- 權限：`ALLOWED_USER_ID` 照舊檢查；**不**套 `ALLOWED_CHANNEL_ID`（卡片在 `#e3-bot`，不在 `#plane`）。
- ✅ `plane_e3_ok`：`deferUpdate()` → 解析卡片 → 截止日不是 `YYYY-MM-DD` 就 `followUp` ephemeral 要求走 ✏️ →
  `fetchAllIssues()` 找同名（去掉 emoji 前綴、trim、全形半形空白合併後比對，不分大小寫）：
  - 沒有 → `createPlaneIssue({ name: emoji+title, due, label, desc })` → 卡片改綠、`components: []`、
    加欄位 `狀態：✅ 已加入 Plane：<name>（<due>）` 並附 issue 連結。
  - 有且 `target_date` 相同 → 不建立，`狀態：ℹ️ Plane 已有「<name>」（<due>），未重複建立`。
  - 有且 `target_date` 不同 → `PATCH …/issues/<id>/ { target_date }`（期待 200）→
    `狀態：🔁 已更新「<name>」期限：<舊> → <新>`。
  - 同名多筆 → 不自動處理，`狀態：⚠️ Plane 有 N 筆同名事件，請手動處理` 並保留按鈕。
- ✏️ `plane_e3_edit`：`showModal`（customId `plane_e3_modal`）四個 TextInput 預填：`名稱`（必填）、
  `截止日`（`YYYY-MM-DD`，必填，允許 `M/D`／`今天`／`明天` 等 `parseSingleDate` 認得的格式）、
  `類型`（label 名稱，選填，預設 remind）、`描述`（paragraph，選填）。submit 後 `deferUpdate()`，
  走與 ✅ 相同的建立／更新／去重流程，並把卡片欄位改成使用者修改後的值。
- ❌ `plane_e3_skip`：`deferUpdate()` → 卡片改灰、`components: []`、`狀態：❌ 已略過`。
- 任何 Plane API 失敗：卡片**不動**（按鈕保留，可重按），`followUp` ephemeral 顯示錯誤。
- 所有結果宣稱只憑 API 回應（POST／PATCH 的 body 與 status），不憑送出值。

## 驗證方式

- e3 端純資料回歸：`node scripts/selftest-plane.mjs`（不打網路）。
- bot 端純邏輯回歸：`node selftest-e3-intake.js`（不連 Discord、不打 Plane）。
- 端到端：`node scripts/post-plane-test-card.mjs`（e3 端）貼一張名稱含「【測試】」的卡到 `#e3-bot`，
  使用者實際按三顆按鈕各一次（要三張卡），用 Plane API 列表 read-back 驗證，最後刪除測試 issue
  （依本目錄 `CLAUDE.md` 的刪除規範：列出→確認→DELETE 204→GET 403）。
