const test = require("node:test");
const assert = require("node:assert");
const S = require("../../src/srs.js");
const { requireOwner } = require("../src/lib.js");

const NOW = new Date("2026-11-03T08:00:00+09:00").getTime();

test("nextState の間隔が想定どおりになる", () => {
  let s = S.nextState(null, "good", NOW);
  assert.equal(s.interval, 1);
  s = S.nextState(s, "good", NOW);
  assert.equal(s.interval, 3);
  s = S.nextState(s, "good", NOW);
  assert.equal(s.interval, Math.round(3 * 2.5));
  const a = S.nextState(s, "again", NOW);
  assert.equal(a.interval, 0);
  assert.equal(a.lapses, 1);
});

test("buildQueue は期限の来た復習＋新規（上限まで）を返し、カテゴリを交互にする", () => {
  const items = [
    { id: "t1", category: "tech", order: 1 }, { id: "t2", category: "tech", order: 2 },
    { id: "g1", category: "general", order: 11 }, { id: "g2", category: "general", order: 12 },
    { id: "old", category: "tech", order: 0 },
  ];
  const cards = { old: { due: S.startOfDay(NOW) } };
  const q = S.buildQueue(items, cards, { date: "", count: 0 }, 3, "category", "tech", "general", NOW);
  assert.deepEqual(q.map((x) => x.id), ["old", "t1", "g1", "t2"]);
  const q2 = S.buildQueue(items, cards, { date: S.ymd(NOW), count: 2 }, 3, "category", "tech", "general", NOW);
  assert.deepEqual(q2.map((x) => x.id), ["old", "t1"]);
});

test("gradeFromScore", () => {
  assert.equal(S.gradeFromScore(95), "good");
  assert.equal(S.gradeFromScore(85), "hard");
  assert.equal(S.gradeFromScore(79), "again");
});

test("parsePron は Speech SDK の JSON を整える", () => {
  const json = {
    DisplayText: "Let's connect on LinkedIn.",
    NBest: [{
      Display: "Let's connect on LinkedIn.",
      PronunciationAssessment: { AccuracyScore: 88.4, FluencyScore: 91, CompletenessScore: 100, PronScore: 90.2 },
      Words: [
        { Word: "let's", PronunciationAssessment: { AccuracyScore: 95, ErrorType: "None" }, Phonemes: [{ Phoneme: "l", PronunciationAssessment: { AccuracyScore: 98 } }] },
        { Word: "connect", PronunciationAssessment: { AccuracyScore: 55, ErrorType: "Mispronunciation" }, Phonemes: [] },
        { Word: "on", PronunciationAssessment: { ErrorType: "Omission" } },
      ],
    }],
  };
  const r = S.parsePron(json);
  assert.equal(r.pron, 90);
  assert.equal(r.words.length, 3);
  assert.equal(S.wordClass(r.words[0]), "ok");
  assert.equal(S.wordClass(r.words[1]), "ng");
  assert.equal(S.wordClass(r.words[2]), "omit");
  assert.deepEqual(r.words[0].ph, [["l", 98]]);
});

test("requireOwner は owner ロールがないと 403", () => {
  const mk = (roles) => ({ headers: new Map(roles ? [["x-ms-client-principal", Buffer.from(JSON.stringify({ userRoles: roles })).toString("base64")]] : []) });
  assert.equal(requireOwner(mk(null)).status, 403);
  assert.equal(requireOwner(mk(["anonymous", "authenticated"])).status, 403);
  assert.equal(requireOwner(mk(["anonymous", "authenticated", "owner"])), null);
});

test("judgeScore は崩れた単語の数だけ減点し、厳しさで基準が変わる", () => {
  const r = {
    pron: 92,
    words: [
      { w: "before", acc: 96, err: "None" },
      { w: "technology", acc: 85, err: "None" },   // 厳しめ：mid（-3）／標準：ok
      { w: "think", acc: 70, err: "None" },        // 厳しめ：ng（-8）／標準：mid
      { w: "users", acc: null, err: "Omission" },  // どちらも言い落とし
    ],
  };
  assert.deepEqual(S.judgeScore(r, "standard"), { score: 92, ng: 1 });
  assert.deepEqual(S.judgeScore(r, "strict"), { score: 92 - 3 - 8 - 8, ng: 2 });
  assert.deepEqual(S.judgeScore(r, "hard"), { score: 92 - 5 - 12 - 12, ng: 2 }); // 85 は「とても厳しい」でも mid の下限ちょうど
  assert.equal(S.wordClass(r.words[1], "standard"), "ok");
  assert.equal(S.wordClass(r.words[1], "strict"), "mid");
  assert.equal(S.wordClass(r.words[2], "strict"), "ng");
  assert.equal(S.judgeScore({ pron: 5, words: [{ err: "Omission" }] }, "hard").score, 0);
});

test("gradeFromScore は要練習の単語が残っていれば good にしない（標準以外）", () => {
  assert.equal(S.gradeFromScore(93, 1, "strict"), "hard");
  assert.equal(S.gradeFromScore(93, 0, "strict"), "good");
  assert.equal(S.gradeFromScore(93, 1, "standard"), "good");
  assert.equal(S.gradeFromScore(75, 0, "strict"), "again");
});

const share = require("../src/share.js");

test("scrub はメール・URL・電話番号・長い数字を消す", () => {
  const t = share.scrub("連絡は taro.yamada@example.co.jp か https://example.com/x?a=1 、090-1234-5678 / 1234567 まで", 500);
  assert.ok(!/example|yamada|090|1234567/.test(t), t);
  assert.ok(t.includes("[メール]") && t.includes("[URL]") && t.includes("[番号]"));
  assert.equal(share.scrub("短い数字 12 と 2026 は残す", 50), "短い数字 12 と 2026 は残す");
  assert.equal(share.scrub("x".repeat(50), 10).length, 10);
});

test("buildPayload は決めた項目だけを送り、それ以外は落とす", () => {
  const item = {
    kind: "content", category: "評価が甘すぎる", targetType: "sentence", targetId: "c01", targetText: "Before you pick...",
    comment: "mail me: a@b.com", status: "open", at: "2026-11-04T00:00:00Z",
    detail: { pron: 91.4, judge: 80, strictness: "strict", recognized: "before you pick", secret: "x", userEmail: "a@b.com" },
    context: { tab: "shadow", version: "0.5.0", device: "mobile", userId: "u123" },
  };
  const p = share.buildPayload(item, "abcd-1234-<script>", "0.5.0");
  assert.equal(p.v, 1);
  assert.equal(p.instanceId, "abcd-1234-script");
  assert.equal(p.item.comment, "mail me: [メール]");
  assert.deepEqual(Object.keys(p.item.detail).sort(), ["judge", "pron", "recognized", "strictness"]);
  assert.equal(p.item.detail.pron, 91);
  assert.deepEqual(p.item.context, { tab: "shadow", device: "mobile" });
  assert.equal(p.app, "english-trainer");
  assert.equal(p.item.status, undefined);
  assert.equal(JSON.stringify(p).includes("userId"), false);
});

test("sendToHub は URL 未設定なら送らず、失敗しても例外を投げない", async () => {
  delete process.env.FEEDBACK_HUB_URL;
  assert.equal((await share.sendToHub({ instanceId: "x" })).status, "disabled");
  process.env.FEEDBACK_HUB_URL = "https://hub.example/api/collect";
  let called = null;
  const ok = await share.sendToHub({ instanceId: "x" }, async (u, o) => { called = { u, body: JSON.parse(o.body) }; return { status: 202, ok: true }; });
  assert.equal(ok.status, "sent"); assert.equal(called.u, "https://hub.example/api/collect");
  const ng = await share.sendToHub({ instanceId: "x" }, async () => { throw new Error("boom"); });
  assert.equal(ng.status, "failed");
  const http = await share.sendToHub({ instanceId: "x" }, async () => ({ status: 429, ok: false }));
  assert.equal(http.error, "http_429");
  delete process.env.FEEDBACK_HUB_URL;
});

test("URL の直後の日本語は消さない", () => {
  assert.equal(share.scrub("https://example.com/a?b=1の画面が使いにくい", 100), "[URL]の画面が使いにくい");
});

test("pronFeedback：総評は判定点と要練習の語数で決まる", () => {
  const ok = { judge: 93, ngCount: 0, flu: 95, words: [{ w: "hello", acc: 95, err: "None", ph: [["h", 95]] }] };
  assert.equal(S.pronFeedback(ok, "strict").verdict.level, "ok");
  assert.equal(S.pronFeedback(ok, "strict").hints.length, 0);
  assert.equal(S.pronFeedback({ ...ok, judge: 93, ngCount: 1 }, "strict").verdict.level, "mid");
  assert.equal(S.pronFeedback({ ...ok, judge: 70 }, "strict").verdict.level, "ng");
  assert.equal(S.pronFeedback({ ...ok, judge: 93, ngCount: 1 }, "standard").verdict.level, "ok");
});

test("pronFeedback：崩れた単語の低い音から改善点を最大3つ、低い順に出す", () => {
  const r = {
    judge: 78, ngCount: 2, flu: 60,
    words: [
      { w: "data", acc: 49, err: "Mispronunciation", ph: [["d", 90], ["eɪ", 80], ["t", 30], ["ə", 60]] },
      { w: "about", acc: 63, err: "None", ph: [["ə", 55], ["b", 95], ["aʊ", 92], ["t", 70]] },
      { w: "the", acc: 98, err: "None", ph: [["ð", 40]] }, // 単語として良いので対象外
      { w: "and", acc: null, err: "Omission", ph: [] },
    ],
  };
  const fb = S.pronFeedback(r, "strict");
  assert.equal(fb.hints.length, 3);
  assert.equal(fb.hints[0].kind, "omit");
  assert.deepEqual(fb.hints[0].words, ["and"]);
  assert.equal(fb.hints[1].ph, "t");
  assert.deepEqual(fb.hints[1].words, ["data", "about"]);
  assert.equal(fb.hints[1].score, 30);
  assert.equal(fb.hints[2].ph, "ə");
  assert.ok(fb.hints.every((h) => h.tip && h.tip.length > 5));
  assert.ok(!fb.hints.some((h) => h.ph === "ð"));
});

test("pronFeedback：辞書に無い音は既定のコツ、音素が無ければ単語、流暢さが低ければ一言", () => {
  const a = S.pronFeedback({ judge: 85, ngCount: 0, flu: 90, words: [{ w: "x", acc: 80, err: "None", ph: [["ʔ", 50]] }] }, "strict");
  assert.equal(a.hints[0].ph, "ʔ");
  assert.match(a.hints[0].tip, /ゆっくり/);
  const b = S.pronFeedback({ judge: 85, ngCount: 1, flu: 60, words: [{ w: "y", acc: 50, err: "Mispronunciation", ph: [] }] }, "strict");
  assert.deepEqual(b.hints.map((h) => h.kind), ["word", "fluency"]);
});
