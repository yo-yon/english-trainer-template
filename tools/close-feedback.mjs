// 取り込まれたプルリクエストの本文から「Fixes-feedback: <ID>, <ID>」を読み、
// そのフィードバックを「対応済み」にする。
import { client, friendlyError } from "./lib.mjs";

const body = process.env.PR_BODY || "";
const pr = process.env.PR_NUMBER || "";
const prUrl = process.env.PR_URL || "";

const ids = [...body.matchAll(/^\s*Fixes-feedback:\s*(.+)$/gim)]
  .flatMap((m) => m[1].split(/[\s,、]+/))
  .map((s) => s.trim())
  .filter((s) => /^\d{1,20}$/.test(s));

if (!ids.length) {
  console.log("対応済みにするフィードバックはありません（本文に Fixes-feedback: の行がありません）");
  process.exit(0);
}

const t = client();
let done = 0;
for (const id of [...new Set(ids)]) {
  try {
    const e = await t.getEntity("feedback", id);
    const data = JSON.parse(e.data);
    if (data.status === "done") { console.log(`${id}: すでに対応済み`); continue; }
    data.status = "done";
    data.doneAt = new Date().toISOString();
    data.pr = pr ? Number(pr) : undefined;
    data.prUrl = prUrl || undefined;
    await t.updateEntity({ partitionKey: "feedback", rowKey: id, data: JSON.stringify(data) }, "Replace", { etag: e.etag });
    done++;
    console.log(`${id}: 対応済みにしました（${data.category || ""} ${data.targetText || ""}）`);
  } catch (err) {
    console.log(`::warning::${id}: ${friendlyError(err)}`);
  }
}
console.log(`対応済みにした件数：${done}`);
