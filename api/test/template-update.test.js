const test = require("node:test");
const assert = require("node:assert");
const S = require("../../src/srs.js");

const MD = `# 変更履歴

更新の取り込み方は [docs/UPDATING.md](docs/UPDATING.md) を見てください。

## 0.25.0（2026-11-16）

変わったファイル：\`src/app.js\`

**更新するときの注意**：追加の Azure リソースや環境変数はありません。

- テンプレートの更新のお知らせ

## 0.24.0（2026-11-16）

**更新するときの注意**：費用も増えません。

## 0.9.1（2026-11-05）

- 古い版
`;

test("cmpVersion は数として比べる", () => {
  assert.ok(S.cmpVersion("0.10.0", "0.9.1") > 0);
  assert.ok(S.cmpVersion("0.24.0", "0.24.0") === 0);
  assert.ok(S.cmpVersion("0.23.9", "0.24") < 0);
  assert.ok(S.cmpVersion("1.0", "0.99.99") > 0);
});

test("parseChangelog は版・日付・更新するときの注意を取り出す", () => {
  const l = S.parseChangelog(MD);
  assert.deepEqual(l.map((x) => x.v), ["0.25.0", "0.24.0", "0.9.1"]);
  assert.equal(l[0].date, "2026-11-16");
  assert.equal(l[0].note, "追加の Azure リソースや環境変数はありません。");
  assert.equal(l[2].note, "");
  assert.deepEqual(S.parseChangelog(""), []);
});

test("newerVersions は今の版より新しいものだけを新しい順に", () => {
  const l = S.parseChangelog(MD);
  assert.deepEqual(S.newerVersions(l, "0.23.0").map((x) => x.v), ["0.25.0", "0.24.0"]);
  assert.deepEqual(S.newerVersions(l, "0.25.0"), []);
  assert.deepEqual(S.newerVersions([{ v: "0.9.1" }, { v: "0.10.0" }], "0.9.0").map((x) => x.v), ["0.10.0", "0.9.1"]);
});
