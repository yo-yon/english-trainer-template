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
    s = s ? { ...s } : { interval: 0, ease: 2.5, reps: 0, lapses: 0, first: ymd(now) }; // first：初めて答えた日（今週のまとめに使う）
    if (g === "again") { s.ease = Math.max(1.3, s.ease - 0.2); s.lapses++; s.reps = 0; s.interval = 0; }
    else if (g === "hard") { s.ease = Math.max(1.3, s.ease - 0.15); s.interval = Math.max(1, Math.round(s.interval * 1.2)); s.reps++; }
    else if (g === "good") { s.interval = s.reps === 0 ? 1 : s.reps === 1 ? 3 : Math.round(s.interval * s.ease); s.reps++; }
    else { s.interval = s.reps === 0 ? 3 : Math.round(Math.max(s.interval, 1) * s.ease * 1.3); s.ease += 0.15; s.reps++; }
    // 「もう一度」（interval 0）も次回は明日。今日のうちに出し直すのは画面側で1回だけ（何度も今日の復習に戻り、終わらなくなるため）
    s.due = startOfDay(now) + Math.max(1, s.interval) * DAY;
    return s;
  }

  /**
   * 会話で「使ってみたい表現」を使えたかを、単語の復習の予定に反映する（別の場面で思い出して使えた＝定着の手応え）。
   * - 使えた：次回を少し先に延ばす（今の間隔の1.5倍、最低2日後）。間隔や回数は変えない
   * - 使えなかった：次回が明日より先なら、明日に前倒しする
   * まだ単語帳で覚えていない語（カードなし）は対象外で null を返す
   */
  function applyTalkUse(card, used, now = Date.now()) {
    if (!card) return null;
    const t = startOfDay(now), c = { ...card };
    if (used) c.due = Math.max(c.due || 0, t + Math.max(2, Math.round((c.interval || 0) * 1.5)) * DAY);
    else c.due = Math.min(c.due || 0, t + DAY);
    return c;
  }

  /**
   * 会話の「使ってみたい表現」に混ぜる、前に覚えた単語。単語帳で覚えた（カードがある）語のうち、
   * 復習の時期が近い順（忘れかけのころに思い出すと定着しやすい）に n 語。1週間より先に復習が来る語と、除外する語は選ばない
   */
  function pickSpacedWords(words, cards, exclude, n = 2, now = Date.now()) {
    const t = startOfDay(now), ex = new Set((exclude || []).map((x) => String(x).toLowerCase()));
    return words
      .filter((w) => cards[w.id] && (cards[w.id].reps || cards[w.id].lapses) && !ex.has(String(w.word).toLowerCase()))
      .filter((w) => cards[w.id].due - t <= 7 * DAY) // 1週間以内に復習が来る語
      .sort((a, b) => cards[a.id].due - cards[b.id].due)
      .slice(0, n);
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

  /* ---------- 単語の学習のしかた（v0.20.0） ---------- */
  const PAUSE_NEW_AT = 20; // 復習待ちがこれを超えた日は、新しい単語を出さない

  /** 復習待ちが多い日は新しい単語を止める。held は止めた新しい単語の数 */
  function capNew(queue, cards, limit = PAUSE_NEW_AT) {
    const due = queue.filter((x) => cards[x.id]);
    if (due.length <= limit) return { queue, held: 0 };
    return { queue: due, held: queue.length - due.length };
  }

  /** 一度「覚えた」側に進んだ単語は、逆向き（日本語と例文の穴埋めから英語を言う）で出す */
  const isReverse = (card) => !!(card && card.reps >= 1);

  const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** 例文の中の単語を ____ にする（活用形も含む）。見つからなければ null */
  function cloze(word, example) {
    const parts = String(word || "").trim().split(/\s+/);
    if (!parts[0] || !example) return null;
    // scale → scaling、apply → applies のように語尾が変わる形も拾う
    const head = parts[0].length >= 4 && /[ey]$/i.test(parts[0]) ? escRe(parts[0].slice(0, -1)) : escRe(parts[0]);
    const re = new RegExp("\\b" + head + "\\w*" + (parts.length > 1 ? "\\s+" + parts.slice(1).map(escRe).join("\\s+") : "") + "\\b", "i");
    if (!re.test(example)) return null;
    return example.replace(re, "____");
  }

  /** 意味の4択：同じ種類（技術・一般）の単語の意味を優先して、ほかの3つを選ぶ。同じ意味は重ねない */
  function meaningChoices(word, words, n = 4, rand = Math.random) {
    const norm = (m) => String(m || "").replace(/[（(].*?[)）]/g, "").replace(/\s+/g, "").trim();
    const seen = new Set([norm(word.meaning)]);
    const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const others = words.filter((w) => w.id !== word.id && w.meaning);
    const pool = [...shuffle(others.filter((w) => w.category === word.category)), ...shuffle(others.filter((w) => w.category !== word.category))];
    const picks = [];
    for (const w of pool) {
      if (picks.length >= n - 1) break;
      const k = norm(w.meaning);
      if (!k || seen.has(k)) continue;
      seen.add(k); picks.push({ id: w.id, meaning: w.meaning });
    }
    if (picks.length < n - 1) return null; // 単語が少なくて4択が作れない
    return shuffle([{ id: word.id, meaning: word.meaning }, ...picks]);
  }

  /** 声で答えた英語が、目当ての単語（句）と合っているか。活用形（-s・-ed・-ing など）と小さな聞き違いは許す */
  function matchSpoken(target, heard) {
    const toks = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9' -]/g, " ").replace(/-/g, " ").split(/\s+/).filter(Boolean);
    const want = toks(target), got = toks(heard);
    if (!want.length || !got.length) return false;
    const dist = (a, b) => {
      const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
      for (let j = 1; j <= b.length; j++) d[0][j] = j;
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      return d[a.length][b.length];
    };
    const same = (w, g) => {
      if (w === g) return true;
      if (w.length >= 4 && g.startsWith(w) && g.length - w.length <= 3) return true; // rollouts・deployed・scaling
      if (w.length >= 4 && /[ey]$/.test(w) && g.startsWith(w.slice(0, -1)) && g.length - w.length <= 3) return true; // scale → scaling、apply → applies
      return w.length >= 5 && dist(w, g) <= 1;
    };
    for (let i = 0; i + want.length <= got.length; i++) if (want.every((w, k) => same(w, got[i + k]))) return true;
    return false;
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
   * 音ごとの口の形（発音記号が分からなくても練習できるように）。キーは PHONEME_TIPS と同じ IPA。
   * kana：近い日本語の音（あくまで目安）、lips：唇、tongue：舌、voice：声と息、ng：日本語話者に多い崩れ方、ex：例の単語
   * Azure の en-US の IPA は r を ɹ、g を ɡ と書く（SSML phonetic alphabets、2026-11-11 確認）ので normPh でそろえる。
   */
  const PHONEME_GUIDE = {
    // 母音
    "i": { kana: "イー（張った長いイ）", lips: "横に強く引く（笑顔の形）", tongue: "舌の前を上あごに近づける。舌先は下の前歯の裏", voice: "声を出し、やや長めに", ng: "短く緩い「イ」にすると ɪ に聞こえる（eat が it に）", ex: ["eat", "team", "need"] },
    "ɪ": { kana: "イ（エ寄りの短いイ）", lips: "力を抜き、ほんの少し横に", tongue: "i より少し下げ、舌の力を抜く", voice: "短く、緩く", ng: "日本語の「イ」は張りが強く i に聞こえやすい（it が eat に）", ex: ["it", "this", "fill"] },
    "eɪ": { kana: "エイ", lips: "中くらいに開けた「エ」から、少し横に引いて「イ」", tongue: "中ほどの高さから前の上へ動かす", voice: "止めずに動かし続けて1つの音にする", ng: "「エー」と伸ばすと ɛ に聞こえる（data が「デェタ」に）", ex: ["day", "data", "make"] },
    "ɛ": { kana: "エ（少し広め）", lips: "日本語の「エ」より少し大きく開ける", tongue: "舌は前寄り、中くらいの高さ", voice: "短く", ng: "口が狭いと eɪ や ɪ に寄る", ex: ["get", "every", "help"] },
    "æ": { kana: "ア（エ寄り）", lips: "横にも縦にも大きく開ける", tongue: "舌の前を低く下げ、舌先は下の前歯の裏", voice: "やや長めに、平たく響かせる", ng: "「ア」だと ʌ・ɑ に、「エ」だと ɛ に聞こえる", ex: ["apps", "that", "can"] },
    "ɑ": { kana: "アー（喉の奥）", lips: "縦に大きく開ける（あくびの形）。丸めない", tongue: "舌全体を低く、奥へ", voice: "喉の奥で長めに", ng: "浅い「ア」だと ʌ に近くなる", ex: ["on", "hot", "start"] },
    "ɔ": { kana: "オー（ア寄り）", lips: "縦に開けて、少しだけ丸める", tongue: "低く、奥へ", voice: "長めに。米語では ɑ に近く言う人も多い", ng: "唇を強く丸めると oʊ に聞こえる", ex: ["talk", "all", "cause"] },
    "ʊ": { kana: "ウ（短く緩い）", lips: "軽く丸める。突き出さない", tongue: "舌の奥を少し上げ、力を抜く", voice: "短く", ng: "長く伸ばすと u に聞こえる（pull が pool に）", ex: ["good", "book", "put"] },
    "oʊ": { kana: "オウ", lips: "丸めた「オ」から、さらにすぼめて「ウ」", tongue: "奥で、中ほどから上へ動かす", voice: "止めずに動かし続ける", ng: "「オー」と伸ばすと ɔ に聞こえる（go が「ゴー」に）", ex: ["go", "know", "show"] },
    "u": { kana: "ウー（唇を突き出す）", lips: "強く丸めて前に突き出す（口笛の形）", tongue: "舌の奥を高く上げる", voice: "長めに", ng: "日本語の「ウ」は唇が平たく、ʊ やあいまいな音に聞こえる", ex: ["two", "do", "new"] },
    "ʌ": { kana: "ア（短く、力を抜く）", lips: "軽く開ける程度。力を入れない", tongue: "真ん中より少し奥", voice: "短く。強く読む音節では強めに", ng: "口を大きく開けすぎると ɑ や æ になる", ex: ["but", "up", "run"] },
    "aɪ": { kana: "アイ", lips: "大きく開けた「ア」から、横に引いて「イ」", tongue: "低い位置から前の上へ", voice: "「ア」を長め、「イ」は軽く", ng: "「イ」まで強く言って2拍にすると不自然", ex: ["I", "my", "time"] },
    "aʊ": { kana: "アウ", lips: "開けた「ア」から、すぼめて「ウ」", tongue: "低い位置から奥の上へ", voice: "「ア」を長め、「ウ」は軽く", ng: "「ア・ウ」と2拍に切る", ex: ["now", "out", "about"] },
    "ɔɪ": { kana: "オイ", lips: "丸めた「オ」から、横に引いて「イ」", tongue: "奥の低い位置から前の上へ", voice: "「オ」を長め、「イ」は軽く", ng: "「オ・イ」と2拍に切る", ex: ["choice", "join", "point"] },
    "ju": { kana: "ユー", lips: "「イ」の形から、唇を突き出して「ウー」", tongue: "舌の前を上あごに近づけてから奥へ", voice: "声を出し、「ウー」を長めに", ng: "唇が平たいまま「ユ」で終わる", ex: ["use", "few", "human"] },
    "ə": { kana: "ア（あいまいに弱く）", lips: "力を抜いて、少しだけ開ける", tongue: "真ん中に置いたまま、どこにも力を入れない", voice: "とても短く、弱く", ng: "はっきり「ア」「オ」と読むと、強く読む場所がずれる", ex: ["about", "the", "data"] },
    "ɝ": { kana: "アー（r の響き）", lips: "少しすぼめる", tongue: "舌先を少し持ち上げて奥へ反らす（どこにも付けない）", voice: "長めに。最初から最後まで r の響き", ng: "「アー」だけで終わる（work が「ワーク」に）", ex: ["work", "first", "learn"] },
    "ɚ": { kana: "ア（弱い r の響き）", lips: "少しすぼめる", tongue: "ɝ と同じく奥へ反らす（どこにも付けない）", voice: "短く、弱く", ng: "「アー」で終わると r が消える（user が「ユーザー」に）", ex: ["user", "later", "never"] },
    // 子音
    "p": { kana: "パ行（息を強く）", lips: "上下の唇をしっかり閉じてから開く", tongue: "関係なし", voice: "息だけ（声なし）。語頭はパッと息が出るくらい強く", ng: "息が弱いと b に聞こえる", ex: ["put", "apps", "help"] },
    "b": { kana: "バ行", lips: "上下の唇を閉じてから開く", tongue: "関係なし", voice: "閉じている間から喉を震わせる", ng: "語末で「ブ」と母音を付ける", ex: ["big", "job", "number"] },
    "t": { kana: "タ行（息を強く）", lips: "関係なし", tongue: "舌先を上の歯ぐき（前歯の付け根の少し奥の盛り上がり）に付けて離す", voice: "息だけ。語頭は強く。母音にはさまれると軽く弾く音でよい（water）", ng: "語末に「オ」を付けて「ト」にする", ex: ["time", "talk", "get"] },
    "d": { kana: "ダ行", lips: "関係なし", tongue: "舌先を上の歯ぐきに付けて離す（t と同じ位置）", voice: "舌を付けている間から喉を震わせる（喉に指を当てると分かる）", ng: "声が遅れると t に、語末で「ド」と母音を付ける", ex: ["day", "need", "did"] },
    "k": { kana: "カ行（息を強く）", lips: "関係なし", tongue: "舌の奥を上あごの奥（やわらかい所）に付けて離す", voice: "息だけ。語頭は強く", ng: "語末に「ウ」を付けて「ク」にする", ex: ["can", "like", "click"] },
    "g": { kana: "ガ行", lips: "関係なし", tongue: "舌の奥を上あごの奥に付けて離す（k と同じ位置）", voice: "付けている間から喉を震わせる", ng: "語中で鼻にかかった「ンガ」にする。語末で「グ」", ex: ["go", "big", "again"] },
    "m": { kana: "ム（唇を閉じたまま）", lips: "唇をしっかり閉じる", tongue: "関係なし", voice: "鼻から声を出す。語末も唇を閉じて終える", ng: "語末で唇を開けて「ム」にする", ex: ["me", "team", "time"] },
    "n": { kana: "ン（舌先は上）", lips: "関係なし", tongue: "舌先を上の歯ぐきに付けたまま", voice: "鼻から声を出す。語末も舌を付けたまま終える", ng: "日本語の「ン」は舌が離れて、ŋ や鼻にかかった母音になる", ex: ["no", "ten", "plan"] },
    "ŋ": { kana: "ング（グは言わない）", lips: "関係なし", tongue: "舌の奥を上あごの奥に付けたまま", voice: "鼻から声を出す。舌を離して「グ」を付けない", ng: "「グ」を足す、または舌先の n になる（thing が thin に）", ex: ["sing", "thing", "meeting"] },
    "f": { kana: "フ（唇に歯を当てる）", lips: "上の前歯を下唇の内側に軽く当てる", tongue: "関係なし", voice: "息だけを、歯と唇のすき間から出す", ng: "日本語の「フ」は両唇から息が出て h に近い", ex: ["file", "for", "half"] },
    "v": { kana: "ヴ", lips: "上の前歯を下唇の内側に軽く当てる（f と同じ）", tongue: "関係なし", voice: "声を出す。唇がビリビリ震える", ng: "唇を閉じると b になる", ex: ["very", "value", "have"] },
    "θ": { kana: "ス（舌先を歯に当てて）", lips: "関係なし", tongue: "舌先を上の前歯の先に軽く当てる（歯の間から少し見えてよい）", voice: "息だけを、舌と歯のすき間から出す", ng: "舌が歯から離れて s、または t になる", ex: ["think", "three", "month"] },
    "ð": { kana: "ズ（舌先を歯に当てて）", lips: "関係なし", tongue: "舌先を上の前歯の先に軽く当てる（θ と同じ）", voice: "声を出す。舌先がくすぐったく震える", ng: "z や d になる（the が「ザ」「ダ」に）", ex: ["the", "this", "other"] },
    "s": { kana: "ス（ウを付けない）", lips: "軽く横に引く", tongue: "舌先を上の歯ぐきに近づけ、細いすき間を作る（付けない）", voice: "息だけを鋭く", ng: "後ろに「ウ」を付ける。si を「シ」にすると ʃ に聞こえる", ex: ["see", "sit", "facts"] },
    "z": { kana: "ズ（ウを付けない）", lips: "軽く横に引く", tongue: "s と同じ。舌先は付けない", voice: "声を出し、虫の羽音のように「ズー」と続ける", ng: "舌を付けて「ヅ」にする、または声が消えて s になる（is・語末の -s）", ex: ["is", "busy", "uses"] },
    "ʃ": { kana: "シュ", lips: "唇を丸めて前に突き出す", tongue: "s より少し奥に引き、上あごに近づける（付けない）", voice: "息だけ", ng: "唇が平たいと s に近くなる", ex: ["she", "share", "action"] },
    "ʒ": { kana: "ジュ（舌は付けない）", lips: "唇を丸めて前に突き出す", tongue: "ʃ と同じ。舌は付けない", voice: "声を出して続ける", ng: "舌を付けて dʒ にする", ex: ["usually", "measure", "vision"] },
    "h": { kana: "ハ行（息だけ）", lips: "次の母音の形にしておく", tongue: "次の母音の形にしておく", voice: "喉から息だけを出す", ng: "who などで唇を近づけすぎると f に聞こえる。弱すぎると消える", ex: ["help", "how", "who"] },
    "tʃ": { kana: "チ（息を強く）", lips: "少し前に突き出す", tongue: "舌先を歯ぐきに付けてから、ʃ のすき間へ離す", voice: "息だけ", ng: "語末に「イ」「ウ」を付ける", ex: ["check", "each", "chat"] },
    "dʒ": { kana: "ヂ", lips: "少し前に突き出す", tongue: "舌先を歯ぐきに付けてから、ʒ のすき間へ離す", voice: "付けている間から喉を震わせる", ng: "舌を付けずに ʒ にする。語末で「ジ」と母音を付ける", ex: ["job", "page", "just"] },
    "l": { kana: "ル（舌先は上に付けたまま）", lips: "関係なし", tongue: "舌先を上の歯ぐきに押し付けたまま、舌の両側から声を出す。語末の l は舌の奥も持ち上げる", voice: "声を出す。語末は「ウ」に近い響きでよい", ng: "舌先で弾くと日本語の「ラ」になり、r との区別がなくなる", ex: ["light", "will", "feel"] },
    "r": { kana: "ゥル（舌はどこにも付けない）", lips: "少しすぼめる（「ゥ」の形から始める）", tongue: "舌先をどこにも付けず、少し奥へ反らす（舌の奥を盛り上げてもよい）", voice: "声を出す", ng: "舌先で歯ぐきを弾くと日本語の「ラ」になり、l に聞こえる", ex: ["red", "right", "very"] },
    "w": { kana: "ウ（すぼめてから開く）", lips: "強くすぼめて前に突き出し、次の母音へ一気に開く", tongue: "舌の奥を上げる", voice: "声を出す", ng: "すぼめが弱いと消える（would が「ウッド」に）", ex: ["we", "work", "would"] },
    "j": { kana: "ヤ行の頭のイ", lips: "軽く横に", tongue: "舌の前を上あごに近づけた「イ」の形から、次の母音へ動かす", voice: "声を出す", ng: "抜けると year が ear に聞こえる", ex: ["yes", "you", "year"] },
  };
  PHONEME_TIPS["ɛ"] = "日本語の「エ」より口を少し大きく開けて、短く「エ」（get, every）";
  PHONEME_TIPS["ju"] = "「イ」の形から唇を突き出して「ウー」（use, few）";

  /** Azure の IPA の表記ゆれをそろえる（ɹ→r、ɡ→g、強勢・長音の記号を除く） */
  function normPh(ph) {
    return String(ph || "").replace(/[ˈˌː]/g, "").replace(/ɹ/g, "r").replace(/ɡ/g, "g");
  }

  /** r の響きの付いた母音（ɑɹ・ɪɹ など）は、母音の口の形のあとに r を足す */
  const R_TAIL = "最後に舌先を奥へ反らして、r の響きで終える（舌はどこにも付けない）";
  function guideKey(ph) {
    const k = normPh(ph);
    if (PHONEME_GUIDE[k]) return { k };
    if (k.length > 1 && k.endsWith("r") && PHONEME_GUIDE[k.slice(0, -1)]) return { k: k.slice(0, -1), r: true };
    return null;
  }
  /** 音の口の形。見つからない音は null */
  function guideFor(ph) {
    const g = guideKey(ph);
    if (!g) return null;
    const x = PHONEME_GUIDE[g.k];
    return g.r ? { ...x, kana: x.kana + "＋r", voice: x.voice + "。" + R_TAIL } : { ...x };
  }
  /** 短いコツ（1行）。表記ゆれや r 付き母音も引ける */
  function tipFor(ph) {
    const g = guideKey(ph);
    if (!g) return PHONEME_TIPS[ph] || DEFAULT_TIP;
    const t = PHONEME_TIPS[g.k] || DEFAULT_TIP;
    return g.r ? t + "。" + R_TAIL : t;
  }

  /**
   * 「お手本の音」が「別の音」に聞こえたときの直し方。キーは "お手本>聞こえた音"（normPh 済み）。
   * 日本語話者に多い組み合わせだけを置き、無い組み合わせは null（口の形の説明だけを出す）。
   */
  const CONTRAST_TIPS = {
    "d>t": "声が出ていません。喉に指を当て、舌を離す前から震えているか確かめる。語末の d は、前の母音を少し長めにすると伝わる",
    "t>d": "息が足りません。語頭は「ッ」と強く息を出す（口の前のティッシュが揺れるくらい）。母音にはさまれた t なら d に近くても自然",
    "z>s": "声が消えています。「ズー」と喉を震わせて伸ばしてから単語に戻す。語末の -s・is・was で起きやすい",
    "s>z": "声が出ています。喉を止めて、息だけで「スー」",
    "s>ʃ": "唇を丸めず横に引き、舌先を前の歯ぐきへ戻す（see が she に聞こえる）",
    "ʃ>s": "唇を丸めて前に突き出し、舌を少し奥に引く",
    "z>dʒ": "舌を付けずに、すき間から「ズー」と続ける",
    "z>d": "舌を付けずに、すき間から「ズー」と続ける",
    "ʒ>dʒ": "舌を付けずに、すき間から「ジュー」と続ける",
    "θ>s": "舌先が歯から離れています。舌先を上の前歯の先に当てたまま息を出す",
    "θ>t": "舌先を歯の先に当てたまま、止めずに息を流し続ける",
    "θ>f": "唇ではなく、舌先と上の前歯で息のすき間を作る",
    "ð>z": "舌先が歯から離れています。舌先を上の前歯の先に当てたまま声を出す",
    "ð>d": "舌先を歯の先に当てたまま、止めずに声を流し続ける",
    "f>h": "上の前歯を下唇に当ててから息を出す（唇だけで「フ」にしない）",
    "f>p": "唇を閉じず、上の前歯を下唇に当てて息を流し続ける",
    "v>b": "唇を閉じず、上の前歯を下唇に当てて声を流し続ける",
    "b>v": "上下の唇をしっかり閉じてから開く",
    "r>l": "舌先が歯ぐきに付いています。舌をどこにも付けず、唇をすぼめた「ゥ」から始める",
    "l>r": "舌先を上の歯ぐきにしっかり押し付けたまま声を出す",
    "n>ŋ": "舌先を上の歯ぐきに付けて終える（舌の奥で終えない）",
    "ŋ>n": "舌先ではなく、舌の奥を上あごの奥に付けて終える。「グ」は足さない",
    "m>n": "語末でも唇をしっかり閉じて終える",
    "w>u": "唇をすぼめたら、次の母音へ一気に開く",
    "æ>ɛ": "口をもっと縦にも開け、舌を下げる（「エ」のままにしない）",
    "æ>ʌ": "口を横にも大きく開け、「エ」寄りの「ア」にする",
    "æ>ɑ": "喉の奥ではなく、口の前で平たく響かせる。口を横にも開ける",
    "ʌ>ɑ": "口を開けすぎです。軽く開けて、短く力を抜いた「ア」",
    "ɑ>ʌ": "口をもっと縦に大きく開け、喉の奥で長めに",
    "ɑ>æ": "唇を横に引かず、縦に開けて喉の奥で響かせる",
    "i>ɪ": "唇を横に強く引き、少し長めに張った「イー」",
    "ɪ>i": "力を抜いて、短く緩い「イ」（「エ」に少し寄せる）",
    "u>ʊ": "唇を強く突き出し、長めに「ウー」",
    "ʊ>u": "唇を突き出さず、短く緩い「ウ」",
    "eɪ>ɛ": "「エ」で止めず、「イ」まで動かす",
    "oʊ>ɔ": "「オ」で止めず、唇をすぼめて「ウ」まで動かす",
    "ɝ>ʌ": "舌先を奥へ反らしたまま「アー」と言う。最初から r の響きを付ける",
    "ɝ>ɑ": "舌先を奥へ反らしたまま「アー」と言う。最初から r の響きを付ける",
    "ɚ>ə": "最後に舌先を奥へ反らして、r の響きで終える",
  };
  function contrastTip(expected, heard) {
    if (!heard) return null;
    return CONTRAST_TIPS[normPh(expected) + ">" + normPh(heard)] || null;
  }

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
      hints.push({ kind: "phoneme", ph: e.ph, words: e.words.slice(0, 3), score: e.score, tip: tipFor(e.ph), guide: guideFor(e.ph) });
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
        // [音, 点] に加えて、話された音の第1候補がお手本と違うときだけ3つ目に入れる（nBestPhonemeCount を指定したときだけ返る）
        ph: (w.Phonemes || []).map((p) => {
          const pa = p.PronunciationAssessment || {};
          const top = (pa.NBestPhonemes || [])[0];
          const e = [p.Phoneme, Math.round(pa.AccuracyScore ?? 0)];
          if (top && top.Phoneme && top.Phoneme !== p.Phoneme) e.push(top.Phoneme);
          return e;
        }),
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

  /* ---------- 単語の発音練習：シャドーイングでつまずいた単語を、単語だけで評価する ---------- */
  const normWord = (s) => String(s || "").toLowerCase().replace(/[^a-z']/g, "");
  /**
   * r：parsePron の結果（お手本はその単語1語）。合格は、その単語が採点の厳しさで「良い」（ok）のとき。
   * 流暢さ・完全さは1語では意味が薄いので使わない。
   * @returns {{acc:number|null, pass:boolean, level:string, ph:Array, weak:Array<{ph:string,score:number,heard?:string,tip:string}>}|null}
   */
  function wordDrill(r, target, name = "strict") {
    const L = level(name);
    const words = (r && r.words) || [];
    const t = normWord(target);
    const ref = words.filter((x) => x.err !== "Insertion");
    // お手本はまとまり（数語）。その単語が見つからないときだけ、お手本が1語なら代わりに使う
    const w = ref.find((x) => normWord(x.w) === t) || (ref.length === 1 ? ref[0] : null);
    if (!w) return null;
    const c = wordClass(w, name);
    const weak = (w.ph || []).filter(([, a]) => a < L.ok).sort((a, b) => a[1] - b[1]).slice(0, 2)
      .map(([ph, score, heard]) => ({ ph, score, ...(heard ? { heard, fix: contrastTip(ph, heard) } : {}), tip: tipFor(ph), guide: guideFor(ph) }));
    return { acc: c === "omit" ? 0 : w.acc, pass: c === "ok", level: c === "omit" ? "ng" : c, ph: w.ph || [], weak };
  }

  /**
   * 単語練習のお手本：その単語を含む、文の中の短いまとまり（前後1語ずつ。短ければもう1語足して最大4語）。
   * 発音評価はお手本が1語だけだと聞き取れないことがあるため（2026-11-10 確認）、まとまりで言ってもらい、採点は単語だけにする。
   * @returns {string} お手本の文字列（見つからなければ単語そのもの）
   */
  function drillChunk(sentence, word) {
    const toks = String(sentence || "").split(/\s+/).filter(Boolean);
    const t = normWord(word);
    const i = toks.findIndex((x) => normWord(x) === t);
    if (i < 0 || toks.length < 2) return String(word || "");
    let a = Math.max(0, i - 1), b = Math.min(toks.length - 1, i + 1);
    const letters = () => toks.slice(a, b + 1).join("").replace(/[^A-Za-z]/g, "").length;
    if (letters() < 12 && b - a < 3) { if (b < toks.length - 1) b++; else if (a > 0) a--; }
    // 文頭・文末の記号は落とす（語の中のアポストロフィ・ハイフンは残す）
    return toks.slice(a, b + 1).join(" ").replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, "");
  }

  /**
   * 録音の中身を数値にする（診断用）。16kHz の Int16Array の配列を受け取り、20ms ごとの音量から求める。
   * noiseDb：静かな部分の音量（下から20%）、speechDb：声の部分の音量（上から5%）、snr：その差、
   * voicedSec：声のある時間（雑音より12dB以上大きい区間）、leadSec／tailSec：声の前後の無音、clipPct：音割れの割合
   */
  function audioProfile(chunks, rate = 16000) {
    const F = Math.round(rate * 0.02);
    const frames = [];
    let acc = 0, n = 0, clip = 0, total = 0;
    for (const c of chunks || []) {
      for (let i = 0; i < c.length; i++) {
        const v = c[i] / 32768;
        if (c[i] >= 32767 || c[i] <= -32768) clip++;
        total++;
        acc += v * v; n++;
        if (n === F) { frames.push(10 * Math.log10(Math.max(acc / n, 1e-12))); acc = 0; n = 0; }
      }
    }
    if (!frames.length) return null;
    const sorted = [...frames].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const noiseDb = q(0.2), speechDb = q(0.95);
    const th = noiseDb + 12;
    const voiced = frames.map((d) => d >= th);
    const first = voiced.indexOf(true), last = voiced.lastIndexOf(true);
    const sec = (k) => +(k * 0.02).toFixed(2);
    return {
      noiseDb: Math.round(noiseDb), speechDb: Math.round(speechDb), snr: Math.round(speechDb - noiseDb),
      voicedSec: sec(voiced.filter(Boolean).length),
      leadSec: first < 0 ? sec(frames.length) : sec(first), tailSec: last < 0 ? 0 : sec(frames.length - 1 - last),
      clipPct: +((clip / Math.max(total, 1)) * 100).toFixed(2),
    };
  }

  /* ---------- 定着率（改善5）：7日以上あけた復習で、覚えていた割合 ---------- */
  /** 週の始まり（月曜）の日付 "YYYY-MM-DD"（端末の時刻＝日本時間で区切る） */
  function weekStart(now = Date.now()) {
    const d = new Date(startOfDay(now));
    const back = (d.getDay() + 6) % 7; // 月曜からの日数
    return ymd(d.getTime() - back * DAY);
  }
  const MATURE_DAYS = 7;
  /**
   * 復習の結果を週ごとの記録に足す。前回の間隔が7日以上の復習だけを数える（日をあけても覚えていたか）。
   * log：{ "YYYY-MM-DD"(週): { word|sentence|compose|dict: { n, ok } } }。12週より古い週は消す。数えたら true
   */
  function recordRetention(log, kind, prev, grade, now = Date.now()) {
    if (!prev || (prev.interval || 0) < MATURE_DAYS) return false;
    const wk = weekStart(now);
    const b = (log[wk] = log[wk] || {});
    const x = (b[kind] = b[kind] || { n: 0, ok: 0 });
    x.n++;
    if (grade !== "again") x.ok++;
    for (const k of Object.keys(log).sort().slice(0, -12)) delete log[k];
    return true;
  }
  /** 直近 weeks 週の定着率を種類ごとと合計で。rate は 0〜100（回数 0 なら null） */
  function retentionSummary(log, weeks = 4, now = Date.now()) {
    const since = ymd(new Date(weekStart(now) + "T00:00:00").getTime() - (weeks - 1) * 7 * DAY);
    const kinds = {}, total = { n: 0, ok: 0 };
    for (const [wk, b] of Object.entries(log || {})) {
      if (wk < since) continue;
      for (const [k, x] of Object.entries(b)) {
        kinds[k] = kinds[k] || { n: 0, ok: 0 };
        kinds[k].n += x.n; kinds[k].ok += x.ok; total.n += x.n; total.ok += x.ok;
      }
    }
    const rate = (x) => (x.n ? Math.round((x.ok / x.n) * 100) : null);
    return { since, total: { ...total, rate: rate(total) }, kinds: Object.fromEntries(Object.entries(kinds).map(([k, x]) => [k, { ...x, rate: rate(x) }])) };
  }

  /* ---------- 苦手な音（Phase 3c）：発音の記録から、音ごとの平均点を集計する ---------- */
  /**
   * attempts：発音の記録（{ sentenceId, words: [{ w, err, ph: [[音, 点], ...] }] }）
   * 音ごとに平均点・回数・つまずいた単語（平均点の低い順）・その音が出てきた文を集め、平均点の低い順に top 件。
   * 回数が minCount 未満の音は、たまたまの結果かもしれないので除く。言い落とし・余分な語は数えない
   */
  function weakSounds(attempts, { minCount = 5, top = 3, maxWords = 5 } = {}) {
    const agg = new Map();
    for (const a of attempts || []) for (const w of a.words || []) {
      if (!w || w.err === "Omission" || w.err === "Insertion" || !Array.isArray(w.ph)) continue;
      const word = String(w.w || "").toLowerCase().replace(/[^a-z']/g, "");
      for (const [ph, sc] of w.ph) {
        if (!ph || typeof sc !== "number") continue;
        if (!agg.has(ph)) agg.set(ph, { ph, sum: 0, n: 0, words: new Map(), sentences: new Set() });
        const e = agg.get(ph);
        e.sum += sc; e.n++;
        if (a.sentenceId) e.sentences.add(a.sentenceId);
        if (word) { const x = e.words.get(word) || { w: word, sum: 0, n: 0 }; x.sum += sc; x.n++; e.words.set(word, x); }
      }
    }
    return [...agg.values()].filter((e) => e.n >= minCount)
      .map((e) => ({
        ph: e.ph, n: e.n, avg: Math.round(e.sum / e.n), tip: tipFor(e.ph), guide: guideFor(e.ph),
        words: [...e.words.values()].map((x) => ({ w: x.w, avg: Math.round(x.sum / x.n), n: x.n })).sort((p, q) => p.avg - q.avg || q.n - p.n).slice(0, maxWords),
        sentenceIds: [...e.sentences],
      }))
      .sort((p, q) => p.avg - q.avg || q.n - p.n)
      .slice(0, top);
  }

  /* ---------- ディクテーション（Phase 3b）：聞いて書き取った文と、お手本を単語単位で比べる ---------- */
  const NUMS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  const CONTRACT = [[/\bi'm\b/g, "i am"], [/\b(you|we|they)'re\b/g, "$1 are"], [/\b(he|she|it|that|there|what|who|where|here)'s\b/g, "$1 is"], [/\bcan't\b/g, "cannot"], [/\bwon't\b/g, "will not"], [/\b(\w+)n't\b/g, "$1 not"], [/\b(i|you|we|they)'ve\b/g, "$1 have"], [/\b(i|you|we|they|he|she|it|that)'ll\b/g, "$1 will"], [/\b(i|you|we|they|he|she)'d\b/g, "$1 would"], [/\blet's\b/g, "let us"]];
  /** 比べやすい単語の並びにする：小文字、短縮形を展開、ハイフンを詰める（Wi-Fi = wifi）、数字は英単語に（20まで）、記号を除く */
  function dictTokens(text) {
    let t = String(text || "").toLowerCase().replace(/[’‘]/g, "'").replace(/(\w)-(\w)/g, "$1$2");
    t = CONTRACT.reduce((x, [re, rep]) => x.replace(re, rep), t);
    return t.replace(/[^a-z0-9' ]/g, " ").split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean)
      .map((w) => (/^\d+$/.test(w) && +w <= 20 ? NUMS[+w] : w));
  }
  /**
   * 書き取った答えとお手本の比較（最長共通部分列）。
   * model：お手本の単語ごとに ok（書けた）／miss（抜け・違い）、extra：お手本にない語、score：書けた割合（0〜100）
   */
  function dictationDiff(answer, model) {
    const a = dictTokens(answer), m = dictTokens(model);
    const L = Array.from({ length: m.length + 1 }, () => new Array(a.length + 1).fill(0));
    for (let i = m.length - 1; i >= 0; i--) for (let j = a.length - 1; j >= 0; j--)
      L[i][j] = m[i] === a[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [], extra = [];
    let i = 0, j = 0;
    while (i < m.length && j < a.length) {
      if (m[i] === a[j]) { out.push({ w: m[i], ok: true }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ w: m[i], ok: false }); i++; }
      else { extra.push(a[j]); j++; }
    }
    while (i < m.length) out.push({ w: m[i++], ok: false });
    while (j < a.length) extra.push(a[j++]);
    const okCount = out.filter((x) => x.ok).length;
    // 余分な語も減点（お手本の語数を分母に、余分の半分を差し引く）
    const score = m.length ? Math.max(0, Math.round(((okCount - extra.length * 0.5) / m.length) * 100)) : 0;
    return { model: out, extra, score, total: m.length, okCount };
  }
  /** 書けた割合から復習の評価：100 → good、80以上 → hard、それ未満 → again */
  const dictationGrade = (score) => (score >= 100 ? "good" : score >= 80 ? "hard" : "again");

  return { PAUSE_NEW_AT, capNew, isReverse, cloze, meaningChoices, matchSpoken, DAY, startOfDay, ymd, weekStart, recordRetention, retentionSummary, nextState, applyTalkUse, pickSpacedWords, weakSounds, dictTokens, dictationDiff, dictationGrade, interleave, buildQueue, gradeFromScore, parsePron, wordClass, judgeScore, pronFeedback, wordDrill, drillChunk, audioProfile, PHONEME_TIPS, PHONEME_GUIDE, normPh, guideFor, tipFor, contrastTip, STRICTNESS };
});
