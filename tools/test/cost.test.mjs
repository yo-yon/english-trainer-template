import test from "node:test";
import assert from "node:assert/strict";
import { sumByService, scopesFromEnv } from "../cost.mjs";

test("サービス別に合計し、高い順に並べる（PreTaxCost・Cost のどちらの列名でも）", () => {
  const a = { properties: { columns: [{ name: "PreTaxCost" }, { name: "ServiceName" }, { name: "Currency" }], rows: [[10.004, "Foundry Models", "JPY"], [0, "Storage", "JPY"]] } };
  const b = { properties: { columns: [{ name: "Cost" }, { name: "ServiceName" }, { name: "Currency" }], rows: [[5, "Foundry Models", "JPY"], [1.5, "Static Web Apps", "JPY"]] } };
  const r = sumByService([a, b]);
  assert.equal(r.currency, "JPY");
  assert.equal(r.total, 16.5);
  assert.deepEqual(r.services.map((s) => s.name), ["Foundry Models", "Static Web Apps", "Storage"]);
  assert.equal(r.services[0].cost, 15);
});

test("9つ以上のサービスは上位8つと「その他」にまとめる・空の結果は0", () => {
  const rows = Array.from({ length: 10 }, (_, i) => [i + 1, "s" + i, "USD"]);
  const r = sumByService([{ properties: { columns: [{ name: "PreTaxCost" }, { name: "ServiceName" }, { name: "Currency" }], rows } }]);
  assert.equal(r.services.length, 9);
  assert.equal(r.services[8].name, "その他");
  assert.equal(r.services[8].cost, 3);
  assert.equal(sumByService([{ properties: { columns: [], rows: [] } }]).total, 0);
});

test("範囲は COST_SCOPES（カンマ区切り）、なければサブスクリプション全体", () => {
  assert.deepEqual(scopesFromEnv({ COST_SCOPES: " /subscriptions/x/resourceGroups/a/ , /subscriptions/x/resourceGroups/b" }), ["/subscriptions/x/resourceGroups/a", "/subscriptions/x/resourceGroups/b"]);
  assert.deepEqual(scopesFromEnv({ AZURE_SUBSCRIPTION_ID: "abc" }), ["/subscriptions/abc"]);
  assert.deepEqual(scopesFromEnv({}), []);
});
