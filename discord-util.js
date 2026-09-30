// Discord 工具：訊息 2000 字切段、log 遮蔽 webhook/interaction token。
const util = require('util');

const DISCORD_LIMIT = 2000;
const FENCE = '```';
const INSTALLED = Symbol.for('plane-discord-bot.splitInstalled');
const LOG_INSTALLED = Symbol.for('plane-discord-bot.logRedactionInstalled');

function fenceOpenAfter(text, openBefore) {
  const n = (text.match(/```/g) || []).length;
  return n % 2 === 1 ? !openBefore : openBefore;
}

function splitMessage(text, limit = DISCORD_LIMIT) {
  text = String(text == null ? '' : text);
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  let open = false;
  while (rest.length > 0) {
    const prefix = open ? FENCE + '\n' : '';
    if (prefix.length + rest.length <= limit) {
      parts.push(prefix + rest);
      break;
    }
    const budget = limit - prefix.length - (FENCE.length + 1); // 預留 "\n```"
    const window = rest.slice(0, budget);
    let cut = window.lastIndexOf('\n');
    let skip = 1;
    if (cut <= 0) cut = window.lastIndexOf(' ');
    if (cut <= 0) { cut = budget; skip = 0; }
    const body = rest.slice(0, cut);
    rest = rest.slice(cut + skip);
    const stillOpen = fenceOpenAfter(body, open);
    parts.push(prefix + body + (stillOpen ? '\n' + FENCE : ''));
    open = stillOpen;
  }
  return parts;
}

function redactSecrets(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/(discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/)(\d+)\/[\w.-]+/g,
      (m, p, id) => `${p}${id.slice(0, 8)}…/***`)
    .replace(/(\/interactions\/)(\d+)\/[\w.-]+/g,
      (m, p, id) => `${p}${id.slice(0, 8)}…/***`);
}

function wrapMethod(proto, name, kind) {
  const orig = proto[name];
  if (typeof orig !== 'function' || orig[INSTALLED]) return;
  const wrapped = function (options, ...more) {
    let opts = options;
    if (typeof opts === 'string') opts = { content: opts };
    if (!opts || typeof opts !== 'object' || typeof opts.content !== 'string' || opts.content.length <= DISCORD_LIMIT) {
      return orig.call(this, options, ...more);
    }
    const parts = splitMessage(opts.content);
    const first = orig.call(this, { ...opts, content: parts[0] }, ...more);
    const sendRest = () => {
      let chain = Promise.resolve();
      for (const p of parts.slice(1)) {
        chain = chain.then(() => {
          if (kind === 'message') return this.channel.send({ content: p });
          const extra = {};
          if (opts.ephemeral !== undefined) extra.ephemeral = opts.ephemeral;
          if (opts.flags !== undefined) extra.flags = opts.flags;
          return this.followUp({ content: p, ...extra });
        });
      }
      return chain;
    };
    return Promise.resolve(first).then((res) => sendRest().then(() => res));
  };
  wrapped[INSTALLED] = true;
  proto[name] = wrapped;
}

function installSplitting(discordjs) {
  const d = discordjs || require('discord.js');
  const msgNames = ['reply', 'edit'];
  const ixNames = ['reply', 'editReply', 'update', 'followUp'];
  if (d.Message && d.Message.prototype) {
    for (const n of msgNames) {
      if (Object.getOwnPropertyNames(d.Message.prototype).includes(n)) wrapMethod(d.Message.prototype, n, 'message');
    }
  }
  const ixClasses = ['BaseInteraction', 'CommandInteraction', 'ChatInputCommandInteraction',
    'MessageComponentInteraction', 'ButtonInteraction', 'StringSelectMenuInteraction',
    'ModalSubmitInteraction', 'ContextMenuCommandInteraction', 'AutocompleteInteraction'];
  for (const cn of ixClasses) {
    const C = d[cn];
    if (!C || !C.prototype) continue;
    const own = Object.getOwnPropertyNames(C.prototype);
    for (const n of ixNames) if (own.includes(n)) wrapMethod(C.prototype, n, 'interaction');
  }
}

function installLogRedaction() {
  if (console[LOG_INSTALLED]) return;
  const fix = (a) => {
    if (typeof a === 'string') return redactSecrets(a);
    if (a !== null && typeof a === 'object') {
      let str;
      try { str = util.inspect(a, { depth: 4 }); } catch (e) { return a; }
      if (str.includes('webhooks/') || str.includes('interactions/')) return redactSecrets(str);
    }
    return a;
  };
  for (const m of ['log', 'error', 'warn']) {
    const orig = console[m].bind(console);
    console[m] = (...args) => orig(...args.map(fix));
  }
  console[LOG_INSTALLED] = true;
}

module.exports = { splitMessage, redactSecrets, installSplitting, installLogRedaction, DISCORD_LIMIT };
