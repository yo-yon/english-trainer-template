const test = require("node:test");
const assert = require("node:assert");
const P = require("../src/phrase.js");

test("保存：英語の表現を整え、ID・日付（日本時間）を付ける", () => {
  const r = P.cleanPhrase({ text: "  How is that   billed ", ja: "それはどう課金されますか？", scene: "ブースで質問する", sceneId: "booth", from: "review" }, Date.parse("2026-11-07T15:30:00Z"));
  assert.ifError(r.error);
  assert.equal(r.item.text, "How is that billed.");
  assert.match(r.item.id, /^p[a-z0-9]{4,20}$/);
  assert.equal(r.item.added, "2026-11-08");
  assert.equal(r.item.from, "review");
  assert.equal(P.cleanPhrase({ text: "Could you say that again?" }).item.text, "Could you say that again?", "記号で終わっていればそのまま");
  assert.equal(P.cleanPhrase({ text: "Thanks a lot!", from: "x" }).item.from, "review", "from は決まった値だけ");
});

test("保存：日本語・1語・長すぎる文は断る", () => {
  assert.equal(P.cleanPhrase(null).error, "body");
  assert.equal(P.cleanPhrase({ text: "ありがとう" }).error, "text");
  assert.equal(P.cleanPhrase({ text: "Thanks" }).error, "length");
  assert.equal(P.cleanPhrase({ text: Array(31).fill("word").join(" ") }).error, "length");
});

test("重複：大文字小文字・記号の違いは同じ表現とみなす", () => {
  const ex = [{ id: "p1", text: "How is that billed?" }];
  assert.equal(P.findDuplicate(ex, "how is that billed.").id, "p1");
  assert.equal(P.findDuplicate(ex, "How is it billed?"), null);
});

test("言い換えから保存したときは、直す前の言い方も残す", () => {
  const r = P.cleanPhrase({ text: "I have a question.", before: "I have question.", from: "correction" });
  assert.equal(r.item.before, "I have question.");
  assert.equal(P.cleanPhrase({ text: "Thanks a lot!" }).item.before, "");
});
