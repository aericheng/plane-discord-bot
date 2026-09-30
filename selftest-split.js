// splitMessage / redactSecrets / installSplitting 自測（純 node、不連網）
const { splitMessage, redactSecrets, installSplitting } = require('./discord-util');
let n = 0;
function ok(cond, name) {
  n++;
  if (!cond) { console.error('FAIL ' + name); process.exit(1); }
}
const fences = (s) => (s.match(/```/g) || []).length;
const allLE = (parts) => parts.every((p) => p.length <= 2000);

ok(JSON.stringify(splitMessage('')) === '[""]', 'empty');
let s = 'a'.repeat(1999);
ok(splitMessage(s).length === 1 && splitMessage(s)[0] === s, '<2000');
s = 'a'.repeat(2000);
ok(splitMessage(s).length === 1 && splitMessage(s)[0] === s, '==2000');
s = 'a'.repeat(2001);
let p = splitMessage(s);
ok(p.length === 2 && allLE(p) && p.join('') === s, '2001 hard cut');

// 多行：切點在換行
const lines = Array.from({ length: 300 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(20));
s = lines.join('\n');
p = splitMessage(s);
ok(p.length > 1 && allLE(p), 'multiline <=2000');
ok(p.join('\n') === s, 'multiline rejoin by newline');
ok(p.every((x) => /x$/.test(x)), 'multiline cut at newline');

// 程式碼區塊被切開
const code = Array.from({ length: 200 }, (_, i) => 'const v' + i + ' = ' + i + ';').join('\n');
s = 'intro\n```js\n' + code + '\n```\noutro';
p = splitMessage(s);
ok(p.length > 1 && allLE(p), 'code <=2000');
ok(p.every((x) => fences(x) % 2 === 0), 'code fences even');
ok(p[0].endsWith('\n```'), 'code first ends with fence');
ok(p[1].startsWith('```\n'), 'code second starts with fence');
ok(p[p.length - 1].endsWith('outro'), 'code tail kept');

// 無換行無空白超長
s = 'z'.repeat(7000);
p = splitMessage(s);
ok(allLE(p) && p.join('') === s && p.length === 4, 'hard cut 7000');

// 空白切
s = ('word ').repeat(1000);
p = splitMessage(s);
ok(allLE(p) && p.length >= 3, 'space cut');

// redact
const wh = 'https://discord.com/api/v10/webhooks/123456789012345678/abcDEF_ghi-JKL123';
let r = redactSecrets('POST ' + wh + ' failed');
ok(!r.includes('abcDEF_ghi-JKL123') && r.includes('discord.com') && r.includes('12345678…/***') && !r.includes('123456789012'), 'webhook redact');
const ix = 'https://discord.com/api/v10/interactions/987654321098765432/tok.en_ABC-def123/callback';
r = redactSecrets(ix);
ok(!r.includes('tok.en_ABC-def123') && r.includes('discord.com') && r.includes('98765432…/***') && r.endsWith('/callback') === false || !r.includes('tok.en'), 'interaction redact');
ok(redactSecrets('https://discordapp.com/webhooks/1/x') === 'https://discordapp.com/webhooks/1/x', 'no api path untouched');
ok(redactSecrets(42) === 42, 'non-string');

// installSplitting 假 prototype
async function run() {
  const calls = [];
  class Message {
    reply(o) { calls.push(['reply', o]); return Promise.resolve('R'); }
    edit(o) { calls.push(['edit', o]); return Promise.resolve('E'); }
  }
  Message.prototype.channel = { send: (o) => { calls.push(['send', o]); return Promise.resolve(); } };
  class CommandInteraction {
    reply(o) { calls.push(['ireply', o]); return Promise.resolve('IR'); }
    editReply(o) { calls.push(['editReply', o]); return Promise.resolve('ER'); }
    followUp(o) { calls.push(['followUp', o]); return Promise.resolve(); }
  }
  class MessageComponentInteraction {
    update(o) { calls.push(['update', o]); return Promise.resolve('U'); }
    followUp(o) { calls.push(['followUp', o]); return Promise.resolve(); }
  }
  const fake = { Message, CommandInteraction, MessageComponentInteraction };
  installSplitting(fake);
  installSplitting(fake); // 重複安裝不重複包
  const big = 'y'.repeat(4500);

  const m = new Message();
  let res = await m.reply(big);
  ok(res === 'R', 'reply returns first result');
  ok(calls.filter((c) => c[0] === 'reply').length === 1, 'reply orig once');
  ok(calls.filter((c) => c[0] === 'send').length === 2, 'reply rest via send x2');
  ok(calls[0][1].content.length <= 2000, 'first part <=2000');

  calls.length = 0;
  await m.reply('short');
  ok(calls.length === 1 && calls[0][1] === 'short', 'short passthrough unchanged');

  calls.length = 0;
  res = await new Message().edit({ content: big, components: ['c'] });
  ok(res === 'E' && calls[0][1].components[0] === 'c' && calls.filter((c) => c[0] === 'send').length === 2, 'edit keeps options');

  calls.length = 0;
  res = await new CommandInteraction().reply({ content: big, ephemeral: true });
  ok(res === 'IR' && calls.filter((c) => c[0] === 'ireply').length === 1, 'interaction reply orig once');
  const fu = calls.filter((c) => c[0] === 'followUp');
  ok(fu.length === 2 && fu.every((c) => c[1].ephemeral === true && c[1].content.length <= 2000), 'followUp ephemeral kept');

  calls.length = 0;
  await new MessageComponentInteraction().update({ content: big });
  ok(calls.filter((c) => c[0] === 'update').length === 1 && calls.filter((c) => c[0] === 'followUp').length === 2, 'update + followUp');

  console.log('ALL PASS ' + n);
}
run().catch((e) => { console.error(e); process.exit(1); });
