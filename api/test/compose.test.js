const test = require("node:test");
const assert = require("node:assert");
const C = require("../src/compose.js");

test("お手本とほぼ同じなら AI を呼ばずに正解（大文字・記号・短縮形の違いは無視）", () => {
  assert.equal(C.quickMatch("let's go through the steps one by one", "Let's go through the steps one by one."), true);
  assert.equal(C.quickMatch("I am new to Copilot Studio.", "I'm new to Copilot Studio."), true);
  assert.equal(C.quickMatch("We don't have time", "We do not have time."), true);
  assert.equal(C.quickMatch("We have time.", "We do not have time."), false);
  assert.equal(C.quickMatch("", "Hello."), false);
});

test("入力の検査と、AI へのメッセージ（練習する表現があれば、その条件も入れる）", () => {
  assert.equal(C.prepare(null).error, "body");
  assert.equal(C.prepare({ ja: "", model: "Hi." , answer: "Hi" }).error, "item");
  assert.equal(C.prepare({ ja: "こんにちは", model: "Hi.", answer: " " }).error, "answer");
  const p = C.prepare({ ja: "手順を1つずつ見ていきましょう。", model: "Let's go through the steps one by one.", answer: "Let's check steps.", target: "go through" });
  assert.match(p.messages[0].content, /practices the expression "go through"/);
  assert.match(p.messages[1].content, /Learner's answer: Let's check steps\./);
  assert.doesNotMatch(C.prepare({ ja: "a", model: "b c", answer: "d" }).messages[0].content, /practices the expression/);
});

test("AI の出力を整える（不明な判定は ok、言い換えがなければお手本）", () => {
  assert.deepEqual(C.clean({ grade: "perfect", note: "x".repeat(200) }, "Model."), { grade: "ok", better: "Model.", note: "x".repeat(80), by: "ai" });
  assert.equal(C.clean({ grade: "wrong", better: "Better." }, "Model.").better, "Better.");
});
