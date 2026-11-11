// フレーズ帳（Phase 2b）：会話の振り返りや場面の「使えるフレーズ」から保存した英語の表現。
// Table のパーティション phrase に保存し、画面ではシャドーイングの文として出題する。
const MAX_PHRASES = 500;
const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const hasJa = (s) => /[぀-ヿ一-鿿]/.test(s);
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const FROM = ["review", "correction", "scene", "hint"];

/** 保存のリクエストを検査し、保存する形にする。不正なら { error } */
function cleanPhrase(b, now = Date.now()) {
  if (!b || typeof b !== "object") return { error: "body" };
  const text = clip(b.text, 200);
  if (!text || hasJa(text) || !/[a-z]/i.test(text)) return { error: "text" };
  const n = text.split(/\s+/).length;
  if (n < 2 || n > 30) return { error: "length" };
  const ja = clip(b.ja, 200);
  return {
    item: {
      id: "p" + now.toString(36) + Math.random().toString(36).slice(2, 5),
      text: /[.?!]$/.test(text) ? text : text + ".",
      ja,
      before: clip(b.before, 200), // 言い換えから保存したとき、直す前の自分の言い方（思い出す練習の手がかり）
      scene: clip(b.scene, 40) || "フレーズ帳",
      sceneId: clip(b.sceneId, 40),
      from: FROM.includes(b.from) ? b.from : "review",
      added: new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10), // 日本時間の日付
    },
  };
}

/** すでに同じ表現があればそれを返す */
function findDuplicate(existing, text) {
  const k = norm(text);
  return existing.find((p) => norm(p.text) === k) || null;
}

module.exports = { cleanPhrase, findDuplicate, MAX_PHRASES, norm };
