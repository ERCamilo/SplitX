const { test } = require('node:test');
const assert = require('node:assert/strict');
const { solveCash } = require('../js/CashOptimizer.js');
test('greedy counterexample: three 10 bills instead of one 25 coin', () => {
  const r = solveCash(30, [25,10,5,1], {25:1,10:3,5:0,1:0});
  assert.equal(r.remainder,0);
  assert.deepEqual(r.distribution,{10:3});
});
test('does not use more cash than available', () => {
  const r=solveCash(31,[25,10,5,1],{25:1,10:3,5:0,1:0});
  assert.equal(r.remainder,1);
});
test('supports cents as integer minor units', () => {
  const r=solveCash(0.3,[0.25,0.1,0.05],{0.25:1,0.1:1,0.05:1});
  assert.equal(r.remainder,0);
});
test('invalid negative counts are rejected',()=>{
  assert.throws(()=>solveCash(30,[10],{10:-1}));
});
test('does not change existing canonical greedy results',()=>{
  const r=solveCash(1750,[1000,500,200,50],{1000:1,500:1,200:1,50:1});
  assert.deepEqual(r.distribution, {1000:1,500:1,200:1,50:1});
});

test('matches brute-force optimal coverage for small finite inventories', () => {
  const denoms = [7, 5, 3, 1];
  for (let a = 0; a <= 2; a++) for (let b = 0; b <= 2; b++)
    for (let c = 0; c <= 2; c++) for (let d = 0; d <= 2; d++) {
      const inv = { 7: a, 5: b, 3: c, 1: d };
      for (let target = 0; target < 26; target++) {
        let best = 0;
        for (let i = 0; i <= a; i++) for (let j = 0; j <= b; j++)
          for (let k = 0; k <= c; k++) for (let l = 0; l <= d; l++) {
            const sum = 7*i + 5*j + 3*k + l;
            if (sum <= target && sum > best) best = sum;
          }
        const r = solveCash(target, denoms, inv);
        assert.equal(r.remainder, target - best, JSON.stringify({ target, inv, r }));
        for (const [denom, count] of Object.entries(r.distribution)) {
          assert.ok(count <= inv[denom] && count >= 0);
        }
      }
    }
});
test('budget fallback stays valid and cannot overspend inventory', () => {
    const result = solveCash(31, [25, 10], { 25: 1, 10: 3 }, { maxStates: 1 });
    assert.deepEqual(result.distribution, {25:1});
    assert.equal(result.optimized, false);
});
test('safe cents with repeated finite stocks', () => {
    const r = solveCash(0.3, [0.25,0.1], {0.25:1,0.1:3});
    assert.equal(r.remainder, 0);
    assert.deepEqual(r.distribution, {'0.1':3});
});
