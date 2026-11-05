// 共通処理：本人確認・テーブル操作・レスポンス
const { TableClient } = require("@azure/data-tables");

const OWNER_ROLE = "owner";
const TABLE_NAME = process.env.TABLE_NAME || "learning";

/** SWA が付ける x-ms-client-principal（Base64のJSON）を読む */
function getPrincipal(request) {
  const raw = request.headers.get("x-ms-client-principal");
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** ルート設定に加えて、API側でも owner ロールを再確認する */
function requireOwner(request) {
  const p = getPrincipal(request);
  if (!p || !Array.isArray(p.userRoles) || !p.userRoles.includes(OWNER_ROLE)) {
    return { status: 403, jsonBody: { error: "forbidden" } };
  }
  return null;
}

let tableClient = null;
let tableReady = null;
async function table() {
  if (!tableClient) {
    const cs = process.env.STORAGE_CONNECTION_STRING;
    if (!cs) throw new Error("STORAGE_CONNECTION_STRING が未設定です");
    tableClient = TableClient.fromConnectionString(cs, TABLE_NAME);
    tableReady = tableClient.createTable().catch((e) => {
      if (e.statusCode !== 409) throw e; // 409 = すでに存在
    });
  }
  await tableReady;
  return tableClient;
}

/**
 * 1行 = { partitionKey, rowKey, data: JSON文字列 }
 * 配列や入れ子をそのまま保存できるように、本体はJSON文字列1列にまとめる。
 */
async function listPartition(pk) {
  const t = await table();
  const out = [];
  const iter = t.listEntities({ queryOptions: { filter: `PartitionKey eq '${pk.replace(/'/g, "''")}'` } });
  for await (const e of iter) {
    try {
      out.push({ id: e.rowKey, ...JSON.parse(e.data) });
    } catch {
      /* 壊れた行は読み飛ばす */
    }
  }
  return out;
}

async function getOne(pk, rk) {
  const t = await table();
  try {
    const e = await t.getEntity(pk, rk);
    return JSON.parse(e.data);
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

async function upsert(pk, rk, obj) {
  const t = await table();
  const { id, ...rest } = obj || {};
  await t.upsertEntity({ partitionKey: pk, rowKey: rk, data: JSON.stringify(rest) }, "Replace");
}

/** 同じパーティションへの一括書き込み（トランザクションは1回100件まで） */
async function upsertMany(pk, items) {
  const t = await table();
  for (let i = 0; i < items.length; i += 100) {
    const actions = items.slice(i, i + 100).map((it) => {
      const { id, ...rest } = it;
      return ["upsert", { partitionKey: pk, rowKey: String(id), data: JSON.stringify(rest) }, "Replace"];
    });
    if (actions.length) await t.submitTransaction(actions);
  }
}

/** RowKey に使えない文字（/ \ # ?）を置き換える */
function safeKey(s) {
  return String(s).replace(/[\/\\#?\u0000-\u001f\u007f-\u009f]/g, "_").slice(0, 200);
}

const bad = (msg) => ({ status: 400, jsonBody: { error: msg } });
const fail = (context, e) => {
  context.error(e);
  return { status: 500, jsonBody: { error: "server_error" } };
};

module.exports = { getPrincipal, requireOwner, listPartition, getOne, upsert, upsertMany, safeKey, bad, fail, OWNER_ROLE };
