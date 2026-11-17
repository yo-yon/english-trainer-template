// Azure の費用を Cost Management の Query API で読み、Table の cost/latest に書く（GitHub Actions「Cost report」から1日1回）
//
// 認証：ワークフローが azure/login（OpenID Connect、シークレットのパスワードなし）でサインインし、
//       az account get-access-token で取った ARM のアクセストークンを ARM_TOKEN で渡す
// 範囲：COST_SCOPES（カンマ区切り）。例 /subscriptions/<ID>/resourceGroups/rg-english-trainer
//       未設定ならサブスクリプション全体（/subscriptions/<AZURE_SUBSCRIPTION_ID>）
// 権限：各範囲に「Cost Management Reader」ロール（Microsoft Learn「Assign access to Cost Management data」）
// 頻度：Microsoft Learn は1日1回までを推奨（データの更新は4時間ごと）
import { client, friendlyError } from "./lib.mjs";

const API_VERSION = process.env.COST_API_VERSION || "2026-06-01";
const MAX_SERVICES = 8;

export function scopesFromEnv(env = process.env) {
  const list = String(env.COST_SCOPES || "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
  if (list.length) return list;
  return env.AZURE_SUBSCRIPTION_ID ? [`/subscriptions/${env.AZURE_SUBSCRIPTION_ID.trim()}`] : [];
}

/** Query API の結果（columns・rows）をサービス別の合計にする。費用の列名は契約の種類で PreTaxCost または Cost になる */
export function sumByService(results) {
  const by = new Map();
  let currency = "";
  for (const res of results) {
    const cols = ((res && res.properties && res.properties.columns) || []).map((c) => c.name);
    const ic = cols.findIndex((n) => /^(PreTaxCost|Cost|CostUSD|totalCost)$/i.test(n));
    const is = cols.findIndex((n) => /^ServiceName$/i.test(n));
    const icur = cols.findIndex((n) => /^Currency$/i.test(n));
    for (const row of (res && res.properties && res.properties.rows) || []) {
      const v = Number(row[ic]) || 0;
      const name = (is >= 0 && row[is]) || "その他";
      if (icur >= 0 && row[icur]) currency = currency || row[icur];
      by.set(name, (by.get(name) || 0) + v);
    }
  }
  const services = [...by.entries()].map(([name, cost]) => ({ name, cost: round(cost) })).sort((a, b) => b.cost - a.cost);
  const total = round(services.reduce((s, x) => s + x.cost, 0));
  const top = services.slice(0, MAX_SERVICES);
  if (services.length > MAX_SERVICES) top.push({ name: "その他", cost: round(services.slice(MAX_SERVICES).reduce((s, x) => s + x.cost, 0)) });
  return { total, currency, services: top };
}
const round = (x) => Math.round(x * 100) / 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body, token) {
  for (let i = 0; i < 2; i++) {
    const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429 && i === 0) {
      // 使いすぎの制限（QPU）。指定の秒数だけ待って1回だけやり直す（Microsoft Learn「Data latency and rate limits」）
      const wait = Number(r.headers.get("x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after") || r.headers.get("retry-after") || 30);
      await sleep(Math.min(wait, 120) * 1000);
      continue;
    }
    const text = await r.text();
    if (r.status === 204) return { properties: { columns: [], rows: [] } };
    if (!r.ok) throw Object.assign(new Error(`Cost Management ${r.status}: ${text.slice(0, 300)}`), { status: r.status });
    return JSON.parse(text);
  }
  throw new Error("Cost Management 429: 使いすぎの制限のため取得できませんでした");
}

/** 1つの範囲・期間の費用（サービス別）。次のページ（nextLink）もたどる */
async function queryScope(scope, timeframe, token) {
  const url = `https://management.azure.com${scope}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`;
  // 公式の例どおり type "Usage"（= ActualCost）と PreTaxCost。列名が合わない契約では Cost でやり直す
  const body = (col) => ({
    type: "Usage", timeframe,
    dataset: { granularity: "None", aggregation: { totalCost: { name: col, function: "Sum" } }, grouping: [{ type: "Dimension", name: "ServiceName" }] },
  });
  let b = body("PreTaxCost");
  let res;
  try { res = await post(url, b, token); }
  catch (e) { if (e.status !== 400) throw e; b = body("Cost"); res = await post(url, b, token); }
  const out = [res];
  let next = res.properties && res.properties.nextLink;
  for (let i = 0; next && i < 10; i++) {
    const r2 = await post(next, b, token);
    out.push(r2);
    next = r2.properties && r2.properties.nextLink;
  }
  return out;
}

async function main() {
  const token = (process.env.ARM_TOKEN || "").trim();
  const scopes = scopesFromEnv();
  if (!token || !scopes.length) {
    console.log("::notice::Azure へのサインイン（AZURE_CLIENT_ID など）が未設定のため、費用は取得しませんでした（docs/COST.md の手順を参照）");
    return;
  }
  const t = client();
  let prev = null;
  try { prev = JSON.parse((await t.getEntity("cost", "latest")).data); } catch { /* 初回 */ }
  const now = new Date().toISOString();
  try {
    const month = [], last = [];
    for (const sc of scopes) {
      month.push(...await queryScope(sc, "MonthToDate", token));
      last.push(...await queryScope(sc, "TheLastMonth", token));
    }
    const m = sumByService(month), l = sumByService(last);
    const data = { at: now, currency: m.currency || l.currency || "", scopes: scopes.length, month: { total: m.total, services: m.services }, last: { total: l.total, services: l.services } };
    await t.upsertEntity({ partitionKey: "cost", rowKey: "latest", data: JSON.stringify(data) }, "Replace");
    console.log(`費用を取得しました：今月 ${m.total} ${data.currency}、先月 ${l.total} ${data.currency}（範囲 ${scopes.length} 件）`);
  } catch (e) {
    // 失敗しても前回の値は残し、失敗したことだけ書く（アプリで原因が分かるように）
    const data = { ...(prev || {}), error: String(e.message || e).slice(0, 300), errorAt: now };
    await t.upsertEntity({ partitionKey: "cost", rowKey: "latest", data: JSON.stringify(data) }, "Replace");
    console.error("::error::" + friendlyError(e));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
