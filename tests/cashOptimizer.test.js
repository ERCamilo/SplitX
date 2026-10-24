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
