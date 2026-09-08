# plane-discord-bot

用 Discord 對話建立 [Plane](https://plane.so) 事件的個人 bot。搭配 Google Apps Script 每小時把 Plane issue 同步到 Google 日曆，讓手機（iPhone 的 Google 日曆 App）能以日曆形式看到 Plane 的任務。

## 對話流程

在指定頻道傳「事件名稱」後，bot 依序詢問：

1. **Due date** — 單日（`7/30`、`2026-07-30`、`今天`、`明天`）或週期（`9/1到12/20的每個禮拜三`，範圍內每個週三各建一筆，單次上限 40 筆）
2. **label** — 下拉選單或直接打字；特定 label 會在事件名稱加上前綴：💯 test、📚 homework、🗣️ presentation、💡 remind、🏆 competition
3. **description** — 直接輸入（可多行）或打 `跳過`；描述中的時間與地點（如 `地點：X 下午2點`）會在日曆同步時被自動解析成定時事件與地點欄位

中途打 `取消` 放棄、`幫助` 看用法。

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
