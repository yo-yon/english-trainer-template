// 会話ロールプレイ（Phase 2a）：プロンプトの組み立て・入力の検査・出力の整形。
// API の窓口は functions/index.js。ここは外部に接続しない純粋な処理だけを置く（テストしやすくするため）。

const MAX_TURNS = 8;          // 学習者の発言の上限（これを超えたら会話を閉じる）
const MAX_TEXT = 400;         // 1発言の最大文字数
const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

/** 場面（クライアントが scenes.json から送る）を必要な項目だけに絞る */
function cleanScene(s) {
  if (!s || typeof s !== "object") return null;
  const scene = {
    id: clip(s.id, 40),
    title: clip(s.title, 60),
    role: clip(s.role, 300),
    setting: clip(s.setting, 300),
    goal: clip(s.goal, 300),
    opener: clip(s.opener, 300),
    // 毎回の展開の変化（クライアントが場面の候補から選んで送る）と、使ってみたい表現
    twist: clip(s.twist, 200),
    persona: clip(s.persona, 100),
    targets: (Array.isArray(s.targets) ? s.targets : []).map((t) => clip(t, 60)).filter(Boolean).slice(0, 3),
  };
  return scene.id && scene.role && scene.goal ? scene : null;
}

/** 会話の履歴：[{ who: "ai" | "me", text }]。上限を超える分は切る */
function cleanHistory(h) {
  if (!Array.isArray(h)) return [];
  return h
    .filter((t) => t && (t.who === "ai" || t.who === "me") && clip(t.text, MAX_TEXT))
    .slice(-2 * MAX_TURNS - 2)
    .map((t) => ({ who: t.who, text: clip(t.text, MAX_TEXT) }));
}
const myTurns = (h) => h.filter((t) => t.who === "me").length;
const transcript = (h) => h.map((t) => `${t.who === "ai" ? "Partner" : "Learner"}: ${t.text}`).join("\n");

const CONTEXT =
  "The learner is a Japanese IT engineer at an intermediate English level (around CEFR B1) who travels abroad for international tech conferences and wants to handle everyday conversations too. " +
  "The learner's messages come from speech recognition, so they may contain recognition errors; interpret them charitably.";

/** 会話の続き（相手役の返事）を作るメッセージ */
function turnMessages(scene, history) {
  return [
    {
      role: "system",
      content:
        `You are role-playing as: ${scene.role}. Situation: ${scene.setting} ${CONTEXT}\n` +
        `The learner's goal in this conversation: ${scene.goal}\n` +
        (scene.persona ? `Your personality in this conversation: ${scene.persona}.\n` : "") +
        (scene.twist ? `At a natural moment around the learner's 2nd to 4th reply, introduce this small unexpected turn and keep it realistic: ${scene.twist}\n` : "") +
        (scene.targets.length ? `The learner is practicing these expressions: ${scene.targets.map((t) => `"${t}"`).join(", ")}. When it fits naturally, ask questions that give the learner a chance to use them, but do not say them yourself before the learner does.\n` : "") +
        "Rules:\n" +
        "- Stay in character. Never say you are an AI and never switch to Japanese in the reply.\n" +
        "- Reply in 1 or 2 short, natural spoken sentences (at most 30 words) with simple, common vocabulary.\n" +
        "- Keep the conversation going toward the learner's goal, usually by asking one follow-up question.\n" +
        "- Do not correct the learner's grammar during the conversation.\n" +
        "- If the learner's last message is hard to understand or they seem stuck, set help_ja to a short hint in Japanese (at most 60 characters) about what they could say next. Otherwise set help_ja to null.\n" +
        "- Set goal_reached to true only when the learner has clearly achieved the goal.\n" +
        "- Set reply_ja to a natural Japanese translation of your reply (shown only when the learner asks for it).\n" +
        'Return only JSON: {"reply": "...", "reply_ja": "...", "help_ja": null, "goal_reached": false}',
    },
    { role: "user", content: `Conversation so far:\n${transcript(history)}\n\nRespond as the Partner to the Learner's last message.` },
  ];
}

/** 振り返り（よかった点・言い換え・覚えたいフレーズ） */
function reviewMessages(scene, history) {
  return [
    {
      role: "system",
      content:
        `You are a friendly English coach for a Japanese learner. ${CONTEXT}\n` +
        `The learner just finished a role-play. Scene: ${scene.title}. Partner role: ${scene.role}. Goal: ${scene.goal}\n` +
        "Review only the Learner's lines. Ignore capitalization, punctuation, and anything that looks like a speech recognition error.\n" +
        "Write all explanations in natural Japanese. Return only JSON:\n" +
        '{"summary_ja": "全体の一言（80文字以内）", "goal_reached": true,\n' +
        ' "good": ["よかった点（日本語、各40文字以内、1〜3個）"],\n' +
        ' "corrections": [{"you": "学習者の実際の発言", "better": "より自然な英語", "ja": "better の自然な日本語訳", "note": "理由（日本語40文字以内）"}],\n' +
        ' "phrases": [{"en": "この場面で覚えたい英語のフレーズ", "ja": "日本語訳"}]}\n' +
        "corrections: at most 5, only where a native speaker would say it differently. phrases: exactly 3, short and reusable in this scene. Always fill \"ja\" for every correction and phrase." +
        (scene.targets.length
          ? `\nThe learner also wanted to try these expressions: ${scene.targets.map((t) => `"${t}"`).join(", ")}. Add "targets_used": [the ones the learner actually used, allowing small changes in form].`
          : ""),
    },
    { role: "user", content: `Conversation:\n${transcript(history)}` },
  ];
}

/** 「日本語で言いたいこと」を英語に */
function hintMessages(scene, history, ja) {
  return [
    {
      role: "system",
      content:
        `You help a Japanese learner say something in English during a role-play. ${CONTEXT}\n` +
        `Scene: ${scene.title}. Partner role: ${scene.role}.\n` +
        "Give a short, natural spoken English sentence that fits the conversation and expresses the learner's Japanese text. Keep it simple enough for a B1 learner to say.\n" +
        'Return only JSON: {"en": "...", "alt": "もう少しくだけた別の言い方（英語）", "note": "使い方のコツ（日本語40文字以内）"}',
    },
    { role: "user", content: `Conversation so far:\n${transcript(history)}\n\nWhat the learner wants to say (Japanese): ${clip(ja, 200)}` },
  ];
}

/** LLM の出力を、画面に出してよい形に整える */
function cleanTurn(o, history) {
  const reply = clip(o && o.reply, 300);
  const help = o && o.help_ja ? clip(o.help_ja, 80) : null;
  const done = myTurns(history) >= MAX_TURNS;
  // 訳は返事があるときだけ（返事が無いときの代わりの文には訳を付けない）
  const ja = reply ? clip(o && o.reply_ja, 200) || null : null;
  return { reply: reply || "Sorry, could you say that again?", reply_ja: ja, help_ja: help, goal_reached: !!(o && o.goal_reached), end: done };
}
function cleanReview(o) {
  const arr = (x, n) => (Array.isArray(x) ? x.slice(0, n) : []);
  return {
    summary_ja: clip(o && o.summary_ja, 120),
    goal_reached: !!(o && o.goal_reached),
    good: arr(o && o.good, 3).map((s) => clip(s, 80)).filter(Boolean),
    corrections: arr(o && o.corrections, 5)
      .map((c) => ({ you: clip(c && c.you, MAX_TEXT), better: clip(c && c.better, 300), ja: clip(c && c.ja, 120), note: clip(c && c.note, 80) }))
      .filter((c) => c.you && c.better),
    phrases: arr(o && o.phrases, 3).map((p) => ({ en: clip(p && p.en, 160), ja: clip(p && p.ja, 120) })).filter((p) => p.en),
  };
}
/** 使ってみたい表現のうち、使えたもの（場面の targets にあるものだけを返す） */
function cleanTargetsUsed(o, targets) {
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z ]/g, "").trim();
  const used = new Set((Array.isArray(o && o.targets_used) ? o.targets_used : []).map(norm));
  return targets.filter((t) => used.has(norm(t)));
}
function cleanHint(o) {
  return { en: clip(o && o.en, 200), alt: clip(o && o.alt, 200), note: clip(o && o.note, 80) };
}

/** 1日の上限を数えるキー（日本時間の日付） */
function usageKey(now = Date.now()) {
  const j = new Date(now + 9 * 3600 * 1000);
  return `roleplay-${j.getUTCFullYear()}${String(j.getUTCMonth() + 1).padStart(2, "0")}${String(j.getUTCDate()).padStart(2, "0")}`;
}
/** 会話の記録のパーティション（日本時間の月） */
function logPartition(now = Date.now()) {
  return "talk-" + usageKey(now).slice(9, 15);
}

/**
 * リクエストを検査し、LLM に渡すメッセージと出力の整形関数を返す。
 * 不正なら { error }。
 */
function prepare(b) {
  if (!b || typeof b !== "object") return { error: "body" };
  const scene = cleanScene(b.scene);
  if (!scene) return { error: "scene" };
  const history = cleanHistory(b.history);
  if (b.action === "turn") {
    if (!history.length || history[history.length - 1].who !== "me") return { error: "history" };
    if (myTurns(history) > MAX_TURNS) return { error: "too_long" };
    return { scene, history, messages: turnMessages(scene, history), maxTokens: 700 /* 訳（reply_ja）の分を足した上限 */, clean: (o) => cleanTurn(o, history) };
  }
  if (b.action === "review") {
    if (!myTurns(history)) return { error: "history" };
    return {
      scene, history, messages: reviewMessages(scene, history), maxTokens: 1500,
      clean: (o) => ({ ...cleanReview(o), targets: scene.targets, targets_used: cleanTargetsUsed(o, scene.targets) }),
    };
  }
  if (b.action === "hint") {
    if (!clip(b.ja, 200)) return { error: "ja" };
    return { scene, history, messages: hintMessages(scene, history, b.ja), maxTokens: 400, clean: cleanHint };
  }
  return { error: "action" };
}

module.exports = { prepare, cleanTurn, cleanReview, cleanHint, cleanTargetsUsed, usageKey, logPartition, MAX_TURNS, myTurns };
