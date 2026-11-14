(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const S = window.SRS;
const APP_VERSION = "0.21.0";
try { document.getElementById("app-ver").textContent = "v" + APP_VERSION; } catch (e) {}
const SPK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/></svg>';
const SLOW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="3"/></svg>';
const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

/* ---------- 状態 ---------- */
let data = { words: [], sentences: [], phrases: [], cards: { word: {}, sentence: {}, compose: {}, dict: {} }, settings: {} };
let loaded = false;
const defaults = { newPerDay: 5, newSentencesPerDay: 5, composePerDay: 5, dictPerDay: 3, newLog: { date: "", count: 0 }, newSentLog: { date: "", count: 0 }, composeLog: { date: "", count: 0 }, dictLog: { date: "", count: 0 }, quiz: { total: 0, correct: 0 }, hideText: false, strictness: "strict" };
const st = () => data.settings;
const TALK_GOAL = 1; // 1日の会話の目安（回）。上の「会話」の数は今日の残り

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
/* 定着率：7日以上あけた復習の結果を、週ごとに設定へ記録する（単語・文・瞬間作文・ディクテーション） */
function noteRetention(kind, prev, g) { if (S.recordRetention((st().retention = st().retention || {}), kind, prev, g)) saveSettings(); }
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

/* 再生は Web Audio で行う（AudioContext は録音にも使う）。
   出力先を明示的に選んだときだけ <audio> 要素で再生する（setSinkId は <audio> 要素にしかない）。
   iPhone では <audio> 要素で再生した後、録音が無音になったため（v0.5.2）、既定では使わない */
let audioCtx = null, playing = null;
const player = new Audio();
player.setAttribute("playsinline", ""); player.preload = "auto";
let playerUnlocked = false;
// 無音の短い WAV（タップの中で一度鳴らしておくと、後から非同期で再生しても止められにくい）
const SILENT_WAV = (() => {
  const n = 800, b = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); b.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, "data"); b.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b.buffer], { type: "audio/wav" }));
})();
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
  if (!playerUnlocked && useSink()) {
    playerUnlocked = true;
    try { player.src = SILENT_WAV; const p = player.play(); if (p) p.catch(() => { playerUnlocked = false; }); } catch (e) { playerUnlocked = false; }
  }
}
function stopAudio() {
  try { playing && playing.stop(); } catch (e) {} playing = null;
  try { player.pause(); } catch (e) {}
  try { speechSynthesis.cancel(); } catch (e) {}
}

/* ---------- 出力先（スピーカー／受話口など）。setSinkId に対応した端末だけ選べる ---------- */
const OUT_KEY = "et-output";
const canPickOutput = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
let outputs = [];        // enumerateDevices の audiooutput
let lastPeak = null, lastMaxDb = null, lastStats = null, lastVariantDiag = ""; // 直近の録音の最大音量・長さ・周波数（診断用）
let lastSinkError = "";
const savedOutput = () => { try { return localStorage.getItem(OUT_KEY) || ""; } catch (e) { return ""; } };
async function refreshOutputs() {
  try { outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput"); } catch (e) { outputs = []; }
  return outputs;
}
async function applySink() {
  if (!canPickOutput) return;
  const id = savedOutput();
  try { if (player.sinkId !== id) await player.setSinkId(id); lastSinkError = ""; }
  catch (e) { lastSinkError = String((e && e.name) || e); }
}
function outputSelectHTML(id) {
  if (!canPickOutput || outputs.length < 2) return "";
  const cur = savedOutput();
  return `<label class="note" for="${id}" style="display:flex;gap:6px;align-items:center">音の出力先
    <select id="${id}"><option value="">端末におまかせ</option>${outputs.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? "selected" : ""}>${esc(d.label || "出力先 " + (i + 1))}</option>`).join("")}</select></label>`;
}
function diagText() {
  const as = navigator.audioSession;
  return [
    `アプリ: v${APP_VERSION}`,
    `ブラウザ: ${navigator.userAgent}`,
    `出力先の選択 (setSinkId): ${canPickOutput ? "対応" : "非対応"}`,
    `選んでいる出力先: ${savedOutput() ? (outputs.find((d) => d.deviceId === savedOutput())?.label || "（一覧にない）") : "端末におまかせ"}`,
    `今の出力先 (sinkId): ${canPickOutput ? (player.sinkId ? player.sinkId.slice(0, 8) + "…" : "既定") : "-"}${lastSinkError ? "　切り替え失敗: " + lastSinkError : ""}`,
    `出力先の一覧: ${outputs.length ? outputs.map((d, i) => d.label || "名前なし " + (i + 1)).join(" / ") : "なし（録音を一度すると取れることがあります）"}`,
    `再生方法: ${usePlayer && useSink() ? "<audio> 要素（出力先を指定）" : "Web Audio"}`,
    `Audio Session: ${as ? as.type : "非対応"}`,
    `マイクの感度: ${(MIC_GAINS.find(([v]) => v === micGain()) || [])[1]}`,
    `直近の録音の最大音量: ${lastPeak == null ? "まだ録音していません" : (lastPeak * 100).toFixed(1) + "%（平均音量の最大 " + (isFinite(lastMaxDb) ? lastMaxDb.toFixed(0) : "-") + "dB、目安 " + OK_DB + "dB）"}`,
    `直近の録音の長さと周波数: ${lastStats ? `送った音声 ${lastStats.sentSec}秒・実際 ${lastStats.wallSec}秒、処理 ${lastStats.ctxRate}Hz／マイク ${lastStats.trackRate || "不明"}Hz（録音開始時の状態 ${lastStats.ctxState}）。${profText(lastStats.prof, lastStats.gain)}（${lastStats.ok ? "評価できた" : "評価できなかった"}）` : "-"}`,
    `直近の聞き取れなかった録音: ${recDiag ? recDiagText(recDiag) : "なし"}`,
    `設定を変えた再評価（直近）: ${lastVariantDiag || "なし"}`,
  ].join("\n");
}
function bindOutputSelect(id, rerender) {
  const el = $(id); if (!el) return;
  el.onchange = async (e) => {
    try { localStorage.setItem(OUT_KEY, e.target.value); } catch (er) {}
    await applySink();
    if (lastSinkError) showBanner("この出力先には切り替えられませんでした（" + lastSinkError + "）。");
    rerender();
  };
}
/* iPhone（Safari・Chrome とも WebKit）：マイクを使うと通話用の状態になり、出力が受話口に切り替わる。
   対応している端末では、再生前に「再生用」、録音前に「録音用」と明示する（navigator.audioSession） */
function setAudioSession(type) { try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch (e) {} }
/* 録音後、受話口に向いたままの AudioContext を捨てる。次のタップで作り直す（decode 済みの音声も作り直し。音声データは端末に保存済みなので課金はない） */
function resetOutput() {
  stopAudio();
  try { audioCtx && audioCtx.close(); } catch (e) {}
  audioCtx = null; memAudio.clear();
  setAudioSession("playback");
}
async function playBuffer(buf) {
  stopAudio();
  setAudioSession("playback");
  const src = audioCtx.createBufferSource();
  src.buffer = buf; src.connect(audioCtx.destination); src.start(); playing = src;
}
/* mp3 を <audio> 要素で再生。再生できないとき（自動再生の制限など）は Web Audio に切り替える */
const memUrl = new Map();            // 端末内の再生済み音声（Blob URL。AudioContext を作り直しても使える）
let usePlayer = true;                 // <audio> 要素が再生できない環境では false にする
function useSink() { return canPickOutput && !!savedOutput(); }
async function playMp3(key, bytes) {
  if (usePlayer && useSink()) {
    try {
      let url = memUrl.get(key);
      if (!url) { url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" })); memUrl.set(key, url); }
      stopAudio();
      setAudioSession("playback");
      await applySink();
      player.src = url;
      await player.play();
      return;
    } catch (e) {
      if (!/NotAllowed|NotSupported/i.test(String((e && e.name) || e))) throw e;
      usePlayer = false; // 以後は Web Audio で再生
    }
  }
  if (memAudio.has(key)) return playBuffer(memAudio.get(key));
  if (!bytes) bytes = await (await fetch(memUrl.get(key))).arrayBuffer();
  const buf = await audioCtx.decodeAudioData(bytes.slice(0));
  memAudio.set(key, buf);
  return playBuffer(buf);
}

/* 速さは3段階。通常はタグなし（SSMLのタグも課金文字数に入るため） */
// 読み上げの速さ：ふつう（0.9）／ゆっくり（0.7 → -25%）／単語のゆっくり（0.55〜0.6 → -40%）／さらにゆっくり（0.5 → -50%）
// -50%（0.5倍）は Azure の読み上げで指定できる一番遅い速さ（SSML の prosody rate は 0.5〜2倍）
const rateKey = (r) => (!r || r >= 0.85 ? "n" : r >= 0.65 ? "s" : r >= 0.55 ? "xs" : "xxs");
const RATE_PCT = { s: "-25%", xs: "-40%", xxs: "-50%" };
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
    if (usePlayer && useSink() && memUrl.has(key)) return playMp3(key, null);
    if (memAudio.has(key) && !(usePlayer && useSink())) return playBuffer(memAudio.get(key));
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
    return playMp3(key, bytes);
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
let wQueue = [], wCur = null, revealed = false, wDone = 0, wHeld = 0;
/* 1枚の単語の出し方（v0.20.0、v0.21.0 で「聞いて意味を選ぶ」を追加。決め方は srs.js の wordMode）
   mc       ：英語 → 意味を4択で選んでから答えを見る（間違えたら「もう一度」）
   rev      ：一度覚えた単語は逆向き。日本語の意味と例文の穴埋めを見て、英語を声で言う（Speech で判定）
   listen   ：文字を見せずに単語の音だけを聞いて、意味を4択
   listen-ex：文字を見せずに例文の音だけを聞いて、例文の意味を4択
   wPick：4択で選んだもの、wRev：声で答える状態 { state: ask|listening|wrong, heard } */
let wMode = "mc", wChoices = null, wPick = null, wRev = null, wGiveUp = false;
const isListen = () => wMode === "listen" || wMode === "listen-ex";
const cueText = () => (wCur ? (wMode === "listen-ex" ? wCur.example : wCur.word) : "");
function setWordCur(w) {
  wCur = w || null; revealed = false; wPick = null; wGiveUp = false; wRev = null;
  if (!wCur) return;
  wMode = S.wordMode(data.cards.word[wCur.id], wCur);
  if (wMode === "rev") wRev = { state: "ask", heard: "" };
  wChoices = wMode === "listen-ex" ? S.exampleChoices(wCur, data.words) : wMode === "rev" ? null : S.meaningChoices(wCur, data.words);
  // 4択が作れないとき（単語が少ない）は、今までどおり英語を見て答えを見る形にする
  if (isListen() && !wChoices) { wMode = "mc"; wChoices = S.meaningChoices(wCur, data.words); }
}
/* 聞いて意味を選ぶ形のときは、出したらすぐに音を鳴らす（ボタンを押した直後なので自動再生が許される） */
function playListenCue() { if (wCur && isListen() && !revealed) say(cueText(), 0.9); }
function buildWordQueue() {
  const q = S.buildQueue(data.words, data.cards.word, st().newLog, st().newPerDay, "category", "tech", "general");
  // 復習待ちが多い日は、新しい単語を止めて復習を先に終わらせる
  const c = S.capNew(q, data.cards.word);
  wQueue = c.queue; wHeld = c.held;
  setWordCur(wQueue.shift());
}
function counts() {
  const all = [wCur, ...wQueue].filter(Boolean);
  $("s-wrev").textContent = all.filter((w) => data.cards.word[w.id]).length;
  $("s-wnew").textContent = all.filter((w) => !data.cards.word[w.id]).length;
  $("s-sent").textContent = [sCur, ...sQueue].filter(Boolean).length;
  // 単語・文と同じく「今日の残り」を出す（会話は1日1回が目安。振り返りまで終えると1回）
  if ($("s-talk")) $("s-talk").textContent = Math.max(0, TALK_GOAL - talkCountToday());
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
  if (!wCur) { v.innerHTML = emptyCard("今日の単語は終わりです", (wDone ? wDone + "枚を学習しました。" : "") + (wHeld ? `復習がたまっているので、今日の新しい単語（${wHeld}語）はお休みにしました。` : "") + "次はシャドーイングに進みましょう。"); return; }
  const w = wCur, s = data.cards.word[w.id];
  const rev = wMode === "rev";
  let h = `<article class="card" aria-live="polite">
    <div class="row between"><span class="chip">${rev ? "英語で言う" : wMode === "listen" ? "聞いて意味を選ぶ" : wMode === "listen-ex" ? "例文を聞いて意味を選ぶ" : s ? "復習" : "新しい単語"} · ${w.category === "general" ? "一般" : "技術"}</span><span class="note">${esc(w.pos || "")}</span></div>
`;
  if (rev && !revealed) {
    // 逆向き：答え（英単語）は見せず、音も鳴らさない
    const lis = wRev.state === "listening";
    h += `<p class="word-ja">${esc(w.meaning)}</p>
      <div class="ex">${esc(S.cloze(w.word, w.example))}</div><div class="tr">${esc(w.translation)}</div>
      <p class="note" style="margin:0">____ に入る英語を、声に出して言いましょう${w.word.includes(" ") ? `（${w.word.split(" ").length}語）` : ""}。</p>
      ${wRev.state === "wrong" ? `<p class="note" role="alert" style="margin:0;color:var(--again)">「${esc(wRev.heard)}」と聞こえました。もう一度言うか、答えを見てください。</p>` : ""}
      ${lis ? listenBtn("w-say") : `<button class="btn primary" id="w-say">${MIC}${wRev.state === "wrong" ? "もう一度言う" : "英語で言う"}</button>`}
      ${lis ? `<div class="meter" role="img" aria-label="マイクの音量。縦線を超えれば十分です"><i id="mic-level"></i></div><p class="note" id="mic-label" style="margin:-8px 0 0">マイクを準備しています…</p>` : ""}
      <div class="row"><button class="btn" id="w-giveup" ${lis ? "disabled" : ""}>分からない（答えを見る）</button><button class="linkbtn" id="w-self" ${lis ? "disabled" : ""}>声を出せないので自分で判定</button></div>
    </article>`;
    v.innerHTML = h;
    $("w-say").onclick = () => (lis ? listenStop && listenStop() : wordListen());
    $("w-giveup").onclick = () => { wGiveUp = true; revealed = true; renderStudy(); say(w.word, 0.9); };
    $("w-self").onclick = () => { wRev = null; revealed = true; renderStudy(); say(w.word, 0.9); };
    return;
  }
  if (isListen() && !revealed) {
    // 聞いて意味を選ぶ：英語の文字は見せない
    const ex = wMode === "listen-ex", cue = cueText();
    h += `<p class="note" style="margin:0">${ex ? "例文を聞いて、文の意味を選んでください。" : "音だけを聞いて、意味を選んでください。"}文字は答えのあとに出ます。</p>
      <div class="row">
        <button class="btn primary" data-say="${esc(cue)}">${SPK}聞く</button>
        <button class="btn" data-say="${esc(cue)}" data-rate="0.6">${SLOW}ゆっくり</button>
      </div>
      <div class="opts">${wChoices.map((c, i) => `<button class="opt" data-mc="${i}" style="font-family:inherit;font-size:15px">${esc(c.meaning)}</button>`).join("")}</div>
      <div class="row"><button class="linkbtn" id="reveal">分からない（答えを見る）</button><button class="linkbtn" id="w-noaudio">音を出せないので文字で答える</button></div>
    </article>`;
    v.innerHTML = h;
    bindWordChoices(v, w);
    $("w-noaudio").onclick = () => { wMode = "mc"; wChoices = S.meaningChoices(w, data.words); renderStudy(); };
    return;
  }
  h += `<p class="word">${esc(w.word)}</p>
    <div class="row">
      <button class="btn" data-say="${esc(w.word)}">${SPK}発音を聞く</button>
      <button class="btn" data-say="${esc(w.word)}" data-rate="0.55">${SLOW}ゆっくり</button>
    </div>`;
  if (!revealed) {
    if (wChoices) {
      h += `<p class="note" style="margin:0">意味を選んでください。</p>
        <div class="opts">${wChoices.map((c, i) => `<button class="opt" data-mc="${i}" style="font-family:inherit;font-size:15px">${esc(c.meaning)}</button>`).join("")}</div>
        <button class="linkbtn" id="reveal">分からない（答えを見る）</button></article>`;
    } else {
      h += `<p class="note">意味と類義語を思い出し、発音をまねてから答えを見ましょう。</p>
        <button class="btn primary" id="reveal">答えを見る</button></article>`;
    }
  } else {
    // 4択で間違えた・分からなかった・声で言えなかった → 「もう一度」だけ
    const missed = wGiveUp || (wPick && !wPick.ok);
    const said = rev && wRev && wRev.state === "ok";
    h += `${wPick ? `<div class="opts">${wChoices.map((c) => `<div class="opt ${c.id === w.id ? "ok" : c.id === wPick.id ? "ng" : ""}" style="font-family:inherit;font-size:15px;cursor:default">${c.id === w.id ? "✓ " : c.id === wPick.id ? "✕ " : ""}${esc(c.meaning)}</div>`).join("")}</div>` : ""}
      ${said ? `<p class="note" style="margin:0;color:var(--good)">✓ 言えました（「${esc(wRev.heard)}」）</p>` : ""}
      <div class="row between"><div class="ipa">${esc(w.ipa)}</div><button class="fbbtn" data-fb="word" aria-label="この単語の内容を報告">👎 おかしい</button></div>
      <div class="stress" aria-label="強勢: ${esc(w.stress)}">${stressHTML(w.stress)}</div>
      ${w.stressNote ? `<p class="note" style="margin:-8px 0 0">${esc(w.stressNote)}</p>` : ""}
      <dl>
        <dt>意味</dt><dd><b>${esc(w.meaning)}</b></dd>
        <dt>類義語</dt><dd class="syn">${(w.synonyms || []).map((x) => `<button data-say="${esc(x)}">${esc(x)}</button>`).join("")}</dd>
        <dt>例文</dt><dd><div class="ex">${exHTML(w)}</div><div class="tr">${esc(w.translation)}</div>
          <div class="row" style="margin-top:6px"><button class="btn" data-say="${esc(w.example)}">${SPK}例文</button></div></dd>
      </dl>
      ${w.tip ? `<div class="tip"><strong>発音のコツ</strong>${esc(w.tip)}</div>` : ""}
      ${missed
        ? `<p class="note" style="margin:0">${wGiveUp ? "答えを確かめて、" : "正しい意味を確かめて、"}発音をまねてから次へ進みましょう。少しあとにもう一度出します。</p>
          <div class="grades" style="grid-template-columns:1fr"><button class="g-again" data-grade="again"><span class="lbl">次へ（もう一度）</span><span class="nx">${fmtNext(S.nextState(s, "again").interval)}</span></button></div>`
        : `<div class="grades">${[["again", "もう一度"], ["hard", "難しい"], ["good", "覚えた"], ["easy", "簡単"]].map(([g, l]) =>
          `<button class="g-${g}" data-grade="${g}"><span class="lbl">${l}</span><span class="nx">${fmtNext(S.nextState(s, g).interval)}</span></button>`).join("")}</div>`}
    </article>`;
  }
  v.innerHTML = h;
  bindWordChoices(v, w);
}
/* 4択と「分からない」のボタン（英語を見て選ぶ・聞いて選ぶで共通） */
function bindWordChoices(v, w) {
  const r = $("reveal"); if (r) r.onclick = () => { if (wChoices) wGiveUp = true; revealed = true; renderStudy(); say(w.word, 0.9); };
  v.querySelectorAll("[data-mc]").forEach((b) => (b.onclick = () => {
    const c = wChoices[+b.dataset.mc];
    wPick = { id: c.id, ok: c.id === w.id };
    revealed = true; renderStudy(); say(w.word, 0.9);
  }));
}
/* 逆向きの単語：英語を声で言って、合っているか判定する（発音の点数は付けない） */
async function wordListen() {
  if (!wCur || !wRev || micBusy()) return;
  if (!window.SpeechSDK) { showBanner("音声認識の部品を読み込めていません。「声を出せないので自分で判定」で進めてください。"); return; }
  stopAudio(); unlockAudio();
  if (!audioCtx) { showBanner("このブラウザでは録音できません。「声を出せないので自分で判定」で進めてください。"); return; }
  const w = wCur;
  wRev.state = "listening"; renderStudy(); showBanner("");
  const text = await listenText(() => renderStudy());
  if (wCur !== w || !wRev) return;
  if (!text) { wRev.state = "ask"; renderStudy(); return; }
  wRev.heard = text.replace(/[.?!]+$/, "");
  if (S.matchSpoken(w.word, text)) { wRev.state = "ok"; revealed = true; renderStudy(); say(w.word, 0.9); }
  else { wRev.state = "wrong"; renderStudy(); }
}
function gradeWord(g) {
  const w = wCur; if (!w) return;
  const wasNew = !data.cards.word[w.id];
  noteRetention("word", data.cards.word[w.id], g);
  data.cards.word[w.id] = S.nextState(data.cards.word[w.id], g);
  saveCard("word", w.id);
  if (wasNew) { bumpLog("newLog"); saveSettings(); }
  // その場で出し直すのは1回だけ（2回目の「もう一度」は明日に回す）
  if (g === "again" && !wRetried.has(w.id)) { wRetried.add(w.id); wQueue.splice(Math.min(3, wQueue.length), 0, w); }
  wDone++;
  setWordCur(wQueue.shift());
  renderStudy();
  playListenCue();
}

/* ================= シャドーイング＋発音評価 ================= */
let sBestNg = 0;
const sRetried = new Set(), wRetried = new Set(); // 今日その場で出し直した文・単語
const sExtra = new Set(); // 苦手な音の練習でシャドーイングに足した文
/* フレーズ帳の文は、先に日本語（または直す前の言い方）から英語を思い出してもらう（検索練習）。
   ask：思い出す → shown：答え合わせ → ok / ng：自己判定（ng なら発音の点にかかわらず明日また出す） */
let sRecall = { id: null, state: "ask" };
const recallOf = (s) => (s && s.phrase ? (sRecall.id === s.id ? sRecall.state : "ask") : "none");
let sQueue = [], sCur = null, sBest = null, sResult = null, sShowJa = false, recording = false, sDone = 0, openWord = -1;
let drill = null; // 単語の発音練習 { sid, w, res, tries, passes, msg }
let drillRec = false; // 単語の練習で録音中（音量メーターを単語の枠に出す）
/* 録音の段階：listen＝聞き取り中（「話し終わった」で止める）、score＝採点中（Azure の結果待ち）。
   scoreMsg は採点中に出す説明（設定を変えて採点し直しているときなど） */
let recPhase = "", scoreMsg = "", stopRec = null;
// 録音ボタン：聞き取り中は「話し終わった」で止められる。採点中は押せない
function recButtonHTML(id, active, idleLabel) {
  if (active && recPhase === "listen") return `<button class="btn primary rec" id="${id}">■ 話し終わった（採点する）</button>`;
  if (active && recPhase === "score") return `<button class="btn primary scoring" id="${id}" disabled aria-busy="true"><span class="spin" aria-hidden="true"></span>採点中…${scoreMsg ? `<small>（${esc(scoreMsg)}）</small>` : ""}</button>`;
  return `<button class="btn primary" id="${id}" ${recording ? "disabled" : ""}>${MIC}${idleLabel}</button>`;
}
function buildSentenceQueue() {
  const q = S.buildQueue(data.sentences, data.cards.sentence, st().newSentLog, st().newSentencesPerDay, "category", "conference", "conversation");
  // フレーズ帳の新しい表現は、期限の来た復習のすぐ後（ほかの新しい文より先）に出す
  const isNewPhrase = (x) => x.phrase && !data.cards.sentence[x.id];
  const rest = q.filter((x) => !isNewPhrase(x));
  const dueCount = rest.filter((x) => data.cards.sentence[x.id]).length;
  sQueue = [...rest.slice(0, dueCount), ...q.filter(isNewPhrase), ...rest.slice(dueCount)];
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
  if (!sCur) { v.innerHTML = emptyCard("今日の文は終わりです", (sDone ? sDone + "文を練習しました。" : "") + "仕上げに「練習」をどうぞ。"); return; }
  const s = sCur, c = data.cards.sentence[s.id];
  if (drill && drill.sid !== s.id) drill = null;
  const rc = recallOf(s);
  if (rc === "ask" || rc === "shown") return renderRecall(v, s, c, rc);
  const hide = st().hideText && !sResult;
  const r = sResult;
  let h = `<article class="card" aria-live="polite">
    <div class="row between"><span class="chip">${c ? "復習" : "新しい文"} · ${esc(s.scene || "")}${rc === "ok" ? " · ✓ 思い出せた" : rc === "ng" ? " · もう一度覚える" : ""}</span>
      <span class="row" style="gap:8px"><span class="note">${c && c.best != null ? "最高 " + c.best + "点" : ""}</span><button class="fbbtn" data-fb="sentence" aria-label="この文の内容や評価を報告">👎</button></span></div>
    <p class="sent ${hide ? "hidden" : ""}" id="sent-text">${esc(s.text)}</p>
    ${sShowJa ? `<p class="tr" style="margin:-6px 0 0">${s.ja ? esc(s.ja) : jaPending.has(s.id) ? '<span class="note">訳を作っています…</span>' : '<span class="note">訳がありません</span>'}</p>` : ""}
    <div class="row">
      <button class="btn" data-say="${esc(s.text)}">${SPK}お手本</button>
      <button class="btn" data-say="${esc(s.text)}" data-rate="0.7">${SLOW}ゆっくり</button>
      <button class="btn" data-say="${esc(s.text)}" data-rate="0.5">${SLOW}さらにゆっくり</button>
      ${s.ja || s.phrase ? `<button class="btn" id="toggle-ja">${sShowJa ? "訳を隠す" : "訳を見る"}</button>` : ""}
      ${hide ? `<button class="btn" id="show-text">文を見る</button>` : ""}
    </div>
    <div class="row" style="gap:12px">${outputSelectHTML("out-sel-shadow")}${gainSelectHTML("gain-sel-shadow")}</div>
    ${recButtonHTML("rec", recording && !drillRec, r ? "もう一度話す" : "話す（録音して評価）")}
    ${recording && !drillRec && recPhase === "listen" ? `<div class="meter" role="img" aria-label="マイクの音量。縦線を超えれば十分です"><i id="mic-level"></i></div>
      <p class="note" id="mic-label" style="margin:-8px 0 0">マイクを準備しています…</p>
      <p class="note" style="margin:0">言い終わったら「■ 話し終わった」を押してください（3秒黙ると自動でも止まります）。</p>` : ""}
    ${drill ? "" : recDiagHTML()}`;
  if (r) {
    const fb = S.pronFeedback(r, st().strictness);
    const MARK = { ok: "✓", mid: "△", ng: "✕", omit: "✕", ins: "" };
    h += `<div class="verdict ${fb.verdict.level}" role="status">
        <b>${fb.verdict.level === "ok" ? "✓" : fb.verdict.level === "mid" ? "△" : "✕"} ${esc(fb.verdict.en)}（${esc(fb.verdict.ja)}）</b>
        <span>${esc(fb.verdict.msg)}</span>
      </div>
      <div class="scores">
        <div class="sc main"><div class="v">${r.judge}</div><div class="k">判定点</div></div>
        <div class="sc"><div class="v">${r.acc}</div><div class="k">正確さ</div></div>
        <div class="sc"><div class="v">${r.flu}</div><div class="k">流暢さ</div></div>
        <div class="sc"><div class="v">${r.comp}</div><div class="k">完全さ</div></div>
      </div>
      <div class="pw">${r.words.map((w, i) => { const c = S.wordClass(w, st().strictness); return `<button class="${c}" data-pw="${i}">${MARK[c] ? `<span class="mk" aria-hidden="true">${MARK[c]}</span>` : ""}${esc(w.w)}${w.acc != null && w.err !== "Omission" ? `<small class="note"> ${w.acc}</small>` : ""}</button>`; }).join("")}</div>
      ${fb.hints.length ? `<div class="hints"><p class="note" style="margin:0">改善点</p><ol>${fb.hints.map((t) => `<li>
          <div>${t.kind === "phoneme" ? `<span class="ipa">/${esc(t.ph)}/</span> ` : ""}${t.words.length ? t.words.map((x) => `<b class="w">${esc(x)}</b>`).join("・") : ""}${t.kind === "phoneme" ? `<span class="note">（${t.score}点）</span>` : t.kind === "omit" ? `<span class="note">（言い落とし）</span>` : t.kind === "fluency" ? `<b>流暢さ</b><span class="note">（${r.flu}点）</span>` : ""}</div>
          <div>${esc(t.tip)}</div>
          ${t.kind === "phoneme" ? guideHTML(t.guide, { ph: t.ph, open: false }) : ""}
          ${t.words[0] ? `<div class="row" style="margin-top:4px">${t.words.slice(0, 2).map((x) => `<button class="btn sm" data-say="${esc(x)}" data-rate="0.6">${SLOW}${esc(x)}</button>`).join("")}${t.kind === "phoneme" || t.kind === "word" ? `<button class="btn sm" data-drill="${esc(t.words[0])}" ${recording ? "disabled" : ""}>${MIC}${esc(t.words[0])} を録音して練習</button>` : ""}</div>` : ""}
        </li>`).join("")}</ol></div>` : ""}
      <p class="note" style="margin:0">Azure の総合点 ${r.pron}点${r.judge < r.pron ? ` から、崩れた単語の分を減点しています（採点：${esc((S.STRICTNESS[st().strictness]?.label || "").replace(/（.*）/, ""))}）` : ""}${r.ngCount && r.judge >= 90 && st().strictness !== "standard" ? `。「要練習」の単語が${r.ngCount}語あるので、「覚えた」にはなりません` : ""}</p>
      <div class="legend"><span><i style="background:var(--good)"></i>✓ 良い</span><span><i style="background:var(--hard)"></i>△ あと少し</span><span><i style="background:var(--again)"></i>✕ 要練習</span><span>取り消し線＝言い落とし</span></div>
      ${drill ? drillHTML() : openWord >= 0 && r.words[openWord] ? `<div><p class="note" style="margin:0 0 4px">「${esc(r.words[openWord].w)}」の音ごとの点数</p>
        <div class="phon">${r.words[openWord].ph.map(([p, a]) => `<span style="border-color:${a < 60 ? "var(--again)" : a < 80 ? "var(--hard)" : "var(--good)"}">${esc(p)} ${a}</span>`).join("") || '<span class="note">音素データなし</span>'}</div>
        <div class="row" style="margin-top:6px"><button class="btn" data-say="${esc(r.words[openWord].w)}" data-rate="0.6">${SLOW}この単語をゆっくり</button>${r.words[openWord].err !== "Insertion" ? `<button class="btn" data-drill="${esc(r.words[openWord].w)}" ${recording ? "disabled" : ""}>${MIC}この単語を練習</button>` : ""}</div></div>` : `<p class="note" style="margin:0">単語をタップすると、音ごとの点数が見られます。</p>`}
      ${r.recognized ? `<p class="note" style="margin:0">聞き取られた文：${esc(r.recognized)}</p>` : ""}
      <button class="btn primary" id="next-sent">次の文へ（今回の最高 ${sBest}点で記録）</button>`;
  } else {
    h += `<p class="note" style="margin:0">お手本を聞いて、すぐ後に同じリズムで話してみましょう。1文30秒以内です。</p>`;
  }
  h += `</article>`;
  v.innerHTML = h;
  if ($("toggle-ja")) $("toggle-ja").onclick = () => { sShowJa = !sShowJa; if (sShowJa) ensureJa(s); renderShadow(); };
  if ($("show-text")) $("show-text").onclick = () => { $("sent-text").classList.remove("hidden"); $("show-text").remove(); };
  $("rec").onclick = () => (recording ? stopRec && stopRec() : startAssessment());
  bindOutputSelect("out-sel-shadow", renderShadow);
  bindGainSelect("gain-sel-shadow", renderShadow);
  if ($("next-sent")) $("next-sent").onclick = nextSentence;
  if ($("drill-rec")) $("drill-rec").onclick = () => (drillRec ? stopRec && stopRec() : drillRecord());
  if ($("drill-close")) $("drill-close").onclick = () => { drill = null; renderShadow(); };
  if ($("rec-play")) $("rec-play").onclick = playRecDiag;
}

/* 音の口の形（唇・舌・声）。発音記号だけでは分かりにくいので、近い日本語の音と口の動きで示す。
   g：S.guideFor の結果、fix：聞こえた音に応じた直し方、heard：聞こえた音。open=false なら折りたたむ */
function guideHTML(g, { fix = "", heard = "", ph = "", open = true } = {}) {
  if (!g) return "";
  const line = (icon, k, v) => (v && v !== "関係なし" ? `<div class="gl"><span class="gk">${icon} ${k}</span><span>${esc(v)}</span></div>` : "");
  const body = `${fix ? `<div class="gfix">🔧 ${heard ? `/${esc(heard)}/ に聞こえたときの直し方：` : ""}${esc(fix)}</div>` : ""}
    ${line("👄", "唇", g.lips)}${line("👅", "舌", g.tongue)}${line("🔊", "声・息", g.voice)}
    ${g.ng ? `<div class="gl"><span class="gk">⚠️ 注意</span><span>${esc(g.ng)}</span></div>` : ""}
    ${g.ex && g.ex.length ? `<div class="row gex"><span class="note">同じ音の単語：</span>${g.ex.map((x) => `<button class="btn sm" data-say="${esc(x)}" data-rate="0.6">${SLOW}${esc(x)}</button>`).join("")}</div>` : ""}`;
  const head = `<span class="gkana">カナの目安：${esc(g.kana)}</span>`;
  return open
    ? `<div class="guide">${head}${body}</div>`
    : `<details class="guide"><summary>${ph ? `/${esc(ph)}/ ` : "この音"}の口の形・舌の位置を見る</summary>${body}</details>`;
}

/* ---------- 単語の発音練習：シャドーイングでつまずいた単語を、文の中の短いまとまりで言って、その単語だけを評価する ----------
   お手本が1語だけだと、発音評価が聞き取れないことがある（2026-11-10、発音評価なしなら認識できる録音でも失敗）。
   そこで前後の語ごと（2〜4語）言ってもらい、採点はその単語だけにする。合格は、その単語が採点の厳しさで「良い」になったとき。
   話された音の候補（nBestPhonemeCount）から、どの音に聞こえたかも示す。単語の記録は発音の記録（attempts）には入れない */
function startDrill(word) {
  const w = String(word || "").replace(/[^A-Za-z'\-]/g, "");
  if (!w || !sCur || recording) return;
  drill = { sid: sCur.id, w, chunk: S.drillChunk(sCur.text, w), res: null, tries: 0, passes: 0, msg: "" };
  renderShadow();
  // 改善点のボタンから開いたときは、練習の枠が画面の下にあるので見える位置まで動かす
  const box = document.querySelector("#view-shadow .drill");
  if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function drillRecord() {
  if (!drill || recording) return;
  const d = drill;
  d.msg = "";
  drillRec = true;
  let r = null;
  try {
    r = await assessOnce(d.chunk, { nbestPhonemes: 5 });
    if (drill === d) {
      if (r) {
        d.res = S.wordDrill(r, d.w, st().strictness);
        d.tries++;
        if (d.res && d.res.pass) d.passes++;
        else if (!d.res) d.msg = `「${d.w}」を聞き取れませんでした。お手本を聞いてから、まとまりごと言ってみてください。`;
      } else {
        // 失敗の理由は画面上部のバナーにも出るが、下までスクロールしていると見えないので枠の中にも出す
        const b = $("banner");
        d.msg = (b && !b.hidden && b.textContent) || "評価できませんでした。もう一度試してください。";
      }
    }
  } catch (e) {
    if (drill === d) d.msg = "評価できませんでした（" + (e && e.message ? e.message : e) + "）。ページを開き直してもう一度試してください。";
  } finally {
    drillRec = false;
    renderShadow();
  }
}
// まとまりの中の練習する単語を太字にする
function chunkHTML(chunk, w) {
  const t = String(w).toLowerCase().replace(/[^a-z']/g, "");
  let done = false;
  return String(chunk).split(/\s+/).map((x) => {
    if (!done && x.toLowerCase().replace(/[^a-z']/g, "") === t) { done = true; return `<b><u>${esc(x)}</u></b>`; }
    return esc(x);
  }).join(" ");
}
function drillHTML() {
  const d = drill, x = d.res;
  const col = (a) => (a < 60 ? "var(--again)" : a < 80 ? "var(--hard)" : "var(--good)");
  let h = `<div class="drill">
    <div class="row between"><b>🎯 単語の練習：<span class="w">${esc(d.w)}</span></b><span class="note">${d.tries ? `${d.tries}回中 ${d.passes}回合格` : ""}</span></div>
    <p class="sent" style="margin:0">${chunkHTML(d.chunk, d.w)}</p>
    <p class="note" style="margin:0">前後の語といっしょに言ってください。採点は「${esc(d.w)}」だけです。</p>
    <div class="row">
      <button class="btn sm" data-say="${esc(d.chunk)}">${SPK}お手本</button>
      <button class="btn sm" data-say="${esc(d.chunk)}" data-rate="0.6">${SLOW}ゆっくり</button>
      <button class="btn sm" data-say="${esc(d.w)}" data-rate="0.6">${SLOW}単語だけゆっくり</button>
    </div>
    ${recButtonHTML("drill-rec", drillRec, d.tries ? "もう一度言う（録音して評価）" : "まとまりで言う（録音して評価）")}
    ${drillRec && recPhase === "listen" ? `<div class="meter" role="img" aria-label="マイクの音量。縦線を超えれば十分です"><i id="mic-level"></i></div>
      <p class="note" id="mic-label" style="margin:-4px 0 0">マイクを準備しています…</p>` : ""}
    ${d.msg ? `<p class="note" role="alert" style="margin:0;color:var(--again)">${esc(d.msg)}</p>` : ""}
    ${recDiagHTML()}`;
  if (x) {
    h += `<div class="verdict ${x.pass ? "ok" : x.level === "mid" ? "mid" : "ng"}" role="status"><b>${x.pass ? "✓ 合格" : x.level === "mid" ? "△ あと少し" : "✕ 要練習"}（${x.acc ?? 0}点）</b>
        <span>${x.pass ? "文に戻って、もう一度通して話してみましょう。" : "下の音を意識して、お手本の「ゆっくり」をまねしてから言い直しましょう。"}</span></div>
      <div class="phon">${x.ph.map(([p, a, heard]) => `<span style="border-color:${col(a)}">${esc(p)}${heard && a < 80 ? `→${esc(heard)}` : ""} ${a}</span>`).join("") || '<span class="note">音素データなし</span>'}</div>
      ${x.weak.length ? `<ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px">${x.weak.map((t) => `<li><span class="ipa">/${esc(t.ph)}/</span><span class="note">（${t.score}点）</span>${t.heard ? ` <span class="note">/${esc(t.ph)}/ が /${esc(t.heard)}/ に近く聞こえました</span>` : ""}<div>${esc(t.tip)}</div>${guideHTML(t.guide, { fix: t.fix, heard: t.heard })}</li>`).join("")}</ol>` : ""}`;
  }
  h += `<div class="row">${x && x.pass ? `<button class="btn primary" id="drill-close" style="width:auto;flex:1">文に戻る</button>` : `<button class="btn" id="drill-close">文に戻る</button>`}</div>
    <p class="note" style="margin:0">→の右は、実際にそう聞こえた音です。単語の練習は復習の予定や発音の記録には入りません。</p>
  </div>`;
  return h;
}

/* フレーズ帳：思い出す → 答え合わせ → 自己判定 */
function renderRecall(v, s, c, rc) {
  if (!s.ja && !s.before) ensureJa(s); // 手がかり（訳）が無いと思い出す練習にならないので、1回だけ訳を作る
  const words = s.text.split(/\s+/);
  v.innerHTML = `<article class="card recall" aria-live="polite">
    <div class="row between"><span class="chip">📒 フレーズ帳 · ${c ? "復習" : "新しい表現"} · ${esc(s.scene || "")}</span><span class="note">${c && c.best != null ? "最高 " + c.best + "点" : ""}</span></div>
    <p class="note" style="margin:0">${s.before ? "もっと自然に言うと？ 英語で声に出してみましょう" : "英語で何と言う？ 声に出してみましょう"}</p>
    ${s.before ? `<p class="cue"><span class="note">直す前：</span>${esc(s.before)}</p>` : ""}
    ${s.ja ? `<p class="cue">${esc(s.ja)}</p>` : ""}
    ${!s.before && !s.ja ? `<p class="cue">${jaPending.has(s.id) ? '<span class="note">訳を作っています…</span>' : `（場面：${esc(s.scene || "")}）`}</p>` : ""}
    ${rc === "ask"
      ? `${sRecall.hint && sRecall.id === s.id ? `<p class="note" style="margin:0">ヒント：${esc(words.slice(0, 2).join(" "))} …（${words.length}語）</p>` : ""}
        <div class="row">${sRecall.hint && sRecall.id === s.id ? "" : `<button class="btn" id="rc-hint">ヒント</button>`}<button class="btn primary" id="rc-show" style="width:auto;flex:1">答えを見る</button></div>`
      : `<p class="sent">${esc(s.text)}</p>
        <div class="row"><button class="btn" data-say="${esc(s.text)}">${SPK}もう一度聞く</button><button class="btn" data-say="${esc(s.text)}" data-rate="0.7">${SLOW}ゆっくり</button><button class="btn" data-say="${esc(s.text)}" data-rate="0.5">${SLOW}さらにゆっくり</button></div>
        <p class="note" style="margin:0">言えましたか？（このあとシャドーイングで仕上げます）</p>
        <div class="row"><button class="btn" id="rc-ok" style="width:auto;flex:1">✓ 言えた</button><button class="btn" id="rc-ng" style="width:auto;flex:1">✗ 言えなかった</button></div>`}
  </article>`;
  if ($("rc-hint")) $("rc-hint").onclick = () => { sRecall = { id: s.id, state: "ask", hint: true }; renderShadow(); };
  if ($("rc-show")) $("rc-show").onclick = () => { sRecall = { id: s.id, state: "shown" }; renderShadow(); say(s.text, 0.9); };
  if ($("rc-ok")) $("rc-ok").onclick = () => { sRecall = { id: s.id, state: "ok" }; renderShadow(); };
  if ($("rc-ng")) $("rc-ng").onclick = () => { sRecall = { id: s.id, state: "ng" }; renderShadow(); };
}

/* 録音はアプリ側で行い、16kHz・16bit・モノラルの PCM にして SDK の push stream に流す。
   SDK 既定のマイク入力は、トークン取得の後（タップの外）に 16kHz の AudioContext を新しく作るため、
   iPhone では無音のまま「聞き取れませんでした」になることがある。
   こちらはタップの中で起こした AudioContext を使い、トークン取得より先に録音を始める（話し始めも切れない） */
/* ---------- マイクの感度と音量メーター ---------- */
const GAIN_KEY = "et-micgain";        // 端末ごとに違うので、端末に保存（PCとスマホで共有しない）
const MIC_GAINS = [[1, "標準"], [2, "高め（×2）"], [4, "最大（×4）"]];
const micGain = () => { try { const g = +localStorage.getItem(GAIN_KEY); return MIC_GAINS.some(([v]) => v === g) ? g : 1; } catch (e) { return 1; } };
const OK_DB = -38, QUIET_DB = -50;    // 声として十分な目安／ほぼ無音
const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
function gainSelectHTML(id) {
  return `<label class="note" for="${id}" style="display:flex;gap:6px;align-items:center">マイクの感度
    <select id="${id}">${MIC_GAINS.map(([v, l]) => `<option value="${v}" ${v === micGain() ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;
}
function bindGainSelect(id, rerender) {
  const el = $(id); if (!el) return;
  el.onchange = (e) => { try { localStorage.setItem(GAIN_KEY, e.target.value); } catch (er) {} rerender(); };
}
function updateMeter(db) {
  const bar = $("mic-level"), label = $("mic-label"); if (!bar) return;
  bar.style.width = dbToPct(db).toFixed(0) + "%";
  bar.className = db >= OK_DB ? "ok" : db >= QUIET_DB ? "low" : "";
  if (label) label.textContent = db >= OK_DB ? "聞こえています" : db >= QUIET_DB ? "声が小さめです。マイクに近づくか、感度を上げてください" : "聞こえていません。話してみてください";
}

async function openMic(onPcm, onLevel) {
  setAudioSession("play-and-record");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }, video: false,
  });
  // 別のアプリから戻った後などは resume() が終わらないことがあるので、待つのは 1.5 秒まで
  if (audioCtx.state !== "running") { try { await Promise.race([audioCtx.resume(), sleep(1500)]); } catch (e) {} }
  const ctx = audioCtx;
  const srcNode = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0; // 処理を動かすために出力へつなぐが、音は出さない
  const ratio = ctx.sampleRate / 16000;
  let carry = 0;
  const gain = micGain();
  const track = stream.getAudioTracks()[0];
  let trackRate = null; try { trackRate = (track && track.getSettings().sampleRate) || null; } catch (e) {}
  // 診断用：送った音声（16kHz）と、実際にかかった時間・サンプリング周波数を記録する
  const mic = { peak: 0, maxDb: -Infinity, close: null, pcm: [], samples: 0, firstAt: 0, lastAt: 0, ctxRate: ctx.sampleRate, trackRate, ctxState: ctx.state };
  let gotFrame = null; const firstFrame = new Promise((r) => (gotFrame = r));
  proc.onaudioprocess = (ev) => {
    const now = performance.now();
    if (!mic.firstAt) { mic.firstAt = now; gotFrame(); }
    mic.lastAt = now;
    const x = ev.inputBuffer.getChannelData(0);
    // carry = この区間で次に作るサンプルの開始位置（0以上）
    const n = Math.ceil((x.length - carry) / ratio);
    if (n <= 0) { carry -= x.length; return; }
    const out = new Int16Array(n);
    let sq = 0;
    for (let i = 0; i < n; i++) {
      // 区間の平均で 16kHz に間引く（簡易ローパス）
      const a = Math.floor(carry + i * ratio), b = Math.min(x.length, Math.floor(carry + (i + 1) * ratio));
      let sum = 0; for (let j = a; j < b; j++) sum += x[j];
      const v = Math.max(-1, Math.min(1, (b > a ? sum / (b - a) : x[a] || 0) * gain)); // 感度を掛けて、はみ出しは切る
      const abs = Math.abs(v); if (abs > mic.peak) mic.peak = abs;
      sq += v * v;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    carry = carry + n * ratio - x.length;
    if (mic.samples < 16000 * 40) mic.pcm.push(out); // 40 秒分まで（再生・再認識の診断用。端末のメモリだけに置く）
    mic.samples += n;
    onPcm(out.buffer);
    const db = 20 * Math.log10(Math.max(Math.sqrt(sq / n), 1e-6)); // 区間の平均音量（dBFS）
    if (db > mic.maxDb) mic.maxDb = db;
    if (onLevel) onLevel(db);
  };
  srcNode.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  mic.close = () => {
    proc.onaudioprocess = null;
    try { srcNode.disconnect(); proc.disconnect(); mute.disconnect(); } catch (e) {}
    stream.getTracks().forEach((t) => t.stop());
  };
  // マイクの音が処理に届き始めるまで最大 3 秒待つ。届かなければ AudioContext が止まっているので、捨てて作り直してもらう
  const ok = await Promise.race([firstFrame.then(() => true), sleep(3000).then(() => false)]);
  if (!ok) {
    mic.close();
    try { audioCtx && audioCtx.close(); } catch (e) {}
    audioCtx = null;
    throw new Error("mic_stall");
  }
  return mic;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIC_STALL_MSG = "マイクが動き出しませんでした（別のアプリから戻った直後に起きることがあります）。もう一度ボタンを押してください。続くときはページを開き直してください。";

/* ---------- 録音の診断：聞き取れなかったときに、原因の手がかりを集める ----------
   ・Azure が返した「聞き取れなかった理由」
   ・送った音声の長さと、実際にかかった時間（大きくずれていれば、サンプリング周波数の食い違い）
   ・同じ音声を発音評価なしで認識し直した結果（発音評価だけが原因かどうかの切り分け。失敗したときだけ、数秒分の音声認識を使う） */
let recDiag = null; // { why, plain, sentSec, wallSec, ctxRate, trackRate, pcm, ref, at }
function micStats(mic) {
  const chunk = mic.ctxRate ? 4096 / mic.ctxRate : 0; // 最後の区間の長さ
  return {
    sentSec: +(mic.samples / 16000).toFixed(2),
    wallSec: mic.firstAt ? +((mic.lastAt - mic.firstAt) / 1000 + chunk).toFixed(2) : 0,
    ctxRate: mic.ctxRate, trackRate: mic.trackRate, ctxState: mic.ctxState,
    prof: S.audioProfile(mic.pcm), gain: micGain(),
  };
}
function profText(p, gain) {
  if (!p) return "音声の中身：なし";
  return `雑音 ${p.noiseDb}dB・声 ${p.speechDb}dB（差 ${p.snr}dB）、声 ${p.voicedSec}秒・前の無音 ${p.leadSec}秒・後ろ ${p.tailSec}秒、音割れ ${p.clipPct}%、感度×${gain}`;
}
function noMatchWhy(SDK, result) {
  try {
    const r = SDK.NoMatchDetails.fromResult(result).reason;
    if (r === SDK.NoMatchReason.InitialSilenceTimeout) return "無音と判定";
    if (r === SDK.NoMatchReason.InitialBabbleTimeout) return "雑音と判定";
    return "音はあるが言葉として認識できず";
  } catch (e) { return "不明"; }
}
// 録音済みの音声（16kHz）を、もう一度認識に通す。pa を渡せば発音評価つき
async function recognizePcm(SDK, tk, pcm, pa) {
  let rec = null;
  try {
    const p = SDK.AudioInputStream.createPushStream(SDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
    for (const c of pcm) p.write(c.buffer.slice(0));
    p.close();
    const cfg = SDK.SpeechConfig.fromAuthorizationToken(tk.token, tk.region);
    cfg.speechRecognitionLanguage = "en-US";
    rec = new SDK.SpeechRecognizer(cfg, SDK.AudioConfig.fromStreamInput(p));
    if (pa) pa.applyTo(rec);
    return await new Promise((resolve, reject) => rec.recognizeOnceAsync(resolve, reject));
  } finally {
    try { rec && rec.close(); } catch (e) {}
  }
}
// 録音済みの音声を、連続認識で発音評価する（recognizeOnce と別の経路。診断用の別設定の1つ）
async function recognizePcmContinuous(SDK, tk, pcm, pa) {
  let rec = null;
  try {
    const p = SDK.AudioInputStream.createPushStream(SDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
    for (const c of pcm) p.write(c.buffer.slice(0));
    p.close();
    const cfg = SDK.SpeechConfig.fromAuthorizationToken(tk.token, tk.region);
    cfg.speechRecognitionLanguage = "en-US";
    rec = new SDK.SpeechRecognizer(cfg, SDK.AudioConfig.fromStreamInput(p));
    pa.applyTo(rec);
    const got = [];
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 40000);
      rec.recognized = (_, e) => { if (e.result.reason === SDK.ResultReason.RecognizedSpeech) got.push(e.result); };
      rec.sessionStopped = () => { clearTimeout(t); resolve(); };
      rec.canceled = () => { clearTimeout(t); resolve(); };
      rec.startContinuousRecognitionAsync(() => {}, () => { clearTimeout(t); resolve(); });
    });
    try { await new Promise((r) => rec.stopContinuousRecognitionAsync(r, r)); } catch (e) {}
    // 区切られて複数になったときは、単語の多いものを使う
    const parsed = got.map((r) => S.parsePron(JSON.parse(r.properties.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult)))).filter(Boolean);
    return parsed.sort((a, b) => b.words.length - a.words.length)[0] || null;
  } finally {
    try { rec && rec.close(); } catch (e) {}
  }
}
/* 発音評価が「聞き取れず」になったとき、同じ録音を設定を変えて評価し直す（2026-11-10：
   発音評価なしなら認識できる録音が、発音評価つきだと聞き取れずになる。お手本と話した内容が一致していても起きる）。
   どの設定で評価できたかを記録し、最初に評価できた結果を使う。失敗したときだけ、録音の長さ×最大3回分の音声認識を使う */
async function retryVariants(SDK, tk, pcm, refText, nbest, onStep) {
  const G = SDK.PronunciationAssessmentGranularity, H = SDK.PronunciationAssessmentGradingSystem.HundredMark;
  const mk = (gran, miscue) => { const pa = new SDK.PronunciationAssessmentConfig(refText, H, gran, miscue); pa.phonemeAlphabet = "IPA"; if (nbest && gran === G.Phoneme) pa.nbestPhonemeCount = nbest; return pa; };
  const variants = [
    ["言い間違い判定なし", () => recognizePcm(SDK, tk, pcm, mk(G.Phoneme, false))],
    ["単語単位", () => recognizePcm(SDK, tk, pcm, mk(G.Word, true))],
    ["連続認識", () => recognizePcmContinuous(SDK, tk, pcm, mk(G.Phoneme, true))],
  ];
  const log = [];
  let out = null, via = "";
  for (const [i, [name, run]] of variants.entries()) {
    if (out) break; // 評価できたらそこで終わり（全部試すと、その分だけ待ち時間が延びる）
    if (onStep) onStep(`別の設定で採点し直し中 ${i + 1}/${variants.length}`);
    try {
      const r = await run();
      let parsed = null;
      if (r && r.words) parsed = r; // 連続認識は parsePron 済み
      else if (r && r.reason === SDK.ResultReason.RecognizedSpeech) parsed = S.parsePron(JSON.parse(r.properties.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult)));
      if (parsed) { log.push(name + "：成功"); if (!out) { out = parsed; via = name; } }
      else log.push(name + "：" + (r && r.reason === SDK.ResultReason.NoMatch ? "聞き取れず" : r ? "失敗" : "結果なし"));
    } catch (e) { log.push(name + "：エラー"); }
  }
  return { out, via, log: log.join("、") };
}
function paConfig(SDK, refText, nbest) {
  // 抑揚（Prosody）は追加料金のため使わない。nBestPhonemeCount（話された音の候補）は基本料金の範囲
  const pa = new SDK.PronunciationAssessmentConfig(refText, SDK.PronunciationAssessmentGradingSystem.HundredMark, SDK.PronunciationAssessmentGranularity.Phoneme, true);
  pa.phonemeAlphabet = "IPA";
  if (nbest) pa.nbestPhonemeCount = nbest; // SDK 1.20 以降のプロパティ
  return pa;
}
// 送った音声を、発音評価なしでもう一度認識する（診断用）
async function plainRecognize(SDK, tk, pcm) {
  try {
    const r = await recognizePcm(SDK, tk, pcm, null);
    if (r.reason === SDK.ResultReason.RecognizedSpeech) return (r.text || "").trim() || "（空）";
    if (r.reason === SDK.ResultReason.NoMatch) return "聞き取れず（" + noMatchWhy(SDK, r) + "）";
    const d = SDK.CancellationDetails.fromResult(r);
    return "エラー（" + (d.errorDetails || d.reason) + "）";
  } catch (e) {
    return "エラー（" + (e && e.message ? e.message : e) + "）";
  }
}
function recDiagText(d) {
  if (!d) return "";
  const rate = d.trackRate && d.trackRate !== d.ctxRate ? `処理 ${d.ctxRate}Hz／マイク ${d.trackRate}Hz` : `${d.ctxRate}Hz`;
  return `理由：${d.why}／送った音声 ${d.sentSec}秒・実際 ${d.wallSec}秒（${rate}）／${profText(d.prof, d.gain)}／発音評価なしでの認識：${d.plain || "未実施"}${d.variants ? "／設定を変えた再評価：" + d.variants : ""}／お手本：${d.ref}`;
}
// 送った 16kHz の音声を、端末の再生用の周波数に直して鳴らす
function playRecDiag() {
  const d = recDiag; if (!d || !d.pcm.length) return;
  unlockAudio(); if (!audioCtx) return;
  const n = d.pcm.reduce((s, c) => s + c.length, 0);
  const rate = audioCtx.sampleRate, m = Math.floor((n * rate) / 16000);
  const src = new Float32Array(n); let o = 0;
  for (const c of d.pcm) { for (let i = 0; i < c.length; i++) src[o + i] = c[i] / 32768; o += c.length; }
  const buf = audioCtx.createBuffer(1, m, rate), ch = buf.getChannelData(0);
  for (let i = 0; i < m; i++) { const t = (i * 16000) / rate, a = Math.floor(t), f = t - a; ch[i] = (src[a] || 0) * (1 - f) + (src[a + 1] || 0) * f; }
  playBuffer(buf);
}
function recDiagHTML() {
  if (!recDiag || recording) return "";
  return `<div class="hintbox" role="note">
    <div class="row between"><b class="note">🔍 聞き取れなかったときの診断</b><button class="btn sm" id="rec-play">${SPK}今の録音を聞く</button></div>
    <p class="note" style="margin:4px 0 0;word-break:break-all">${esc(recDiagText(recDiag))}</p></div>`;
}
// 録音中にほかのアプリへ切り替えたら録音を打ち切る（戻ったときに固まらないように）
let abortRec = null;

/* 録音して発音評価を1回行い、parsePron の結果を返す（聞き取れない・エラーのときはバナーを出して null）。
   シャドーイング（文）と単語の発音練習で共用。recording の切り替えと再描画もここで行う */
async function assessOnce(refText, opts = {}) {
  if (recording) return null;
  const SDK = window.SpeechSDK;
  if (!SDK) { showBanner("音声評価の部品を読み込めていません。ページを開き直してください。"); return null; }
  stopAudio();
  unlockAudio(); // タップの中で AudioContext を起こす（iPhone はタップの外では動き出さない）
  if (!audioCtx) { showBanner("このブラウザでは録音できません。"); return null; }
  recording = true; recPhase = "listen"; scoreMsg = ""; recDiag = null; renderShadow(); showBanner("");
  let recognizer = null, mic = null, push = null, timer = null, out = null, stopped = false;
  // 録音を止めて採点に移る（「話し終わった」ボタン、自動の区切り、35秒の上限のどれでも）。
  // 入力を閉じると、Azure は無音を待たずにその時点までの音声で結果を返す
  const toScore = (msg) => {
    if (stopped) return; stopped = true;
    try { mic && mic.close(); } catch (e) {}
    try { push && push.close(); } catch (e) {}
    recPhase = "score"; scoreMsg = msg || ""; renderShadow();
  };
  const step = (msg) => { scoreMsg = msg; renderShadow(); };
  stopRec = () => toScore();
  try {
    push = SDK.AudioInputStream.createPushStream(SDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
    mic = await openMic((buf) => { try { push.write(buf); } catch (e) {} }, updateMeter);
    abortRec = () => { try { mic.close(); push.close(); } catch (e) {} };
    if (stopped) { try { mic.close(); } catch (e) {} } // マイクの準備中に止めた
    const tk = await speechToken();
    const cfg = SDK.SpeechConfig.fromAuthorizationToken(tk.token, tk.region);
    cfg.speechRecognitionLanguage = "en-US";
    // 文の途中の息継ぎで切れないよう、区切りの無音を 3 秒に（既定は約 0.5 秒、設定できる範囲は 100〜5000 ミリ秒）。
    // 普段は「話し終わった」ボタンで入力を閉じるので、この 3 秒を待つことはない
    cfg.setProperty(SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, "3000");
    const audio = SDK.AudioConfig.fromStreamInput(push);
    const pa = paConfig(SDK, refText, opts.nbestPhonemes);
    recognizer = new SDK.SpeechRecognizer(cfg, audio);
    pa.applyTo(recognizer);
    // 1文30秒以内。万一終わらないときは 35 秒で入力を閉じて結果を受け取る
    timer = setTimeout(() => toScore(), 35000);
    const result = await new Promise((resolve, reject) => recognizer.recognizeOnceAsync(resolve, reject));
    toScore(); // 3 秒の無音で自動的に区切られたときも、ここでマイクを止めて採点中の表示にする
    if (result.reason === SDK.ResultReason.RecognizedSpeech) {
      const json = JSON.parse(result.properties.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult));
      out = S.parsePron(json);
      if (!out) throw new Error("no_result");
    } else if (result.reason === SDK.ResultReason.NoMatch) {
      const why = noMatchWhy(SDK, result);
      recDiag = { why, plain: "", ...micStats(mic), pcm: mic.pcm, ref: refText };
      // 音が入っていれば、同じ音声を発音評価なしで認識し直す（発音評価が原因かどうかの切り分け。F0 は同時1件なので先に閉じる）
      if (mic.peak >= 0.01 && mic.pcm.length) {
        try { recognizer.close(); } catch (e) {}
        recognizer = null;
        recDiag.plain = "確認中…";
        step("聞き取れなかったので、原因を確認中");
        recDiag.plain = await plainRecognize(SDK, tk, mic.pcm);
        // 発音評価なしで言葉が取れたときだけ、設定を変えて評価し直す
        if (!/^(聞き取れず|エラー|（空）)/.test(recDiag.plain)) {
          const v = await retryVariants(SDK, tk, mic.pcm, refText, opts.nbestPhonemes, step);
          recDiag.variants = v.log;
          lastVariantDiag = `${new Date().toLocaleTimeString()} お手本「${refText}」 ${v.log}`;
          if (v.out) { out = v.out; out.via = v.via; }
        }
      }
      if (out) {
        // 設定を変えて評価できた。結果を使い、どの設定だったかを上に出す（原因の手がかり）
        showBanner(`（診断）通常の設定では聞き取れず、「${out.via}」で評価しました。${recDiag.variants}`);
        recDiag = null;
      } else {
        // マイクの音量がほぼゼロなら、声の大きさではなく録音そのものの問題。
        // 「声が小さい」と出すのは、Azure が無音と判断したときだけ（音があるのに認識できないときは別の原因）
        showBanner(mic.peak < 0.01
          ? `マイクの音がほとんど入っていません（最大音量 ${(mic.peak * 100).toFixed(1)}%）。ほかのアプリがマイクを使っていないか確認して、ページを開き直してください。`
          : mic.maxDb < OK_DB && why === "無音と判定"
            ? `声が小さかったようです（最大 ${mic.maxDb.toFixed(0)}dB、目安 ${OK_DB}dB）。マイクに近づくか、「マイクの感度」を上げてもう一度話してください。`
            : "声を聞き取れませんでした。マイクに近づいて、もう一度話してください。");
      }
    } else {
      const d = SDK.CancellationDetails.fromResult(result);
      showBanner(/429|Too many/i.test(d.errorDetails || "") ? "混み合っています。数秒おいてもう一度試してください。" : "評価できませんでした（" + (d.errorDetails || d.reason) + "）");
      if (/401|auth/i.test(d.errorDetails || "")) tokenCache = null;
    }
  } catch (e) {
    out = null;
    if (e && e.message === "mic_stall") showBanner(MIC_STALL_MSG);
    else if (e && e.message !== "auth") showBanner(/Permission|NotAllowed/i.test(String(e)) ? "マイクの使用を許可してください。" : "評価できませんでした。もう一度試してください。");
  } finally {
    clearTimeout(timer);
    abortRec = null; stopRec = null;
    if (mic) { lastPeak = mic.peak; lastMaxDb = mic.maxDb; lastStats = { ...micStats(mic), ok: !!out }; }
    try { mic && mic.close(); } catch (e) {}
    try { push && push.close(); } catch (e) {}
    try { recognizer && recognizer.close(); } catch (e) {}
    resetOutput(); // 受話口に向いたままにしない
    recording = false; recPhase = ""; scoreMsg = "";
    // マイクを許可した後は出力先の名前も取れるので、一覧を取り直す
    refreshOutputs().then(() => { if (!recording) renderShadow(); });
  }
  return out;
}

async function startAssessment() {
  if (recording || !sCur) return;
  const target = sCur;
  const r = await assessOnce(target.text);
  if (r && sCur === target) {
    const j = S.judgeScore(r, st().strictness);
    r.judge = j.score; r.ngCount = j.ng;
    sResult = r; drill = null; openWord = r.words.findIndex((w) => S.wordClass(w, st().strictness) === "ng");
    // 「今回の最高」は判定点で比べる。同点なら要練習の単語が少ない方
    if (sBest == null || r.judge > sBest || (r.judge === sBest && r.ngCount < sBestNg)) { sBest = r.judge; sBestNg = r.ngCount; }
    queueSave(() => api("attempts", { method: "POST", body: JSON.stringify({ sentenceId: target.id, text: target.text, pron: r.pron, judge: r.judge, strictness: st().strictness, acc: r.acc, flu: r.flu, comp: r.comp, recognized: r.recognized, words: r.words }) }));
  }
  renderShadow();
}

function nextSentence() {
  const s = sCur; if (!s) return;
  if (sBest != null) {
    const prev = data.cards.sentence[s.id];
    const wasNew = !prev;
    // フレーズ帳で「言えなかった」ときは、発音の点にかかわらず「もう一度」（明日また思い出す）
    const g = recallOf(s) === "ng" ? "again" : S.gradeFromScore(sBest, sBestNg, st().strictness);
    // 苦手な音の練習で足した文（復習の時期がまだ来ていない）は、予定を進めない。最高点は記録し、「もう一度」なら明日に前倒し
    const extra = sExtra.has(s.id) && prev && prev.due > Date.now();
    if (!extra) noteRetention("sentence", prev, g);
    const next = extra ? (g === "again" ? S.applyTalkUse(prev, false) : { ...prev }) : S.nextState(prev, g);
    next.best = Math.max(prev && prev.best != null ? prev.best : 0, sBest);
    data.cards.sentence[s.id] = next;
    saveCard("sentence", s.id);
    if (wasNew) { bumpLog("newSentLog"); saveSettings(); }
    // その場で出し直すのは1回だけ（2回目の「もう一度」は明日に回す）
    if (g === "again" && !sRetried.has(s.id)) { sRetried.add(s.id); sQueue.splice(Math.min(3, sQueue.length), 0, s); }
    sDone++;
  }
  sCur = sQueue.shift() || null; sBest = null; sBestNg = 0; sResult = null; openWord = -1;
  sRecall = { id: null, state: "ask" }; // 出し直しのときも、もう一度思い出すところから
  renderShadow();
}

/* ================= 会話ロールプレイ（Phase 2a） =================
   場面を選ぶ → 相手（AI）の最初の一言 → 「話す」で返事 → 相手の返事（読み上げ） … → 振り返り
   相手の発言は、最初は文字を隠す（聞き取り重視）。録音はシャドーイングと同じ仕組み（音量メーター・感度） */
let scenes = null, talk = null, seedScenes = null;
const micBusy = () => recording || !!(wRev && wRev.state === "listening") || !!(talk && talk.listening) || !!(comp && comp.state === "listening");
async function loadScenes() {
  if (scenes) return scenes;
  if (!seedScenes) { try { seedScenes = await (await fetch("/seed/scenes.json", { cache: "no-store" })).json(); } catch (e) { seedScenes = []; } }
  // 共通の教材パックの場面（Table）を後ろに足す。同じ ID は元の教材を優先
  const ids = new Set(seedScenes.map((x) => x.id));
  scenes = [...seedScenes, ...((data.scenes || []).filter((x) => x && !ids.has(x.id)))];
  return scenes;
}
function talkCountToday() { const l = st().talkLog; return l && l.date === S.ymd() ? l.count : 0; }
const myTalkTurns = () => (talk ? talk.history.filter((t) => t.who === "me").length : 0);
const TALK_MAX = 8; // api/src/roleplay.js の MAX_TURNS と同じ
// 同じ場面でも毎回少し変える：相手の性格（ここから1つ）と、場面の変化球（scenes.json の twists から1つ）
const PERSONAS = ["friendly and patient", "busy and a bit brief", "talkative and speaks a little fast", "curious and asks a lot of questions", "calm and polite"];

async function renderTalk() {
  const v = $("view-talk");
  counts();
  if (!talk) {
    const list = await loadScenes();
    if (talk) return renderTalk();
    // 今日の新しい場面 → 最近7日 → 分野ごと（場面が多い分野は折りたたむ）
    const today = S.ymd(), weekAgo = S.ymd(Date.now() - 7 * 86400000);
    const btn = (sc) => `<button class="scene-btn" data-scene="${esc(sc.id)}"><span class="scene-emoji" aria-hidden="true">${esc(sc.emoji || "💬")}</span>
        <span class="grow"><b>${esc(sc.title)}</b><span class="note" style="display:block">${esc(sc.goal_ja || "")}</span>${(sc.targets || []).length ? `<span class="note targets">使ってみたい表現：${sc.targets.map(esc).join(" / ")}</span>` : ""}</span></button>`;
    const isNew = list.filter((sc) => sc.added === today);
    const recent = list.filter((sc) => sc.added && sc.added < today && sc.added >= weekAgo).sort((a, b) => (b.added > a.added ? 1 : -1));
    const groups = [...new Set(list.map((sc) => sc.group || "その他"))];
    setTimeout(() => { const pb = $("phrasebook"); if (pb) pb.ontoggle = () => (pbOpen = pb.open); });
    v.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">
      <article class="card" style="gap:8px"><h2 style="margin:0;font-size:18px">場面を選んで会話する</h2>
        <p class="note" style="margin:0">1日1回・10分ほどが目安です（今日 ${talkCountToday()} 回）。場面は毎日1つ増え、同じ場面でも毎回少し展開が変わります。相手の発言は最初は文字を隠しています。</p></article>
      ${phrasebookHTML()}
      ${isNew.length ? `<h3 class="scene-group">🆕 今日の新しい場面</h3><div class="scene-list">${isNew.map(btn).join("")}</div>` : ""}
      ${recent.length ? `<h3 class="scene-group">最近の場面</h3><div class="scene-list">${recent.map(btn).join("")}</div>` : ""}
      ${groups.map((g) => { const items = list.filter((sc) => (sc.group || "その他") === g).sort((a, b) => ((b.added || "") > (a.added || "") ? 1 : -1));
        return `<details class="scene-fold" ${items.length <= 10 ? "open" : ""}><summary class="scene-group">${esc(g)}（${items.length}）</summary><div class="scene-list" style="margin-top:8px">${items.map(btn).join("")}</div></details>`; }).join("") || emptyCard("場面を読み込めませんでした", "ページを開き直してください。")}
    </div>`;
    return;
  }
  const sc = talk.scene;
  if (talk.review) return renderTalkReview(v);
  const ended = talk.ended || myTalkTurns() >= TALK_MAX;
  const bubbles = talk.history.map((t, i) => t.who === "ai"
    ? `<div class="bubble ai"><div class="${t.shown ? "" : "veil"}" ${t.shown ? "" : 'aria-label="文字は隠れています"'}>${esc(t.text)}</div>
        <div class="tools"><button class="iconbtn" data-say="${esc(t.text)}" aria-label="もう一度聞く">${SPK}</button><button class="iconbtn" data-say="${esc(t.text)}" data-rate="0.7" aria-label="ゆっくり聞く">${SLOW}</button><button class="linkbtn" data-say="${esc(t.text)}" data-rate="0.5">さらにゆっくり</button>
        ${t.shown ? "" : `<button class="linkbtn" data-reveal="${i}">文字を見る</button>`}${t.ja ? `<button class="linkbtn" data-talk-ja="${i}" aria-expanded="${t.jaShown ? "true" : "false"}">${t.jaShown ? "訳を隠す" : "訳を見る"}</button>` : ""}</div>
        ${t.ja && t.jaShown ? `<p class="tr" style="margin:4px 0 0">${esc(t.ja)}</p>` : ""}
        ${t.help ? `<p class="help">💡 ${esc(t.help)}</p>` : ""}</div>`
    : `<div class="bubble me">${esc(t.text)}</div>`).join("");
  v.innerHTML = `<article class="card talk">
    <div class="row between"><span class="chip">${esc(sc.emoji || "")} ${esc(sc.title)}</span><button class="linkbtn" id="talk-quit">やめる</button></div>
    <p class="note" style="margin:0">目的：${esc(sc.goal_ja || "")}</p>
    ${talk.targets.length ? `<p class="note targets" style="margin:0">使ってみたい表現：${talk.targets.map((t) => `<b>${esc(t)}</b>${talk.spaced.includes(t) ? '<span class="note">（復習）</span>' : ""}`).join(" / ")}</p>` : ""}
    <details id="talk-phrases" ${talk.phrasesOpen ? "open" : ""}><summary class="note">使えるフレーズ</summary><div class="list" style="margin-top:6px">${(sc.phrases || []).map((p) => `<div class="li"><button class="iconbtn" data-say="${esc(p.en)}" aria-label="読み上げ">${SPK}</button><div class="grow"><div class="s">${esc(p.en)}</div><div class="m">${esc(p.ja)}</div></div>${saveBtn(p.en, p.ja, "scene")}</div>`).join("")}</div></details>
    <div class="talk-log" aria-live="polite">${bubbles}${talk.waiting ? '<div class="bubble ai note">…</div>' : ""}</div>
    ${talk.hint ? `<div class="hintbox"><div class="row between"><b>${esc(talk.hint.en)}</b><button class="iconbtn" data-say="${esc(talk.hint.en)}" aria-label="読み上げ">${SPK}</button></div>
      ${talk.hint.alt ? `<p class="note" style="margin:4px 0 0">別の言い方：${esc(talk.hint.alt)}</p>` : ""}${talk.hint.note ? `<p class="note" style="margin:2px 0 0">${esc(talk.hint.note)}</p>` : ""}<div style="margin-top:4px">${saveBtn(talk.hint.en, talk.hintJa || "", "hint")}</div></div>` : ""}
    ${ended
      ? `<p class="note" style="margin:0">${talk.goalReached ? "🎉 目的を達成しました。" : "会話はここまでです。"}振り返りをしましょう。</p>`
      : `${talk.listening ? listenBtn("talk-rec", "話し終わったら「■ 話し終わった」を押すと相手に届きます") : `<button class="btn primary" id="talk-rec" ${talk.waiting ? "disabled" : ""}>${MIC}${talk.waiting ? "相手が考えています…" : "話す"}</button>`}
        ${talk.listening ? `<div class="meter" role="img" aria-label="マイクの音量。縦線を超えれば十分です"><i id="mic-level"></i></div><p class="note" id="mic-label" style="margin:-8px 0 0">マイクを準備しています…</p>` : ""}
        <div class="row">${talk.hintOpen
          ? `<input id="hint-ja" class="textin" placeholder="言いたいことを日本語で" maxlength="200"><button class="btn" id="hint-go">英語にする</button>`
          : `<button class="btn" id="hint-open">💡 日本語で言いたいこと</button>`}</div>`}
    <button class="btn ${ended ? "primary" : ""}" id="talk-review" ${myTalkTurns() && !talk.waiting && !talk.listening ? "" : "disabled"}>終わって振り返る</button>
  </article>`;
  $("talk-phrases").ontoggle = () => { talk.phrasesOpen = $("talk-phrases").open; };
  $("talk-quit").onclick = () => { if (!talk.listening && (!myTalkTurns() || confirm("会話をやめますか？（振り返りはしません）"))) { stopAudio(); talk = null; renderTalk(); } };
  if ($("talk-rec")) $("talk-rec").onclick = () => (talk.listening ? listenStop && listenStop() : talkListen());
  if ($("hint-open")) $("hint-open").onclick = () => { talk.hintOpen = true; renderTalk().then(() => $("hint-ja") && $("hint-ja").focus()); };
  if ($("hint-go")) $("hint-go").onclick = talkHint;
  if ($("hint-ja")) $("hint-ja").onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) talkHint(); };
  $("talk-review").onclick = talkReview;
  v.querySelectorAll("[data-reveal]").forEach((b) => (b.onclick = () => { talk.history[+b.dataset.reveal].shown = true; renderTalk(); }));
  v.querySelectorAll("[data-talk-ja]").forEach((b) => (b.onclick = () => { const t = talk.history[+b.dataset.talkJa]; t.jaShown = !t.jaShown; renderTalk(); }));
  const log = v.querySelector(".talk-log"); if (log && log.lastElementChild) log.lastElementChild.scrollIntoView({ block: "nearest" });
}

function renderTalkReview(v) {
  const r = talk.review, sc = talk.scene;
  v.innerHTML = `<article class="card talk">
    <div class="row between"><span class="chip">${esc(sc.emoji || "")} ${esc(sc.title)}・振り返り</span>${r.goal_reached ? '<span class="chip">🎉 目的達成</span>' : ""}</div>
    ${r.summary_ja ? `<p style="margin:0">${esc(r.summary_ja)}</p>` : ""}
    ${(r.targets || []).length ? `<div><b class="note">使ってみたい表現</b><div class="row" style="margin-top:4px">${r.targets.map((t) => `<span class="chip ${(r.targets_used || []).includes(t) ? "used" : ""}">${(r.targets_used || []).includes(t) ? "✓" : "–"} ${esc(t)}</span>`).join("")}</div>
      ${(r.wordUpdates || []).length ? `<p class="note" style="margin:6px 0 0">単語帳に反映：${r.wordUpdates.map((u) => `${esc(u.word)} → ${u.used ? "使えたので次回を " + u.when + " に" : "次回を " + u.when + " に前倒し"}`).join("、")}</p>` : ""}</div>` : ""}
    ${r.good.length ? `<div><b class="note">よかった点</b><ul class="rv">${r.good.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div>` : ""}
    ${r.corrections.length ? `<div><b class="note">もっと自然な言い方</b><div class="list" style="margin-top:6px">${r.corrections.map((c) => `<div class="li"><div class="grow"><div class="m">あなた：${esc(c.you)}</div><div class="s">→ ${esc(c.better)}</div>${c.note ? `<div class="m">${esc(c.note)}</div>` : ""}</div><button class="iconbtn" data-say="${esc(c.better)}" aria-label="読み上げ">${SPK}</button>${saveBtn(c.better, c.ja || "", "correction", c.you)}</div>`).join("")}</div></div>` : ""}
    ${r.phrases.length ? `<div><b class="note">覚えたいフレーズ</b><div class="list" style="margin-top:6px">${r.phrases.map((p) => `<div class="li"><button class="iconbtn" data-say="${esc(p.en)}" aria-label="読み上げ">${SPK}</button><div class="grow"><div class="s">${esc(p.en)}</div><div class="m">${esc(p.ja)}</div></div>${saveBtn(p.en, p.ja, "review")}</div>`).join("")}</div>
      <p class="note" style="margin:6px 0 0">「＋保存」でフレーズ帳に入り、シャドーイングで練習できます。</p></div>` : ""}
    <details><summary class="note">会話の全文</summary><div class="talk-log" style="margin-top:8px">${talk.history.map((t) => `<div class="bubble ${t.who}">${esc(t.text)}${t.ja ? `<p class="tr" style="margin:4px 0 0">${esc(t.ja)}</p>` : ""}</div>`).join("")}</div></details>
    <div class="row"><button class="btn primary" id="talk-again" style="width:auto;flex:1">同じ場面をもう一度</button><button class="btn" id="talk-menu">場面を選ぶ</button></div>
  </article>`;
  $("talk-again").onclick = () => startTalk(sc.id);
  $("talk-menu").onclick = () => { talk = null; renderTalk(); };
}

/* 使ってみたい表現：場面の表現（その日の単語）を最大2つ ＋ 単語帳で復習の時期が近い語を1〜2つ（合計3つまで）。
   覚えた語を、日をあけて別の場面で思い出して使う練習にする */
function talkTargets(sc) {
  const own = (sc.targets || []).slice(0, 2);
  const spaced = S.pickSpacedWords(data.words, data.cards.word, own, 3 - own.length).map((w) => w.word);
  return { targets: [...own, ...spaced], spaced };
}
const findWordByText = (t) => data.words.find((w) => String(w.word).toLowerCase() === String(t).toLowerCase());
/* 振り返りの結果を単語帳の予定に反映（使えた：次回を延ばす／使えなかった：明日に前倒し）。まだ覚えていない語は対象外 */
function applyTalkToWords(r) {
  const out = [];
  for (const t of r.targets || []) {
    const w = findWordByText(t); if (!w) continue;
    const used = (r.targets_used || []).includes(t);
    const next = S.applyTalkUse(data.cards.word[w.id], used);
    if (!next) continue;
    const changed = next.due !== data.cards.word[w.id].due;
    data.cards.word[w.id] = next;
    if (changed) saveCard("word", w.id);
    const d = new Date(next.due);
    out.push({ word: w.word, used, when: `${d.getMonth() + 1}/${d.getDate()}` });
  }
  return out;
}

function startTalk(id) {
  const sc = (scenes || []).find((x) => x.id === id); if (!sc) return;
  stopAudio(); showBanner("");
  const pick = (a) => (a && a.length ? a[Math.floor(Math.random() * a.length)] : "");
  const tg = talkTargets(sc);
  talk = { scene: sc, targets: tg.targets, spaced: tg.spaced, twist: pick(sc.twists), persona: pick(PERSONAS), history: [{ who: "ai", text: sc.opener, ja: sc.opener_ja || "", shown: false }], listening: false, waiting: false, ended: false, goalReached: false, hint: null, hintOpen: false, review: null };
  renderTalk();
  say(sc.opener, 0.9);
}

async function talkApi(body) {
  try {
    const scene = { ...talk.scene, targets: talk.targets, twist: talk.twist, persona: talk.persona };
    return await api("roleplay", { method: "POST", body: JSON.stringify({ scene, history: talk.history.map(({ who, text }) => ({ who, text })), ...body }) });
  } catch (e) {
    showBanner(e.status === 429 ? "今日の会話の上限に達しました。また明日どうぞ。" : e.status === 503 ? "AI の設定（FOUNDRY_ENDPOINT など）がないため、会話できません。" : "AI の応答を受け取れませんでした。もう一度試してください。");
    throw e;
  }
}

/* 録音して文字にする（発音評価なし）。会話と瞬間作文で共用。呼ぶ前に「聞き取り中」の画面（音量メーター）を出しておく。
   聞き取れなかったときは理由をバナーに出して "" を返す */
/* 押して話す（v0.20.1）：シャドーイングと同じく「■ 話し終わった」で入力を閉じる。
   入力を閉じると、Azure は無音を待たずにその時点までの音声で結果を返す。
   考えながら話しても途中で切れないよう、区切りの無音は上限の 5 秒、話し始めるまでの待ちは 15 秒
   （Speech_SegmentationSilenceTimeoutMs は 100〜5000 ミリ秒。Microsoft Learn「How to recognize speech」で確認） */
let listenStop = null, listenPhase = "";
const listenBtn = (id, label) => listenPhase === "text"
  ? `<button class="btn primary scoring" id="${id}" disabled aria-busy="true"><span class="spin" aria-hidden="true"></span>文字にしています…</button>`
  : `<button class="btn primary rec" id="${id}">■ 話し終わった</button>
     <p class="note" style="margin:0">${label || "言い終わったら「■ 話し終わった」を押してください"}（5秒黙ると自動でも止まります）。</p>`;
async function listenText(onPhase) {
  const SDK = window.SpeechSDK;
  let recognizer = null, mic = null, push = null, timer = null, text = "", stopped = false;
  listenPhase = "listen";
  const stop = () => {
    if (stopped) return; stopped = true;
    try { mic && mic.close(); } catch (e) {}
    try { push && push.close(); } catch (e) {}
    listenPhase = "text"; if (onPhase) onPhase();
  };
  listenStop = stop;
  try {
    push = SDK.AudioInputStream.createPushStream(SDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
    mic = await openMic((buf) => { try { push.write(buf); } catch (e) {} }, updateMeter);
    abortRec = () => { try { mic.close(); push.close(); } catch (e) {} };
    if (stopped) { try { mic.close(); } catch (e) {} } // マイクの準備中に止めた
    const tk = await speechToken();
    const cfg = SDK.SpeechConfig.fromAuthorizationToken(tk.token, tk.region);
    cfg.speechRecognitionLanguage = "en-US";
    cfg.setProperty(SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, "5000");
    cfg.setProperty(SDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "15000");
    recognizer = new SDK.SpeechRecognizer(cfg, SDK.AudioConfig.fromStreamInput(push));
    timer = setTimeout(stop, 35000);
    const result = await new Promise((resolve, reject) => recognizer.recognizeOnceAsync(resolve, reject));
    stop(); // 5 秒の無音で自動的に区切られたときも、ここでマイクを止める
    if (result.reason === SDK.ResultReason.RecognizedSpeech) text = (result.text || "").trim();
    else if (result.reason === SDK.ResultReason.NoMatch) {
      showBanner(mic && mic.maxDb < OK_DB ? `声が小さかったようです（最大 ${mic.maxDb.toFixed(0)}dB）。マイクに近づくか、「マイクの感度」を上げてもう一度話してください。` : "聞き取れませんでした。もう一度話してください。");
    } else {
      const d = SDK.CancellationDetails.fromResult(result);
      showBanner("聞き取れませんでした（" + (d.errorDetails || d.reason) + "）");
      if (/401|auth/i.test(d.errorDetails || "")) tokenCache = null;
    }
  } catch (e) {
    if (e && e.message === "mic_stall") showBanner(MIC_STALL_MSG);
    else showBanner(/Permission|NotAllowed/i.test(String(e)) ? "マイクの使用を許可してください。" : "聞き取れませんでした。もう一度試してください。");
  } finally {
    clearTimeout(timer);
    abortRec = null; listenStop = null; listenPhase = "";
    if (mic) { lastPeak = mic.peak; lastMaxDb = mic.maxDb; lastStats = micStats(mic); }
    try { mic && mic.close(); } catch (e) {}
    try { push && push.close(); } catch (e) {}
    try { recognizer && recognizer.close(); } catch (e) {}
    // このあと結果を読み上げることがあるので、AudioContext は閉じない（iPhone はタップの外で作り直すと鳴らない）
    setAudioSession("playback");
  }
  return text;
}
async function talkListen() {
  if (!talk || micBusy()) return;
  const SDK = window.SpeechSDK;
  if (!SDK) { showBanner("音声認識の部品を読み込めていません。ページを開き直してください。"); return; }
  stopAudio();
  unlockAudio();
  if (!audioCtx) { showBanner("このブラウザでは録音できません。"); return; }
  // 「日本語で言いたいこと」の英文は、見ながら話せるように聞き取り中も残す（相手が返事をしたら消す）
  talk.listening = true; talk.hintOpen = false; renderTalk(); showBanner("");
  const text = await listenText(() => talk && renderTalk());
  if (talk) talk.listening = false;
  if (!talk) return;
  if (!text) { renderTalk(); return; }
  talk.history.push({ who: "me", text });
  talk.waiting = true; renderTalk();
  try {
    const r = await talkApi({ action: "turn" });
    if (!talk) return;
    talk.history.push({ who: "ai", text: r.reply, ja: r.reply_ja || "", shown: false, help: r.help_ja || "" });
    talk.hint = null; // 発言が相手に届いたら、使ったヒントは片付ける
    talk.goalReached = talk.goalReached || !!r.goal_reached;
    talk.ended = !!r.end || myTalkTurns() >= TALK_MAX;
    say(r.reply, 0.9);
  } catch (e) {
    talk.history.pop(); // 送れなかった発言は取り消して、もう一度話せるようにする
  } finally {
    if (talk) { talk.waiting = false; renderTalk(); }
  }
}

async function talkHint() {
  const ja = ($("hint-ja") && $("hint-ja").value.trim()) || "";
  if (!ja || !talk || talk.waiting) return;
  talk.waiting = true; renderTalk();
  try { const r = await talkApi({ action: "hint", ja }); if (talk) { talk.hint = r; talk.hintJa = ja; talk.hintOpen = false; } }
  catch (e) {}
  finally { if (talk) { talk.waiting = false; renderTalk(); } }
}

async function talkReview() {
  if (!talk || !myTalkTurns() || talk.waiting) return;
  stopAudio();
  talk.waiting = true; renderTalk();
  try {
    const r = await talkApi({ action: "review" });
    if (!talk) return;
    talk.review = r;
    talk.review.wordUpdates = applyTalkToWords(r);
    const today = S.ymd();
    if (!st().talkLog || st().talkLog.date !== today) st().talkLog = { date: today, count: 0 };
    st().talkLog.count++; saveSettings();
  } catch (e) {}
  finally { if (talk) { talk.waiting = false; renderTalk(); } }
}

/* ================= フレーズ帳（Phase 2b） =================
   会話の振り返り（覚えたいフレーズ・言い換え）、場面の「使えるフレーズ」、日本語ヒントから保存する。
   保存した表現はシャドーイングの会話文として出題する（間隔反復と発音評価をそのまま使う） */
let pbOpen = false; // フレーズ帳の開閉（描き直しても保つ）
const normEn = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function phraseToSentence(p) {
  return { id: p.id, text: p.text, ja: p.ja || "", before: p.before || "", scene: p.scene || "フレーズ帳", category: "conversation", focus: [], source: "フレーズ帳", order: -1, phrase: true };
}
const isSaved = (en) => data.phrases.some((p) => normEn(p.text) === normEn(en));
/* 訳のないフレーズ（以前「もっと自然な言い方」から保存したものなど）に、AI で訳を付けて保存する。
   1件につき1回だけ呼ぶ（失敗したらこの画面を開き直すまで呼ばない） */
const jaPending = new Set(), jaTried = new Set();
async function ensureJa(s) {
  if (!s || s.ja || !s.phrase || jaPending.has(s.id) || jaTried.has(s.id)) return;
  jaPending.add(s.id); jaTried.add(s.id);
  try {
    const r = await api(`phrase/${encodeURIComponent(s.id)}`, { method: "PATCH", body: JSON.stringify({ action: "translate" }) });
    const ja = r && r.item && r.item.ja;
    if (ja) {
      s.ja = ja;
      const p = data.phrases.find((x) => x.id === s.id); if (p) p.ja = ja;
      for (const x of data.sentences) if (x.id === s.id) x.ja = ja;
    }
  } catch (e) {
    showBanner(e.status === 429 ? "今日の訳の作成は上限に達しました。明日もう一度開いてください。" : e.status === 503 ? "AI の設定がないため、訳を作れません。" : "訳を作れませんでした。");
  }
  jaPending.delete(s.id);
  if (sCur === s) renderShadow();
}
function saveBtn(en, ja, from, before = "") {
  if (!en) return "";
  return isSaved(en)
    ? `<span class="note saved">✓ 保存済み</span>`
    : `<button class="linkbtn save-ph" data-phrase="${esc(en)}" data-ja="${esc(ja || "")}" data-before="${esc(before)}" data-from="${from}">＋保存</button>`;
}
async function savePhrase(btn) {
  btn.disabled = true;
  try {
    const sc = talk && talk.scene;
    const r = await api("phrase", { method: "POST", body: JSON.stringify({ text: btn.dataset.phrase, ja: btn.dataset.ja, before: btn.dataset.before || "", from: btn.dataset.from, scene: sc ? sc.title : "", sceneId: sc ? sc.id : "" }) });
    if (r && r.item && !data.phrases.some((p) => p.id === r.item.id)) {
      data.phrases.push(r.item);
      const s = phraseToSentence(r.item);
      data.sentences.push(s);
      if (!data.cards.sentence[s.id]) { if (sCur) sQueue.push(s); else sCur = s; } // 今日のシャドーイングの最後に足す
    }
    showBanner("フレーズ帳に保存しました。シャドーイングで練習できます。");
  } catch (e) {
    showBanner(e.status === 409 ? "フレーズ帳がいっぱいです（500件まで）。使わないものを削除してください。" : "保存できませんでした。もう一度試してください。");
  }
  renderTalk(); counts();
}
async function deletePhrase(id) {
  const p = data.phrases.find((x) => x.id === id); if (!p) return;
  if (!confirm(`「${p.text}」をフレーズ帳から削除しますか？（練習の記録も消えます）`)) return;
  try {
    await api("phrase/" + encodeURIComponent(id), { method: "DELETE" });
    data.phrases = data.phrases.filter((x) => x.id !== id);
    data.sentences = data.sentences.filter((x) => x.id !== id);
    sQueue = sQueue.filter((x) => x.id !== id);
    if (sCur && sCur.id === id) { sCur = sQueue.shift() || null; sResult = null; sBest = null; }
    delete data.cards.sentence[id];
  } catch (e) { showBanner("削除できませんでした。もう一度試してください。"); }
  renderTalk(); counts();
}
function phrasebookHTML() {
  const ps = data.phrases || [];
  const scenesOf = [...new Set(ps.map((p) => p.scene || "フレーズ帳"))];
  return `<details class="card phrasebook" id="phrasebook" ${pbOpen ? "open" : ""}><summary><b>📒 フレーズ帳</b> <span class="note">${ps.length} 件</span></summary>
    ${ps.length ? scenesOf.map((g) => `<h3 class="scene-group">${esc(g)}</h3><div class="list">${ps.filter((p) => (p.scene || "フレーズ帳") === g).slice().reverse().map((p) => {
      const c = data.cards.sentence[p.id];
      return `<div class="li"><button class="iconbtn" data-say="${esc(p.text)}" aria-label="読み上げ">${SPK}</button>
        <div class="grow"><div class="s">${esc(p.text)}</div>${p.ja ? `<div class="m">${esc(p.ja)}</div>` : ""}<div class="m">${c ? (c.best != null ? `最高 ${c.best} 点・` : "") + "次回 " + S.ymd(c.due) : "まだ練習していません"}</div></div>
        <button class="linkbtn" data-del-phrase="${esc(p.id)}" aria-label="削除">削除</button></div>`; }).join("")}</div>`).join("")
      : `<p class="note" style="margin:8px 0 0">会話の振り返りや「使えるフレーズ」の「＋保存」で、ここに集まります。保存した表現はシャドーイングにも出てきます。</p>`}
  </details>`;
}

/* ================= 瞬間作文（Phase 3a） =================
   日本語を見て、英語を声に出す（タイピングも可）→ 判定 → お手本と自然な言い方。独自の間隔反復で出題する。
   出題：単語帳で覚えた単語の例文、練習したシャドーイングの文、フレーズ帳（訳があるもの） */
let comp = null; // { queue, cur, state: ask|listening|typing|judging|result, answer, result, done, retried:Set }
const COMPOSE_GRADE = { correct: "good", ok: "hard", wrong: "again" };
function composeItems() {
  const out = [];
  for (const w of data.words) if (data.cards.word[w.id] && w.example && w.translation)
    out.push({ id: "w-" + w.id, cat: "word", ja: w.translation, en: w.example, target: w.word, label: "単語の例文", order: w.order || 0 });
  for (const x of data.sentences) if (data.cards.sentence[x.id] && x.ja && x.text)
    out.push({ id: (x.phrase ? "p-" : "s-") + x.id, cat: "sentence", ja: x.ja, en: x.text, target: "", label: x.phrase ? "フレーズ帳" : "シャドーイングの文", order: x.phrase ? -1 : 0 });
  return out;
}
/* 今週のまとめ：直近7日に覚え始めた（初めて答えた）単語・フレーズ・文から10問。足りなければ覚えたものから補う。
   いつ覚え始めたかはカードの first、なければ教材の追加日（added）で判断する */
function weeklyItems() {
  const since = S.ymd(Date.now() - 7 * S.DAY);
  const recentOf = (card, added) => ((card && card.first) || added || "") >= since;
  const phraseAdded = Object.fromEntries(data.phrases.map((p) => [p.id, p.added]));
  const isRecent = (it) => {
    const raw = it.id.slice(2);
    if (it.id.startsWith("w-")) { const w = data.words.find((x) => x.id === raw); return recentOf(data.cards.word[raw], w && w.added); }
    const x = data.sentences.find((y) => y.id === raw);
    return recentOf(data.cards.sentence[raw], (x && x.added) || phraseAdded[raw]);
  };
  const all = composeItems();
  return [...shuffle(all.filter(isRecent)), ...shuffle(all.filter((x) => !isRecent(x)))].slice(0, 10);
}
function saveWeekly() {
  const t = comp.tally, w = (st().weekly = st().weekly || {});
  w[S.weekStart()] = { n: comp.done, correct: t.correct || 0, ok: t.ok || 0, wrong: t.wrong || 0, at: new Date().toISOString() };
  for (const k of Object.keys(w).sort().slice(0, -12)) delete w[k];
  saveSettings();
}
const composeQueue = () => S.buildQueue(composeItems(), data.cards.compose, st().composeLog, st().composePerDay, "cat", "word", "sentence");
function startCompose(items = null, mode = "daily") {
  const q = items || composeQueue();
  comp = { mode, queue: q.slice(1), cur: q[0] || null, state: "ask", answer: "", result: null, done: 0, retried: new Set(), tally: {} };
  showBanner(""); renderCompose();
}
function renderCompose() {
  const v = $("view-quiz");
  if (!comp) return renderQuizMenu();
  const it = comp.cur;
  if (!it) {
    const wk = comp.mode === "weekly", t = comp.tally;
    if (wk && comp.done && !comp.saved) { comp.saved = true; saveWeekly(); }
    v.innerHTML = `<article class="card"><h2 style="margin:0;font-size:18px">${wk ? "今週のまとめは終わりです" : "今日の瞬間作文は終わりです"}</h2>
      <p class="note" style="margin:0">${comp.done ? `${comp.done}問に答えました（◎ ${t.correct || 0}・○ ${t.ok || 0}・✕ ${t.wrong || 0}）。` : wk ? "出題できる問題がありません。単語帳やシャドーイングで覚えると出題できます。" : "今日出せる問題がありません。単語帳やシャドーイングで覚えた文から出題します。"}</p>
      ${wk && t.wrong ? `<p class="note" style="margin:0">✕ だった問題は、明日の瞬間作文で出てきます。</p>` : ""}
      <button class="btn" id="cp-menu">練習のメニューへ</button></article>`;
    $("cp-menu").onclick = () => { comp = null; renderQuizMenu(); };
    return;
  }
  const c = data.cards.compose[it.id], r = comp.result;
  const MARK = { correct: ["ok", "◎ 正解"], ok: ["mid", "○ 通じる"], wrong: ["ng", "✕ もう一度"] };
  let h = `<article class="card compose" aria-live="polite">
    <div class="row between"><span class="chip">${comp.mode === "weekly" ? "📅 今週のまとめ" : "🗣️ 瞬間作文 · " + (c ? "復習" : "新規")} · ${esc(it.label)}</span><span class="note">残り ${comp.queue.length + 1}</span></div>
    <p class="note" style="margin:0">英語で言うと？</p>
    <p class="cue">${esc(it.ja)}</p>
    ${it.target ? `<p class="note targets" style="margin:0">使う表現：<b>${esc(it.target)}</b></p>` : ""}`;
  if (comp.state === "ask") {
    h += `<button class="btn primary" id="cp-rec">${MIC}英語で言う</button>
      <div class="row"><button class="btn" id="cp-type" style="width:auto;flex:1">⌨ 入力する</button><button class="btn" id="cp-skip" style="width:auto;flex:1">わからない</button></div>
      <div class="row" style="gap:12px">${gainSelectHTML("gain-sel-comp")}</div>`;
  } else if (comp.state === "listening") {
    h += `${listenBtn("cp-stop")}
      <div class="meter" role="img" aria-label="マイクの音量。縦線を超えれば十分です"><i id="mic-level"></i></div><p class="note" id="mic-label" style="margin:-8px 0 0">マイクを準備しています…</p>`;
  } else if (comp.state === "typing") {
    h += `<textarea id="cp-input" class="textin" rows="3" placeholder="英語で入力" maxlength="400" autocapitalize="sentences">${esc(comp.answer)}</textarea>
      <div class="row"><button class="btn primary" id="cp-check" style="width:auto;flex:1">判定する</button><button class="btn" id="cp-back">声で答える</button></div>`;
  } else if (comp.state === "judging") {
    h += `<p class="note" style="margin:0">あなた：${esc(comp.answer)}</p><p class="note">判定しています…</p>`;
  } else if (comp.state === "self") {
    h += `<p class="note" style="margin:0">あなた：${esc(comp.answer || "（答えなし）")}</p>
      <div class="li"><button class="iconbtn" data-say="${esc(it.en)}" aria-label="読み上げ">${SPK}</button><div class="grow"><div class="m">お手本</div><div class="s">${esc(it.en)}</div></div></div>
      <p class="note" style="margin:0">AI で判定できなかったので、自分で判定してください。</p>
      <div class="row"><button class="btn" data-cp-self="correct" style="width:auto;flex:1">◎ 言えた</button><button class="btn" data-cp-self="ok" style="width:auto;flex:1">○ 惜しい</button><button class="btn" data-cp-self="wrong" style="width:auto;flex:1">✕ 言えなかった</button></div>`;
  } else if (r) {
    const [cls, label] = MARK[r.grade];
    h += `<div class="verdict ${cls}" role="status"><b>${label}</b>${r.note ? `<span>${esc(r.note)}</span>` : ""}</div>
      ${comp.answer ? `<p class="note" style="margin:0">あなた：${esc(comp.answer)}</p>` : ""}
      <div class="list">
        <div class="li"><button class="iconbtn" data-say="${esc(it.en)}" aria-label="読み上げ">${SPK}</button><div class="grow"><div class="m">お手本</div><div class="s">${esc(it.en)}</div></div></div>
        ${r.better && normEn(r.better) !== normEn(it.en) && normEn(r.better) !== normEn(comp.answer) ? `<div class="li"><button class="iconbtn" data-say="${esc(r.better)}" aria-label="読み上げ">${SPK}</button><div class="grow"><div class="m">あなたの答えを自然にすると</div><div class="s">${esc(r.better)}</div></div></div>` : ""}
      </div>
      <button class="btn primary" id="cp-next">次へ</button>`;
  }
  h += `</article>`;
  v.innerHTML = h;
  if ($("cp-rec")) $("cp-rec").onclick = composeListen;
  if ($("cp-stop")) $("cp-stop").onclick = () => listenStop && listenStop();
  if ($("cp-type")) $("cp-type").onclick = () => { comp.state = "typing"; renderCompose(); $("cp-input").focus(); };
  if ($("cp-back")) $("cp-back").onclick = () => { comp.state = "ask"; renderCompose(); };
  if ($("cp-skip")) $("cp-skip").onclick = () => { comp.answer = ""; comp.result = { grade: "wrong", better: "", note: "" }; comp.state = "result"; renderCompose(); say(it.en, 0.9); };
  if ($("cp-check")) $("cp-check").onclick = () => { const t = $("cp-input").value.trim(); if (t) composeJudge(t); };
  if ($("cp-next")) $("cp-next").onclick = composeNext;
  bindGainSelect("gain-sel-comp", renderCompose);
  v.querySelectorAll("[data-cp-self]").forEach((b) => (b.onclick = () => { comp.result = { grade: b.dataset.cpSelf, better: "", note: "" }; comp.state = "result"; renderCompose(); }));
}
async function composeListen() {
  if (!comp || micBusy()) return;
  if (!window.SpeechSDK) { showBanner("音声認識の部品を読み込めていません。ページを開き直してください。"); return; }
  stopAudio(); unlockAudio();
  if (!audioCtx) { showBanner("このブラウザでは録音できません。入力で答えてください。"); return; }
  comp.state = "listening"; renderCompose(); showBanner("");
  const text = await listenText(() => comp && renderCompose());
  if (!comp) return;
  if (!text) { comp.state = "ask"; renderCompose(); return; }
  composeJudge(text);
}
async function composeJudge(answer) {
  const it = comp.cur;
  comp.answer = answer; comp.state = "judging"; renderCompose();
  try {
    const r = await api("compose-judge", { method: "POST", body: JSON.stringify({ ja: it.ja, model: it.en, answer, target: it.target }) });
    if (!comp || comp.cur !== it) return;
    comp.result = r; comp.state = "result";
    renderCompose();
    say(it.en, 0.9); // 答え合わせとしてお手本を聞く
  } catch (e) {
    if (!comp) return;
    if (e.status === 429) showBanner("今日の AI 判定の上限に達しました。自分で判定してください。");
    comp.state = "self"; renderCompose();
  }
}
function composeNext() {
  const it = comp.cur, r = comp.result;
  if (it && r) {
    const prev = data.cards.compose[it.id];
    const g = COMPOSE_GRADE[r.grade] || "again";
    // 今週のまとめでは、復習の時期が来ていない問題の予定を進めない（「もう一度」なら明日に前倒し）。新規の数にも数えない
    const weekly = comp.mode === "weekly", extra = weekly && prev && prev.due > Date.now();
    if (!extra) noteRetention("compose", prev, g);
    data.cards.compose[it.id] = extra ? (g === "again" ? S.applyTalkUse(prev, false) : { ...prev }) : S.nextState(prev, g);
    saveCard("compose", it.id);
    if (!prev && !weekly) { bumpLog("composeLog"); saveSettings(); }
    comp.tally[r.grade] = (comp.tally[r.grade] || 0) + 1;
    // その場での出し直しは1回だけ（2回目は明日）
    if (g === "again" && !weekly && !comp.retried.has(it.id)) { comp.retried.add(it.id); comp.queue.splice(Math.min(3, comp.queue.length), 0, it); }
    comp.done++;
  }
  comp.cur = comp.queue.shift() || null; comp.state = "ask"; comp.answer = ""; comp.result = null;
  renderCompose();
}

/* ================= ディクテーション（Phase 3b） =================
   練習したシャドーイングの文（フレーズ帳を含む）を聞いて書き取る。単語ごとに比べて、抜けた語・違う語に色を付ける。
   AI は使わない（読み上げは端末に保存した音声）。独自の間隔反復で、新規は1日3問 */
let dict = null; // { queue, cur, state: ask|result, answer, diff, done, retried:Set }
function dictItems() {
  return data.sentences.filter((x) => data.cards.sentence[x.id] && x.text)
    .map((x) => ({ id: x.id, en: x.text, ja: x.ja || "", scene: x.scene || "", cat: x.category === "conference" ? "conference" : "conversation", order: x.order || 0 }));
}
const dictQueue = () => S.buildQueue(dictItems(), data.cards.dict, st().dictLog, st().dictPerDay, "cat", "conference", "conversation");
function startDict() {
  const q = dictQueue();
  dict = { queue: q.slice(1), cur: q[0] || null, state: "ask", answer: "", diff: null, done: 0, retried: new Set() };
  showBanner(""); renderDict();
  if (dict.cur) say(dict.cur.en, 0.9);
}
function renderDict() {
  const v = $("view-quiz");
  if (!dict) return renderQuizMenu();
  const it = dict.cur;
  if (!it) {
    v.innerHTML = `<article class="card"><h2 style="margin:0;font-size:18px">今日のディクテーションは終わりです</h2>
      <p class="note" style="margin:0">${dict.done ? dict.done + "問に答えました。" : "今日出せる問題がありません。シャドーイングで練習した文から出題します。"}</p>
      <button class="btn" id="dc-menu">練習のメニューへ</button></article>`;
    $("dc-menu").onclick = () => { dict = null; renderQuizMenu(); };
    return;
  }
  const c = data.cards.dict[it.id], d = dict.diff;
  const words = S.dictTokens(it.en).length;
  let h = `<article class="card dict" aria-live="polite">
    <div class="row between"><span class="chip">🎧 ディクテーション · ${c ? "復習" : "新規"} · ${esc(it.scene)}</span><span class="note">残り ${dict.queue.length + 1}</span></div>
    <p class="note" style="margin:0">聞こえた英文を書き取ってください（${words}語）。</p>
    <div class="row"><button class="btn" data-say="${esc(it.en)}" id="dc-play">${SPK}もう一度聞く</button><button class="btn" data-say="${esc(it.en)}" data-rate="0.7">${SLOW}ゆっくり</button><button class="btn" data-say="${esc(it.en)}" data-rate="0.5">${SLOW}さらにゆっくり</button></div>`;
  if (dict.state === "ask") {
    h += `<textarea id="dc-input" class="textin" rows="3" placeholder="英語で入力" maxlength="400" autocapitalize="sentences" autocomplete="off" autocorrect="off" spellcheck="false">${esc(dict.answer)}</textarea>
      <div class="row"><button class="btn primary" id="dc-check" style="width:auto;flex:1">答え合わせ</button><button class="btn" id="dc-skip">わからない</button></div>`;
  } else {
    const grade = S.dictationGrade(d.score);
    const [cls, label] = grade === "good" ? ["ok", "◎ 全部書けた"] : grade === "hard" ? ["mid", "○ あと少し"] : ["ng", "✕ もう一度"];
    h += `<div class="verdict ${cls}" role="status"><b>${label}（${d.score}点）</b><span>${d.okCount} / ${d.total} 語${d.extra.length ? `、余分な語 ${d.extra.length}` : ""}</span></div>
      <div><p class="note" style="margin:0 0 4px">お手本（赤は書けなかった語）</p><p class="sent dictans">${d.model.map((x) => `<span class="${x.ok ? "dk" : "dm"}">${esc(x.w)}</span>`).join(" ")}</p>
      <p class="note" style="margin:4px 0 0">${esc(it.en)}${it.ja ? "　" + esc(it.ja) : ""}</p></div>
      ${dict.answer ? `<p class="note" style="margin:0">あなた：${esc(dict.answer)}${d.extra.length ? `<br>余分な語：${d.extra.map(esc).join(", ")}` : ""}</p>` : ""}
      <button class="btn primary" id="dc-next">次へ</button>`;
  }
  h += `</article>`;
  v.innerHTML = h;
  if ($("dc-check")) $("dc-check").onclick = () => { const t = $("dc-input").value.trim(); if (t) dictCheck(t); };
  if ($("dc-input")) $("dc-input").oninput = (e) => { dict.answer = e.target.value; };
  if ($("dc-skip")) $("dc-skip").onclick = () => dictCheck("");
  if ($("dc-next")) $("dc-next").onclick = dictNext;
}
function dictCheck(answer) {
  dict.answer = answer; dict.diff = S.dictationDiff(answer, dict.cur.en); dict.state = "result";
  renderDict();
}
function dictNext() {
  const it = dict.cur;
  const prev = data.cards.dict[it.id];
  const g = S.dictationGrade(dict.diff.score);
  noteRetention("dict", prev, g);
  data.cards.dict[it.id] = S.nextState(prev, g);
  saveCard("dict", it.id);
  if (!prev) { bumpLog("dictLog"); saveSettings(); }
  if (g === "again" && !dict.retried.has(it.id)) { dict.retried.add(it.id); dict.queue.splice(Math.min(3, dict.queue.length), 0, it); }
  dict.done++;
  dict.cur = dict.queue.shift() || null; dict.state = "ask"; dict.answer = ""; dict.diff = null;
  renderDict();
  if (dict.cur) say(dict.cur.en, 0.9); // 次の問題をすぐ聞く（タップの中なので iPhone でも鳴る）
}

/* ================= 苦手な音（Phase 3c） =================
   直近2か月のシャドーイングの発音記録から、音ごとの平均点を出し、低い音の上位3つを示す。
   コツ・つまずいた単語（ゆっくり聞く）・その音を含む文を今日のシャドーイングの先頭に足す練習 */
let sounds = null; // { loading, list, total, error }
const ymKey = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`; // サーバーの記録は UTC の月で区切る
async function startSounds() {
  sounds = { loading: true }; renderSounds();
  try {
    const now = new Date(), prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const [a, b] = await Promise.all([api("attempts?month=" + ymKey(now)), api("attempts?month=" + ymKey(prev))]);
    const rows = [...(a || []), ...(b || [])];
    sounds = { list: S.weakSounds(rows, { minCount: 5, top: 3 }), total: rows.length };
  } catch (e) { sounds = { error: true, list: [], total: 0 }; }
  renderSounds();
}
function renderSounds() {
  const v = $("view-quiz");
  if (!sounds) return renderQuizMenu();
  const back = `<button class="btn" id="sd-menu">練習のメニューへ</button>`;
  if (sounds.loading) { v.innerHTML = emptyCard("発音の記録を集計しています", ""); return; }
  const known = new Set(data.sentences.map((x) => x.id));
  let h = `<div style="display:flex;flex-direction:column;gap:12px">
    <article class="card" style="gap:6px"><h2 style="margin:0;font-size:18px">🔤 苦手な音</h2>
      <p class="note" style="margin:0">直近2か月のシャドーイングの記録（${sounds.total}回の録音）から、平均点の低い音を出しています。5回以上出てきた音だけが対象です。</p></article>`;
  if (sounds.error) h += emptyCard("記録を読み込めませんでした", "時間をおいてもう一度開いてください。");
  else if (!sounds.list.length) h += emptyCard("まだ記録が足りません", "シャドーイングで録音を続けると、音ごとの点数が集まります。");
  sounds.list.forEach((x, i) => {
    const sents = x.sentenceIds.filter((id) => known.has(id));
    h += `<article class="card sound">
      <div class="row between"><span class="ipa big">/${esc(x.ph)}/</span><span class="chip ${x.avg < 60 ? "ng" : x.avg < 80 ? "mid" : ""}">平均 ${x.avg}点・${x.n}回</span></div>
      <p style="margin:0">${esc(x.tip)}</p>
      ${guideHTML(x.guide)}
      <div><p class="note" style="margin:0 0 4px">つまずいた単語（押すとゆっくり読み上げ）</p>
        <div class="row">${x.words.map((w) => `<button class="btn sm" data-say="${esc(w.w)}" data-rate="0.55">${SLOW}${esc(w.w)} <span class="note">${w.avg}点</span></button>`).join("")}</div></div>
      ${sents.length ? `<button class="btn primary" data-sound-practice="${i}">この音を含む文をシャドーイングで練習（${Math.min(5, sents.length)}文）</button>` : ""}
    </article>`;
  });
  h += back + `</div>`;
  v.innerHTML = h;
  $("sd-menu").onclick = () => { sounds = null; renderQuizMenu(); };
  v.querySelectorAll("[data-sound-practice]").forEach((b) => (b.onclick = () => practiceSound(sounds.list[+b.dataset.soundPractice])));
}
/* その音を含む文（最大5文）を、今日のシャドーイングの先頭に入れて、シャドーイングを開く */
function practiceSound(x) {
  const pick = x.sentenceIds.map((id) => data.sentences.find((y) => y.id === id)).filter(Boolean).slice(0, 5);
  if (!pick.length) return;
  const ids = new Set(pick.map((y) => y.id));
  pick.forEach((y) => sExtra.add(y.id));
  const rest = sQueue.filter((y) => !ids.has(y.id));
  if (sCur && !ids.has(sCur.id) && !sResult) rest.unshift(sCur); // 練習中でなければ、今の文は後ろに回す
  sQueue = [...pick, ...rest];
  if (!sCur || !sResult) { sCur = sQueue.shift(); sBest = null; sBestNg = 0; openWord = -1; }
  showBanner(`苦手な音 /${x.ph}/ を含む文を ${pick.length} 文、今日のシャドーイングの先頭に入れました。`);
  tab("shadow");
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
  if (!loaded) { v.innerHTML = emptyCard("読み込んでいます", ""); return; }
  const studied = data.words.filter((w) => data.cards.word[w.id]).length;
  const q = st().quiz || { total: 0, correct: 0 };
  const cq = composeQueue(), dq = dictQueue();
  const wres = (st().weekly || {})[S.weekStart()], wn = Math.min(10, composeItems().length);
  const ret = S.retentionSummary(st().retention || {}, 4);
  const KIND = { word: "単語", sentence: "シャドーイング", compose: "瞬間作文", dict: "ディクテーション" };
  v.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">
    <article class="card retention" style="gap:6px">
      <div class="row between"><b>📈 定着率（直近4週）</b><span class="big">${ret.total.rate == null ? "—" : ret.total.rate + "%"}</span></div>
      <p class="note" style="margin:0">7日以上あけた復習で、覚えていた割合です。${ret.total.n ? `（${ret.total.n}回）` : "復習の間隔が7日を超えると集まり始めます。"}</p>
      ${ret.total.n ? `<div class="row" style="flex-wrap:wrap;gap:6px">${Object.entries(KIND).filter(([k]) => ret.kinds[k]).map(([k, l]) => `<span class="chip">${l} ${ret.kinds[k].rate}%（${ret.kinds[k].n}）</span>`).join("")}</div>` : ""}
    </article>
    <button class="scene-btn" data-practice="weekly"${wn ? "" : " disabled"}><span class="scene-emoji" aria-hidden="true">📅</span>
      <span class="grow"><b>今週のまとめ</b><span class="note" style="display:block">${wres ? `今週は済み（◎ ${wres.correct}・○ ${wres.ok}・✕ ${wres.wrong}）。もう一度もできます` : wn ? `今週覚えた単語・フレーズ・文から${wn}問（日本語 → 英語）。週に1回どうぞ` : "単語帳やシャドーイングで覚えると出題できます"}</span></span></button>
    <h3 class="scene-group">思い出して使う</h3>
    <button class="scene-btn" data-practice="compose"><span class="scene-emoji" aria-hidden="true">🗣️</span>
      <span class="grow"><b>瞬間作文</b><span class="note" style="display:block">日本語を見て、英語で言う。今日 ${cq.length} 問（新規は1日${st().composePerDay}問まで）</span></span></button>
    <button class="scene-btn" data-practice="dict"><span class="scene-emoji" aria-hidden="true">🎧</span>
      <span class="grow"><b>ディクテーション</b><span class="note" style="display:block">聞いて、英文を書き取る。今日 ${dq.length} 問（新規は1日${st().dictPerDay}問まで）</span></span></button>
    <h3 class="scene-group">発音</h3>
    <button class="scene-btn" data-practice="sounds"><span class="scene-emoji" aria-hidden="true">🔤</span>
      <span class="grow"><b>苦手な音</b><span class="note" style="display:block">シャドーイングの記録から、点数の低い音とコツ、その音を含む文の練習</span></span></button>
    <h3 class="scene-group">単語クイズ</h3>
    ${data.words.length ? `<p class="prompt">${studied >= 4 ? `学習済みの${studied}語から出題します。` : "登録済みの全単語から出題します。"}1回10問です。</p>
    <div class="modes">
      <button class="mode all" data-mode="mix"><span class="t">おまかせ</span><span class="d">4種類をまぜて出題</span></button>
      ${Object.entries(MODES).map(([k, m]) => `<button class="mode" data-mode="${k}"><span class="t">${m.t}</span><span class="d">${m.d}</span></button>`).join("")}
    </div>` : `<p class="note" style="margin:0">まだ単語がありません。「一覧」タブから初期データを取り込んでください。</p>`}
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
      ${outputSelectHTML("out-sel-list")}
      ${gainSelectHTML("gain-sel-list")}
      <details id="diag"><summary>音声の診断情報（アプリ v${APP_VERSION}）</summary>
        <pre class="note" id="diag-body" style="white-space:pre-wrap;word-break:break-all;margin:8px 0">${esc(diagText())}</pre>
        <button class="btn" id="diag-refresh">更新</button>
      </details>
      ${contentHTML()}
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
  bindOutputSelect("out-sel-list", () => { renderList(); renderShadow(); });
  bindGainSelect("gain-sel-list", () => { renderList(); renderShadow(); });
  $("diag-refresh").onclick = async () => { await refreshOutputs(); $("diag-body").textContent = diagText(); };
  $("import").onclick = importSeed;
  if ($("content-pull")) {
    $("content-pull").onclick = () => pullContent(false);
    $("content-auto").onchange = (e) => { st().contentAuto = e.target.checked; saveSettings(); };
  }
  $("fb-details").ontoggle = (e) => { if (e.target.open && !fbHistory) loadFbHistory(); };
}
/* ---------- 共通の教材（v0.19.0） ----------
   作者が毎週公開する一般的な教材（単語・文・会話の場面）を、自分の Table に取り込む。週1回は自動、ボタンでいつでも */
function contentHTML() {
  const c = data.content;
  if (!c || !c.enabled) return "";
  const last = c.last ? `前回届いた分：${esc(c.last.packs.join("・"))}（単語${c.last.words}語・文${c.last.sentences}文・場面${c.last.scenes}）` : "まだ届いていません";
  return `<div class="sharebox">
      <p style="margin:0"><b>共通の教材</b> <span class="note">毎週、単語・文・会話の場面が届きます（字幕ログを使わない一般的な教材）</span></p>
      <label><input type="checkbox" id="content-auto" ${st().contentAuto !== false ? "checked" : ""}> 週に1回、自動で取り込む</label>
      <p class="note" style="margin:0">${last}${c.lastCheck ? `。最後の確認：${esc(S.ymd(Date.parse(c.lastCheck)))}` : ""}</p>
      <button class="btn" id="content-pull">新しい教材を取り込む</button>
    </div>`;
}
let contentBusy = false;
async function pullContent(auto) {
  if (contentBusy || !data.content || !data.content.enabled) return;
  if (auto && st().contentAuto === false) return;
  contentBusy = true;
  const b = $("content-pull"); if (b) { b.disabled = true; b.textContent = "確認しています…"; }
  try {
    const r = await api("content-pull", { method: "POST", body: JSON.stringify({ auto: !!auto }) });
    if (r && r.skipped) return;
    const a = (r && r.added) || { words: 0, sentences: 0, scenes: 0 };
    const n = a.words + a.sentences + a.scenes;
    if (n) {
      showBanner(`共通の教材が届きました：単語${a.words}語・文${a.sentences}文・会話の場面${a.scenes}つ${r.more ? "（続きは次の確認で届きます）" : ""}`);
      scenes = null; await load();
    } else if (!auto) {
      showBanner(r && r.errors && r.errors.length ? "教材を取り込めませんでした。時間をおいてもう一度試してください。" : "新しい教材はありません。");
      if (data.content) data.content.lastCheck = r && r.lastCheck;
    }
  } catch (e) {
    if (!auto) showBanner(e.status === 409 ? "共通の教材はオフになっています（CONTENT_FEED_URL）。" : "教材の置き場に接続できませんでした。時間をおいてもう一度試してください。");
  } finally {
    contentBusy = false;
    if (!$("view-list").hidden) renderList();
  }
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
const TABS = ["study", "shadow", "talk", "quiz", "list"];
function tab(which) {
  for (const t of TABS) { $("tab-" + t).setAttribute("aria-selected", which === t); $("view-" + t).hidden = which !== t; }
  if (which === "list") renderList();
  if (which === "quiz" && sounds) renderSounds();
  else if (which === "quiz" && dict) renderDict();
  else if (which === "quiz" && comp) renderCompose();
  else if (which === "quiz" && !quiz) renderQuizMenu();
  if (which === "shadow") renderShadow();
  if (which === "talk") renderTalk();
}
TABS.forEach((t) => ($("tab-" + t).onclick = () => tab(t)));

document.addEventListener("click", (e) => {
  unlockAudio();
  const s = e.target.closest("[data-say]"); if (s) { say(s.dataset.say, s.dataset.rate ? +s.dataset.rate : 0.9); return; }
  const scb = e.target.closest("[data-scene]"); if (scb) { startTalk(scb.dataset.scene); return; }
  const sp = e.target.closest("[data-phrase]"); if (sp) { savePhrase(sp); return; }
  const dp = e.target.closest("[data-del-phrase]"); if (dp) { deletePhrase(dp.dataset.delPhrase); return; }
  const g = e.target.closest("[data-grade]"); if (g) { gradeWord(g.dataset.grade); return; }
  const dr = e.target.closest("[data-drill]"); if (dr) { startDrill(dr.dataset.drill); return; }
  const pw = e.target.closest("[data-pw]"); if (pw) { openWord = +pw.dataset.pw; drill = null; renderShadow(); return; }
  const lm = e.target.closest("[data-lm]"); if (lm) { listMode = lm.dataset.lm; renderList(); return; }
  const lc = e.target.closest("[data-lc]"); if (lc) { listCat = lc.dataset.lc; renderList(); return; }
  const fb = e.target.closest("[data-fb]"); if (fb) { openFeedbackFor(fb.dataset.fb); return; }
  const m = e.target.closest("[data-mode]"); if (m) { startQuiz(m.dataset.mode); return; }
  const pr = e.target.closest("[data-practice]"); if (pr) { if (pr.dataset.practice === "compose") startCompose(); if (pr.dataset.practice === "dict") startDict(); if (pr.dataset.practice === "sounds") startSounds(); if (pr.dataset.practice === "weekly") startCompose(weeklyItems(), "weekly"); return; }
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
  // フレーズ帳の表現は、シャドーイングの会話文として出題する（新しい文より先に出るよう order を小さく）
  data.phrases = d.phrases || [];
  data.cards.compose = data.cards.compose || {}; data.cards.dict = data.cards.dict || {};
  data.sentences = [...(d.sentences || []), ...data.phrases.map(phraseToSentence)];
  data.settings = { ...defaults, ...(d.settings || {}) };
  // v0.20.0：新しい単語の初期値を10語から5語に。以前の初期値のままの人だけ一度だけ直す（自分で変えた人はそのまま）
  if (!st().wordPlan) {
    if (st().newPerDay === 10) { st().newPerDay = 5; showBanner("単語の覚え方を変えました：新しい単語は1日5語に（一覧タブで変えられます）。意味は4択で答え、一度覚えた単語は日本語から英語を言う練習になります。"); }
    st().wordPlan = 2; saveSettings();
  }
  // v0.21.0：覚えた単語の復習に「聞いて意味を選ぶ」を混ぜる。一度だけお知らせする
  if (st().wordPlan < 3) {
    if (Object.keys(data.cards.word || {}).length) showBanner("覚えた単語の復習に「聞いて意味を選ぶ」練習を足しました。文字を見ずに単語や例文を聞いて、意味を4択で選びます。");
    st().wordPlan = 3; saveSettings();
  }
  if (!st().instanceId) { // 将来、匿名でフィードバックを集めるときに使うランダムなID（個人情報とは結び付かない）
    st().instanceId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    saveSettings();
  }
  loaded = true;
  scenes = null; // 共通の教材の場面を読み直す
  maybeAskShare();
  buildWordQueue(); buildSentenceQueue();
  renderStudy();
  if (!$("view-shadow").hidden) renderShadow();
  if (!$("view-list").hidden) renderList();
  counts();
}
renderStudy();
refreshOutputs();
load().then(() => pullContent(true)).catch((e) => { if (e.message !== "auth") { loaded = true; showBanner("データを読み込めませんでした。ページを開き直してください。"); renderStudy(); } });
/* 別の端末で学習したあとに戻ってきたら読み直す（スマホとPCの同期） */
/* ---------- 新しい版の確認 ----------
   iPhone の Chrome は、タブを開き直してもページを読み込み直さず、前の画面をそのまま出すことがある。
   起動時と画面に戻ったときに、サーバーの app.js の版を確かめ、新しければ「更新」を出す（5分に1回まで） */
let verCheckedAt = 0;
async function checkUpdate() {
  if (Date.now() - verCheckedAt < 5 * 60 * 1000) return;
  verCheckedAt = Date.now();
  try {
    const t = await (await fetch("/app.js", { cache: "no-store" })).text();
    const m = t.match(/const APP_VERSION = "([^"]+)"/);
    if (!m || m[1] === APP_VERSION) return;
    const bar = $("update");
    $("update-text").textContent = `新しい版（v${m[1]}）があります。いまは v${APP_VERSION} です。`;
    bar.hidden = false;
  } catch (e) {}
}
$("update-btn").onclick = () => { if (!micBusy()) location.reload(); };
checkUpdate();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    // 録音中にほかのアプリへ切り替えたら、録音を打ち切って結果を受け取る（戻ったときに固まらないように）
    if (abortRec) abortRec();
    return;
  }
  // 戻ったときは、止まっている可能性のある AudioContext を捨てる（次のタップで作り直す）
  if (audioCtx && !micBusy()) resetOutput();
  checkUpdate();
  if (loaded && !micBusy() && !quiz && !revealed && !sResult && !talk) load().catch(() => {});
});
// 戻る・タブ復元でメモリ上の画面が出たとき（bfcache）も確かめる
window.addEventListener("pageshow", (e) => { if (e.persisted) { verCheckedAt = 0; checkUpdate(); } });
})();
