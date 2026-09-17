# plane-discord-bot

用 Discord 對話建立 [Plane](https://plane.so) 事件的個人 bot。搭配 Google Apps Script 每小時把 Plane issue 同步到 Google 日曆，讓手機（iPhone 的 Google 日曆 App）能以日曆形式看到 Plane 的任務。

## 對話流程

在指定頻道傳「事件名稱」後，bot 依序詢問：

1. **Due date** — 單日（`7/30`、`2026-07-30`、`今天`、`明天`）或週期（`9/1到12/20的每個禮拜三`，範圍內每個週三各建一筆，單次上限 40 筆）
2. **label** — 下拉選單或直接打字；特定 label 會在事件名稱加上前綴：💯 test、📚 homework、🗣️ presentation、💡 remind、🏆 competition
3. **description** — 直接輸入（可多行）或打 `跳過`；描述中的時間與地點（如 `地點：X 下午2點`）會在日曆同步時被自動解析成定時事件與地點欄位

中途打 `取消` 放棄、`幫助` 看用法。

## E3 連動（候選期限確認卡）

`e3-course-watch`（另一個專案，每天巡檢 NYCU E3 的腳本）發現有截止日的新作業或公告後，用**本 bot 的 token** 在 `#e3-bot` 貼一張「候選卡」（embed＋三顆按鈕）；本 bot 收到按鈕互動後，只從卡片的 embed 讀回欄位、去重、寫進 Plane。沒按按鈕就永遠不會進 Plane。卡片格式與互動規則以 [`BOT-E3-INTAKE-SPEC.md`](BOT-E3-INTAKE-SPEC.md) 為唯一契約，兩邊改欄位都要同步改它；bot 端實作在 `e3-intake.js`。

| 按鈕 | 行為 |
|------|------|
| ✅ 加入 Plane | 讀卡片的標題／截止／類型／描述，先抓 Plane 全部事件做同名比對，再建立或更新（見下）；截止日無法解析（`❓` 開頭）時會請你改走 ✏️ |
| ✏️ 修改後加入 | 跳出表單（名稱、截止日、類型、描述）預填卡片內容，送出後走與 ✅ 相同的流程，並把卡片欄位改成你修改後的值 |
| ❌ 略過 | 卡片改灰、拿掉按鈕，不動 Plane |

同名比對規則：去掉開頭 emoji、全形空白轉半形、連續空白合併、不分大小寫。

- 同名 0 筆 → 建立（名稱前綴 emoji 依 label 決定，與對話模式一致），卡片改綠並附 issue 連結
- 同名 1 筆、截止日相同 → 不重複建立，卡片標示「已有」
- 同名 1 筆、截止日不同 → `PATCH` 該 issue 的 `target_date`，卡片標示「舊 → 新」
- 同名 2 筆以上 → **不自動處理**，卡片加「請手動處理」並保留按鈕，等你在 Plane 清理後再按
- Plane API 失敗 → 卡片不動、按鈕保留，錯誤只用 ephemeral 訊息告訴你，可以再按一次

這些互動只檢查 `ALLOWED_USER_ID`，不套 `ALLOWED_CHANNEL_ID`（卡片在 `#e3-bot`，不在對話頻道）。純邏輯回歸：`node selftest-e3-intake.js`（不連 Discord、不打 Plane）。

## 安裝

```bash
npm install
cp .env.example .env   # 填入 token（見下）
node bot.js
```

`.env` 內容：

```
DISCORD_TOKEN=你的 Discord bot token
PLANE_API_TOKEN=你的 Plane personal access token
ALLOWED_USER_ID=（可選）只回應這個使用者
ALLOWED_CHANNEL_ID=（可選）只回應這個頻道
```

Windows 開機自動啟動：以工作排程器登入觸發執行 `start-bot-hidden.vbs`（隱藏視窗跑 `start-bot.cmd`，內含 crash 自動重啟迴圈）。

## 注意

- `bot.js` 內的 workspace slug、project id、label id 為個人環境值，換環境需自行更新
- `.env` 含機密，已列入 `.gitignore`，不要提交

## License

MIT — see [LICENSE](LICENSE).
