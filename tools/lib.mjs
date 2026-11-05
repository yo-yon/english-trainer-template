// GitHub Actions から Table Storage を読み書きする共通処理
//
// 本番：テーブル単位の SAS（読み取り・追加・更新のみ）を使う
//   TABLE_ACCOUNT_URL = https://<ストレージアカウント名>.table.core.windows.net
//   TABLE_SAS         = az storage table generate-sas の出力（? なしのトークン）
// ローカルの動作確認：STORAGE_CONNECTION_STRING（Azurite など）でも動く
import { TableClient, AzureSASCredential } from "@azure/data-tables";

export const TABLE_NAME = process.env.TABLE_NAME || "learning";

export function client() {
  const url = (process.env.TABLE_ACCOUNT_URL || "").trim().replace(/\/+$/, "");
  const sas = (process.env.TABLE_SAS || "").trim().replace(/^\?/, "");
  // 本番は https のみ。ローカルの模擬環境（127.0.0.1 / localhost）だけ http を許可する
  const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);
  if (url && sas) return new TableClient(url, TABLE_NAME, new AzureSASCredential(sas), { allowInsecureConnection: local });
  const cs = process.env.STORAGE_CONNECTION_STRING;
  if (cs) return TableClient.fromConnectionString(cs, TABLE_NAME, { allowInsecureConnection: /UseDevelopmentStorage|127\.0\.0\.1|localhost/.test(cs) });
  // 初期設定前（テンプレートから作った直後など）は失敗させずに終える
  console.log("::notice::GitHub のシークレット TABLE_ACCOUNT_URL と TABLE_SAS が未設定のため、何もしませんでした（docs/FEEDBACK-LOOP.md の手順を参照）");
  process.exit(0);
}

/** アプリと同じ形式：1行 = { partitionKey, rowKey, data: JSON文字列 } */
export async function listPartition(t, pk) {
  const out = [];
  const filter = `PartitionKey eq '${pk.replace(/'/g, "''")}'`;
  for await (const e of t.listEntities({ queryOptions: { filter } })) {
    try { out.push({ id: e.rowKey, ...JSON.parse(e.data) }); } catch { /* 壊れた行は読み飛ばす */ }
  }
  return out;
}

/** RowKey に使えない文字を置き換える（api/src/lib.js の safeKey と同じ） */
export function safeKey(s) {
  return String(s).replace(/[\/\\#?\u0000-\u001f\u007f-\u009f]/g, "_").slice(0, 200);
}

/** 日本時間の日付 */
export function jstDate(d = new Date()) {
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate(), ymd: j.toISOString().slice(0, 10) };
}

export function friendlyError(e) {
  const code = e && (e.statusCode || e.code);
  if (code === 403) return "アクセスが拒否されました（SAS の権限・有効期限、またはテーブル名を確認してください）";
  if (code === 404) return "テーブルまたはデータが見つかりません";
  return String((e && e.message) || e);
}
