/**
 * SplitXCore: cash distribution, payroll summary and bank planner.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createCore } = require('../js/SplitXCore.js');

const DOP = [2000, 1000, 500, 200, 100, 50, 25, 10, 5, 1];
const USD = [100, 50, 20, 10, 5, 2, 1, 0.25, 0.10, 0.05, 0.01];

const make = (overrides = {}) => {
    const state = {
        denominations: DOP,
        inventory: {},
        employees: [],
        bankLimits: {},
        payrollMode: 'normal',
        payrollLoanFund: 0,
        ...overrides
    };
    const core = createCore({ getState: () => state, fmt: (n) => `$${Number(n).toFixed(2)}` });
    return { state, core };
};

describe('getIdealBreakdown', () => {
    test('breaks an amount greedily by the largest denominations', () => {
        const { core } = make();
        assert.deepEqual(core.getIdealBreakdown(3786), {
            distribution: { 2000: 1, 1000: 1, 500: 1, 200: 1, 50: 1, 25: 1, 10: 1, 1: 1 },
            remainder: 0
        });
    });

    test('keeps the sub-unit remainder that no denomination covers', () => {
        const { core } = make();
        assert.equal(core.getIdealBreakdown(10.5).remainder, 0.5);
    });

    test('handles decimal coins without float drift', () => {
        const { core } = make({ denominations: USD });
        const { distribution, remainder } = core.getIdealBreakdown(0.35);
        assert.deepEqual(distribution, { 0.25: 1, 0.1: 1 });
        assert.equal(remainder, 0);
    });

    test('negative or invalid amounts yield an empty breakdown', () => {
        const { core } = make();
        assert.deepEqual(core.getIdealBreakdown(-50), { distribution: {}, remainder: 0 });
        assert.deepEqual(core.getIdealBreakdown('abc'), { distribution: {}, remainder: 0 });
    });
});

describe('getEffectiveEmployeeAmount', () => {
    const emp = { amount: 900, payroll: { afterDiscounts: 1000, loans: 100 } };

    test('normal mode ignores loan deductions', () => {
        assert.equal(make().core.getEffectiveEmployeeAmount(emp), 1000);
    });

    test('deductions mode pays the net amount', () => {
        assert.equal(make({ payrollMode: 'deductions' }).core.getEffectiveEmployeeAmount(emp), 900);
    });

    test('employees without payroll use their amount', () => {
        assert.equal(make().core.getEffectiveEmployeeAmount({ amount: 250 }), 250);
    });
});

describe('calculateDistribution', () => {
    test('pays from inventory and reports leftovers', () => {
        const { core } = make({
            inventory: { 1000: 2, 500: 1, 100: 5 },
            employees: [{ id: 1, name: 'Ana', amount: 1600, paid: false }]
        });
        const { results, leftoverInventory } = core.calculateDistribution();
        assert.deepEqual(results[0].distribution, { 1000: 1, 500: 1, 100: 1 });
        assert.equal(results[0].status, 'ok');
        assert.equal(results[0]._missingAmount, 0);
        assert.deepEqual(leftoverInventory, { 1000: 1, 500: 0, 100: 4 });
    });

    test('flags the missing amount when the box cannot cover an employee', () => {
        const { core } = make({
            inventory: { 1000: 1 },
            employees: [{ id: 1, name: 'Ana', amount: 1300, paid: false }]
        });
        const { results } = core.calculateDistribution();
        assert.equal(results[0].status, 'error');
        assert.equal(results[0]._missingAmount, 300);
        assert.deepEqual(results[0].notes, ['Faltan $300.00']);
    });

    test('inventory is consumed in employee order', () => {
        const { core } = make({
            inventory: { 1000: 1 },
            employees: [
                { id: 1, name: 'A', amount: 1000, paid: false },
                { id: 2, name: 'B', amount: 1000, paid: false }
            ]
        });
        const { results } = core.calculateDistribution();
        assert.equal(results[0].status, 'ok');
        assert.equal(results[1]._missingAmount, 1000);
    });

    test('paid employees never consume inventory', () => {
        const { core } = make({
            inventory: { 1000: 1 },
            employees: [{ id: 1, name: 'A', amount: 1000, paid: true }]
        });
        const { results, leftoverInventory } = core.calculateDistribution();
        assert.deepEqual(results[0].distribution, { 1000: 1 });
        assert.equal(leftoverInventory[1000], 1);
    });

    test('does not mutate the stored state (no _missingAmount leaks into persisted employees)', () => {
        const { core, state } = make({
            employees: [{ id: 1, name: 'A', amount: 500, paid: false }]
        });
        const before = JSON.stringify(state);
        core.calculateDistribution();
        assert.equal(JSON.stringify(state), before);
    });

    test('loan fund is reserved from inventory only in deductions mode', () => {
        const employees = [{ id: 1, name: 'A', amount: 100, paid: false, payroll: { afterDiscounts: 600, loans: 500, loanDetails: {} } }];
        const normal = make({ inventory: { 500: 1 }, payrollLoanFund: 500, employees }).core.calculateDistribution();
        assert.equal(normal.loanFundResult.amount, 0);

        const ded = make({ inventory: { 500: 1 }, payrollMode: 'deductions', payrollLoanFund: 500, employees }).core.calculateDistribution();
        assert.equal(ded.loanFundResult.amount, 500);
        assert.deepEqual(ded.loanFundResult.distribution, { 500: 1 });
    });

    test('loan fund is capped by the total loans collected', () => {
        const employees = [{ id: 1, name: 'A', amount: 100, paid: false, payroll: { loans: 200, afterDiscounts: 300 } }];
        const { loanFundResult } = make({ payrollMode: 'deductions', payrollLoanFund: 9999, employees }).core.calculateDistribution();
        assert.equal(loanFundResult.amount, 200);
        assert.equal(loanFundResult.status, 'error');
        assert.equal(loanFundResult.missingAmount, 200);
    });
});

describe('calculateBankNeeds', () => {
    test('plans only what the box cannot cover', () => {
        const { core } = make({
            inventory: { 1000: 1 },
            employees: [{ id: 1, name: 'A', amount: 1700, paid: false }]
        });
        const { breakdown, remainder } = core.calculateBankNeeds();
        assert.equal(breakdown[500].final, 1);
        assert.equal(breakdown[200].final, 1);
        assert.equal(breakdown[1000].final, 0);
        assert.equal(remainder, 0);
    });

    test('a bank limit cascades the shortfall into smaller denominations', () => {
        const { core } = make({
            bankLimits: { 1000: 0 },
            employees: [{ id: 1, name: 'A', amount: 1000, paid: false }]
        });
        const { breakdown } = core.calculateBankNeeds();
        assert.equal(breakdown[1000].final, 0);
        assert.equal(breakdown[500].final, 2);
    });

    test('paid employees add nothing to the bank order', () => {
        const { core } = make({ employees: [{ id: 1, name: 'A', amount: 1000, paid: true }] });
        const { breakdown } = core.calculateBankNeeds();
        assert.ok(Object.values(breakdown).every(row => row.final === 0));
    });
});

describe('getPayrollSummary', () => {
    const employees = [
        { id: 1, name: 'A', amount: 900, payroll: { gross: 1000, bonuses: 100, discounts: 50, afterDiscounts: 1050, loans: 150, loanDetails: { principal: 100, interestAmount: 50, remainingBalance: 700 } } },
        { id: 2, name: 'B', amount: 400 }
    ];

    test('normal mode nets after discounts, ignoring loans', () => {
        const s = make({ employees }).core.getPayrollSummary();
        assert.equal(s.count, 1);
        assert.equal(s.loansCount, 1);
        assert.equal(s.gross, 1000);
        assert.equal(s.loans, 150);
        assert.equal(s.net, 400 + 1050);
    });

    test('deductions mode nets after loans and splits principal/interest', () => {
        const s = make({ employees, payrollMode: 'deductions' }).core.getPayrollSummary();
        assert.equal(s.net, 400 + 900);
        assert.equal(s.totalPrincipal, 100);
        assert.equal(s.totalInterest, 50);
        assert.equal(s.totalRemainingBalance, 700);
    });
});

describe('bounded optimizer integration: protect payroll regressions', () => {
    test('uses three 10 bills when a greedy 25 bill leaves an avoidable shortage', () => {
        const { core } = make({
            denominations: [25, 10], inventory: {25: 1, 10: 3},
            employees: [{id:1,name:'Ana', amount:30, paid:false}]
        });
        const {results,leftoverInventory} = core.calculateDistribution();
        assert.equal(results[0]._missingAmount,0);
        assert.deepEqual(results[0].distribution, {10:3});
        assert.deepEqual(leftoverInventory, {25:1, 10:0});
        const {breakdown} = core.calculateBankNeeds();
        assert.ok(Object.values(breakdown).every(x=>x.final===0));
    });
    test('never sacrifices an employee who was fully payable with old distribution', () => {
        const {core} = make({
            denominations:[25,10], inventory:{25:1,10:3},
            employees:[{id:1,name:'A',amount:30,paid:false},{id:2,name:'B',amount:10,paid:false}]
        });
        const {results}=core.calculateDistribution();
        // Optimizing A would require all three 10s and make B newly short.
        assert.equal(results[0]._missingAmount,5);
        assert.equal(results[1]._missingAmount,0);
    });
    test('optimizes loan reserve independently of paid employee inventory', () => {
        const {core} = make({
            denominations:[25,10], inventory:{25:1,10:3}, payrollMode:'deductions',
            payrollLoanFund:30,
            employees:[{id:1,name:'A',amount:0,paid:true,payroll:{loans:30,afterDiscounts:30}}]
        });
        const {loanFundResult,leftoverInventory}=core.calculateDistribution();
        assert.equal(loanFundResult.missingAmount,0);
        assert.deepEqual(loanFundResult.distribution, {10:3});
        assert.equal(leftoverInventory[25],1);
    });
});
