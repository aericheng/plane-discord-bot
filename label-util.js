'use strict';
// label 名稱解析（bot.js／e3-intake.js 共用）。
// remind 在 Plane 上只有一個 label id；「要出席」只影響名稱前綴 💡：
// LABELS 的 remind 列 emoji 為空、另帶 attendEmoji；選「要出席」時回傳 { ...remind, emoji: attendEmoji, attend: true }
// （同 id、name 仍是 'remind'，所以任何依 id／name 反查 LABELS 的地方都不受影響）。

const ATTEND_LABEL_NAME = 'remind（要出席）';

function normKey(s) {
  return String(s || '').trim().toLowerCase().replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '');
}
const ATTEND_KEY = normKey(ATTEND_LABEL_NAME);

function withAttend(label, attend) {
  if (attend === true && label && label.attendEmoji) return { ...label, emoji: label.attendEmoji, attend: true };
  return label;
}

// 依使用者輸入／選單 value 找 label；「remind（要出席）」→ 帶 💡 的 remind。找不到回 undefined。
function resolveLabel(LABELS, name) {
  const key = normKey(name);
  if (!key) return undefined;
  if (key === ATTEND_KEY) return withAttend(LABELS.find((l) => l.name === 'remind'), true);
  return LABELS.find((l) => l.name.toLowerCase() === key);
}

// 給 embed／文字顯示用的名稱：要出席的 remind 顯示 ATTEND_LABEL_NAME，其他用 label.name。
function labelDisplayName(label) {
  return label && label.attend ? ATTEND_LABEL_NAME : label && label.name;
}

module.exports = { ATTEND_LABEL_NAME, withAttend, resolveLabel, labelDisplayName };
