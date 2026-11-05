// 作者へのフィードバック送信（任意・初期設定は「送らない」）
//
// - 送り先は環境変数 FEEDBACK_HUB_URL。空なら機能ごと無効（社内ルールで社外に出せない場合など）
// - 送るのは、本人が「作者にも送る」を選んだフィードバックだけ
// - メールアドレス・氏名・ユーザー ID・音声・Azure の情報は送らない
// - コメントなどの自由記述は、メール・URL・電話番号・長い数字を消してから送る（受付側でも同じ処理をする）

const HUB_URL = () => (process.env.FEEDBACK_HUB_URL || "").trim();
const SCHEMA_VERSION = 1;

/** 個人情報らしき文字列を消す */
function scrub(s, max) {
  if (s == null) return "";
  let t = String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, "[メール]")
    .replace(/\b(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]+/gi, "[URL]")
    .replace(/\+?\d[\d\-\s()（）]{8,}\d/g, "[番号]")
    .replace(/\d{7,}/g, "[番号]");
  return t.slice(0, max);
}

const pickNum = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v) : undefined);
const pickStr = (v, n) => (v == null ? undefined : scrub(v, n));

/** 送る内容を組み立てる（ここに無い項目は送らない） */
function buildPayload(item, instanceId, appVersion) {
  const d = item.detail && typeof item.detail === "object" ? item.detail : {};
  const detail = {
    pron: pickNum(d.pron), acc: pickNum(d.acc), flu: pickNum(d.flu), comp: pickNum(d.comp), judge: pickNum(d.judge),
    strictness: pickStr(d.strictness, 20),
    mode: pickStr(d.mode, 20),
    answer: pickStr(d.answer, 100),
    judged: typeof d.judged === "boolean" ? d.judged : undefined,
    comment: pickStr(d.comment, 120),
    recognized: pickStr(d.recognized, 300),
  };
  Object.keys(detail).forEach((k) => detail[k] === undefined && delete detail[k]);
  return {
    v: SCHEMA_VERSION,
    type: "feedback",
    app: "english-trainer", // 受付（feedback-hub）は複数のアプリで共通のため、どのアプリからかを付ける
    instanceId: String(instanceId || "").replace(/[^A-Za-z0-9\-]/g, "").slice(0, 64),
    appVersion: String(appVersion || "").replace(/[^\w.\-]/g, "").slice(0, 20),
    item: {
      kind: item.kind,
      category: scrub(item.category, 40),
      targetType: scrub(item.targetType, 20),
      targetId: scrub(item.targetId, 100),
      targetText: scrub(item.targetText, 300),
      comment: scrub(item.comment, 1000),
      detail,
      context: { tab: scrub(item.context?.tab, 20), device: scrub(item.context?.device, 20) },
    },
  };
}

/** 受付に送る。失敗しても利用者の操作は止めない */
async function sendToHub(payload, fetchImpl = fetch) {
  const url = HUB_URL();
  if (!url) return { status: "disabled" };
  if (!payload.instanceId) return { status: "failed", error: "no_instance" };
  try {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 202 || r.ok) return { status: "sent", at: new Date().toISOString() };
    return { status: "failed", error: `http_${r.status}`, at: new Date().toISOString() };
  } catch (e) {
    return { status: "failed", error: e.name === "TimeoutError" ? "timeout" : "network", at: new Date().toISOString() };
  }
}

module.exports = { scrub, buildPayload, sendToHub, hubEnabled: () => !!HUB_URL(), SCHEMA_VERSION };
