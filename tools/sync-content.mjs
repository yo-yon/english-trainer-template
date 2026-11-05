// 教材（単語・文）を src/seed から Table に反映する。復習状態・設定・記録には触れない。
// main に取り込まれた教材の修正を、アプリで「初期データを取り込む」を押さなくても反映するため。
import { readFile } from "node:fs/promises";
import { client, safeKey, friendlyError } from "./lib.mjs";

const root = new URL("../src/seed/", import.meta.url);

// テーブル単位の SAS では一括書き込み（$batch）が拒否されることがあるため、1件ずつ書き込む（教材は数十件なので十分速い）
async function upsertPartition(t, pk, items) {
  let n = 0;
  for (const { id, ...rest } of items) {
    await t.upsertEntity({ partitionKey: pk, rowKey: safeKey(id), data: JSON.stringify(rest) }, "Replace");
    n++;
  }
  return n;
}

try {
  const words = JSON.parse(await readFile(new URL("words.json", root), "utf8")).filter((w) => w && w.id && w.word);
  const sentences = JSON.parse(await readFile(new URL("sentences.json", root), "utf8")).filter((s) => s && s.id && s.text);
  const t = client();
  const w = await upsertPartition(t, "word", words);
  const s = await upsertPartition(t, "sentence", sentences);
  console.log(`教材を反映しました：単語 ${w} 語、文 ${s} 文（復習状態は変更していません）`);
} catch (e) {
  console.error("::error::" + friendlyError(e));
  process.exit(1);
}
