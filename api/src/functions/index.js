const { app } = require("@azure/functions");
const { requireOwner, listPartition, getOne, upsert, upsertMany, remove, safeKey, bad, fail } = require("../lib");
const share = require("../share");
const roleplay = require("../roleplay");
const phrase = require("../phrase");
const compose = require("../compose");

const KINDS = { word: "card-word", sentence: "card-sentence", compose: "card-compose", dict: "card-dict" };

/* ---------- Speech の短期トークン（有効10分。9分間は使い回す） ---------- */
let cachedToken = null; // { token, exp }
app.http("speechToken", {
  route: "speech-token",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    const key = process.env.SPEECH_KEY;
    const region = process.env.SPEECH_REGION;
    if (!key || !region) return { status: 500, jsonBody: { error: "SPEECH_KEY / SPEECH_REGION が未設定です" } };
    try {
      if (!cachedToken || Date.now() > cachedToken.exp) {
        const r = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
          method: "POST",
          headers: { "Ocp-Apim-Subscription-Key": key, "Content-Length": "0" },
        });
        if (!r.ok) {
          context.error(`issueToken failed: ${r.status}`);
          return { status: 502, jsonBody: { error: "token_failed" } };
        }
        cachedToken = { token: await r.text(), exp: Date.now() + 9 * 60 * 1000 };
      }
      return {
        jsonBody: { token: cachedToken.token, region, expiresAt: cachedToken.exp, voice: process.env.TTS_VOICE || "en-US-AvaNeural" },
        headers: { "Cache-Control": "no-store" },
      };
    } catch (e) {
      return fail(context, e);
    }
  },
});

/* ---------- 起動時にまとめて読む（単語・文・復習状態・設定） ---------- */
app.http("state", {
  route: "state",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    try {
      const [words, sentences, wordCards, sentenceCards, settings, phrases, composeCards, dictCards] = await Promise.all([
        listPartition("word"),
        listPartition("sentence"),
        listPartition("card-word"),
        listPartition("card-sentence"),
        getOne("settings", "app"),
        listPartition("phrase"),
        listPartition("card-compose"),
        listPartition("card-dict"),
      ]);
      const toMap = (arr) => Object.fromEntries(arr.map(({ id, ...s }) => [id, s]));
      return {
        jsonBody: { words, sentences, phrases, cards: { word: toMap(wordCards), sentence: toMap(sentenceCards), compose: toMap(composeCards), dict: toMap(dictCards) }, settings: settings || {}, hub: { enabled: share.hubEnabled() } },
        headers: { "Cache-Control": "no-store" },
      };
    } catch (e) {
      return fail(context, e);
    }
  },
});

/* ---------- 復習状態の保存 ---------- */
app.http("card", {
  route: "card/{kind}/{id}",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    const pk = KINDS[request.params.kind];
    if (!pk) return bad("kind");
    try {
      const b = await request.json();
      const card = {
        interval: Number(b.interval) || 0,
        ease: Number(b.ease) || 2.5,
        reps: Number(b.reps) || 0,
        lapses: Number(b.lapses) || 0,
        due: Number(b.due) || 0,
        best: b.best != null ? Number(b.best) : undefined,
        first: /^\d{4}-\d{2}-\d{2}$/.test(b.first || "") ? b.first : undefined, // 初めて答えた日
      };
      await upsert(pk, safeKey(request.params.id), card);
      return { status: 204 };
    } catch (e) {
      return fail(context, e);
    }
  },
});

/* ---------- 設定（1日の新規数・クイズ成績など） ---------- */
app.http("settings", {
  route: "settings",
  methods: ["PUT"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    try {
      const b = await request.json();
      if (!b || typeof b !== "object" || JSON.stringify(b).length > 20000) return bad("settings");
      await upsert("settings", "app", b);
      return { status: 204 };
    } catch (e) {
      return fail(context, e);
    }
  },
});

/* ---------- 発音評価の結果（苦手な音の分析用に月ごとに保存） ---------- */
const monthKey = (d = new Date()) => {
  const j = new Date(d.getTime() + 9 * 3600 * 1000); // 日本時間で月を決める
  return `attempt-${j.getUTCFullYear()}${String(j.getUTCMonth() + 1).padStart(2, "0")}`;
};
app.http("attempts", {
  route: "attempts",
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    try {
      if (request.method === "GET") {
        const m = request.query.get("month");
        const pk = m && /^\d{6}$/.test(m) ? `attempt-${m}` : monthKey();
        const rows = await listPartition(pk);
        return { jsonBody: rows.slice(0, 500) };
      }
      const b = await request.json();
      if (!b || !b.sentenceId || JSON.stringify(b).length > 60000) return bad("attempt");
      const rk = String(9e15 - Date.now()).padStart(16, "0"); // 新しい順に並ぶ
      await upsert(monthKey(), rk, { ...b, at: new Date().toISOString() });
      return { status: 201 };
    } catch (e) {
      return fail(context, e);
    }
  },
});

/* ---------- 意味の判定（Foundry の gpt-5.4-mini） ---------- */
async function callLLM(messages, maxTokens = 400) {
  const ep = (process.env.FOUNDRY_ENDPOINT || "").replace(/\/+$/, "");
  const key = process.env.FOUNDRY_API_KEY;
  const model = process.env.FOUNDRY_DEPLOYMENT || "gpt-5.4-mini";
  if (!ep || !key) throw Object.assign(new Error("FOUNDRY_ENDPOINT / FOUNDRY_API_KEY が未設定です"), { code: "no_llm" });
  const body = { model, messages, response_format: { type: "json_object" }, max_completion_tokens: maxTokens, reasoning_effort: "low" };
  let r = await fetch(`${ep}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": key },
    body: JSON.stringify(body),
  });
  if (r.status === 400) {
    // reasoning_effort に未対応のモデル・デプロイだった場合は外して再試行
    delete body.reasoning_effort;
    r = await fetch(`${ep}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": key },
      body: JSON.stringify(body),
    });
  }
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return JSON.parse(j.choices?.[0]?.message?.content || "{}");
}

app.http("judge", {
  route: "judge",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    try {
      const b = await request.json();
      const clip = (s, n) => String(s || "").slice(0, n);
      const answer = clip(b.answer, 200);
      if (!b.word || !answer) return bad("judge");
      const out = await callLLM([
        {
          role: "system",
          content:
            "あなたは英単語テストの採点者です。英単語の日本語訳として学習者の答えが正しいかを判定します。" +
            "言い回しが違っても意味が同じなら正解、品詞の違い（「活用」と「活用する」など）も正解にします。" +
            "意味がずれている、または別の語の意味なら不正解です。" +
            '必ず {"correct": true|false, "comment": "日本語60文字以内の一言"} のJSONだけを返してください。',
        },
        {
          role: "user",
          content: `英単語: ${clip(b.word, 60)}（${clip(b.pos, 20)}）\n想定する意味: ${clip(b.meaning, 100)}\n例文: ${clip(b.example, 200)}\n学習者の答え: ${answer}`,
        },
      ]);
      return { jsonBody: { correct: !!out.correct, comment: String(out.comment || "").slice(0, 120) } };
    } catch (e) {
      if (e.code === "no_llm") return { status: 503, jsonBody: { error: "no_llm" } };
      return fail(context, e);
    }
  },
});

/* ---------- 会話ロールプレイ（Phase 2a） ----------
   action: turn（相手役の返事）／review（振り返り。会話の記録も保存）／hint（日本語→英語）
   使いすぎ防止のため、日本時間の1日あたりの回数に上限を設ける（ROLEPLAY_DAILY_LIMIT、既定 60） */
app.http("roleplay", {
  route: "roleplay",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    try {
      let b;
      try { b = await request.json(); } catch { return bad("body"); }
      if (JSON.stringify(b || {}).length > 20000) return bad("too_large");
      const p = roleplay.prepare(b);
      if (p.error) return bad(p.error);

      const limit = Number(process.env.ROLEPLAY_DAILY_LIMIT) || 60;
      const uk = roleplay.usageKey();
      const used = (await getOne("usage", uk)) || { count: 0 };
      if (used.count >= limit) return { status: 429, jsonBody: { error: "daily_limit", limit } };
      await upsert("usage", uk, { count: used.count + 1 });

      const out = p.clean(await callLLM(p.messages, p.maxTokens));
      if (b.action === "review") {
        // 会話の記録（文字だけ。音声は保存しない）。週次の改善ループで苦手な表現を探すのに使う
        const rk = String(9e15 - Date.now()).padStart(16, "0");
        await upsert(roleplay.logPartition(), rk, { sceneId: p.scene.id, history: p.history, review: out, at: new Date().toISOString() });
      }
      return { jsonBody: { ...out, remaining: Math.max(0, limit - used.count - 1) }, headers: { "Cache-Control": "no-store" } };
    } catch (e) {
      if (e.code === "no_llm") return { status: 503, jsonBody: { error: "no_llm" } };
      return fail(context, e);
    }
  },
});

/* ---------- 瞬間作文の判定（Phase 3a） ----------
   お手本とほぼ同じなら AI を呼ばない。AI を呼ぶ回数は1日 COMPOSE_DAILY_LIMIT 回まで（既定 100） */
app.http("composeJudge", {
  route: "compose-judge",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    try {
      let b;
      try { b = await request.json(); } catch { return bad("body"); }
      const p = compose.prepare(b);
      if (p.error) return bad(p.error);
      if (compose.quickMatch(p.answer, p.model)) return { jsonBody: { grade: "correct", better: p.model, note: "", by: "match" } };
      const limit = Number(process.env.COMPOSE_DAILY_LIMIT) || 100;
      const uk = roleplay.usageKey().replace("roleplay-", "compose-");
      const used = (await getOne("usage", uk)) || { count: 0 };
      if (used.count >= limit) return { status: 429, jsonBody: { error: "daily_limit", limit } };
      await upsert("usage", uk, { count: used.count + 1 });
      return { jsonBody: compose.clean(await callLLM(p.messages, 400), p.model), headers: { "Cache-Control": "no-store" } };
    } catch (e) {
      if (e.code === "no_llm") return { status: 503, jsonBody: { error: "no_llm" } };
      return fail(context, e);
    }
  },
});

/* ---------- フレーズ帳（Phase 2b） ----------
   POST：保存（同じ表現があればそれを返す）／DELETE：削除（復習状態も消す）
   PATCH phrase/{id} {action:"translate"}：訳のない表現に AI で日本語訳を付けて保存する（1件につき1回だけ。
   1日 TRANSLATE_DAILY_LIMIT 回まで、既定 100） */
app.http("phrase", {
  route: "phrase/{id?}",
  methods: ["POST", "PATCH", "DELETE"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    try {
      if (request.method === "PATCH") {
        const id = request.params.id || "";
        if (!/^p[a-z0-9]{4,20}$/.test(id)) return bad("id");
        let b;
        try { b = await request.json(); } catch { return bad("body"); }
        if (!b || b.action !== "translate") return bad("action");
        const item = await getOne("phrase", id);
        if (!item) return { status: 404, jsonBody: { error: "not_found" } };
        if (item.ja) return { jsonBody: { item } }; // すでに訳があれば AI を呼ばない
        const limit = Number(process.env.TRANSLATE_DAILY_LIMIT) || 100;
        const uk = roleplay.usageKey().replace("roleplay-", "translate-");
        const used = (await getOne("usage", uk)) || { count: 0 };
        if (used.count >= limit) return { status: 429, jsonBody: { error: "daily_limit", limit } };
        await upsert("usage", uk, { count: used.count + 1 });
        const ja = phrase.cleanTranslation(await callLLM(phrase.translateMessages(item), 200));
        if (!ja) return { status: 502, jsonBody: { error: "no_translation" } };
        const next = { ...item, ja };
        await upsert("phrase", id, next);
        return { jsonBody: { item: next }, headers: { "Cache-Control": "no-store" } };
      }
      if (request.method === "DELETE") {
        const id = request.params.id || "";
        if (!/^p[a-z0-9]{4,20}$/.test(id)) return bad("id");
        await remove("phrase", id);
        await remove("card-sentence", id);
        return { status: 204 };
      }
      let b;
      try { b = await request.json(); } catch { return bad("body"); }
      const r = phrase.cleanPhrase(b);
      if (r.error) return bad(r.error);
      const existing = await listPartition("phrase");
      const dup = phrase.findDuplicate(existing, r.item.text);
      if (dup) return { jsonBody: { item: dup, duplicate: true } };
      if (existing.length >= phrase.MAX_PHRASES) return { status: 409, jsonBody: { error: "too_many", limit: phrase.MAX_PHRASES } };
      await upsert("phrase", r.item.id, r.item);
      return { status: 201, jsonBody: { item: r.item, duplicate: false } };
    } catch (e) {
      if (e.code === "no_llm") return { status: 503, jsonBody: { error: "no_llm" } };
      return fail(context, e);
    }
  },
});

/* ---------- フィードバック（👎・ご意見・要望） ---------- */
const FB_KINDS = new Set(["content", "app"]);
app.http("feedback", {
  route: "feedback",
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    try {
      if (request.method === "GET") {
        const rows = await listPartition("feedback");
        return { jsonBody: rows.slice(0, 200), headers: { "Cache-Control": "no-store" } };
      }
      const b = await request.json();
      const clip = (s, n) => (s == null ? "" : String(s).slice(0, n));
      if (!b || !FB_KINDS.has(b.kind) || !b.category) return bad("feedback");
      if (b.kind === "app" && !clip(b.comment, 1000).trim()) return bad("comment");
      const item = {
        kind: b.kind,                               // content = 教材・判定への👎 / app = 機能の要望・使い勝手・不具合
        category: clip(b.category, 40),
        targetType: clip(b.targetType, 20),         // word / sentence / quiz
        targetId: clip(b.targetId, 100),
        targetText: clip(b.targetText, 300),
        // 判定結果など、そのときの状況（大きすぎるものは保存しない）
        detail: b.detail && typeof b.detail === "object" && JSON.stringify(b.detail).length <= 2000 ? b.detail : undefined,
        comment: clip(b.comment, 1000),
        context: { tab: clip(b.context?.tab, 20), version: clip(b.context?.version, 20), device: clip(b.context?.device, 20) },
        instanceId: clip(b.instanceId, 40),
        status: "open",
        at: new Date().toISOString(),
      };
      const rk = String(9e15 - Date.now()).padStart(16, "0");
      // 本人が「作者にも送る」を選んだときだけ、作者の受付に転送する（初期設定は送らない）
      if (b.share === true && share.hubEnabled()) {
        item.share = await share.sendToHub(share.buildPayload(item, b.instanceId, b.context?.version));
      }
      await upsert("feedback", rk, item);
      return { status: 201, jsonBody: { share: item.share ? item.share.status : "none" } };
    } catch (e) {
      if (e instanceof SyntaxError) return bad("feedback");
      return fail(context, e);
    }
  },
});

/* ---------- 単語・文・復習状態の取り込み（初期データ投入・教材追加用） ---------- */
app.http("import", {
  route: "import",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const denied = requireOwner(request);
    if (denied) return denied;
    try {
      const b = await request.json();
      const arr = (x) => (Array.isArray(x) ? x.slice(0, 2000) : []);
      const words = arr(b.words).filter((w) => w && w.id && w.word).map((w) => ({ ...w, id: safeKey(w.id) }));
      const sentences = arr(b.sentences).filter((s) => s && s.id && s.text).map((s) => ({ ...s, id: safeKey(s.id) }));
      const wc = Object.entries(b.wordCards || {}).map(([id, c]) => ({ id: safeKey(id), ...c }));
      const sc = Object.entries(b.sentenceCards || {}).map(([id, c]) => ({ id: safeKey(id), ...c }));
      await upsertMany("word", words);
      await upsertMany("sentence", sentences);
      await upsertMany("card-word", wc);
      await upsertMany("card-sentence", sc);
      if (b.settings && typeof b.settings === "object") {
        const cur = (await getOne("settings", "app")) || {};
        // 取り込みは明示的な操作なので移行データを優先。端末のランダムIDだけは今のものを残す
        await upsert("settings", "app", { ...cur, ...b.settings, instanceId: cur.instanceId || b.settings.instanceId, imported: true });
      }
      return { jsonBody: { words: words.length, sentences: sentences.length, wordCards: wc.length, sentenceCards: sc.length } };
    } catch (e) {
      return fail(context, e);
    }
  },
});
