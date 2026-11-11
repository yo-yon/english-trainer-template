const test = require("node:test");
const assert = require("node:assert");
const R = require("../src/roleplay.js");

const scene = { id: "booth", title: "ブースで質問する", role: "a Microsoft product manager at a booth", setting: "the expo hall", goal: "Find out how agent licensing works.", opener: "Hi! Anything I can help with?" };
const H = (...lines) => lines.map((t, i) => ({ who: i % 2 ? "me" : "ai", text: t }));

test("turn：最後が学習者の発言なら、相手役のメッセージを作る", () => {
  const p = R.prepare({ action: "turn", scene, history: H("Hi! Anything I can help with?", "Yes, I have a question about licensing.") });
  assert.ifError(p.error);
  assert.equal(p.messages.length, 2);
  assert.match(p.messages[0].content, /a Microsoft product manager at a booth/);
  assert.match(p.messages[0].content, /Find out how agent licensing works/);
  assert.match(p.messages[1].content, /Learner: Yes, I have a question about licensing\./);
  assert.equal(p.maxTokens, 700); // 訳（reply_ja）の分を含む
});

test("入力の検査：場面・履歴・action", () => {
  assert.equal(R.prepare(null).error, "body");
  assert.equal(R.prepare({ action: "turn", scene: { id: "x" }, history: [] }).error, "scene");
  assert.equal(R.prepare({ action: "turn", scene, history: H("Hi!") }).error, "history", "最後が相手役ならエラー");
  assert.equal(R.prepare({ action: "review", scene, history: H("Hi!") }).error, "history", "学習者が話していなければ振り返れない");
  assert.equal(R.prepare({ action: "hint", scene, history: [], ja: " " }).error, "ja");
  assert.equal(R.prepare({ action: "delete", scene, history: [] }).error, "action");
});

test("学習者の発言が上限（8回）を超えたら turn を断り、8回目で end を返す", () => {
  const lines = [];
  for (let i = 0; i < 9; i++) lines.push("ai line", "my line");
  assert.equal(R.prepare({ action: "turn", scene, history: H(...lines) }).error, "too_long");
  const eight = H(...lines.slice(0, 16));
  assert.equal(R.myTurns(eight), 8);
  assert.equal(R.cleanTurn({ reply: "Great talking to you!" }, eight).end, true);
  assert.equal(R.cleanTurn({ reply: "OK" }, H("a", "b")).end, false);
});

test("出力の整形：長さを切り、空の返事は聞き返しにする", () => {
  const t = R.cleanTurn({ reply: "", help_ja: "あ".repeat(200), goal_reached: 1 }, H("a", "b"));
  assert.equal(t.reply, "Sorry, could you say that again?");
  assert.equal(t.help_ja.length, 80);
  assert.equal(t.reply_ja, null); // 返事が無いときの代わりの文には訳を付けない
  const u = R.cleanTurn({ reply: "Sure, the session starts at ten.", reply_ja: "はい、セッションは10時からです。" }, H("a", "b"));
  assert.equal(u.reply_ja, "はい、セッションは10時からです。");
  assert.equal(R.cleanTurn({ reply: "OK." }, H("a", "b")).reply_ja, null);
  assert.equal(t.goal_reached, true);
  const r = R.cleanReview({ good: ["a", "b", "c", "d"], corrections: [{ you: "x", better: "y" }, { you: "", better: "z" }], phrases: [{ en: "p" }, {}, { en: "q", ja: "く" }] });
  assert.equal(r.good.length, 3);
  assert.deepEqual(r.corrections, [{ you: "x", better: "y", note: "" }]);
  assert.deepEqual(r.phrases.map((p) => p.en), ["p", "q"]);
  assert.deepEqual(R.cleanReview(null), { summary_ja: "", goal_reached: false, good: [], corrections: [], phrases: [] });
});

test("1日の上限と記録のキーは日本時間で区切る", () => {
  const utc = Date.parse("2026-11-07T15:30:00Z"); // 日本時間 11/8 0:30
  assert.equal(R.usageKey(utc), "roleplay-20261108");
  assert.equal(R.logPartition(Date.parse("2026-11-30T16:00:00Z")), "talk-202612");
});

test("変化球・相手の性格を相手役の指示に入れる（なければ入れない）", () => {
  const sc = { ...scene, twist: "The dish you want is sold out tonight.", persona: "busy and a bit brief" };
  const sys = R.prepare({ action: "turn", scene: sc, history: H("Hi", "Hello") }).messages[0].content;
  assert.match(sys, /busy and a bit brief/);
  assert.match(sys, /sold out tonight/);
  const plain = R.prepare({ action: "turn", scene, history: H("Hi", "Hello") }).messages[0].content;
  assert.doesNotMatch(plain, /personality|unexpected turn/);
});

test("使ってみたい表現：振り返りで使えたものだけを返す", () => {
  const sc = { ...scene, targets: ["make sure", "a little bit", "governance", "extra"] };
  const p = R.prepare({ action: "review", scene: sc, history: H("Hi", "I want to make sure.") });
  assert.match(p.messages[0].content, /"make sure", "a little bit", "governance"/);
  const out = p.clean({ targets_used: ["Make sure", "not a target", "governance"] });
  assert.deepEqual(out.targets, ["make sure", "a little bit", "governance"], "最大3つ");
  assert.deepEqual(out.targets_used, ["make sure", "governance"]);
  const none = R.prepare({ action: "review", scene, history: H("Hi", "Hello") });
  assert.doesNotMatch(none.messages[0].content, /targets_used/);
  assert.deepEqual(none.clean({}).targets_used, []);
});

test("使ってみたい表現があれば、学習者が使える機会を作るよう相手役に指示する（先に言わない）", () => {
  const sys = R.prepare({ action: "turn", scene: { ...scene, targets: ["governance", "go through"] }, history: H("Hi", "Hello") }).messages[0].content;
  assert.match(sys, /practicing these expressions: "governance", "go through"/);
  assert.match(sys, /do not say them yourself/);
  assert.doesNotMatch(R.prepare({ action: "turn", scene, history: H("Hi", "Hello") }).messages[0].content, /practicing these expressions/);
});
