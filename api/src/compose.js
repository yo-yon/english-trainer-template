// 瞬間作文（Phase 3a）：日本語を見て英語で言った答えの判定。
// お手本とほぼ同じなら AI を呼ばずに正解にする（料金を抑えるため）。それ以外は gpt-5.4-mini で意味と自然さを見る。
const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const norm = (s) => String(s || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();
// 短縮形はそろえて比べる（I'm と I am は同じ）
const EXPAND = [[/\bi'm\b/g, "i am"], [/\b(you|we|they)'re\b/g, "$1 are"], [/\b(he|she|it|that|there|what)'s\b/g, "$1 is"], [/\bcan't\b/g, "cannot"], [/\bwon't\b/g, "will not"], [/\b(\w+)n't\b/g, "$1 not"], [/\b(i|you|we|they)'ve\b/g, "$1 have"], [/\b(i|you|we|they|he|she|it)'ll\b/g, "$1 will"], [/\b(i|you|we|they|he|she)'d\b/g, "$1 would"], [/\blet's\b/g, "let us"]];
const canon = (s) => EXPAND.reduce((t, [re, rep]) => t.replace(re, rep), norm(s));

/** お手本とほぼ同じか（大文字小文字・記号・短縮形の違いは無視） */
function quickMatch(answer, model) {
  return !!canon(answer) && canon(answer) === canon(model);
}

/** リクエストの検査と、AI に渡すメッセージ。不正なら { error } */
function prepare(b) {
  if (!b || typeof b !== "object") return { error: "body" };
  const ja = clip(b.ja, 300), model = clip(b.model, 300), answer = clip(b.answer, 400);
  const target = clip(b.target, 60);
  if (!ja || !model) return { error: "item" };
  if (!answer) return { error: "answer" };
  return {
    ja, model, answer, target,
    messages: [
      {
        role: "system",
        content:
          "You check a Japanese learner's spoken English translation (an instant composition drill). The answer may come from speech recognition, so ignore capitalization, punctuation, and likely recognition errors.\n" +
          'Grade: "correct" = natural and conveys the full meaning (it does not need to match the model sentence); "ok" = the meaning gets across but there are grammar mistakes, unnatural wording, or a small missing part; "wrong" = the meaning does not get across, a key part is missing, or it is not English.\n' +
          (target ? `The drill practices the expression "${target}". If the answer conveys the meaning without it, grade at most "ok".\n` : "") +
          'Return only JSON: {"grade": "correct" | "ok" | "wrong", "better": "a natural English sentence close to the learner\'s answer (or the model if the answer is wrong)", "note": "日本語で40文字以内の短い説明"}',
      },
      { role: "user", content: `Japanese: ${ja}\nModel answer: ${model}\nLearner's answer: ${answer}` },
    ],
  };
}

/** AI の出力を整える */
function clean(o, model) {
  const grade = ["correct", "ok", "wrong"].includes(o && o.grade) ? o.grade : "ok";
  return { grade, better: clip(o && o.better, 300) || model, note: clip(o && o.note, 80), by: "ai" };
}

module.exports = { quickMatch, prepare, clean, canon };
