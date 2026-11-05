/* 間隔反復と発音評価の計算（ブラウザとNodeのテストで共用） */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SRS = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const DAY = 86400000;
  const startOfDay = (now = Date.now()) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const ymd = (now = Date.now()) => { const d = new Date(now); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

  /** 間隔反復の計算（again / hard / good / easy） */
  function nextState(s, g, now = Date.now()) {
    s = s ? { ...s } : { interval: 0, ease: 2.5, reps: 0, lapses: 0 };
    if (g === "again") { s.ease = Math.max(1.3, s.ease - 0.2); s.lapses++; s.reps = 0; s.interval = 0; }
    else if (g === "hard") { s.ease = Math.max(1.3, s.ease - 0.15); s.interval = Math.max(1, Math.round(s.interval * 1.2)); s.reps++; }
    else if (g === "good") { s.interval = s.reps === 0 ? 1 : s.reps === 1 ? 3 : Math.round(s.interval * s.ease); s.reps++; }
    else { s.interval = s.reps === 0 ? 3 : Math.round(Math.max(s.interval, 1) * s.ease * 1.3); s.ease += 0.15; s.reps++; }
    s.due = startOfDay(now) + s.interval * DAY;
    return s;
  }

  /** 2つのカテゴリを交互に並べる（技術語と一般語、セッション文と会話文） */
  function interleave(items, key, a, b) {
    const A = items.filter((x) => x[key] === a), B = items.filter((x) => x[key] === b), R = items.filter((x) => x[key] !== a && x[key] !== b);
    const out = [];
    while (A.length || B.length) { if (A.length) out.push(A.shift()); if (B.length) out.push(B.shift()); }
    return out.concat(R);
  }

  /** 今日の出題：期限が来た復習 ＋ 新規（1日の上限まで） */
  function buildQueue(items, cards, log, perDay, catKey, catA, catB, now = Date.now()) {
    const t = startOfDay(now);
    const used = log && log.date === ymd(now) ? log.count : 0;
    const due = items.filter((x) => cards[x.id] && cards[x.id].due <= t).sort((x, y) => cards[x.id].due - cards[y.id].due);
    const unseen = items.filter((x) => !cards[x.id]).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    const fresh = interleave(unseen, catKey, catA, catB).slice(0, Math.max(0, perDay - used));
    return [...due, ...fresh];
  }

  /**
   * 採点の厳しさ。Azure の総合点（PronScore）は文全体の平均なので、1〜2語の崩れが目立たない。
   * そこで、単語ごとの点数で減点した「判定点」を使い、単語の色分けの基準も上げる。
   *   ok   : 単語の正確さが ok 以上
   *   mid  : mid 以上 ok 未満（あと少し）→ midPenalty 点減点
   *   ng   : mid 未満、または Azure が Mispronunciation と判定 → ngPenalty 点減点
   *   言い落とし（Omission）も ngPenalty 点減点
   */
  const STRICTNESS = {
    standard: { label: "標準（Azure の点数そのまま）", ok: 80, mid: 60, midPenalty: 0, ngPenalty: 0 },
    strict:   { label: "厳しめ（おすすめ）",           ok: 90, mid: 75, midPenalty: 3, ngPenalty: 8 },
    hard:     { label: "とても厳しい",                 ok: 95, mid: 85, midPenalty: 5, ngPenalty: 12 },
  };
  const level = (name) => STRICTNESS[name] || STRICTNESS.strict;

  /** 単語の評価クラス（色分け用） */
  function wordClass(w, name) {
    const L = level(name);
    if (w.err === "Omission") return "omit";
    if (w.err === "Insertion") return "ins";
    if (w.err === "Mispronunciation" || (w.acc != null && w.acc < L.mid)) return "ng";
    if (w.acc != null && w.acc < L.ok) return "mid";
    return "ok";
  }

  /** 判定点：Azure の総合点から、崩れた単語の数だけ減点する */
  function judgeScore(r, name) {
    const L = level(name);
    let score = r.pron;
    let ng = 0;
    for (const w of r.words || []) {
      const c = wordClass(w, name);
      if (c === "ng" || c === "omit") { score -= L.ngPenalty; ng++; }
      else if (c === "mid") score -= L.midPenalty;
    }
    return { score: Math.max(0, Math.round(score)), ng };
  }

  /** 判定点から復習の評価を決める。「要練習」の単語が残っていれば、点数が高くても good にしない */
  function gradeFromScore(score, ngWords = 0, name = "strict") {
    if (score >= 90 && (name === "standard" || ngWords === 0)) return "good";
    if (score >= 80) return "hard";
    return "again";
  }

  /** Speech SDK の JSON 結果を、画面表示と保存に使う形に整える */
  function parsePron(json) {
    const nb = json && json.NBest && json.NBest[0];
    if (!nb) return null;
    const pa = nb.PronunciationAssessment || {};
    const words = (nb.Words || []).map((w) => {
      const a = w.PronunciationAssessment || {};
      return {
        w: w.Word,
        acc: a.AccuracyScore != null ? Math.round(a.AccuracyScore) : null,
        err: a.ErrorType || "None",
        ph: (w.Phonemes || []).map((p) => [p.Phoneme, Math.round((p.PronunciationAssessment || {}).AccuracyScore ?? 0)]),
      };
    });
    return {
      recognized: nb.Display || json.DisplayText || "",
      pron: Math.round(pa.PronScore ?? 0),
      acc: Math.round(pa.AccuracyScore ?? 0),
      flu: Math.round(pa.FluencyScore ?? 0),
      comp: Math.round(pa.CompletenessScore ?? 0),
      words,
    };
  }

  return { DAY, startOfDay, ymd, nextState, interleave, buildQueue, gradeFromScore, parsePron, wordClass, judgeScore, STRICTNESS };
});
