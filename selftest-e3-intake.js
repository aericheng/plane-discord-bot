// selftest-e3-intake.js
// E3 候選卡（BOT-E3-INTAKE-SPEC.md）bot 端純邏輯回歸：不連 Discord、不打 Plane。
// require('./bot.js') 只為拿 parseSingleDate／fmt／LABELS（bot.js 被 require 時不登入）。
// 用法：node selftest-e3-intake.js；任何 FAIL 會讓 process.exitCode = 1。

const assert = require('node:assert/strict');
const { parseSingleDate, fmt, LABELS } = require('./bot.js');
const e3 = require('./e3-intake');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL ${name}\n     ${err.message.split('\n').join('\n     ')}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL ${name}\n     ${err.message.split('\n').join('\n     ')}`);
  }
}

// 契約範例卡（plain object）
const SPEC_EMBED = {
  title: '強化學習專論 LAB1 - 2048',
  url: 'https://e3p.nycu.edu.tw/mod/assign/view.php?id=235967',
  description: '📌 E3 發現新作業，要加進 Plane 嗎？',
  color: 5793266,
  fields: [
    { name: '截止', value: '2026-09-27（日）23:59', inline: true },
    { name: '類型', value: 'homework', inline: true },
    { name: '課程', value: '強化學習專論', inline: true },
    { name: '描述', value: '課程：強化學習專論（1151.535517）\n截止：2026年 09月 27日(週日) 23:59\nE3：https://e3p.nycu.edu.tw/mod/assign/view.php?id=235967' },
    { name: '日期來源', value: '程式自 E3 作業頁抓取' },
  ],
  footer: { text: 'e3-course-watch · e3:25866:235967:2026-09-27' },
};
const withField = (embed, name, value) => ({
  ...embed,
  fields: embed.fields.map((f) => (f.name === name ? { ...f, value } : f)),
});

// ===== (a) 契約範例解析 =====
test('(a) parseCardEmbed 契約範例', () => {
  const p = e3.parseCardEmbed(SPEC_EMBED, LABELS);
  assert.equal(p.name, '強化學習專論 LAB1 - 2048');
  assert.equal(p.dueDate, '2026-09-27');
  assert.equal(p.dueRaw, '2026-09-27（日）23:59');
  assert.equal(p.labelName, 'homework');
  assert.match(p.desc, /^課程：強化學習專論（1151\.535517）\n截止：/);
  assert.equal(p.url, 'https://e3p.nycu.edu.tw/mod/assign/view.php?id=235967');
  assert.equal(p.candidateId, 'e3:25866:235967:2026-09-27');
});

test('(a2) parseCardEmbed 吃 discord.js Embed 實例', () => {
  const { Embed } = require('discord.js');
  const p = e3.parseCardEmbed(new Embed(SPEC_EMBED), LABELS);
  assert.equal(p.name, '強化學習專論 LAB1 - 2048');
  assert.equal(p.dueDate, '2026-09-27');
  assert.equal(p.labelName, 'homework');
  assert.equal(p.candidateId, 'e3:25866:235967:2026-09-27');
});

// ===== (b) ❓ 開頭 → dueDate null =====
test('(b) 截止以 ❓ 開頭 → dueDate null、dueRaw 保留', () => {
  const p = e3.parseCardEmbed(withField(SPEC_EMBED, '截止', '❓ 無法解析：11/5 前'), LABELS);
  assert.equal(p.dueDate, null);
  assert.equal(p.dueRaw, '❓ 無法解析：11/5 前');
});

test('(b2) 截止格式對但不是真日期 → null；缺欄位 → null', () => {
  assert.equal(e3.parseCardEmbed(withField(SPEC_EMBED, '截止', '2026-13-45'), LABELS).dueDate, null);
  assert.equal(e3.parseCardEmbed({ title: 'x', fields: [] }, LABELS).dueDate, null);
  assert.equal(e3.parseCardEmbed({ title: 'x' }, LABELS).candidateId, null);
});

// ===== (c) 類型對不上 → remind =====
test('(c) 類型 abc → remind', () => {
  assert.equal(e3.parseCardEmbed(withField(SPEC_EMBED, '類型', 'abc'), LABELS).labelName, 'remind');
  assert.equal(e3.parseCardEmbed(withField(SPEC_EMBED, '類型', '不加label'), LABELS).labelName, '不加label');
  assert.equal(e3.parseCardEmbed(withField(SPEC_EMBED, '類型', ' Test '), LABELS).labelName, 'test');
});

// ===== (d) normalizeName =====
test('(d) normalizeName 去 emoji 前綴、合併空白、不分大小寫', () => {
  assert.equal(e3.normalizeName('📚 強化學習專論 LAB1 - 2048'), e3.normalizeName('強化學習專論  LAB1 - 2048'));
  assert.equal(e3.normalizeName('🗣️ 期末報告　Final'), '期末報告 final');
  assert.equal(e3.normalizeName('   '), '');
  assert.equal(e3.normalizeName(null), '');
  assert.notEqual(e3.normalizeName('📚 強化學習專論 LAB1'), e3.normalizeName('📚 強化學習專論 LAB2'));
});

// ===== (e) decideAction 四種結果 =====
test('(e) decideAction create / skipDuplicate / update / ambiguous', () => {
  const name = '📚 強化學習專論 LAB1 - 2048';
  const dueDate = '2026-09-27';
  const other = { id: 'z', name: '📚 別的作業', target_date: '2026-09-27' };

  let r = e3.decideAction({ name, dueDate, existingIssues: [other] });
  assert.equal(r.action, 'create');
  assert.equal(r.matches.length, 0);

  r = e3.decideAction({ name, dueDate, existingIssues: [other, { id: 'a', name: '📚 強化學習專論  LAB1 - 2048', target_date: '2026-09-27' }] });
  assert.equal(r.action, 'skipDuplicate');
  assert.equal(r.matches[0].id, 'a');

  r = e3.decideAction({ name, dueDate, existingIssues: [{ id: 'b', name: '強化學習專論 lab1 - 2048', target_date: '2026-09-20' }] });
  assert.equal(r.action, 'update');
  assert.equal(r.matches[0].id, 'b');

  r = e3.decideAction({
    name,
    dueDate,
    existingIssues: [
      { id: 'c', name: '📚 強化學習專論 LAB1 - 2048', target_date: '2026-09-27' },
      { id: 'd', name: '強化學習專論 LAB1 - 2048', target_date: '2026-09-28' },
    ],
  });
  assert.equal(r.action, 'ambiguous');
  assert.equal(r.matches.length, 2);

  r = e3.decideAction({ name, dueDate, existingIssues: [] });
  assert.equal(r.action, 'create');
});

// ===== (f) validateModalInput =====
const deps = { parseSingleDate, fmt, LABELS };
test('(f) validateModalInput 空名稱 → error', () => {
  const r = e3.validateModalInput({ name: '  ', dueInput: '2026-10-01', labelInput: '', desc: '' }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /名稱/);
});
test('(f) validateModalInput 2026-10-01 過', () => {
  const r = e3.validateModalInput({ name: 'X', dueInput: '2026-10-01', labelInput: '', desc: '' }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.value.dueDate, '2026-10-01');
});
test('(f) validateModalInput 10/1 過（bumpPast：不早於今天）', () => {
  const r = e3.validateModalInput({ name: 'X', dueInput: '10/1', labelInput: '', desc: '' }, deps);
  assert.equal(r.ok, true);
  assert.match(r.value.dueDate, /^\d{4}-10-01$/);
  assert.ok(r.value.dueDate >= fmt(new Date()), `${r.value.dueDate} 不該早於今天`);
});
test('(f) validateModalInput abc 日期 → error', () => {
  const r = e3.validateModalInput({ name: 'X', dueInput: 'abc', labelInput: '', desc: '' }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /截止日/);
});
test('(f) validateModalInput label homework 過、xyz error、空 → remind', () => {
  let r = e3.validateModalInput({ name: 'X', dueInput: '2026-10-01', labelInput: 'homework', desc: 'd' }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.value.label.name, 'homework');
  assert.equal(r.value.label.emoji, '📚');
  assert.equal(r.value.desc, 'd');

  r = e3.validateModalInput({ name: 'X', dueInput: '2026-10-01', labelInput: 'xyz', desc: '' }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /xyz/);
  assert.match(r.error, /homework/);

  r = e3.validateModalInput({ name: 'X', dueInput: '2026-10-01', labelInput: '', desc: '' }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.value.label.name, 'remind');
  assert.equal(r.value.desc, '');
});

// ===== (g) buildEditModal =====
test('(g) buildEditModal 四個 text input、customId 正確、預填', () => {
  const parsed = e3.parseCardEmbed(SPEC_EMBED, LABELS);
  const json = e3.buildEditModal(parsed).toJSON();
  assert.equal(json.custom_id, 'plane_e3_modal');
  const inputs = json.components.flatMap((row) => row.components);
  assert.equal(inputs.length, 4);
  assert.deepEqual(inputs.map((i) => i.custom_id), ['name', 'due', 'label', 'desc']);
  assert.equal(inputs[0].value, '強化學習專論 LAB1 - 2048');
  assert.equal(inputs[0].required, true);
  assert.equal(inputs[1].value, '2026-09-27');
  assert.equal(inputs[1].required, true);
  assert.equal(inputs[2].value, 'homework');
  assert.equal(inputs[3].style, 2, 'desc 應為 Paragraph');
  assert.ok(inputs.every((i) => i.label.length <= 45));
  assert.ok(inputs.every((i) => i.value === undefined || i.value.length <= 4000));
});
test('(g2) buildEditModal 截止無法解析時 due 不預填、超長描述截到 4000', () => {
  const parsed = e3.parseCardEmbed(withField(withField(SPEC_EMBED, '截止', '❓ 無法解析：11/5 前'), '描述', 'x'.repeat(5000)), LABELS);
  const inputs = e3.buildEditModal(parsed).toJSON().components.flatMap((row) => row.components);
  assert.equal(inputs[1].value, undefined);
  assert.match(inputs[1].placeholder, /11\/5/);
  assert.equal(inputs[3].value.length, 4000);
});

// ===== (h) buildResultEmbed =====
test('(h) buildResultEmbed 加狀態欄位、改色、重複呼叫不重複加', () => {
  const once = e3.buildResultEmbed(SPEC_EMBED, { status: '✅ 已加入', color: e3.COLOR_DONE }).toJSON();
  assert.equal(once.color, 0x57f287);
  assert.notEqual(once.color, SPEC_EMBED.color);
  const statusFields = once.fields.filter((f) => f.name === '狀態');
  assert.equal(statusFields.length, 1);
  assert.equal(statusFields[0].value, '✅ 已加入');
  assert.equal(once.fields.length, SPEC_EMBED.fields.length + 1);
  assert.equal(once.title, SPEC_EMBED.title);
  assert.equal(once.footer.text, SPEC_EMBED.footer.text);

  const twice = e3.buildResultEmbed(once, { status: '❌ 已略過', color: e3.COLOR_SKIP }).toJSON();
  assert.equal(twice.fields.filter((f) => f.name === '狀態').length, 1);
  assert.equal(twice.fields.find((f) => f.name === '狀態').value, '❌ 已略過');
  assert.equal(twice.color, 0x99aab5);
});
test('(h2) buildResultEmbed 帶修改值時同步替換 title／截止／類型／描述', () => {
  const j = e3.buildResultEmbed(SPEC_EMBED, {
    status: 's', color: 1, name: '新名字', dueDate: '2026-10-02', labelName: 'test', desc: '新描述',
  }).toJSON();
  assert.equal(j.title, '新名字');
  assert.equal(j.fields.find((f) => f.name === '截止').value, '2026-10-02');
  assert.equal(j.fields.find((f) => f.name === '類型').value, 'test');
  assert.equal(j.fields.find((f) => f.name === '描述').value, '新描述');
  assert.equal(j.fields.find((f) => f.name === '課程').value, '強化學習專論');
  // 改完再解析要得到修改後的值（卡片是資料載體）
  const p = e3.parseCardEmbed(j, LABELS);
  assert.equal(p.name, '新名字');
  assert.equal(p.dueDate, '2026-10-02');
  assert.equal(p.labelName, 'test');
  assert.equal(p.desc, '新描述');

  const noDesc = e3.buildResultEmbed(SPEC_EMBED, { status: 's', desc: '' }).toJSON();
  assert.equal(noDesc.fields.find((f) => f.name === '描述'), undefined);
  assert.equal(e3.parseCardEmbed(noDesc, LABELS).desc, '');
  assert.equal(noDesc.color, SPEC_EMBED.color, '沒傳 color 時顏色不變');
});

// ===== (i) isE3Interaction =====
test('(i) isE3Interaction 假 interaction 判斷', () => {
  const btn = (id) => ({ isButton: () => true, isModalSubmit: () => false, customId: id });
  const modal = (id) => ({ isButton: () => false, isModalSubmit: () => true, customId: id });
  const select = (id) => ({ isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => true, customId: id });
  assert.equal(e3.isE3Interaction(btn('plane_e3_ok')), true);
  assert.equal(e3.isE3Interaction(btn('plane_e3_edit')), true);
  assert.equal(e3.isE3Interaction(btn('plane_e3_skip')), true);
  assert.equal(e3.isE3Interaction(modal('plane_e3_modal')), true);
  assert.equal(e3.isE3Interaction(btn('plane_e3_modal')), false, '按鈕不該吃 modal id');
  assert.equal(e3.isE3Interaction(modal('plane_e3_ok')), false, 'modal 不該吃按鈕 id');
  assert.equal(e3.isE3Interaction(btn('plane_ai_ok:123')), false);
  assert.equal(e3.isE3Interaction(btn('plane_del_no')), false);
  assert.equal(e3.isE3Interaction(select('plane_label')), false);
  assert.equal(e3.isE3Interaction(null), false);
  assert.equal(e3.isE3Interaction({}), false);
});

// ===== (j) handleE3Interaction 以假 interaction＋假 deps 走完整流程（不連 Discord、不打 Plane） =====
function fakeButton(customId, embed) {
  const calls = [];
  const message = { embeds: [embed], edit: async (payload) => { calls.push(['message.edit', payload]); } };
  return {
    calls,
    customId,
    message,
    isButton: () => true,
    isModalSubmit: () => false,
    deferUpdate: async () => { calls.push(['deferUpdate']); },
    showModal: async (m) => { calls.push(['showModal', m]); },
    reply: async (p) => { calls.push(['reply', p]); },
    followUp: async (p) => { calls.push(['followUp', p]); },
  };
}
function fakeModal(values, embed, fromMessage = true) {
  const calls = [];
  const message = { embeds: [embed], edit: async (payload) => { calls.push(['message.edit', payload]); } };
  return {
    calls,
    customId: 'plane_e3_modal',
    message,
    isButton: () => false,
    isModalSubmit: () => true,
    isFromMessage: () => fromMessage,
    fields: { getTextInputValue: (id) => values[id] ?? '' },
    deferUpdate: async () => { calls.push(['deferUpdate']); },
    reply: async (p) => { calls.push(['reply', p]); },
    followUp: async (p) => { calls.push(['followUp', p]); },
  };
}
function fakeDeps(existing, opts = {}) {
  const api = [];
  return {
    api,
    createPlaneIssue: async (payload) => {
      api.push(['create', payload]);
      if (opts.createFails) throw new Error('Plane API 500: boom');
      return { id: 'new-id', name: payload.name, target_date: payload.due };
    },
    updatePlaneIssue: async (id, patch) => {
      api.push(['update', id, patch]);
      return { id, name: existing.find((i) => i.id === id).name, target_date: patch.target_date };
    },
    fetchAllIssues: async () => {
      api.push(['fetch']);
      if (opts.fetchFails) throw new Error('Plane API 429: slow down');
      return existing;
    },
    LABELS,
    parseSingleDate,
    fmt,
    issueUrl: (id) => `https://app.plane.so/x/${id}`,
    log: () => {},
  };
}
const names = (calls) => calls.map((c) => c[0]);

(async () => {
  await testAsync('(j) ✅ 沒同名 → deferUpdate → create → 卡片改綠、拿掉按鈕、狀態取自 API 回應', async () => {
    const it = fakeButton('plane_e3_ok', SPEC_EMBED);
    const d = fakeDeps([]);
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(it.calls), ['deferUpdate', 'message.edit']);
    assert.deepEqual(names(d.api), ['fetch', 'create']);
    assert.equal(d.api[1][1].name, '📚 強化學習專論 LAB1 - 2048');
    assert.equal(d.api[1][1].due, '2026-09-27');
    assert.equal(d.api[1][1].label.name, 'homework');
    assert.match(d.api[1][1].desc, /^課程：強化學習專論/);
    const payload = it.calls[1][1];
    assert.deepEqual(payload.components, []);
    const j = payload.embeds[0].toJSON();
    assert.equal(j.color, e3.COLOR_DONE);
    assert.match(j.fields.find((f) => f.name === '狀態').value, /^✅ 已加入 Plane：📚 強化學習專論 LAB1 - 2048（2026-09-27）\n.*new-id/);
  });

  await testAsync('(j) ✅ 同名同日 → 不建立、狀態 ℹ️、拿掉按鈕', async () => {
    const it = fakeButton('plane_e3_ok', SPEC_EMBED);
    const d = fakeDeps([{ id: 'dup', name: '📚 強化學習專論 LAB1 - 2048', target_date: '2026-09-27' }]);
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(d.api), ['fetch']);
    assert.deepEqual(names(it.calls), ['deferUpdate', 'message.edit']);
    const j = it.calls[1][1].embeds[0].toJSON();
    assert.match(j.fields.find((f) => f.name === '狀態').value, /^ℹ️ Plane 已有「📚 強化學習專論 LAB1 - 2048」（2026-09-27），未重複建立/);
    assert.deepEqual(it.calls[1][1].components, []);
  });

  await testAsync('(j) ✅ 同名異日 → PATCH target_date、狀態 🔁 舊 → 新', async () => {
    const it = fakeButton('plane_e3_ok', SPEC_EMBED);
    const d = fakeDeps([{ id: 'old', name: '強化學習專論 lab1 - 2048', target_date: '2026-09-20' }]);
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(d.api), ['fetch', 'update']);
    assert.equal(d.api[1][1], 'old');
    assert.deepEqual(d.api[1][2], { target_date: '2026-09-27' });
    const j = it.calls[1][1].embeds[0].toJSON();
    assert.match(j.fields.find((f) => f.name === '狀態').value, /^🔁 已更新「強化學習專論 lab1 - 2048」期限：2026-09-20 → 2026-09-27/);
    assert.deepEqual(it.calls[1][1].components, []);
  });

  await testAsync('(j) ✅ 同名多筆 → 不建不改、按鈕保留、狀態 ⚠️、followUp ephemeral', async () => {
    const it = fakeButton('plane_e3_ok', SPEC_EMBED);
    const d = fakeDeps([
      { id: 'a', name: '📚 強化學習專論 LAB1 - 2048', target_date: '2026-09-27' },
      { id: 'b', name: '強化學習專論 LAB1 - 2048', target_date: '2026-09-28' },
    ]);
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(d.api), ['fetch']);
    assert.deepEqual(names(it.calls), ['deferUpdate', 'message.edit', 'followUp']);
    const payload = it.calls[1][1];
    assert.equal('components' in payload, false, '按鈕要保留（不傳 components）');
    const j = payload.embeds[0].toJSON();
    assert.equal(j.color, SPEC_EMBED.color, '顏色不變');
    assert.match(j.fields.find((f) => f.name === '狀態').value, /^⚠️ Plane 有 2 筆同名事件，請手動處理$/);
    assert.equal(it.calls[2][1].ephemeral, true);
  });

  await testAsync('(j) ✅ 截止無法解析 → 不打 API、followUp 要求走 ✏️', async () => {
    const it = fakeButton('plane_e3_ok', withField(SPEC_EMBED, '截止', '❓ 無法解析：11/5 前'));
    const d = fakeDeps([]);
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(d.api), []);
    assert.deepEqual(names(it.calls), ['deferUpdate', 'followUp']);
    assert.match(it.calls[1][1].content, /✏️/);
    assert.equal(it.calls[1][1].ephemeral, true);
  });

  await testAsync('(j) ✅ Plane 建立失敗 → 卡片不動、followUp 錯誤', async () => {
    const it = fakeButton('plane_e3_ok', SPEC_EMBED);
    const d = fakeDeps([], { createFails: true });
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(it.calls), ['deferUpdate', 'followUp']);
    assert.match(it.calls[1][1].content, /Plane API 500/);
    assert.equal(it.calls[1][1].ephemeral, true);
  });

  await testAsync('(j) ✅ fetchAllIssues 失敗 → 卡片不動、followUp 錯誤', async () => {
    const it = fakeButton('plane_e3_ok', SPEC_EMBED);
    const d = fakeDeps([], { fetchFails: true });
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(it.calls), ['deferUpdate', 'followUp']);
    assert.match(it.calls[1][1].content, /Plane API 429/);
  });

  await testAsync('(j) ❌ 略過 → 不打 API、卡片改灰、拿掉按鈕', async () => {
    const it = fakeButton('plane_e3_skip', SPEC_EMBED);
    const d = fakeDeps([]);
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(d.api), []);
    assert.deepEqual(names(it.calls), ['deferUpdate', 'message.edit']);
    const j = it.calls[1][1].embeds[0].toJSON();
    assert.equal(j.color, e3.COLOR_SKIP);
    assert.equal(j.fields.find((f) => f.name === '狀態').value, '❌ 已略過');
    assert.deepEqual(it.calls[1][1].components, []);
  });

  await testAsync('(j) ✏️ → showModal 是第一個也是唯一的回應（不先 defer）', async () => {
    const it = fakeButton('plane_e3_edit', SPEC_EMBED);
    const d = fakeDeps([]);
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(it.calls), ['showModal']);
    assert.deepEqual(names(d.api), []);
    assert.equal(it.calls[0][1].toJSON().custom_id, 'plane_e3_modal');
  });

  await testAsync('(j) modal submit → deferUpdate → 用修改值建立、卡片欄位改成修改值', async () => {
    const it = fakeModal({ name: '強化學習專論 LAB1 改', due: '2026-10-05', label: 'test', desc: '' }, SPEC_EMBED);
    const d = fakeDeps([]);
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(it.calls), ['deferUpdate', 'message.edit']);
    assert.deepEqual(names(d.api), ['fetch', 'create']);
    assert.equal(d.api[1][1].name, '💯 強化學習專論 LAB1 改');
    assert.equal(d.api[1][1].due, '2026-10-05');
    assert.equal(d.api[1][1].desc, '');
    const j = it.calls[1][1].embeds[0].toJSON();
    assert.equal(j.title, '強化學習專論 LAB1 改');
    assert.equal(j.fields.find((f) => f.name === '截止').value, '2026-10-05');
    assert.equal(j.fields.find((f) => f.name === '類型').value, 'test');
    assert.equal(j.fields.find((f) => f.name === '描述'), undefined);
    assert.equal(j.color, e3.COLOR_DONE);
  });

  await testAsync('(j) modal submit 驗證失敗 → followUp 錯誤、不打 API', async () => {
    const it = fakeModal({ name: 'X', due: 'abc', label: '', desc: '' }, SPEC_EMBED);
    const d = fakeDeps([]);
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(it.calls), ['deferUpdate', 'followUp']);
    assert.deepEqual(names(d.api), []);
    assert.match(it.calls[1][1].content, /截止日/);
  });

  await testAsync('(j) modal submit 不是從訊息開的 → reply ephemeral、不 defer', async () => {
    const it = fakeModal({ name: 'X', due: '2026-10-05', label: '', desc: '' }, SPEC_EMBED, false);
    const d = fakeDeps([]);
    await e3.handleE3Interaction(it, d);
    assert.deepEqual(names(it.calls), ['reply']);
    assert.deepEqual(names(d.api), []);
  });

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
})();
