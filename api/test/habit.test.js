const test = require("node:test");
const assert = require("node:assert");
const S = require("../../src/srs.js");

const day = (c = 1) => ({ w: 5, s: 5, t: 1, c });

test("addDays・weekOf は月をまたいでも正しい", () => {
  assert.equal(S.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(S.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(S.weekOf("2026-11-16"), "2026-11-16"); // 月曜
  assert.equal(S.weekOf("2026-11-15"), "2026-11-09"); // 日曜は前の週
});

test("habitRings：残り0は満タン、会話は回数", () => {
  const r = S.habitRings({ w: 6, s: 2, t: 0 }, { w: 4, s: 0 }, 1);
  assert.equal(r.w.p, 0.6);
  assert.equal(r.w.total, 10);
  assert.equal(r.s.p, 1);
  assert.equal(r.t.p, 0);
  const z = S.habitRings({}, { w: 0, s: 0 }, 1);
  assert.equal(z.w.p, 1);
});

test("habitCounts：3つ満タン、または5分だけモードで単語が満タン。何もしていない日は数えない", () => {
  const full = S.habitRings({ w: 3, s: 2, t: 1 }, { w: 0, s: 0 });
  assert.equal(S.habitCounts({ w: 3, s: 2, t: 1 }, full), true);
  const part = S.habitRings({ w: 3, s: 1, t: 0 }, { w: 0, s: 2 });
  assert.equal(S.habitCounts({ w: 3, s: 1, t: 0 }, part), false);
  assert.equal(S.habitCounts({ w: 3, s: 1, t: 0, f: 1 }, part), true);
  const none = S.habitRings({}, { w: 0, s: 0 });
  assert.equal(S.habitCounts({ f: 1 }, none), false);
});

test("habitScan：続けた日を数え、今日は終えたら +1", () => {
  const h = { days: { "2026-11-13": day(), "2026-11-14": day(), "2026-11-15": day() } };
  let s = S.habitScan(h, "2026-11-16");
  assert.equal(s.run, 3);
  assert.equal(s.current, 3);
  assert.equal(s.todayDone, false);
  h.days["2026-11-16"] = day();
  s = S.habitScan(h, "2026-11-16");
  assert.equal(s.current, 4);
  assert.equal(s.best, 4);
});

test("habitScan：休んだ日はその週のお休み券で切れない。同じ週に2回休むと切れる", () => {
  // 11/10(火)〜11/15(日) は同じ週。11/12 を休む → お休み券
  const h = { days: { "2026-11-10": day(), "2026-11-11": day(), "2026-11-13": day(), "2026-11-14": day(), "2026-11-15": day() } };
  let s = S.habitScan(h, "2026-11-16");
  assert.equal(s.states["2026-11-12"], "rest");
  assert.equal(s.run, 5); // 休んだ日は増えない
  assert.equal(s.freezeLeft, 1); // 11/16 からは新しい週
  delete h.days["2026-11-14"];
  s = S.habitScan(h, "2026-11-16");
  assert.equal(s.states["2026-11-14"], "miss");
  assert.equal(s.run, 1);
  assert.equal(s.best, 3);
});

test("habitScan：今週のお休み券を使ったら残り0", () => {
  const h = { days: { "2026-11-16": day(), "2026-11-18": day() } };
  const s = S.habitScan(h, "2026-11-19");
  assert.equal(s.states["2026-11-17"], "rest");
  assert.equal(s.freezeLeft, 0);
  assert.equal(s.run, 2);
});

test("habitScan：連続が0のときはお休み券を使わない", () => {
  const h = { days: { "2026-11-10": { w: 1 } } }; // 数えなかった日だけ
  const s = S.habitScan(h, "2026-11-12");
  assert.equal(s.states["2026-11-10"], "miss");
  assert.equal(s.states["2026-11-11"], "miss");
  assert.equal(s.freezeLeft, 1);
});

test("habitWeek：直近7日の点", () => {
  const h = { days: { "2026-11-14": day(), "2026-11-15": day() } };
  const w = S.habitWeek(h, "2026-11-16");
  assert.equal(w.length, 7);
  assert.deepEqual(w.map((x) => x.state), ["none", "none", "none", "none", "done", "done", "today"]);
  assert.equal(w[6].dow, "月");
});

test("habitFold：古い日をまとめても連続日数と最長は変わらない", () => {
  const days = {};
  for (let d = "2026-08-01"; d <= "2026-11-15"; d = S.addDays(d, 1)) if (d !== "2026-09-02") days[d] = day();
  const h = { days: JSON.parse(JSON.stringify(days)) };
  const before = S.habitScan({ days }, "2026-11-16");
  S.habitFold(h, "2026-11-16");
  assert.ok(Object.keys(h.days).length <= S.HABIT_KEEP);
  assert.ok(h.anchor);
  const after = S.habitScan(h, "2026-11-16");
  assert.equal(after.run, before.run);
  assert.equal(after.best, before.best);
  // 2回まとめても同じ
  S.habitFold(h, "2026-11-20");
  h.days["2026-11-16"] = day(); h.days["2026-11-17"] = day(); h.days["2026-11-18"] = day(); h.days["2026-11-19"] = day();
  assert.equal(S.habitScan(h, "2026-11-20").run, before.run + 4);
});
