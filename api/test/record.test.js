const test = require("node:test");
const assert = require("node:assert");
const S = require("../../src/srs.js");

test("retentionWeeks：直近の週を古い順に、回数0の週は null", () => {
  const log = { "2026-11-09": { word: { n: 6, ok: 3 }, sentence: { n: 4, ok: 4 } }, "2026-11-16": { word: { n: 10, ok: 8 } } };
  const w = S.retentionWeeks(log, 3, "2026-11-18");
  assert.deepEqual(w.map((x) => x.week), ["2026-11-02", "2026-11-09", "2026-11-16"]);
  assert.deepEqual(w.map((x) => x.rate), [null, 70, 80]);
});

test("habitMonth：月曜始まり、7の倍数、日ごとの段階", () => {
  const h = { days: { "2026-11-01": { w: 5, c: 1 }, "2026-11-03": { w: 3, p: 60 }, "2026-11-04": { w: 1, p: 10 } } };
  const m = S.habitMonth(h, "2026-11", "2026-11-16");
  assert.equal(m.length % 7, 0);
  assert.equal(m[0].date, "2026-10-26");
  const lv = Object.fromEntries(m.map((c) => [c.date, c.level]));
  assert.equal(lv["2026-10-31"], "none");
  assert.equal(lv["2026-11-01"], "done");
  assert.equal(lv["2026-11-02"], "rest");
  assert.equal(lv["2026-11-03"], "part");
  assert.equal(lv["2026-11-04"], "low");
  assert.equal(lv["2026-11-05"], "miss");
  assert.equal(lv["2026-11-16"], "today");
  assert.equal(lv["2026-11-17"], "future");
  assert.equal(m.find((c) => c.date === "2026-11-30").inMonth, true);
  assert.equal(m.find((c) => c.date === "2026-12-01").inMonth, false);
});

test("badgeStatus：条件を満たしたものだけ done、進み具合は目標で止める", () => {
  const b = S.badgeStatus({ best: 8, cleared: 1, mature: 12, talks: 0, retBest: 80 });
  const by = Object.fromEntries(b.map((x) => [x.id, x]));
  assert.equal(b.length, S.BADGES.length);
  assert.equal(by.first.done, true);
  assert.equal(by.streak7.done, true);
  assert.equal(by.streak7.cur, 7);
  assert.equal(by.streak30.done, false);
  assert.equal(by.streak30.cur, 8);
  assert.equal(by.mature50.cur, 12);
  assert.equal(by.ret80.done, true);
  assert.equal(by.talk10.done, false);
});
