(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const S = window.SRS;
const APP_VERSION = "0.6.0";
const SPK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/></svg>';
const SLOW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="3"/></svg>';
const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

/* ---------- 状態 ---------- */
let data = { words: [], sentences: [], cards: { word: {}, sentence: {} }, settings: {} };
let loaded = false;
const defaults = { newPerDay: 10, newSentencesPerDay: 5, newLog: { date: "", count: 0 }, newSentLog: { date: "", count: 0 }, quiz: { total: 0, correct: 0 }, hideText: false, strictness: "strict" };
const st = () => data.settings;

/* ---------- 共通 ---------- */
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function showBanner(t) { const b = $("banner"); b.textContent = t; b.hidden = !t; }
async function api(path, opt = {}) {
  const r = await fetch("/api/" + path, { headers: { "Content-Type": "application/json" }, ...opt });
  if (r.status === 401 || r.status === 403) { location.href = "/login"; throw new Error("auth"); }
  if (!r.ok) throw Object.assign(new Error("api " + r.status), { status: r.status });
  if (r.status === 204) return null;
  try { return await r.json(); } catch (e) { return null; }
}
/* 保存は順番に流す（スマホとPCの同期はサーバー側の最新が正） */
let chain = Promise.resolve();
function queueSave(fn) {
  chain = chain.then(fn).catch(() => showBanner("保存できませんでした。通信状況を確認してから、もう一度操作してください。"));
}
function saveCard(kind, id) { const c = data.cards[kind][id]; queueSave(() => api(`card/${kind}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(c) })); }
let settingsTimer = null;
function saveSettings() { clearTimeout(settingsTimer); settingsTimer = setTimeout(() => queueSave(() => api("settings", { method: "PUT", body: JSON.stringify(st()) })), 400); }
function bumpLog(key) { const today = S.ymd(); if (!st()[key] || st()[key].date !== today) st()[key] = { date: today, count: 0 }; st()[key].count++; }

/* ---------- 読み上げ：Azure ニューラル音声（女性）。使えないときだけブラウザ内蔵 ---------- */
let voice = null;
function pickVoice() {
  try {
    const vs = speechSynthesis.getVoices().filter((v) => /^en[-_]US/i.test(v.lang));
    voice = vs.find((v) => /Google|Natural|Samantha|Aria|Jenny/i.test(v.name)) || vs[0] || null;
  } catch (e) {}
}
try { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; } catch (e) {}
function browserSay(text, rate) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US"; u.rate = rate || 0.9; if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  } catch (e) { showBanner("このブラウザでは音声読み上げが使えません。"); }
}

/* 再生は Web Audio で行う（スマホでも、タップ後の非同期再生が止められにくい） */
let audioCtx = null, playing = null;
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}
function stopAudio() { try { playing && playing.stop(); } catch (e) {} playing = null; try { speechSynthesis.cancel(); } catch (e) {} }
async function playBuffer(buf) {
  stopAudio();
  const src = audioCtx.createBufferSource();
  src.buffer = buf; src.connect(audioCtx.destination); src.start(); playing = src;
}

/* 速さは3段階。通常はタグなし（SSMLのタグも課金文字数に入るため） */
const rateKey = (r) => (!r || r >= 0.85 ? "n" : r >= 0.65 ? "s" : "xs");
const RATE_PCT = { s: "-25%", xs: "-40%" };
const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
const memAudio = new Map();          // 端末内の再生済み音声（AudioBuffer）
const CACHE = "tts-v1";
let ttsRecent = [];                  // F0 は 60秒あたり20回まで → 18回で止める
let ttsDisabledUntil = 0;            // 429 や無料枠超過のときは一時的にブラウザ内蔵へ
let ttsWarned = false;

async function synthAzure(text, rk) {
  const SDK = window.SpeechSDK;
  const tk = await speechToken();
  const cfg = SDK.SpeechConfig.fromAuthorizationToken(tk.token, tk.region);
  cfg.speechSynthesisOutputFormat = SDK.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
  const v = tk.voice || "en-US-AvaNeural";
  const body = rk === "n" ? xmlEsc(text) : `<prosody rate="${RATE_PCT[rk]}">${xmlEsc(text)}</prosody>`;
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${v}">${body}</voice></speak>`;
  const synth = new SDK.SpeechSynthesizer(cfg, null); // null = スピーカーに流さず音声データだけ受け取る
  try {
    const result = await new Promise((resolve, reject) => synth.speakSsmlAsync(ssml, resolve, reject));
    if (result.reason !== SDK.ResultReason.SynthesizingAudioCompleted) {
      const d = SDK.CancellationDetails.fromResult(result);
      throw Object.assign(new Error(d.errorDetails || "tts_failed"), { details: d.errorDetails || "" });
    }
    countTts(body.length);
    return result.audioData; // ArrayBuffer (mp3)
  } finally { try { synth.close(); } catch (e) {} }
}
function countTts(n) {
  const m = S.ymd().slice(0, 7);
  if (!st().tts || st().tts.month !== m) st().tts = { month: m, chars: 0 };
  st().tts.chars += n; saveSettings();
}

async function say(text, rate) {
  unlockAudio();
  const rk = rateKey(rate);
  const key = `${(tokenCache && tokenCache.voice) || "ava"}|${rk}|${text}`;
  try {
    if (!audioCtx || !window.SpeechSDK) throw new Error("no_audio");
    if (memAudio.has(key)) return playBuffer(memAudio.get(key));
    const req = new Request("/__tts/" + encodeURIComponent(key));
    let bytes = null;
    try { const hit = await (await caches.open(CACHE)).match(req); if (hit) bytes = await hit.arrayBuffer(); } catch (e) {}
    if (!bytes) {
      const now = Date.now();
      ttsRecent = ttsRecent.filter((t) => now - t < 60000);
      if (now < ttsDisabledUntil || ttsRecent.length >= 18) throw new Error("throttled");
      ttsRecent.push(now);
      bytes = await synthAzure(text, rk);
      try { await (await caches.open(CACHE)).put(req, new Response(bytes.slice(0), { headers: { "Content-Type": "audio/mpeg" } })); } catch (e) {}
    }
    const buf = await audioCtx.decodeAudioData(bytes.slice(0));
    memAudio.set(key, buf);
    return playBuffer(buf);
  } catch (e) {
    const det = String((e && (e.details || e.message)) || e);
    if (/429|Too many|quota|exceed/i.test(det)) ttsDisabledUntil = Date.now() + 60000;
    if (/401|auth/i.test(det)) tokenCache = null;
    if (!ttsWarned && e.message !== "no_audio") { ttsWarned = true; showBanner("Azure の読み上げが一時的に使えないため、ブラウザの読み上げで代わりに再生しています。"); }
    browserSay(text, rate);
  }
}
const fmtNext = (d) => (d === 0 ? "このあと" : d === 1 ? "明日" : d < 30 ? d + "日後" : Math.round(d / 30) + "か月後");

/* ================= 単語（間隔反復） ================= */
let wQueue = [], wCur = null, revealed = false, wDone = 0;
function buildWordQueue() {
  wQueue = S.buildQueue(data.words, data.cards.word, st().newLog, st().newPerDay, "category", "tech", "general");
  wCur = wQueue.shift() || null; revealed = false;
}
function counts() {
  const all = [wCur, ...wQueue].filter(Boolean);
  $("s-wrev").textContent = all.filter((w) => data.cards.word[w.id]).length;
  $("s-wnew").textContent = all.filter((w) => !data.cards.word[w.id]).length;
  $("s-sent").textContent = [sCur, ...sQueue].filter(Boolean).length;
}
function stressHTML(s) {
  return String(s || "").split(/([- ])/).map((p) => p === "-" ? '<span class="sep">·</span>' : p === " " ? '<span class="sep">&nbsp;</span>'
    : `<span class="syl ${/[A-Z]/.test(p) && p === p.toUpperCase() ? "on" : ""}">${esc(p.toLowerCase())}</span>`).join("");
}
function exHTML(w) {
  const first = w.word.split(" ")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rest = w.word.includes(" ") ? " " + w.word.split(" ").slice(1).join(" ") : "";
  return esc(w.example).replace(new RegExp("\\b(" + first + "\\w*" + rest + ")", "i"), "<mark>$1</mark>");
}
function emptyCard(title, note) { return `<div class="card empty"><h2>${esc(title)}</h2><p class="note">${note}</p></div>`; }

function renderStudy() {
  const v = $("view-study");
  counts();
  if (!loaded) { v.innerHTML = emptyCard("読み込んでいます", "単語と学習記録を取得しています。"); return; }
  if (!data.words.length) { v.innerHTML = emptyCard("まだ単語がありません", "「一覧」タブの「データ管理」→「初期データを取り込む」から、単語と文を入れてください。"); return; }
  if (!wCur) { v.innerHTML = emptyCard("今日の単語は終わりです", (wDone ? wDone + "枚を学習しました。" : "") + "次はシャドーイングに進みましょう。"); return; }
  const w = wCur, s = data.cards.word[w.id];
  let h = `<article class="card" aria-live="polite">
    <div class="row between"><span class="chip">${s ? "復習" : "新しい単語"} · ${w.category === "general" ? "一般" : "技術"}</span><span class="note">${esc(w.pos || "")}</span></div>
    <p class="word">${esc(w.word)}</p>
    <div class="row">
      <button class="btn" data-say="${esc(w.word)}">${SPK}発音を聞く</button>
      <button class="btn" data-say="${esc(w.word)}" data-rate="0.55">${SLOW}ゆっくり</button>
    </div>`;
  if (!revealed) {
    h += `<p class="note">意味と類義語を思い出し、発音をまねてから答えを見ましょう。</p>
      <button class="btn primary" id="reveal">答えを見る</button></article>`;
  } else {
    h += `<div class="row between"><div class="ipa">${esc(w.ipa)}</div><button class="fbbtn" data-fb="word" aria-label="この単語の内容を報告">👎 おかしい</button></div>
      <div class="stress" aria-label="強勢: ${esc(w.stress)}">${stressHTML(w.stress)}</div>
      ${w.stressNote ? `<p class="note" style="margin:-8px 0 0">${esc(w.stressNote)}</p>` : ""}
      <dl>
        <dt>意味</dt><dd><b>${esc(w.meaning)}</b></dd>
        <dt>類義語</dt><dd class="syn">${(w.synonyms || []).map((x) => `<button data-say="${esc(x)}">${esc(x)}</button>`).join("")}</dd>
        <dt>例文</dt><dd><div class="ex">${exHTML(w)}</div><div class="tr">${esc(w.translation)}</div>
          <div class="row" style="margin-top:6px"><button class="btn" data-say="${esc(w.example)}">${SPK}例文</button></div></dd>
      </dl>
      ${w.tip ? `<div class="tip"><strong>発音のコツ</strong>${esc(w.tip)}</div>` : ""}
      <div class="grades">${[["again", "もう一度"], ["hard", "難しい"], ["good", "覚えた"], ["easy", "簡単"]].map(([g, l]) =>
        `<button class="g-${g}" data-grade="${g}"><span class="lbl">${l}</span><span class="nx">${fmtNext(S.nextState(s, g).interval)}</span></button>`).join("")}</div>
    </article>`;
  }
  v.innerHTML = h;
  const r = $("reveal"); if (r) r.onclick = () => { revealed = true; renderStudy(); };
}
function gradeWord(g) {
  const w = wCur; if (!w) return;
  const wasNew = !data.cards.word[w.id];
  data.cards.word[w.id] = S.nextState(data.cards.word[w.id], g);
  saveCard("word", w.id);
  if (wasNew) { bumpLog("newLog"); saveSettings(); }
  if (g === "again") wQueue.splice(Math.min(3, wQueue.length), 0, w);
  wDone++;
  wCur = wQueue.shift() || null; revealed = false;
  renderStudy();
}

/* ================= シャドーイング＋発音評価 ================= */
let sBestNg = 0;
let sQueue = [], sCur = null, sBest = null, sResult = null, sShowJa = false, recording = false, sDone = 0, openWord = -1;
function buildSentenceQueue() {
  sQueue = S.buildQueue(data.sentences, data.cards.sentence, st().newSentLog, st().newSentencesPerDay, "category", "conference", "conversation");
  sCur = sQueue.shift() || null; sBest = null; sBestNg = 0; sResult = null; openWord = -1;
}
let tokenCache = null;
async function speechToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 30000) return tokenCache;
  tokenCache = await api("speech-token");
  return tokenCache;
}

function renderShadow() {
  const v = $("view-shadow");
  counts();
  if (!loaded) { v.innerHTML = emptyCard("読み込んでいます", ""); return; }
  if (!data.sentences.length) { v.innerHTML = emptyCard("まだ文がありません", "「一覧」タブから初期データを取り込んでください。"); return; }
  if (!sCur) { v.innerHTML = emptyCard("今日の文は終わりです", (sDone ? sDone + "文を練習しました。" : "") + "仕上げにクイズをどうぞ。"); return; }
  const s = sCur, c = data.cards.sentence[s.id];
  const hide = st().hideText && !sResult;
  const r = sResult;
  let h = `<article class="card" aria-live="polite">
    <div class="row between"><span class="chip">${c ? "復習" : "新しい文"} · ${esc(s.scene || "")}</span>
      <span class="row" style="gap:8px"><span class="note">${c && c.best != null ? "最高 " + c.best + "点" : ""}</span><button class="fbbtn" data-fb="sentence" aria-label="この文の内容や評価を報告">👎</button></span></div>
    <p class="sent ${hide ? "hidden" : ""}" id="sent-text">${esc(s.text)}</p>
    ${sShowJa ? `<p class="tr" style="margin:-6px 0 0">${esc(s.ja)}</p>` : ""}
    <div class="row">
      <button class="btn" data-say="${esc(s.text)}">${SPK}お手本</button>
      <button class="btn" data-say="${esc(s.text)}" data-rate="0.7">${SLOW}ゆっくり</button>
      <button class="btn" id="toggle-ja">${sShowJa ? "訳を隠す" : "訳を見る"}</button>
      ${hide ? `<button class="btn" id="show-text">文を見る</button>` : ""}
    </div>
    <button class="btn primary ${recording ? "rec" : ""}" id="rec" ${recording ? "disabled" : ""}>${MIC}${recording ? "聞き取り中…話し終わると自動で止まります" : r ? "もう一度話す" : "話す（録音して評価）"}</button>`;
  if (r) {
    h += `<div class="scores">
        <div class="sc main"><div class="v">${r.judge}</div><div class="k">判定点</div></div>
        <div class="sc"><div class="v">${r.acc}</div><div class="k">正確さ</div></div>
        <div class="sc"><div class="v">${r.flu}</div><div class="k">流暢さ</div></div>
        <div class="sc"><div class="v">${r.comp}</div><div class="k">完全さ</div></div>
      </div>
      <div class="pw">${r.words.map((w, i) => `<button class="${S.wordClass(w, st().strictness)}" data-pw="${i}">${esc(w.w)}${w.acc != null && w.err !== "Omission" ? `<small class="note"> ${w.acc}</small>` : ""}</button>`).join("")}</div>
      <p class="note" style="margin:0">Azure の総合点 ${r.pron}点${r.judge < r.pron ? ` から、崩れた単語の分を減点しています（採点：${esc((S.STRICTNESS[st().strictness]?.label || "").replace(/（.*）/, ""))}）` : ""}${r.ngCount && r.judge >= 90 && st().strictness !== "standard" ? `。「要練習」の単語が${r.ngCount}語あるので、「覚えた」にはなりません` : ""}</p>
      <div class="legend"><span><i style="background:var(--good)"></i>良い</span><span><i style="background:var(--hard)"></i>あと少し</span><span><i style="background:var(--again)"></i>要練習</span><span>取り消し線＝言い落とし</span></div>
      ${openWord >= 0 && r.words[openWord] ? `<div><p class="note" style="margin:0 0 4px">「${esc(r.words[openWord].w)}」の音ごとの点数</p>
        <div class="phon">${r.words[openWord].ph.map(([p, a]) => `<span style="border-color:${a < 60 ? "var(--again)" : a < 80 ? "var(--hard)" : "var(--good)"}">${esc(p)} ${a}</span>`).join("") || '<span class="note">音素データなし</span>'}</div>
        <div class="row" style="margin-top:6px"><button class="btn" data-say="${esc(r.words[openWord].w)}" data-rate="0.6">${SLOW}この単語をゆっくり</button></div></div>` : `<p class="note" style="margin:0">単語をタップすると、音ごとの点数が見られます。</p>`}
      ${r.recognized ? `<p class="note" style="margin:0">聞き取られた文：${esc(r.recognized)}</p>` : ""}
      <button class="btn primary" id="next-sent">次の文へ（今回の最高 ${sBest}点で記録）</button>`;
  } else {
    h += `<p class="note" style="margin:0">お手本を聞いて、すぐ後に同じリズムで話してみましょう。1文30秒以内です。</p>`;
  }
  h += `</article>`;
  v.innerHTML = h;
  $("toggle-ja").onclick = () => { sShowJa = !sShowJa; renderShadow(); };
  if ($("show-text")) $("show-text").onclick = () => { $("sent-text").classList.remove("hidden"); $("show-text").remove(); };
  $("rec").onclick = startAssessment;
  if ($("next-sent")) $("next-sent").onclick = nextSentence;
}

async function startAssessment() {
  if (recording) return;
  const SDK = window.SpeechSDK;
  if (!SDK) { showBanner("音声評価の部品を読み込めていません。ページを開き直してください。"); return; }
  stopAudio();
  recording = true; renderShadow(); showBanner("");
  let recognizer = null;
  try {
    const tk = await speechToken();
    const cfg = SDK.SpeechConfig.fromAuthorizationToken(tk.token, tk.region);
    cfg.speechRecognitionLanguage = "en-US";
    const audio = SDK.AudioConfig.fromDefaultMicrophoneInput();
    const pa = new SDK.PronunciationAssessmentConfig(sCur.text, SDK.PronunciationAssessmentGradingSystem.HundredMark, SDK.PronunciationAssessmentGranularity.Phoneme, true);
    pa.phonemeAlphabet = "IPA";
    // 抑揚（Prosody）は追加料金のため使わない
    recognizer = new SDK.SpeechRecognizer(cfg, audio);
    pa.applyTo(recognizer);
    const result = await new Promise((resolve, reject) => recognizer.recognizeOnceAsync(resolve, reject));
    if (result.reason === SDK.ResultReason.RecognizedSpeech) {
      const json = JSON.parse(result.properties.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult));
      const r = S.parsePron(json);
      if (!r) throw new Error("no_result");
      const j = S.judgeScore(r, st().strictness);
      r.judge = j.score; r.ngCount = j.ng;
      sResult = r; openWord = r.words.findIndex((w) => S.wordClass(w, st().strictness) === "ng");
      // 「今回の最高」は判定点で比べる。同点なら要練習の単語が少ない方
      if (sBest == null || r.judge > sBest || (r.judge === sBest && r.ngCount < sBestNg)) { sBest = r.judge; sBestNg = r.ngCount; }
      queueSave(() => api("attempts", { method: "POST", body: JSON.stringify({ sentenceId: sCur.id, text: sCur.text, pron: r.pron, judge: r.judge, strictness: st().strictness, acc: r.acc, flu: r.flu, comp: r.comp, recognized: r.recognized, words: r.words }) }));
    } else if (result.reason === SDK.ResultReason.NoMatch) {
      showBanner("声を聞き取れませんでした。マイクに近づいて、もう一度話してください。");
    } else {
      const d = SDK.CancellationDetails.fromResult(result);
      showBanner(/429|Too many/i.test(d.errorDetails || "") ? "混み合っています。数秒おいてもう一度試してください。" : "評価できませんでした（" + (d.errorDetails || d.reason) + "）");
      if (/401|auth/i.test(d.errorDetails || "")) tokenCache = null;
    }
  } catch (e) {
    if (e && e.message !== "auth") showBanner(/Permission|NotAllowed/i.test(String(e)) ? "マイクの使用を許可してください。" : "評価できませんでした。もう一度試してください。");
  } finally {
    try { recognizer && recognizer.close(); } catch (e) {}
    recording = false; renderShadow();
  }
}

function nextSentence() {
  const s = sCur; if (!s) return;
  if (sBest != null) {
    const prev = data.cards.sentence[s.id];
    const wasNew = !prev;
    const g = S.gradeFromScore(sBest, sBestNg, st().strictness);
    const next = S.nextState(prev, g);
    next.best = Math.max(prev && prev.best != null ? prev.best : 0, sBest);
    data.cards.sentence[s.id] = next;
    saveCard("sentence", s.id);
    if (wasNew) { bumpLog("newSentLog"); saveSettings(); }
    if (g === "again") sQueue.splice(Math.min(3, sQueue.length), 0, s);
    sDone++;
  }
  sCur = sQueue.shift() || null; sBest = null; sBestNg = 0; sResult = null; openWord = -1;
  renderShadow();
}

/* ================= クイズ ================= */
let quiz = null;
const MODES = {
  meaning: { t: "意味を答える", d: "英単語を見て日本語で入力。AIが判定します" },
  synonym: { t: "類義語を選ぶ", d: "4つの中から近い意味の語を選ぶ" },
  stress: { t: "強く読む位置", d: "音節の中から強勢の位置をタップ" },
  listen: { t: "聞き取り", d: "音声を聞いて英単語をつづる" },
};
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sylls = (w) => String(w.stress || "").split(/[- ]/).filter(Boolean);
const stressIdx = (w) => sylls(w).findIndex((p) => /[A-Z]/.test(p) && p === p.toUpperCase());

function renderQuizMenu() {
  quiz = null;
  const v = $("view-quiz");
  if (!data.words.length) { v.innerHTML = emptyCard("まだ単語がありません", ""); return; }
  const studied = data.words.filter((w) => data.cards.word[w.id]).length;
  const q = st().quiz || { total: 0, correct: 0 };
  v.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">
    <p class="prompt">${studied >= 4 ? `学習済みの${studied}語から出題します。` : "登録済みの全単語から出題します。"}1回10問です。</p>
    <div class="modes">
      <button class="mode all" data-mode="mix"><span class="t">おまかせ</span><span class="d">4種類をまぜて出題</span></button>
      ${Object.entries(MODES).map(([k, m]) => `<button class="mode" data-mode="${k}"><span class="t">${m.t}</span><span class="d">${m.d}</span></button>`).join("")}
    </div>
    ${q.total ? `<p class="note">これまでの正答率 ${Math.round((q.correct / q.total) * 100)}%（${q.total}問）</p>` : ""}
  </div>`;
}
function startQuiz(mode) {
  const pool0 = data.words.filter((w) => data.cards.word[w.id]);
  const pool = pool0.length >= 4 ? pool0 : data.words;
  const kinds = mode === "mix" ? Object.keys(MODES) : [mode];
  let picks = shuffle(pool); while (picks.length < 10) picks = picks.concat(shuffle(pool));
  const qs = [];
  for (let i = 0; i < 10; i++) {
    let k = kinds[i % kinds.length]; const w = picks[i];
    if (k === "stress" && (stressIdx(w) < 0 || sylls(w).length < 2)) k = "meaning";
    if (k === "synonym" && !(w.synonyms || []).length) k = "meaning";
    qs.push({ k, w });
  }
  quiz = { mode, qs: mode === "mix" ? shuffle(qs) : qs, i: 0, correct: 0, wrong: [], state: "ask", verdict: null, opts: null, picked: null };
  renderQuestion();
  if (quiz.qs[0].k === "listen") say(quiz.qs[0].w.word, 0.9);
}
function renderQuestion() {
  const v = $("view-quiz"), q = quiz.qs[quiz.i], w = q.w;
  const head = `<div class="qhead"><span>${MODES[q.k].t}</span><span>${quiz.i + 1} / ${quiz.qs.length}</span></div><div class="bar"><i style="width:${(quiz.i / quiz.qs.length) * 100}%"></i></div>`;
  const dis = quiz.state !== "ask" ? "disabled" : "";
  let body = "";
  if (q.k === "meaning") {
    body = `<p class="word">${esc(w.word)}</p><div class="row"><button class="btn" data-say="${esc(w.word)}">${SPK}発音</button></div>
      <p class="prompt">日本語で意味を入力してください。</p><input type="text" id="ans" autocomplete="off" placeholder="例：活用する" ${dis}>`;
  } else if (q.k === "synonym") {
    if (!quiz.opts) {
      const right = shuffle(w.synonyms)[0];
      const others = shuffle(data.words.filter((x) => x.id !== w.id).flatMap((x) => x.synonyms || []).filter((s) => !(w.synonyms || []).includes(s)));
      quiz.opts = { right, list: shuffle([right, ...[...new Set(others)].slice(0, 3)]) };
    }
    body = `<p class="word">${esc(w.word)}</p><p class="prompt">意味が近い語を選んでください。</p>
      <div class="opts">${quiz.opts.list.map((o) => { const c = quiz.state === "ask" ? "" : o === quiz.opts.right ? "ok" : o === quiz.picked ? "ng" : "";
        return `<button class="opt ${c}" data-pick="${esc(o)}" ${dis}>${esc(o)}</button>`; }).join("")}</div>`;
  } else if (q.k === "stress") {
    const ss = sylls(w), si = stressIdx(w);
    body = `<p class="word">${esc(w.word)}</p><p class="prompt">一番強く読む部分をタップしてください。</p>
      <div class="sylrow">${ss.map((s, i) => { const c = quiz.state === "ask" ? "" : i === si ? "ok" : i === quiz.picked ? "ng" : "";
        return `<button class="sylbtn ${c}" data-syl="${i}" ${dis}>${esc(s.toLowerCase())}</button>`; }).join("")}</div>`;
  } else {
    body = `<p class="prompt">音声を聞いて、聞こえた英単語を入力してください。</p>
      <div class="row"><button class="btn" data-say="${esc(w.word)}">${SPK}もう一度聞く</button><button class="btn" data-say="${esc(w.word)}" data-rate="0.55">${SLOW}ゆっくり</button></div>
      <input type="text" id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="英単語を入力" ${dis}>`;
  }
  let foot = "";
  if (quiz.state === "ask" && (q.k === "meaning" || q.k === "listen")) foot = `<button class="btn primary" id="submit">答え合わせ</button>`;
  else if (quiz.state === "judging") foot = `<div class="verdict"><b>判定しています</b></div>`;
  else if (quiz.state === "self") foot = `<div class="verdict"><b>正解：${esc(w.meaning)}</b><span>${esc(quiz.verdict.comment)}</span></div>
      <div class="grades" style="grid-template-columns:1fr 1fr"><button class="g-good" data-self="1"><span class="lbl">合っていた</span></button><button class="g-again" data-self="0"><span class="lbl">違った</span></button></div>`;
  else if (quiz.state === "done") {
    const vd = quiz.verdict;
    foot = `<div class="verdict ${vd.ok ? "ok" : "ng"}"><b>${vd.ok ? "正解" : "不正解"}</b>${vd.comment ? `<span>${esc(vd.comment)}</span>` : ""}
      <span class="note">${esc(w.word)} ／ ${esc(w.ipa)} ／ ${esc(w.meaning)}</span></div>
      <div class="row between"><button class="btn" data-say="${esc(w.word)}">${SPK}発音を確認</button><button class="fbbtn" data-fb="quiz">👎 判定・問題がおかしい</button></div>
      <button class="btn primary" id="next">${quiz.i + 1 < quiz.qs.length ? "次の問題" : "結果を見る"}</button>`;
  }
  v.innerHTML = `<div class="card">${head}${body}${foot}</div>`;
  const ans = $("ans");
  if (ans && quiz.state === "ask") {
    ans.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submitText(); } });
    if (q.k === "meaning") ans.focus({ preventScroll: true });
  }
  if ($("submit")) $("submit").onclick = submitText;
  if ($("next")) $("next").onclick = nextQuestion;
}
function finishAnswer(ok, comment) {
  const w = quiz.qs[quiz.i].w;
  quiz.verdict = { ok, comment }; quiz.state = "done";
  if (ok) quiz.correct++; else quiz.wrong.push(w);
  renderQuestion();
}
async function submitText() {
  const q = quiz.qs[quiz.i], w = q.w, val = ($("ans")?.value || "").trim();
  if (!val) { $("ans")?.focus(); return; }
  quiz.answer = val;
  if (q.k === "listen") {
    const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
    const ok = norm(val) === norm(w.word);
    say(w.word, 0.9);
    finishAnswer(ok, ok ? "" : `入力：${val}`);
    return;
  }
  quiz.state = "judging"; renderQuestion();
  try {
    const r = await api("judge", { method: "POST", body: JSON.stringify({ word: w.word, pos: w.pos, meaning: w.meaning, example: w.example, answer: val }) });
    finishAnswer(!!r.correct, r.comment || "");
  } catch (e) {
    quiz.state = "self"; quiz.verdict = { comment: `自動判定ができなかったので、自分で判定してください。あなたの答え：${val}` };
    renderQuestion();
  }
}
function nextQuestion() {
  quiz.i++; quiz.state = "ask"; quiz.verdict = null; quiz.opts = null; quiz.picked = null;
  if (quiz.i >= quiz.qs.length) return renderResult();
  renderQuestion();
  const q = quiz.qs[quiz.i]; if (q.k === "listen") say(q.w.word, 0.9);
}
function renderResult() {
  const t = S.startOfDay();
  const q = st().quiz || (st().quiz = { total: 0, correct: 0 });
  q.total += quiz.qs.length; q.correct += quiz.correct; saveSettings();
  const uniq = [...new Map(quiz.wrong.map((w) => [w.id, w])).values()];
  for (const w of uniq) if (data.cards.word[w.id]) { data.cards.word[w.id] = { ...data.cards.word[w.id], due: t }; saveCard("word", w.id); }
  if (uniq.length) { buildWordQueue(); renderStudy(); }
  $("view-quiz").innerHTML = `<div class="card"><span class="eyebrow">結果</span>
    <div class="score">${quiz.correct}<span style="font-size:24px;color:var(--muted)"> / ${quiz.qs.length}</span></div>
    ${uniq.length ? `<p class="prompt">間違えた単語は、今日の単語に復習として戻しました。</p>
      <div class="list">${uniq.map((w) => `<div class="li"><button class="iconbtn" data-say="${esc(w.word)}" aria-label="${esc(w.word)} の発音">${SPK}</button>
        <div class="grow"><div class="w">${esc(w.word)}</div><div class="m">${esc(w.meaning)} ・ ${esc(w.ipa)}</div></div></div>`).join("")}</div>` : `<p class="prompt">全問正解です。</p>`}
    <div class="row"><button class="btn" id="again-quiz">同じ種類でもう一度</button><button class="btn" id="menu-quiz">クイズの種類を選ぶ</button></div></div>`;
  const m = quiz.mode;
  $("again-quiz").onclick = () => startQuiz(m);
  $("menu-quiz").onclick = renderQuizMenu;
}

/* ================= 一覧と設定 ================= */
let listMode = "words", listCat = "all";
function renderList() {
  const v = $("view-list"), t = S.startOfDay();
  const seg = (name, opts, cur) => `<div class="seg" role="group">${opts.map(([k, l]) => `<button data-${name}="${k}" aria-pressed="${k === cur}">${l}</button>`).join("")}</div>`;
  let rows = "";
  if (listMode === "words") {
    const ws = data.words.filter((w) => listCat === "all" || w.category === listCat);
    rows = ws.map((w) => {
      const s = data.cards.word[w.id];
      const [cls, lab] = !s ? ["new", "未学習"] : s.interval >= 21 ? ["done", "定着"] : ["learn", "学習中"];
      const due = s ? (s.due <= t ? "今日" : fmtNext(Math.round((s.due - t) / S.DAY))) : "";
      return `<div class="li"><button class="iconbtn" data-say="${esc(w.word)}" aria-label="${esc(w.word)} の発音">${SPK}</button>
        <div class="grow"><div class="w">${esc(w.word)}</div><div class="m">${esc(w.meaning)}${due ? " · 次回 " + due : ""}</div></div><span class="st ${cls}">${lab}</span></div>`;
    }).join("");
  } else {
    const ss = data.sentences.filter((s) => listCat === "all" || (listCat === "tech" ? s.category === "conference" : s.category === "conversation"));
    rows = ss.map((s) => {
      const c = data.cards.sentence[s.id];
      const [cls, lab] = !c ? ["new", "未練習"] : c.best >= 90 ? ["done", c.best + "点"] : ["learn", (c.best ?? 0) + "点"];
      return `<div class="li"><button class="iconbtn" data-say="${esc(s.text)}" aria-label="読み上げ">${SPK}</button>
        <div class="grow"><div class="s">${esc(s.text)}</div><div class="m">${esc(s.scene || "")} · ${esc(s.ja)}</div></div><span class="st ${cls}">${lab}</span></div>`;
    }).join("");
  }
  v.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">
    ${seg("lm", [["words", "単語"], ["sentences", "文"]], listMode)}
    ${seg("lc", [["all", "すべて"], ["tech", listMode === "words" ? "技術" : "セッション"], ["general", listMode === "words" ? "一般" : "会話"]], listCat)}
    <div class="list">${rows || '<div class="li"><span class="note">まだありません</span></div>'}</div>
    <div class="card settings">
      <label for="npd">1日の新しい単語 <select id="npd">${[5, 10, 15, 20].map((n) => `<option ${n === st().newPerDay ? "selected" : ""}>${n}</option>`).join("")}</select> 語</label>
      <label for="nsd">1日の新しい文 <select id="nsd">${[3, 5, 8, 10].map((n) => `<option ${n === st().newSentencesPerDay ? "selected" : ""}>${n}</option>`).join("")}</select> 文</label>
      <label for="strict">シャドーイングの採点 <select id="strict">${Object.entries(S.STRICTNESS).map(([k, v]) => `<option value="${k}" ${k === st().strictness ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select></label>
      ${hubOn() ? `<div class="sharebox">
        <label><input type="checkbox" id="share-toggle" ${st().shareFeedback === true ? "checked" : ""}> 👎 やご意見を作者にも送る（匿名）</label>
        <p class="note" style="margin:0">送る・送らないは、送るたびに選べます。<button class="linkbtn" id="share-detail">送る内容を見る</button>　端末 ID：<code>${esc((st().instanceId || "").slice(0, 8))}…</code> <button class="linkbtn" id="share-reset">作り直す</button></p>
      </div>` : ""}
      <label><input type="checkbox" id="hide" ${st().hideText ? "checked" : ""}> シャドーイングで、評価前は文をぼかす（聞き取り重視）</label>
      <p class="note" style="margin:0">今月の読み上げ（Azure）：約${(st().tts && st().tts.month === S.ymd().slice(0, 7) ? st().tts.chars : 0).toLocaleString()}文字 ／ 無料枠 500,000文字。一度聞いた音声は端末に保存され、再生しても文字数は増えません。</p>
      <details id="fb-details"><summary>送ったフィードバック</summary>
        <div class="list fbhist" id="fb-hist" style="margin-top:8px">${fbHistoryHTML()}</div>
      </details>
      <details ${data.words.length ? "" : "open"}><summary>データ管理</summary>
        <p class="note">最初に入っている単語とシャドーイング用の文を取り込みます。同じIDのデータは上書きされます（復習の記録は消えません）。</p>
        <button class="btn" id="import">初期データを取り込む</button>
      </details>
    </div>
  </div>`;
  $("npd").onchange = (e) => { st().newPerDay = +e.target.value; saveSettings(); buildWordQueue(); renderStudy(); };
  $("nsd").onchange = (e) => { st().newSentencesPerDay = +e.target.value; saveSettings(); buildSentenceQueue(); renderShadow(); };
  $("strict").onchange = (e) => { st().strictness = e.target.value; saveSettings(); renderShadow(); };
  if ($("share-toggle")) {
    $("share-toggle").onchange = (e) => { st().shareFeedback = e.target.checked; st().shareAskedAt = new Date().toISOString(); saveSettings(); };
    $("share-detail").onclick = () => openShareConsent(false);
    $("share-reset").onclick = () => {
      if (!confirm("端末 ID を作り直しますか？ これまでに作者へ送ったフィードバックと、今後のフィードバックは結び付かなくなります。")) return;
      st().instanceId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
      saveSettings(); renderList();
    };
  }
  $("hide").onchange = (e) => { st().hideText = e.target.checked; saveSettings(); renderShadow(); };
  $("import").onclick = importSeed;
  $("fb-details").ontoggle = (e) => { if (e.target.open && !fbHistory) loadFbHistory(); };
}
async function importSeed() {
  if (data.words.length && !confirm("すでにデータがあります。初期データで上書きしますか？（同じIDの単語・文・復習状態が上書きされます）")) return;
  const b = $("import"); b.disabled = true; b.textContent = "取り込み中…";
  try {
    const get = (n) => fetch(`/seed/${n}.json`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    const [words, sentences] = await Promise.all([get("words"), get("sentences")]);
    if (!words || !sentences) throw new Error("seed");
    // 別の単語帳から学習記録を移す場合だけ、seed/progress.json を置く（{ wordCards, settings }）。無ければ単語と文だけ
    const prog = await get("progress").catch(() => null);
    const body = { words, sentences, ...(prog ? { wordCards: prog.wordCards, settings: prog.settings } : {}) };
    const r = await api("import", { method: "POST", body: JSON.stringify(body) });
    showBanner(`取り込みました：単語${r.words}語、文${r.sentences}文` + (r.wordCards ? `、復習状態${r.wordCards}件` : ""));
    await load();
  } catch (e) {
    showBanner("取り込みに失敗しました。");
  } finally { b.disabled = false; b.textContent = "初期データを取り込む"; }
}

/* ================= フィードバック（👎・ご意見・要望） ================= */
const FB_CATS = {
  word: ["意味・訳が違う", "発音記号・強勢が違う", "類義語がおかしい", "例文が不自然", "音声がおかしい", "その他"],
  sentence: ["英文がおかしい", "訳が違う", "評価が厳しすぎる", "評価が甘すぎる", "音声がおかしい", "その他"],
  quiz: ["正解なのに不正解", "不正解なのに正解", "選択肢・問題がおかしい", "その他"],
  app: ["あったらいい機能", "使いにくい", "不具合", "その他"],
};
let fbCtx = null, fbCat = "";
function deviceKind() { return /Mobi|Android|iPhone/i.test(navigator.userAgent) ? "mobile" : "desktop"; }
function currentTab() { return TABS.find((t) => !$("view-" + t).hidden) || ""; }
function openFeedbackFor(type) {
  if (type === "word" && wCur) {
    openFeedback({ kind: "content", targetType: "word", targetId: wCur.id, targetText: wCur.word, title: "この単語の内容を報告" });
  } else if (type === "sentence" && sCur) {
    const detail = sResult ? { pron: sResult.pron, judge: sResult.judge, strictness: st().strictness, acc: sResult.acc, flu: sResult.flu, comp: sResult.comp, recognized: sResult.recognized } : undefined;
    openFeedback({ kind: "content", targetType: "sentence", targetId: sCur.id, targetText: sCur.text, detail, title: "この文の内容・評価を報告" });
  } else if (type === "quiz" && quiz && quiz.qs[quiz.i]) {
    const q = quiz.qs[quiz.i];
    const detail = { mode: q.k, answer: quiz.answer ?? quiz.picked ?? null, judged: quiz.verdict ? !!quiz.verdict.ok : null, comment: quiz.verdict ? quiz.verdict.comment : "" };
    openFeedback({ kind: "content", targetType: "quiz", targetId: q.w.id, targetText: q.w.word, detail, title: "クイズの判定・問題を報告" });
  }
}
function openFeedback(ctx) {
  fbCtx = ctx; fbCat = "";
  const cats = ctx.kind === "app" ? FB_CATS.app : FB_CATS[ctx.targetType] || FB_CATS.app;
  $("fb-title").textContent = ctx.title;
  $("fb-target").textContent = ctx.targetText ? "対象：" + ctx.targetText : "あったらいい機能、使いにくいところ、不具合などを教えてください。";
  $("fb-cats").innerHTML = cats.map((c) => `<button type="button" role="radio" aria-checked="false" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
  $("fb-label").textContent = ctx.kind === "app" ? "内容（必須）" : "コメント（任意）";
  $("fb-comment").value = ""; $("fb-err").hidden = true;
  // 作者にも送る（受付が設定されている環境だけ表示。初期値は本人の設定に従う）
  $("fb-share-row").hidden = !hubOn();
  $("fb-share").checked = hubOn() && st().shareFeedback === true;
  $("fb").showModal();
}
$("fb-cats").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cat]"); if (!b) return;
  fbCat = b.dataset.cat;
  for (const x of $("fb-cats").children) x.setAttribute("aria-checked", x === b);
  $("fb-err").hidden = true;
});
$("fb-form").addEventListener("submit", async (e) => {
  if (e.submitter && e.submitter.value !== "send") return; // やめる → そのまま閉じる
  e.preventDefault();
  const comment = $("fb-comment").value.trim();
  const err = (t) => { $("fb-err").textContent = t; $("fb-err").hidden = false; };
  if (!fbCat) return err("種類を選んでください。");
  if (fbCtx.kind === "app" && !comment) return err("内容を書いてください。");
  const send = $("fb-send"); send.disabled = true;
  try {
    const { title, ...rest } = fbCtx;
    const shareIt = hubOn() && $("fb-share").checked;
    const r = await api("feedback", { method: "POST", body: JSON.stringify({ ...rest, category: fbCat, comment, share: shareIt, instanceId: st().instanceId, context: { tab: currentTab(), version: APP_VERSION, device: deviceKind() } }) });
    $("fb").close();
    st().fbCount = (st().fbCount || 0) + 1; saveSettings();
    const sh = r && r.share;
    showBanner(sh === "sent" ? "フィードバックを保存し、作者にも送りました。ご協力ありがとうございます！"
      : sh === "failed" ? "フィードバックを保存しました（作者への送信はできませんでした。時間をおいて送り直す必要はありません）。"
      : "フィードバックを保存しました。ありがとうございます。");
    maybeAskShareAgain();
    fbHistory = null;
    if (!$("view-list").hidden) renderList();
  } catch (x) {
    err("送れませんでした。通信状況を確認して、もう一度送ってください。");
  } finally { send.disabled = false; }
});
$("open-idea").onclick = () => openFeedback({ kind: "app", title: "ご意見・要望" });

let fbHistory = null;
async function loadFbHistory() {
  try { fbHistory = await api("feedback"); } catch (e) { fbHistory = []; }
  const box = $("fb-hist"); if (box) box.innerHTML = fbHistoryHTML();
}
function fbHistoryHTML() {
  if (!fbHistory) return '<div class="li"><span class="note">読み込み中…</span></div>';
  if (!fbHistory.length) return '<div class="li"><span class="note">まだありません</span></div>';
  return fbHistory.slice(0, 30).map((f) => `<div class="li"><div class="grow">
      <div class="m">${esc((f.at || "").slice(0, 10))} · ${f.kind === "app" ? "ご意見" : "👎 " + ({ word: "単語", sentence: "文", quiz: "クイズ" }[f.targetType] || esc(f.targetType))} · ${esc(f.category)}</div>
      ${f.targetText ? `<div class="s">${esc(f.targetText)}</div>` : ""}${f.comment ? `<div class="m">${esc(f.comment)}</div>` : ""}</div>
      ${f.share && f.share.status === "sent" ? `<div class="m">作者にも送信済み</div>` : ""}</div>
      <span class="st ${f.status === "open" ? "learn" : "done"}">${f.status === "open" ? "未対応" : "対応済み"}</span></div>`).join("");
}

/* ================= 作者へのフィードバック送信（同意） ================= */
// 初期設定は「送らない」。受付が設定されている環境で、初回に一度だけ協力をお願いする。
// 断った人には、フィードバックを3件以上書いて14日たったときに、もう一度だけお願いする。
const hubOn = () => !!(data.hub && data.hub.enabled);
const SHARE_PREVIEW = {
  sent: ["フィードバックの種類とコメント（メール・URL・電話番号などは自動で消します）", "対象の単語・文と、そのときの点数", "アプリのバージョン、PC かスマホか", "ランダムな端末 ID（いつでも作り直せます）"],
  notSent: ["名前、メールアドレス、サインインしたアカウント", "録音した音声", "あなたの Azure の情報（URL・キーなど）", "学習の記録（どの単語を覚えたか、など）"],
};
function openShareConsent(again) {
  $("share-title").textContent = again ? "改めてのお願い：作者にフィードバックを届けませんか？" : "作者にフィードバックを届けませんか？";
  $("share-sent").innerHTML = SHARE_PREVIEW.sent.map((t) => `<li>${esc(t)}</li>`).join("");
  $("share-not").innerHTML = SHARE_PREVIEW.notSent.map((t) => `<li>${esc(t)}</li>`).join("");
  $("share-id").textContent = st().instanceId || "";
  $("share").showModal();
}
$("share-form").addEventListener("submit", (e) => {
  const v = e.submitter && e.submitter.value;
  if (v === "yes") { st().shareFeedback = true; showBanner("ありがとうございます！ 👎 やご意見を、作者にも届けます（設定は「一覧」タブでいつでも変えられます）。"); }
  else if (v === "no") { st().shareFeedback = false; }
  st().shareAskedAt = new Date().toISOString();
  saveSettings();
  if ($("view-list") && !$("view-list").hidden) renderList();
});
function maybeAskShare() {
  if (!hubOn() || st().shareFeedback !== undefined) return;
  setTimeout(() => { if (!$("fb").open) openShareConsent(false); }, 1200);
}
function maybeAskShareAgain() {
  if (!hubOn() || st().shareFeedback !== false || st().shareAskedAgain) return;
  const asked = Date.parse(st().shareAskedAt || 0);
  if ((st().fbCount || 0) >= 3 && Date.now() - asked > 14 * 86400000) {
    st().shareAskedAgain = true; saveSettings();
    setTimeout(() => openShareConsent(true), 800);
  }
}

/* ---------- タブとクリック ---------- */
const TABS = ["study", "shadow", "quiz", "list"];
function tab(which) {
  for (const t of TABS) { $("tab-" + t).setAttribute("aria-selected", which === t); $("view-" + t).hidden = which !== t; }
  if (which === "list") renderList();
  if (which === "quiz" && !quiz) renderQuizMenu();
  if (which === "shadow") renderShadow();
}
TABS.forEach((t) => ($("tab-" + t).onclick = () => tab(t)));

document.addEventListener("click", (e) => {
  unlockAudio();
  const s = e.target.closest("[data-say]"); if (s) { say(s.dataset.say, s.dataset.rate ? +s.dataset.rate : 0.9); return; }
  const g = e.target.closest("[data-grade]"); if (g) { gradeWord(g.dataset.grade); return; }
  const pw = e.target.closest("[data-pw]"); if (pw) { openWord = +pw.dataset.pw; renderShadow(); return; }
  const lm = e.target.closest("[data-lm]"); if (lm) { listMode = lm.dataset.lm; renderList(); return; }
  const lc = e.target.closest("[data-lc]"); if (lc) { listCat = lc.dataset.lc; renderList(); return; }
  const fb = e.target.closest("[data-fb]"); if (fb) { openFeedbackFor(fb.dataset.fb); return; }
  const m = e.target.closest("[data-mode]"); if (m) { startQuiz(m.dataset.mode); return; }
  if (!quiz) return;
  if (quiz.state === "self") { const sf = e.target.closest("[data-self]"); if (sf) finishAnswer(sf.dataset.self === "1", ""); return; }
  if (quiz.state !== "ask") return;
  const q = quiz.qs[quiz.i];
  const p = e.target.closest("[data-pick]");
  if (p && q.k === "synonym") { quiz.picked = p.dataset.pick; const ok = quiz.picked === quiz.opts.right; finishAnswer(ok, ok ? "" : `正解は ${quiz.opts.right}`); return; }
  const sy = e.target.closest("[data-syl]");
  if (sy && q.k === "stress") {
    quiz.picked = +sy.dataset.syl; const ok = quiz.picked === stressIdx(q.w);
    say(q.w.word, 0.75);
    finishAnswer(ok, ok ? "" : `強く読むのは ${sylls(q.w)[stressIdx(q.w)].toLowerCase()} です。${q.w.stressNote || ""}`);
  }
});

/* ---------- 起動 ---------- */
async function load() {
  const d = await api("state");
  data = d;
  data.settings = { ...defaults, ...(d.settings || {}) };
  if (!st().instanceId) { // 将来、匿名でフィードバックを集めるときに使うランダムなID（個人情報とは結び付かない）
    st().instanceId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    saveSettings();
  }
  loaded = true;
  maybeAskShare();
  buildWordQueue(); buildSentenceQueue();
  renderStudy();
  if (!$("view-shadow").hidden) renderShadow();
  if (!$("view-list").hidden) renderList();
  counts();
}
renderStudy();
load().catch((e) => { if (e.message !== "auth") { loaded = true; showBanner("データを読み込めませんでした。ページを開き直してください。"); renderStudy(); } });
/* 別の端末で学習したあとに戻ってきたら読み直す（スマホとPCの同期） */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && loaded && !recording && !quiz && !revealed && !sResult) load().catch(() => {});
});
})();
