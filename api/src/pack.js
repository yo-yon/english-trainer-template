// 共通の教材パック（v0.19.0）：公開リポジトリ yo-yon/english-trainer-content の週ごとのパックを検査して、取り込む形にする。
// 字幕ログには頼らない一般的な教材だけが入る。このファイルは english-trainer・english-trainer-template の api/src/pack.js と
// english-trainer-content の tools/pack-rules.cjs に同じものを置く（規則を変えるときは3つとも同じ作業で直す）。
const FORMAT = 1;
const LIMITS = { words: 100, sentences: 60, scenes: 10, text: 400, bytes: 1024 * 1024, packsPerPull: 8 };
const SCENE_GROUPS = ["カンファレンス", "旅行・日常", "職場・オンライン会議"];
const SCENES = ["セッション", "質疑応答", "聞き返し", "雑談", "自己紹介", "ネットワーキング", "会場での移動・食事", "セッションの感想を話す", "ブースで質問する",
  "空港・入国", "ホテル", "レストラン・カフェ", "買い物", "交通・道案内", "体調・薬局", "職場の雑談", "電話・予約"];
const DEFAULT_FEED = "https://raw.githubusercontent.com/yo-yon/english-trainer-content/main/index.json";

const wordId = (w) => String(w).trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-']/g, "");
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const isStr = (v, min = 1) => typeof v === "string" && v.trim().length >= min && v.length <= LIMITS.text;
const hasJa = (s) => /[぀-ヿ一-鿿]/.test(s);
const PACK_ID = /^(\d{4})-W(\d{2})$/;

/** パックの ID（2026-W47）から、文・場面の ID の頭（k2026w47）と、出題順の基準を作る */
function packKeys(id) {
  const m = PACK_ID.exec(String(id || ""));
  if (!m) return null;
  return { prefix: `k${m[1]}w${m[2]}`, base: (Number(m[1]) * 100 + Number(m[2])) * 1000 };
}

function checkWord(w) {
  const e = [];
  if (!w || typeof w !== "object") return ["単語がオブジェクトではありません"];
  if (!isStr(w.word) || !/^[A-Za-z][A-Za-z0-9 '\-]*$/.test(w.word)) e.push("word は英字で書く");
  if (!["tech", "general"].includes(w.category)) e.push("category は tech か general");
  for (const k of ["meaning", "translation", "stressNote", "tip"]) if (!isStr(w[k]) || !hasJa(w[k])) e.push(`${k} は日本語で書く`);
  if (!isStr(w.pos) || !hasJa(w.pos)) e.push("pos は日本語の品詞");
  if (!isStr(w.ipa) || !/^\/[^/]+\/$/.test(w.ipa)) e.push("ipa は /…/ で囲む");
  const syl = isStr(w.stress) ? w.stress.split(/[- ]/).filter(Boolean) : [];
  if (!syl.length || /[^A-Za-z\- ]/.test(w.stress) || syl.filter((p) => /[A-Z]/.test(p) && p === p.toUpperCase()).length !== 1) e.push("stress は強く読む音節を1つだけ大文字に");
  if (!isStr(w.example, 10) || !/[.?!]$/.test(w.example.trim())) e.push("example は英文で、. ? ! で終える");
  else {
    const first = norm(w.word).split(" ")[0];
    if (!norm(w.example).includes(first.slice(0, Math.max(3, first.length - 2)))) e.push(`example に「${w.word}」が入っていない`);
  }
  if (!Array.isArray(w.synonyms) || w.synonyms.length < 1 || w.synonyms.length > 5 || !w.synonyms.every((s) => isStr(s))) e.push("synonyms は1〜5語の配列");
  if (!isStr(w.source)) e.push("source が空");
  return e;
}

function checkSentence(s) {
  const e = [];
  if (!s || typeof s !== "object") return ["文がオブジェクトではありません"];
  if (!isStr(s.text) || hasJa(s.text) || !/[.?!]$/.test(s.text.trim())) e.push("text は英文で、. ? ! で終える");
  else {
    const n = s.text.trim().split(/\s+/).length;
    if (n < 4 || n > 25) e.push(`text は4〜25語（${n}語）`);
  }
  if (!isStr(s.ja) || !hasJa(s.ja)) e.push("ja は日本語訳");
  if (!["conference", "conversation"].includes(s.category)) e.push("category は conference か conversation");
  if (!SCENES.includes(s.scene)) e.push("scene が決まった場面の名前ではない");
  if (s.category === "conference" && s.scene !== "セッション") e.push("conference の scene は「セッション」");
  if (!Array.isArray(s.focus) || !s.focus.length || !s.focus.every((f) => isStr(f) && norm(s.text || "").includes(norm(f).split(" ")[0]))) e.push("focus は text に含まれる表現の配列");
  if (!isStr(s.source)) e.push("source が空");
  return e;
}

function checkScene(sc) {
  const e = [];
  if (!sc || typeof sc !== "object") return ["場面がオブジェクトではありません"];
  const en = (k, min = 10) => { if (!isStr(sc[k], min) || hasJa(sc[k])) e.push(`${k} は英語で書く`); };
  if (!SCENE_GROUPS.includes(sc.group)) e.push("group が決まった分野ではない");
  if (!isStr(sc.title) || !hasJa(sc.title) || sc.title.length > 20) e.push("title は日本語で20文字以内");
  if (!isStr(sc.emoji) || sc.emoji.length > 8) e.push("emoji は絵文字1つ");
  en("role"); en("setting"); en("goal"); en("opener", 5);
  if (isStr(sc.opener) && !/[.?!]$/.test(sc.opener.trim())) e.push("opener は . ? ! で終える");
  if (!isStr(sc.opener_ja) || !hasJa(sc.opener_ja)) e.push("opener_ja は日本語訳");
  if (!isStr(sc.goal_ja) || !hasJa(sc.goal_ja)) e.push("goal_ja は日本語");
  if (!Array.isArray(sc.phrases) || sc.phrases.length < 3 || sc.phrases.length > 5 || !sc.phrases.every((p) => p && isStr(p.en) && !hasJa(p.en) && isStr(p.ja) && hasJa(p.ja))) e.push("phrases は3〜5個の { en, ja }");
  if (!Array.isArray(sc.twists) || sc.twists.length < 2 || sc.twists.length > 4 || !sc.twists.every((t) => isStr(t, 10) && !hasJa(t))) e.push("twists は2〜4個の英文");
  if (!Array.isArray(sc.targets) || sc.targets.length < 1 || sc.targets.length > 3 || !sc.targets.every((t) => isStr(t))) e.push("targets は1〜3個");
  return e;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const WORD_KEYS = ["word", "category", "meaning", "pos", "ipa", "stress", "stressNote", "example", "translation", "synonyms", "tip", "source"];
const SENT_KEYS = ["text", "ja", "category", "scene", "focus", "source"];
const SCENE_KEYS = ["group", "title", "emoji", "role", "setting", "goal", "goal_ja", "opener", "opener_ja", "phrases", "twists", "targets"];

/**
 * パックを検査し、Table に書く形にする。1つでも不備があればパック全体を取り込まない（{ errors }）。
 * 単語の ID は単語から作り直す（同じ単語は、どのパック・自分の教材とも同じ ID になり、二重に出ない）。
 */
function cleanPack(p, expectId) {
  const errors = [];
  if (!p || typeof p !== "object") return { errors: ["パックがオブジェクトではありません"] };
  if (p.format !== FORMAT) errors.push(`format は ${FORMAT}`);
  const keys = packKeys(p.id);
  if (!keys) errors.push("id は 2026-W47 の形");
  if (expectId && p.id !== expectId) errors.push("一覧とパックの id が違う");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.published || ""))) errors.push("published は YYYY-MM-DD");
  const arr = (x) => (Array.isArray(x) ? x : null);
  const ws = arr(p.words), ss = arr(p.sentences), cs = arr(p.scenes) || [];
  if (!ws || !ss) errors.push("words・sentences は配列");
  if (ws && ws.length > LIMITS.words) errors.push(`words は${LIMITS.words}件まで`);
  if (ss && ss.length > LIMITS.sentences) errors.push(`sentences は${LIMITS.sentences}件まで`);
  if (cs.length > LIMITS.scenes) errors.push(`scenes は${LIMITS.scenes}件まで`);
  if (errors.length) return { errors };

  const words = [], sentences = [], scenes = [], seen = new Set();
  ws.forEach((w, i) => {
    const e = checkWord(w);
    if (e.length) return errors.push(`単語${i + 1}（${w && w.word}）：${e.join("、")}`);
    const id = wordId(w.word);
    if (seen.has(id)) return errors.push(`単語「${w.word}」が重複`);
    seen.add(id);
    words.push({ ...pick(w, WORD_KEYS), id, order: keys.base + i, added: p.published, pack: p.id });
  });
  ss.forEach((s, i) => {
    const e = checkSentence(s);
    if (e.length) return errors.push(`文${i + 1}：${e.join("、")}`);
    if (s.id !== `${keys.prefix}-s${String(i + 1).padStart(2, "0")}`) return errors.push(`文${i + 1} の id は ${keys.prefix}-s${String(i + 1).padStart(2, "0")}`);
    sentences.push({ ...pick(s, SENT_KEYS), id: s.id, order: keys.base + i, added: p.published, pack: p.id });
  });
  cs.forEach((c, i) => {
    const e = checkScene(c);
    if (e.length) return errors.push(`場面${i + 1}：${e.join("、")}`);
    if (c.id !== `${keys.prefix}-c${i + 1}`) return errors.push(`場面${i + 1} の id は ${keys.prefix}-c${i + 1}`);
    scenes.push({ ...pick(c, SCENE_KEYS), id: c.id, added: p.published, pack: p.id });
  });
  if (errors.length) return { errors };
  return { words, sentences, scenes };
}

/** 一覧（index.json）を検査し、まだ取り込んでいないパックを古い順に返す */
function pendingPacks(index, imported) {
  if (!index || index.format !== FORMAT || !Array.isArray(index.packs)) return { error: "index" };
  const done = new Set(imported || []);
  const list = index.packs
    .filter((x) => x && packKeys(x.id) && typeof x.file === "string" && /^packs\/\d{4}-W\d{2}\.json$/.test(x.file) && !done.has(x.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { packs: list.slice(0, LIMITS.packsPerPull), more: list.length > LIMITS.packsPerPull };
}

/** パックの URL：一覧と同じ場所の packs/ だけを許す（ほかのサイトは読まない） */
function packUrl(feedUrl, file) {
  const u = new URL(file, feedUrl);
  const base = new URL(".", feedUrl);
  if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) throw new Error("pack url");
  return u.toString();
}

/** 前回の確認から7日たったか（自動の取り込み） */
const dueForCheck = (last, now = Date.now()) => !last || now - Date.parse(last) >= 7 * 24 * 3600 * 1000;

module.exports = { cleanPack, pendingPacks, packUrl, packKeys, dueForCheck, wordId, DEFAULT_FEED, LIMITS, FORMAT, SCENE_GROUPS, SCENES };
