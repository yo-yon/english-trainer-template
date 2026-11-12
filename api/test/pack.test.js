const test = require("node:test");
const assert = require("node:assert");
const P = require("../src/pack.js");
const sample = () => JSON.parse(JSON.stringify(require("./fixtures/pack-sample.json")));

test("パック：正しいパックは単語・文・場面に分けて、ID・出題順・追加日・パック名を付ける", () => {
  const r = P.cleanPack(sample(), "2026-W47");
  assert.equal(r.errors, undefined);
  assert.equal(r.words.length, 2);
  assert.equal(r.words[0].id, "follow-up");
  assert.equal(r.words[0].order, 202647000);
  assert.equal(r.words[1].order, 202647001);
  assert.equal(r.words[0].pack, "2026-W47");
  assert.equal(r.sentences[1].id, "k2026w47-s02");
  assert.equal(r.sentences[0].added, "2026-11-16");
  assert.equal(r.scenes[0].id, "k2026w47-c1");
});

test("パック：余計な項目は捨てる", () => {
  const p = sample();
  p.words[0].evil = "<script>";
  p.sentences[0].extra = 1;
  const r = P.cleanPack(p);
  assert.equal("evil" in r.words[0], false);
  assert.equal("extra" in r.sentences[0], false);
});

test("パック：1件でも不備があればパック全体を断る", () => {
  const p = sample();
  p.sentences[1].ja = "no japanese";
  const r = P.cleanPack(p);
  assert.ok(r.errors.length >= 1);
  assert.equal(r.words, undefined);
});

test("パック：ID・形式・件数・一覧との食い違いを断る", () => {
  let p = sample(); p.sentences[0].id = "k2026w47-s09";
  assert.ok(P.cleanPack(p).errors);
  p = sample(); p.format = 2;
  assert.ok(P.cleanPack(p).errors);
  p = sample(); p.id = "2026-47";
  assert.ok(P.cleanPack(p).errors);
  assert.ok(P.cleanPack(sample(), "2026-W48").errors);
  p = sample(); p.words = Array(101).fill(p.words[0]);
  assert.ok(P.cleanPack(p).errors);
  p = sample(); p.words.push({ ...p.words[0] });
  assert.match(P.cleanPack(p).errors.join(), /重複/);
});

test("一覧：取り込み済みを除いて古い順に、決まった場所のファイルだけ", () => {
  const idx = { format: 1, packs: [
    { id: "2026-W48", file: "packs/2026-W48.json" },
    { id: "2026-W47", file: "packs/2026-W47.json" },
    { id: "2026-W46", file: "packs/2026-W46.json" },
    { id: "2026-W49", file: "https://evil.example/p.json" },
    { id: "bad", file: "packs/bad.json" },
  ] };
  const r = P.pendingPacks(idx, ["2026-W46"]);
  assert.deepEqual(r.packs.map((x) => x.id), ["2026-W47", "2026-W48"]);
  assert.equal(P.pendingPacks({ format: 2, packs: [] }).error, "index");
});

test("パックの URL：一覧と同じ場所の packs/ だけ", () => {
  const feed = "https://raw.githubusercontent.com/yo-yon/english-trainer-content/main/index.json";
  assert.equal(P.packUrl(feed, "packs/2026-W47.json"), "https://raw.githubusercontent.com/yo-yon/english-trainer-content/main/packs/2026-W47.json");
  assert.throws(() => P.packUrl(feed, "../../other/repo/main/x.json"));
  assert.throws(() => P.packUrl(feed, "https://evil.example/packs/x.json"));
});

test("自動の取り込み：前回から7日たったら", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  assert.equal(P.dueForCheck(null, now), true);
  assert.equal(P.dueForCheck("2026-11-14T00:00:00Z", now), false);
  assert.equal(P.dueForCheck("2026-11-13T00:00:00Z", now), true);
});
