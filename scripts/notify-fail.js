// Sends a failure alert to the bot's Discord channel. Never fails the caller: errors go to stderr, exit 0.
// NOTIFY_DRY=1 prints the payload instead of calling fetch.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  try {
    const content = '\u26A0\uFE0F plane-discord-bot: ' + process.argv.slice(2).join(' ');
    const channelId = process.env.ALLOWED_CHANNEL_ID;
    if (process.env.NOTIFY_DRY === '1') {
      console.log('NOTIFY_DRY would post to channel ' + channelId + ': ' + content);
      return;
    }
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('DISCORD_TOKEN missing');
    if (!channelId) throw new Error('ALLOWED_CHANNEL_ID missing');
    const res = await fetch('https://discord.com/api/v10/channels/' + channelId + '/messages', {
      method: 'POST',
      headers: { 'authorization': 'Bot ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error('notify-fail: HTTP ' + res.status);
  } catch (e) {
    console.error('notify-fail: ' + e.message);
  }
})();
