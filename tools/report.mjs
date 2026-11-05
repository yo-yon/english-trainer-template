// 週次レポート：未対応のフィードバックと、直近7日の学習・発音の集計を Markdown と JSON に書き出す。
// 出力先は引数のフォルダ（GitHub Actions では reports ブランチの作業フォルダ）。
// 個人情報（メールアドレスやユーザーID）は Table に保存していないので、レポートにも含まれない。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { client, listPartition, jstDate, friendlyError } from "./lib.mjs";

const outDir = process.argv[2] || "reports-out";
const DAYS = Number(process.env.REPORT_DAYS || 7);
const now = new Date();
const since = new Date(now.getTime() - DAYS * 86400000);

const monthKey = (d) => { const j = jstDate(d); return `attempt-${j.y}${String(j.m).padStart(2, "0")}`; };
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const cell = (s, n = 80) => String(s ?? "").replace(/\|/g, "／").replace(/\s+/g, " ").slice(0, n);
const jst = (iso) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ") : "");

let t;
try {
  t = client();
  const [feedback, words, sentences, wordCards, sentenceCards, settingsRows, attNow, attPrev] = await Promise.all([
    listPartition(t, "feedback"),
    listPartition(t, "word"),
    listPartition(t, "sentence"),
    listPartition(t, "card-word"),
    listPartition(t, "card-sentence"),
    listPartition(t, "settings"),
    listPartition(t, monthKey(now)),
    listPartition(t, monthKey(since)),
  ]);
  const settings = settingsRows.find((r) => r.id === "app") || {};
  const attempts = [...new Map([...attNow, ...attPrev].map((a) => [a.id, a])).values()]
    .filter((a) => a.at && new Date(a.at) >= since);

  /* ---------- フィードバック ---------- */
  const open = feedback.filter((f) => f.status !== "done").sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const doneThisWeek = feedback.filter((f) => f.status === "done" && f.doneAt && new Date(f.doneAt) >= since);

  /* ---------- 発音 ---------- */
  const scoreOf = (a) => (a.judge ?? a.pron);
  const bySentence = new Map();
  for (const a of attempts) {
    const s = bySentence.get(a.sentenceId) || { id: a.sentenceId, text: a.text, scores: [], n: 0 };
    s.scores.push(scoreOf(a)); s.n++; bySentence.set(a.sentenceId, s);
  }
  const lowSentences = [...bySentence.values()]
    .map((s) => ({ ...s, best: Math.max(...s.scores), avg: avg(s.scores) }))
    .sort((a, b) => a.best - b.best).slice(0, 8);

  const phon = new Map(); // 音素 → { n: 低い回数, total: 出現回数, words:Set }
  const weakWords = new Map(); // 単語 → { n, accs:[] }
  for (const a of attempts) {
    for (const w of a.words || []) {
      const key = String(w.w || "").toLowerCase();
      if (w.err === "Mispronunciation" || w.err === "Omission" || (w.acc != null && w.acc < 75)) {
        const x = weakWords.get(key) || { word: key, n: 0, accs: [] };
        x.n++; if (w.acc != null) x.accs.push(w.acc); weakWords.set(key, x);
      }
      for (const [p, acc] of w.ph || []) {
        const x = phon.get(p) || { phoneme: p, low: 0, total: 0, accs: [], words: new Set() };
        x.total++; x.accs.push(acc);
        if (acc < 70) { x.low++; x.words.add(key); }
        phon.set(p, x);
      }
    }
  }
  const weakPhonemes = [...phon.values()].filter((x) => x.low > 0)
    .map((x) => ({ phoneme: x.phoneme, low: x.low, total: x.total, avg: avg(x.accs), words: [...x.words].slice(0, 6) }))
    .sort((a, b) => b.low - a.low || a.avg - b.avg).slice(0, 10);
  const weakWordList = [...weakWords.values()].map((x) => ({ word: x.word, n: x.n, avg: avg(x.accs) }))
    .sort((a, b) => b.n - a.n).slice(0, 10);

  /* ---------- 学習量 ---------- */
  const today = jstDate(now);
  const startOfTodayUtc = Date.UTC(today.y, today.m - 1, today.d) - 9 * 3600 * 1000;
  const cardStats = (items, cards) => {
    const c = { total: items.length, unseen: 0, learning: 0, mature: 0, due: 0 };
    for (const it of items) {
      const s = cards.find((x) => x.id === it.id);
      if (!s) { c.unseen++; continue; }
      if (s.interval >= 21) c.mature++; else c.learning++;
      if (s.due <= startOfTodayUtc + 86400000) c.due++;
    }
    return c;
  };
  const wStats = cardStats(words, wordCards);
  const sStats = cardStats(sentences, sentenceCards);
  const activeDays = new Set(attempts.map((a) => jstDate(new Date(a.at)).ymd)).size;
  const quiz = settings.quiz || { total: 0, correct: 0 };

  /* ---------- JSON（Claude の定期タスクが読む） ---------- */
  const json = {
    generatedAt: now.toISOString(),
    period: { from: since.toISOString(), to: now.toISOString(), days: DAYS },
    settings: { strictness: settings.strictness || "strict", newPerDay: settings.newPerDay, newSentencesPerDay: settings.newSentencesPerDay, tts: settings.tts || null, quiz },
    study: { attempts: attempts.length, activeDays, avgScore: avg(attempts.map(scoreOf)), avgAzurePron: avg(attempts.map((a) => a.pron)), words: wStats, sentences: sStats },
    feedback: { open: open.map(({ id, kind, category, targetType, targetId, targetText, comment, detail, context, at }) => ({ id, kind, category, targetType, targetId, targetText, comment, detail, context, at })), doneThisWeek: doneThisWeek.length },
    lowSentences: lowSentences.map(({ id, text, n, best, avg: a }) => ({ id, text, attempts: n, best, avg: a })),
    weakPhonemes,
    weakWords: weakWordList,
  };

  /* ---------- Markdown（人が読む） ---------- */
  const L = [];
  L.push(`# 週次レポート ${today.ymd}`, "");
  L.push(`期間：直近${DAYS}日（${jst(since.toISOString())} 〜 ${jst(now.toISOString())} 日本時間）`, "");
  L.push("## 学習の概要", "");
  L.push("| 項目 | 値 |", "|---|---|");
  L.push(`| シャドーイングの回数 | ${attempts.length} 回（${activeDays} 日） |`);
  L.push(`| 平均判定点 | ${json.study.avgScore ?? "-"} 点（Azure の総合点 ${json.study.avgAzurePron ?? "-"} 点） |`);
  L.push(`| 採点の厳しさ | ${json.settings.strictness} |`);
  L.push(`| 単語 | 全${wStats.total}語：未学習 ${wStats.unseen}／学習中 ${wStats.learning}／定着 ${wStats.mature}（今日までの復習 ${wStats.due}） |`);
  L.push(`| 文 | 全${sStats.total}文：未練習 ${sStats.unseen}／学習中 ${sStats.learning}／定着 ${sStats.mature} |`);
  L.push(`| クイズの累計正答率 | ${quiz.total ? Math.round((quiz.correct / quiz.total) * 100) + "%（" + quiz.total + "問）" : "-"} |`);
  if (settings.tts) L.push(`| 今月の読み上げ文字数 | ${settings.tts.chars} 文字（${settings.tts.month}） |`);
  L.push("");

  L.push(`## 未対応のフィードバック（${open.length}件）`, "");
  if (!open.length) L.push("なし", "");
  else {
    L.push("| ID | 日時 | 種類 | 対象 | コメント | 状況 |", "|---|---|---|---|---|---|");
    for (const f of open) {
      const kind = f.kind === "app" ? `ご意見：${f.category}` : `👎 ${f.targetType}：${f.category}`;
      const det = f.detail ? cell(JSON.stringify(f.detail), 120) : "";
      L.push(`| \`${f.id}\` | ${jst(f.at)} | ${cell(kind, 40)} | ${cell(f.targetText, 60)} | ${cell(f.comment, 160)} | ${det} |`);
    }
    L.push("", "対応したプルリクエストの本文に `Fixes-feedback: <ID>, <ID>` と書くと、取り込んだときに自動で「対応済み」になります。", "");
  }
  if (doneThisWeek.length) L.push(`今週対応済みになったフィードバック：${doneThisWeek.length}件`, "");

  L.push("## 点数が低い文（今週の最高点が低い順）", "");
  if (!lowSentences.length) L.push("データなし", "");
  else {
    L.push("| 文ID | 英文 | 回数 | 最高 | 平均 |", "|---|---|---|---|---|");
    for (const s of lowSentences) L.push(`| ${s.id} | ${cell(s.text, 90)} | ${s.n} | ${s.best} | ${s.avg} |`);
    L.push("");
  }

  L.push("## 苦手な音（音素の点数が70点未満になった回数）", "");
  if (!weakPhonemes.length) L.push("データなし", "");
  else {
    L.push("| 音素 | 70点未満 | 出現 | 平均 | 出てきた単語 |", "|---|---|---|---|---|");
    for (const p of weakPhonemes) L.push(`| ${cell(p.phoneme, 10)} | ${p.low} | ${p.total} | ${p.avg} | ${cell(p.words.join(", "), 60)} |`);
    L.push("");
  }

  L.push("## つまずいた単語（要練習・言い落とし）", "");
  if (!weakWordList.length) L.push("データなし", "");
  else {
    L.push("| 単語 | 回数 | 平均 |", "|---|---|---|");
    for (const w of weakWordList) L.push(`| ${cell(w.word, 30)} | ${w.n} | ${w.avg ?? "-"} |`);
    L.push("");
  }

  await mkdir(outDir, { recursive: true });
  const md = L.join("\n") + "\n";
  await writeFile(join(outDir, `${today.ymd}.md`), md);
  await writeFile(join(outDir, "latest.md"), md);
  await writeFile(join(outDir, "latest.json"), JSON.stringify(json, null, 2) + "\n");
  console.log(`レポートを書き出しました：${outDir}/${today.ymd}.md（未対応のフィードバック ${open.length}件、シャドーイング ${attempts.length}回）`);
} catch (e) {
  console.error("::error::" + friendlyError(e));
  process.exit(1);
}
