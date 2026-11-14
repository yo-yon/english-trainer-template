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

test("「もう一度」の次回は明日。今日の出題を作り直しても戻ってこない（文が残り続けない）", () => {
  const a = S.nextState({ interval: 3, ease: 2.5, reps: 2, lapses: 0, due: 0 }, "again", NOW);
  assert.equal(a.interval, 0);
  assert.equal(a.due, S.startOfDay(NOW) + S.DAY);
  const items = [{ id: "s1", category: "conference", order: 0 }];
  assert.deepEqual(S.buildQueue(items, { s1: a }, { date: "", count: 0 }, 5, "category", "conference", "conversation", NOW).map((x) => x.id), []);
  const tomorrow = NOW + S.DAY;
  assert.deepEqual(S.buildQueue(items, { s1: a }, { date: "", count: 0 }, 5, "category", "conference", "conversation", tomorrow).map((x) => x.id), ["s1"]);
  const n = S.nextState(a, "good", tomorrow);
  assert.equal(n.interval, 1, "もう一度の後に good なら1日後");
});

test("会話で使えた単語は次回を延ばし、使えなかった単語は明日に前倒しする", () => {
  const t = S.startOfDay(NOW);
  const c = { interval: 4, ease: 2.5, reps: 2, lapses: 0, due: t + 1 * S.DAY };
  assert.equal(S.applyTalkUse(c, true, NOW).due, t + 6 * S.DAY, "4日 × 1.5 = 6日後");
  assert.equal(S.applyTalkUse({ ...c, interval: 0, due: t }, true, NOW).due, t + 2 * S.DAY, "最低2日後");
  assert.equal(S.applyTalkUse({ ...c, due: t + 20 * S.DAY }, true, NOW).due, t + 20 * S.DAY, "すでに先なら縮めない");
  assert.equal(S.applyTalkUse({ ...c, due: t + 10 * S.DAY }, false, NOW).due, t + S.DAY, "使えなかったら明日");
  assert.equal(S.applyTalkUse({ ...c, due: t }, false, NOW).due, t, "すでに今日なら今日のまま");
  assert.equal(S.applyTalkUse(c, true, NOW).interval, 4, "間隔や回数は変えない");
  assert.equal(S.applyTalkUse(null, true, NOW), null, "まだ覚えていない語は対象外");
});

test("会話に混ぜる単語：覚えた語のうち、復習の時期が近い順（今日の語・1週間より先の語は除く）", () => {
  const t = S.startOfDay(NOW);
  const words = [{ id: "a", word: "agent" }, { id: "b", word: "basically" }, { id: "c", word: "tenant" }, { id: "d", word: "go through" }, { id: "e", word: "kind of" }];
  const cards = {
    a: { reps: 1, due: t + 3 * S.DAY }, b: { reps: 2, due: t + 1 * S.DAY }, c: { reps: 1, due: t + 30 * S.DAY },
    d: { reps: 0, lapses: 1, due: t + 1 * S.DAY }, // もう一度の後（定着前）も対象
  };
  assert.deepEqual(S.pickSpacedWords(words, cards, ["Basically"], 2, NOW).map((w) => w.word), ["go through", "agent"]);
  assert.deepEqual(S.pickSpacedWords(words, cards, [], 5, NOW).map((w) => w.word), ["basically", "go through", "agent"], "30日後の語とカードのない語は除く");
});

test("ディクテーション：短縮形・数字・ハイフン・大文字・記号の違いはそろえて比べる", () => {
  assert.deepEqual(S.dictTokens("I'm connecting to the Wi-Fi in 5 minutes!"), ["i", "am", "connecting", "to", "the", "wifi", "in", "five", "minutes"]);
  assert.deepEqual(S.dictTokens("We don't — can't."), ["we", "do", "not", "cannot"]);
  const d = S.dictationDiff("i am connecting to the wifi in five minutes", "I'm connecting to the Wi-Fi in 5 minutes.");
  assert.equal(d.score, 100);
  assert.equal(S.dictationGrade(d.score), "good");
});

test("ディクテーション：抜けた語・違う語・余分な語を見つけて点数にする", () => {
  const d = S.dictationDiff("Could you go to that slide again please", "Could you go through that slide again?");
  assert.deepEqual(d.model.map((x) => (x.ok ? x.w : "[" + x.w + "]")).join(" "), "could you go [through] that slide again");
  assert.deepEqual(d.extra, ["to", "please"]);
  assert.equal(d.okCount, 6);
  assert.equal(d.score, Math.round(((6 - 1) / 7) * 100)); // 余分2語で1語分の減点
  assert.equal(S.dictationGrade(d.score), "again");
  assert.equal(S.dictationGrade(85), "hard");
  assert.equal(S.dictationDiff("", "Hello there.").score, 0);
});

test("苦手な音：音ごとの平均点を集計し、低い順に上位を出す（回数の少ない音・言い落としは除く）", () => {
  const W = (w, ph, err = "None") => ({ w, err, ph });
  const attempts = [
    { sentenceId: "c01", words: [W("through", [["θ", 40], ["r", 60], ["u", 90]]), W("the", [["ð", 70], ["ə", 95]])] },
    { sentenceId: "q01", words: [W("Think", [["θ", 50], ["ɪ", 90], ["ŋ", 80], ["k", 95]]), W("really", [["r", 55], ["i", 90], ["l", 70], ["i", 90]])] },
    { sentenceId: "q01", words: [W("thanks", [["θ", 60], ["æ", 85]]), W("right", [["r", 65], ["aɪ", 90], ["t", 95]]), W("three", [["θ", 30]], "Omission")] },
    { sentenceId: "n02", words: [W("thing", [["θ", 45]]), W("road", [["r", 70]]), W("with", [["θ", 55]])] },
  ];
  const r = S.weakSounds(attempts, { minCount: 4, top: 2 });
  assert.deepEqual(r.map((x) => [x.ph, x.avg, x.n]), [["θ", 50, 5], ["r", 63, 4]], "θ は言い落とし（three）を除いて5回");
  assert.deepEqual(r[0].words.map((x) => x.w), ["through", "thing", "think", "with", "thanks"], "単語は平均点の低い順、小文字");
  assert.deepEqual(r[0].sentenceIds.sort(), ["c01", "n02", "q01"]);
  assert.match(r[0].tip, /舌先を上の前歯/);
  assert.deepEqual(S.weakSounds(attempts, { minCount: 6 }), [], "回数が足りなければ出さない");
  assert.deepEqual(S.weakSounds([]), []);
});

test("定着率：週は月曜始まり。7日以上あけた復習だけを数え、もう一度は忘れていた扱い", () => {
  const sun = new Date(2026, 10, 8, 10).getTime(); // 2026-11-08（日）
  const mon = new Date(2026, 10, 9, 10).getTime(); // 2026-11-09（月）
  assert.equal(S.weekStart(sun), "2026-11-02");
  assert.equal(S.weekStart(mon), "2026-11-09");
  const log = {};
  assert.equal(S.recordRetention(log, "word", { interval: 3 }, "good", sun), false, "間隔が7日未満は数えない");
  assert.equal(S.recordRetention(log, "word", null, "good", sun), false, "初めての語は数えない");
  S.recordRetention(log, "word", { interval: 7 }, "good", sun);
  S.recordRetention(log, "word", { interval: 10 }, "again", sun);
  S.recordRetention(log, "compose", { interval: 8 }, "hard", mon);
  assert.deepEqual(log, { "2026-11-02": { word: { n: 2, ok: 1 } }, "2026-11-09": { compose: { n: 1, ok: 1 } } });
  const sum = S.retentionSummary(log, 4, mon);
  assert.equal(sum.total.rate, 67);
  assert.deepEqual(sum.kinds.word, { n: 2, ok: 1, rate: 50 });
  assert.equal(S.retentionSummary({}, 4, mon).total.rate, null);
});

test("定着率：古い週（12週より前）は消し、集計は直近の週だけ", () => {
  const log = {};
  for (let i = 0; i < 14; i++) S.recordRetention(log, "dict", { interval: 9 }, "good", new Date(2026, 7, 3 + i * 7, 10).getTime());
  assert.equal(Object.keys(log).length, 12);
  const last = new Date(2026, 7, 3 + 13 * 7, 10).getTime();
  assert.equal(S.retentionSummary(log, 4, last).total.n, 4);
});

test("parsePron は話された音の第1候補がお手本と違うときだけ3つ目に入れる", () => {
  const json = { NBest: [{ PronunciationAssessment: { PronScore: 70 }, Words: [
    { Word: "data", PronunciationAssessment: { AccuracyScore: 62, ErrorType: "None" }, Phonemes: [
      { Phoneme: "d", PronunciationAssessment: { AccuracyScore: 40, NBestPhonemes: [{ Phoneme: "t", Score: 80 }, { Phoneme: "d", Score: 40 }] } },
      { Phoneme: "eɪ", PronunciationAssessment: { AccuracyScore: 90, NBestPhonemes: [{ Phoneme: "eɪ", Score: 95 }] } },
      { Phoneme: "t", PronunciationAssessment: { AccuracyScore: 85 } },
    ] },
  ] }] };
  const r = S.parsePron(json);
  assert.deepEqual(r.words[0].ph, [["d", 40, "t"], ["eɪ", 90], ["t", 85]]);
  // 苦手な音の集計は3つ目があっても動く
  assert.equal(S.weakSounds([{ sentenceId: "s1", words: r.words }], { minCount: 1 })[0].ph, "d");
});

test("wordDrill は単語が「良い」なら合格、低い音と聞こえた音を返す", () => {
  const mk = (acc, ph, err = "None") => ({ words: [{ w: "data", acc, err, ph }] });
  const ng = S.wordDrill(mk(62, [["d", 40, "t"], ["eɪ", 90], ["t", 85]]), "data", "strict");
  assert.equal(ng.pass, false);
  assert.equal(ng.level, "ng");
  assert.deepEqual(ng.weak.map((x) => [x.ph, x.score, x.heard]), [["d", 40, "t"], ["t", 85, undefined]]);
  assert.ok(ng.weak[0].tip);
  const ok = S.wordDrill(mk(94, [["d", 95], ["eɪ", 92]]), "Data.", "strict");
  assert.equal(ok.pass, true);
  assert.equal(ok.weak.length, 0);
  assert.equal(S.wordDrill(mk(85, []), "data", "strict").pass, false);   // strict では 90 未満は「あと少し」
  assert.equal(S.wordDrill(mk(85, []), "data", "standard").pass, true);
  assert.equal(S.wordDrill(mk(null, [], "Omission"), "data", "strict").acc, 0);
  assert.equal(S.wordDrill({ words: [] }, "data"), null);
});

test("drillChunk は単語を含む短いまとまりを返す（採点は単語だけ）", () => {
  const s1 = "Understand the limits in both the design phase and the build phase.";
  assert.strictEqual(S.drillChunk(s1, "phase"), "design phase and");
  assert.strictEqual(S.drillChunk(s1, "and"), "phase and the build"); // 短いので1語足す
  assert.strictEqual(S.drillChunk("I'm a Power Platform architect, and I also teach.", "architect"), "Platform architect, and");
  assert.strictEqual(S.drillChunk("Understand the limits.", "Understand"), "Understand the"); // 文頭
  assert.strictEqual(S.drillChunk("Could you go back to that slide?", "slide"), "to that slide"); // 文末は前に足す
  assert.strictEqual(S.drillChunk("Hello.", "hello"), "hello"); // 1語の文
  assert.strictEqual(S.drillChunk("No match here.", "data"), "data");
  // まとまりの中で、採点する単語が見つかる
  const r = { words: [{ w: "design", acc: 90, err: "None", ph: [] }, { w: "phase", acc: 95, err: "None", ph: [["f", 95]] }, { w: "and", acc: 50, err: "None", ph: [] }] };
  assert.strictEqual(S.wordDrill(r, "phase", "strict").pass, true);
});

test("audioProfile は雑音・声の音量、声の時間、前後の無音、音割れを返す", () => {
  const R = 16000;
  const seg = (sec, amp, freq = 200) => { const a = new Int16Array(Math.round(R * sec)); for (let i = 0; i < a.length; i++) a[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / R)); return a; };
  const noise = (sec, amp) => { const a = new Int16Array(Math.round(R * sec)); let x = 1; for (let i = 0; i < a.length; i++) { x = (x * 1103515245 + 12345) % 2147483648; a[i] = Math.round(((x / 2147483648) * 2 - 1) * amp * 32767); } return a; };
  const p = S.audioProfile([noise(1, 0.001), seg(1.5, 0.3), noise(2, 0.001)]);
  assert.ok(p.snr > 40, "SNR " + p.snr);
  assert.ok(Math.abs(p.voicedSec - 1.5) <= 0.06, "voiced " + p.voicedSec);
  assert.ok(Math.abs(p.leadSec - 1) <= 0.04 && Math.abs(p.tailSec - 2) <= 0.04, `lead ${p.leadSec} tail ${p.tailSec}`);
  assert.strictEqual(p.clipPct, 0);
  assert.ok(S.audioProfile([Int16Array.from({ length: 16000 }, (_, i) => (i % 2 ? 32767 : -32768))]).clipPct > 99);
  assert.strictEqual(S.audioProfile([]), null);
});

test("guideFor は Azure の表記ゆれ（ɹ・ɡ）と r 付き母音でも口の形を返す", () => {
  assert.equal(S.normPh("ɹ"), "r");
  assert.equal(S.normPh("ɡ"), "g");
  assert.ok(S.guideFor("ɹ").tongue.includes("付けず"));
  assert.ok(S.guideFor("ɡ"));
  const ar = S.guideFor("ɑɹ");
  assert.ok(ar.kana.endsWith("＋r"));
  assert.ok(ar.voice.includes("r の響き"));
  assert.equal(S.guideFor("xx"), null);
  // 短いコツも同じく引ける（以前は ɹ で既定のコツになっていた）
  assert.equal(S.tipFor("ɹ"), S.PHONEME_TIPS.r);
  assert.ok(S.tipFor("zz").length > 0);
});

test("en-US の IPA の音（Microsoft Learn の一覧）すべてに口の形がある", () => {
  const all = ["i","ɪ","eɪ","ɛ","æ","ɑ","ɔ","ʊ","oʊ","u","ʌ","aɪ","aʊ","ɔɪ","ju","ə","ɪɹ","ɛɹ","ʊɹ","aɪɹ","aʊɹ","ɔɹ","ɑɹ","ɝ","ɚ","w","j","p","b","t","d","k","ɡ","m","n","ŋ","f","v","θ","ð","s","z","ʃ","ʒ","h","tʃ","dʒ","l","ɹ"];
  for (const ph of all) {
    const g = S.guideFor(ph);
    assert.ok(g && g.kana && g.lips && g.tongue && g.voice, ph);
  }
});

test("wordDrill は口の形と、聞こえた音に応じた直し方を返す", () => {
  const r = S.wordDrill({ words: [{ w: "data", acc: 62, err: "None", ph: [["d", 40, "t"], ["eɪ", 90], ["t", 85]] }] }, "data", "strict");
  assert.ok(r.weak[0].guide.voice.includes("喉"));
  assert.ok(r.weak[0].fix.includes("喉"));
  assert.equal(S.contrastTip("ɹ", "l"), S.contrastTip("r", "l"));
  assert.equal(S.contrastTip("d", "k"), null);
  const fb = S.pronFeedback({ pron: 70, flu: 90, words: [{ w: "red", acc: 50, err: "Mispronunciation", ph: [["ɹ", 30], ["ɛ", 90], ["d", 90]] }] });
  assert.ok(fb.hints.find((h) => h.ph === "ɹ").guide);
});

/* ---------- 単語の学習のしかた（v0.20.0） ---------- */
test("復習待ちが20を超えた日は新しい単語を止める", () => {
  const cards = {}; const q = [];
  for (let i = 0; i < 21; i++) { cards["r" + i] = { due: 0 }; q.push({ id: "r" + i }); }
  q.push({ id: "n1" }, { id: "n2" });
  const r = S.capNew(q, cards);
  assert.equal(r.queue.length, 21); assert.equal(r.held, 2);
  const few = S.capNew(q.slice(15), cards);
  assert.equal(few.held, 0); assert.equal(few.queue.length, 8);
});

test("逆向きは一度「覚えた」側に進んだ単語だけ（もう一度で戻る）", () => {
  assert.equal(S.isReverse(undefined), false);
  const once = S.nextState(undefined, "good");
  assert.equal(S.isReverse(once), true);
  assert.equal(S.isReverse(S.nextState(once, "again")), false);
});

test("例文の穴埋め：活用形・句・語尾の e と y", () => {
  assert.equal(S.cloze("follow up", "I'll follow up with you by email."), "I'll ____ with you by email.");
  assert.equal(S.cloze("rollout", "The rollouts start today."), "The ____ start today.");
  assert.equal(S.cloze("scale", "We are scaling fast."), "We are ____ fast.");
  assert.equal(S.cloze("apply", "It applies to all users."), "It ____ to all users.");
  assert.equal(S.cloze("tenant", "No match here."), null);
});

test("意味の4択：正解を含む4つ、同じ意味を重ねない、足りなければ null", () => {
  const words = [
    { id: "a", word: "a", meaning: "取り込み", category: "tech" },
    { id: "b", word: "b", meaning: "制限", category: "tech" },
    { id: "c", word: "c", meaning: "取り込み（データの）", category: "tech" },
    { id: "d", word: "d", meaning: "連絡する", category: "general" },
    { id: "e", word: "e", meaning: "見直す", category: "general" },
  ];
  const r = S.meaningChoices(words[0], words);
  assert.equal(r.length, 4);
  assert.ok(r.some((x) => x.id === "a"));
  assert.ok(!r.some((x) => x.id === "c")); // 括弧を除くと同じ意味
  assert.equal(S.meaningChoices(words[0], words.slice(0, 3)), null);
});

test("声の答え：活用形と小さな聞き違いは合格、違う語は不合格", () => {
  assert.equal(S.matchSpoken("follow up", "Follow up."), true);
  assert.equal(S.matchSpoken("follow up", "I'll follow up with you."), true);
  assert.equal(S.matchSpoken("rollout", "rollouts"), true);
  assert.equal(S.matchSpoken("scale", "Scaling."), true);
  assert.equal(S.matchSpoken("governance", "governence"), true);
  assert.equal(S.matchSpoken("in-depth", "in depth"), true);
  assert.equal(S.matchSpoken("governance", "government"), false);
  assert.equal(S.matchSpoken("data", "that"), false);
  assert.equal(S.matchSpoken("follow up", "follow"), false);
  assert.equal(S.matchSpoken("tenant", ""), false);
});

test("単語の出し方：新しい単語は英語を見て4択、覚えた単語は聞く・言う・例文を聞くを順に回す", () => {
  const w = { id: "a", word: "rollout", example: "The rollout starts next week.", translation: "展開は来週始まります。" };
  const at = (reps) => S.wordMode({ reps }, w);
  assert.equal(S.wordMode(undefined, w), "mc");
  assert.equal(at(0), "mc");
  assert.deepEqual([1, 2, 3, 4, 5].map(at), ["listen", "rev", "listen-ex", "rev", "listen"]);
  // 穴埋めが作れない → 言う代わりに聞く。例文がない → 例文の代わりに単語を聞く
  const noEx = { id: "b", word: "quota" };
  assert.deepEqual([1, 2, 3].map((reps) => S.wordMode({ reps }, noEx)), ["listen", "listen", "listen"]);
});

test("例文の訳の4択：正解の訳を含む4つ、例文がなければ null", () => {
  const words = ["a", "b", "c", "d"].map((id, i) => ({ id, word: id, example: `Example ${id}.`, translation: `例文${i}。`, category: "tech" }));
  const r = S.exampleChoices(words[0], words);
  assert.equal(r.length, 4);
  assert.ok(r.some((x) => x.id === "a" && x.meaning === "例文0。"));
  assert.equal(S.exampleChoices({ id: "z", word: "z", translation: "訳" }, words), null);
});

test("例文の訳の4択：言い回しだけ違う似た訳は重ねない", () => {
  const t = ["この設定をオンにできるのはテナント管理者だけです。", "この設定を変えられるのは、テナントの管理者だけです。", "会議は来週の火曜日に移りました。", "データを移したら速くなりました。", "新しい機能は来月から使えます。"];
  const words = t.map((tr, i) => ({ id: "w" + i, word: "w" + i, example: "Ex.", translation: tr, category: "tech" }));
  for (let k = 0; k < 20; k++) {
    const r = S.exampleChoices(words[0], words);
    assert.ok(!r.some((x) => x.id === "w1"));
  }
});

test("自分の録音の前後の無音を切る：声の前後に少しだけ余白を残す。声がなければ null", () => {
  const rate = 16000, pcm = new Int16Array(rate * 3); // 3秒：1.0〜1.5秒だけ声
  for (let i = rate; i < rate * 1.5; i++) pcm[i] = i % 2 ? 8000 : -8000;
  const out = S.trimSilence([pcm.subarray(0, rate), pcm.subarray(rate)], rate);
  const sec = out.length / rate;
  assert.ok(sec > 0.9 && sec < 1.1, String(sec)); // 0.5秒＋前後0.25秒ずつ
  assert.equal(S.trimSilence([new Int16Array(rate)], rate), null);
  assert.equal(S.trimSilence([], rate), null);
});

test("会話の道具：使えた表現を拾う。似た語の別の使い方は拾わない", () => {
  const ids = (a) => S.toolsUsed(a).map((t) => t.id);
  assert.deepEqual(ids(["Sorry, could you say that again?", "Well, let me think. Actually I work in IT.", "Oh really? That makes sense.", "It was nice talking to you."]), ["t01", "t10", "t13", "t15", "t19", "t20", "t23"]);
  assert.deepEqual(ids(["I see the hotel.", "I really like it.", "Well done."]), []);
  assert.equal(S.isClarify("What do you mean by onboarding?"), true);
  assert.equal(S.isClarify("Just to make sure, the session starts at ten?"), true);
  assert.equal(S.isClarify("That sounds great."), false);
  assert.ok(S.CONV_TOOLS.every((t) => S.TOOL_KINDS[t.kind] && t.en && t.ja));
});
