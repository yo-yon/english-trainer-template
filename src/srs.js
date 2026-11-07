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

  /**
   * 音ごとの改善のコツ（日本語話者がつまずきやすい音を中心に）。キーは Azure が返す IPA（en-US）。
   * 無い音は DEFAULT_TIP を使う。
   */
  const PHONEME_TIPS = {
    "θ": "舌先を上の前歯に軽く当て、すき間から息だけを出す（「ス」にしない）",
    "ð": "θ と同じ舌の位置で、声を出しながら息を出す（「ズ」「ダ」にしない）",
    "r": "舌先をどこにも付けずに奥へ丸め、唇を少しすぼめる（「ラ」にしない）",
    "l": "舌先を上の歯ぐきにしっかり付けたまま声を出す。語末の l は「ウ」に近く聞こえてよい",
    "v": "上の前歯を下唇に軽く当て、声を出しながら息を出す（「ブ」にしない）",
    "f": "上の前歯を下唇に軽く当て、息だけを出す（「フ」の唇を丸めない）",
    "w": "唇を強くすぼめてから、次の母音へ一気に開く",
    "j": "舌の前を上あごに近づけて「イ」の形から次の母音へ移る",
    "h": "喉の奥から息だけを出す。「フ」のように唇を丸めない",
    "æ": "口を横に大きく開き、「ア」と「エ」の間の音を出す（apps, and, that）",
    "ə": "口と舌の力を抜いて、あいまいに短く「ア」。強く読まない（about の a, data の 2つ目の a）",
    "ʌ": "口を軽く開けて、短く強めの「ア」",
    "ɑ": "口を縦に大きく開けて、喉の奥から「アー」",
    "ɔ": "唇を少し丸めて、口を縦に開けた「オー」",
    "ɪ": "力を抜いた短い「イ」。「エ」に少し近い",
    "i": "唇を横に引いて、はっきり長めの「イー」",
    "ʊ": "唇を軽く丸めた、力の抜けた短い「ウ」",
    "u": "唇を強く丸めて前に突き出し、長めの「ウー」",
    "ɝ": "舌を奥に丸めたまま「アー」と r の響きを出す（work, first）",
    "ɚ": "舌を奥に丸めて、弱く短い r の響きで終える（-er）",
    "eɪ": "「エ」から「イ」へなめらかに動かす二重母音。「エー」と伸ばさない（data, day）",
    "oʊ": "「オ」から「ウ」へ唇を丸めていく二重母音。「オー」と伸ばさない（go, know）",
    "aɪ": "「ア」から「イ」へなめらかに動かす（I, my）",
    "aʊ": "「ア」から「ウ」へ唇を丸めていく（about, now）",
    "ɔɪ": "「オ」から「イ」へ動かす（choice）",
    "t": "語頭は息を強く出す。母音にはさまれた t（data, that's a）は、舌先で軽く弾く「ラ」に近い音でよい",
    "d": "舌先を上の歯ぐきに当ててから離す。語末の d も落とさず、軽く止める",
    "p": "唇を閉じてから、息を破裂させるように強く出す",
    "b": "唇を閉じてから、声を出しながら開く",
    "k": "舌の奥を上あごに付けてから、息を強く出す",
    "g": "舌の奥を上あごに付けてから、声を出しながら離す",
    "s": "歯を軽く閉じ、舌先を歯ぐきに近づけて鋭く息を出す。後ろに「ウ」を付けない",
    "z": "s と同じ形で、声を出す（「ズ」の後ろに「ウ」を付けない）",
    "ʃ": "唇を少し突き出して「シュ」。息を強めに",
    "ʒ": "ʃ と同じ形で、声を出す（usually の s）",
    "tʃ": "舌を歯ぐきに付けてから「チ」と破裂させる",
    "dʒ": "舌を歯ぐきに付けてから、声を出して「ヂ」",
    "m": "唇をしっかり閉じて鼻から声を出す。語末でも唇を閉じる",
    "n": "舌先を上の歯ぐきにしっかり付けて鼻から声を出す。語末の n も舌を付けたまま終える",
    "ŋ": "舌の奥を上あごに付けて鼻から声を出す。後ろに「グ」を付けない（-ing）",
  };
  const DEFAULT_TIP = "お手本を「ゆっくり」で聞き、この音だけを何度かまねしてから文に戻す";

  /**
   * 結果の総評と改善点（最大3つ）。発音評価の数値だけから作る（AI は使わない）。
   * @returns {{verdict:{level:string,en:string,ja:string,msg:string}, hints:Array<{kind:string,ph?:string,words:string[],score?:number,tip:string}>}}
   */
  function pronFeedback(r, name = "strict") {
    const L = level(name);
    const j = r.judge ?? judgeScore(r, name).score;
    const ng = r.ngCount ?? judgeScore(r, name).ng;
    const verdict = j >= 90 && (name === "standard" || ng === 0)
      ? { level: "ok", en: "Good!", ja: "良い", msg: "通じる発音です。この調子で、お手本のリズムに合わせて仕上げましょう。" }
      : j >= 80
        ? { level: "mid", en: "Almost", ja: "あと少し", msg: "全体は通じます。下の改善点の単語だけを直すと「良い」になります。" }
        : { level: "ng", en: "Keep practicing", ja: "要練習", msg: "まずは下の改善点の単語を、お手本の「ゆっくり」で練習してから、もう一度話してみましょう。" };
    const hints = [];
    // 1) 言い落とし
    const omit = (r.words || []).filter((w) => w.err === "Omission").map((w) => w.w);
    if (omit.length) hints.push({ kind: "omit", words: omit.slice(0, 4), tip: "聞き取れませんでした。弱く読む語でも、口の形は作って短く言う" });
    // 2) 点数の低い音（崩れた単語の中で、ok 未満の音をまとめる）
    const byPh = new Map();
    for (const w of r.words || []) {
      if (w.err === "Omission" || w.err === "Insertion") continue;
      const weak = w.err === "Mispronunciation" || (w.acc != null && w.acc < L.ok);
      if (!weak) continue;
      for (const [ph, a] of w.ph || []) {
        if (a >= L.ok) continue;
        const e = byPh.get(ph) || { ph, words: [], score: 100 };
        if (!e.words.includes(w.w)) e.words.push(w.w);
        e.score = Math.min(e.score, a);
        byPh.set(ph, e);
      }
    }
    const phs = [...byPh.values()].sort((a, b) => a.score - b.score || b.words.length - a.words.length);
    for (const e of phs) {
      if (hints.length >= 3) break;
      hints.push({ kind: "phoneme", ph: e.ph, words: e.words.slice(0, 3), score: e.score, tip: PHONEME_TIPS[e.ph] || DEFAULT_TIP });
    }
    // 3) 崩れた単語はあるのに、音ごとの点数が無い場合
    if (!phs.length && hints.length < 3) {
      const weakWords = (r.words || []).filter((w) => w.err !== "Omission" && w.err !== "Insertion" && (w.err === "Mispronunciation" || (w.acc != null && w.acc < L.ok))).map((w) => w.w);
      if (weakWords.length) hints.push({ kind: "word", words: weakWords.slice(0, 3), tip: DEFAULT_TIP });
    }
    // 4) 流暢さ
    if (hints.length < 3 && r.flu != null && r.flu < 75) hints.push({ kind: "fluency", words: [], tip: "途中で止まらず、意味のまとまりごとに一息で言う。お手本の直後にかぶせて話すと、リズムがつかみやすい" });
    return { verdict, hints };
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

  return { DAY, startOfDay, ymd, nextState, interleave, buildQueue, gradeFromScore, parsePron, wordClass, judgeScore, pronFeedback, PHONEME_TIPS, STRICTNESS };
});
