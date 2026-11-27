/**
 * SplitXCore: cash distribution, payroll summary and bank planner.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createCore, nextEmployeeId, sanitizeInventoryQty, parseManualAmount, clampLoanFund, roundEmployeeAmounts } = require('../js/SplitXCore.js');
const { parseMoney } = require('../js/SplitXExcelImport.js');

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
            denominations: [25, 10], inventory: { 25: 1, 10: 3 },
            employees: [{ id: 1, name: 'Ana', amount: 30, paid: false }]
        });
        const { results, leftoverInventory } = core.calculateDistribution();
        assert.equal(results[0]._missingAmount, 0);
        assert.deepEqual(results[0].distribution, { 10: 3 });
        assert.deepEqual(leftoverInventory, { 25: 1, 10: 0 });
        const { breakdown } = core.calculateBankNeeds();
        assert.ok(Object.values(breakdown).every(x => x.final === 0));
    });
    test('never sacrifices an employee who was fully payable with old distribution', () => {
        const { core } = make({
            denominations: [25, 10], inventory: { 25: 1, 10: 3 },
            employees: [{ id: 1, name: 'A', amount: 30, paid: false }, { id: 2, name: 'B', amount: 10, paid: false }]
        });
        const { results } = core.calculateDistribution();
        // Optimizing A would require all three 10s and make B newly short.
        assert.equal(results[0]._missingAmount, 5);
        assert.equal(results[1]._missingAmount, 0);
    });
    test('optimizes loan reserve independently of paid employee inventory', () => {
        const { core } = make({
            denominations: [25, 10], inventory: { 25: 1, 10: 3 }, payrollMode: 'deductions',
            payrollLoanFund: 30,
            employees: [{ id: 1, name: 'A', amount: 0, paid: true, payroll: { loans: 30, afterDiscounts: 30 } }]
        });
        const { loanFundResult, leftoverInventory } = core.calculateDistribution();
        assert.equal(loanFundResult.missingAmount, 0);
        assert.deepEqual(loanFundResult.distribution, { 10: 3 });
        assert.equal(leftoverInventory[25], 1);
    });
});

describe('domain validations and rounding helpers (Issue #25)', () => {
    test('sanitizeInventoryQty clamps negatives and invalid inputs to 0', () => {
        assert.equal(sanitizeInventoryQty(-5), 0);
        assert.equal(sanitizeInventoryQty('abc'), 0);
        assert.equal(sanitizeInventoryQty(''), 0);
        assert.equal(sanitizeInventoryQty('12'), 12);
    });

    test('parseManualAmount rejects negative or invalid values and accepts clean amounts', () => {
        assert.equal(parseManualAmount('-500', parseMoney).ok, false);
        assert.equal(parseManualAmount('12.345', parseMoney).ok, false);
        assert.equal(parseManualAmount('abc', parseMoney).ok, false);
        assert.deepEqual(parseManualAmount('1,500.25', parseMoney), { ok: true, amount: 1500.25 });
    });

    test('clampLoanFund handles invalid text without throwing and clamps to collected loans', () => {
        assert.deepEqual(clampLoanFund('', 500, parseMoney), { ok: true, value: 0 });
        assert.deepEqual(clampLoanFund('900', 500, parseMoney), { ok: true, value: 500 });
        assert.equal(clampLoanFund('-10', 500, parseMoney).ok, false);
        assert.equal(clampLoanFund('12.345', 500, parseMoney).ok, false);
    });

    test('roundEmployeeAmounts floors amount, payroll.net and payroll.afterDiscounts consistently', () => {
        const emps = [
            { id: 1, name: 'Ana', amount: 800.50, payroll: { gross: 1000.75, afterDiscounts: 1000.75, loans: 200.25, net: 800.50, calculatedNet: 800.50 } },
            { id: 2, name: 'Luis', amount: 500, payroll: { gross: 500, afterDiscounts: 500, loans: 0, net: 500, calculatedNet: 500 } },
            { id: 3, name: 'Marta', amount: 350.90 }
        ];
        const res = roundEmployeeAmounts(emps, 'normal');
        assert.equal(res.count, 2);
        assert.equal(res.employees[0].amount, 800);
        assert.equal(res.employees[0].payroll.net, 800);
        assert.equal(res.employees[0].payroll.afterDiscounts, 1000);
        assert.equal(res.employees[1], emps[1]); // untouched reference
        assert.equal(res.employees[2].amount, 350);
    });

    test('nextEmployeeId generates strictly unique IDs even in tight loops', () => {
        const ids = new Set(Array.from({ length: 100 }, () => nextEmployeeId()));
        assert.equal(ids.size, 100);
    });
});

describe('Sprint A financial hardening: integer cents, invariants & bank limits', () => {
    test('handles IEEE-754 tricky decimal coin totals (0.29, 0.30, 0.60, 1.15) with zero drift', () => {
        const { core } = make({
            denominations: USD,
            inventory: { 100: 10, 50: 10, 20: 10, 10: 10, 5: 10, 2: 10, 1: 10, 0.25: 50, 0.10: 50, 0.05: 50, 0.01: 100 },
            employees: [
                { id: 1, name: 'A', amount: 0.29, paid: false },
                { id: 2, name: 'B', amount: 0.30, paid: false },
                { id: 3, name: 'C', amount: 0.60, paid: false },
                { id: 4, name: 'D', amount: 1.15, paid: false }
            ]
        });

        for (const amt of [0.29, 0.30, 0.60, 1.15]) {
            const ideal = core.getIdealBreakdown(amt);
            assert.equal(ideal.remainder, 0, `getIdealBreakdown(${amt}) left remainder ${ideal.remainder}`);
            const sumCents = Object.entries(ideal.distribution).reduce((s, [d, c]) => s + Math.round(Number(d) * 100) * c, 0);
            assert.equal(sumCents, Math.round(amt * 100));
        }

        const { results } = core.calculateDistribution();
        for (const emp of results) {
            assert.equal(emp.status, 'ok', `${emp.name} (${emp.amount}) should be fully covered`);
            assert.equal(emp._missingAmount, 0);
        }

        // Direct single-coin IEEE-754 traps: 0.29/0.01=28.999999999999996, 0.30/0.10=2.9999999999999996,
        // 0.60/0.20=2.9999999999999996, 1.15/0.05=22.999999999999996
        for (const [d, amt, expected] of [[0.01, 0.29, 29], [0.10, 0.30, 3], [0.20, 0.60, 3], [0.05, 1.15, 23]]) {
            const { core: trapCore } = make({ denominations: [d], inventory: { [d]: 100 }, employees: [{ id: 1, name: 'T', amount: amt, paid: false }] });
            assert.deepEqual(trapCore.getIdealBreakdown(amt), { distribution: { [d]: expected }, remainder: 0 });
            const { results: trapRes } = trapCore.calculateDistribution();
            assert.equal(trapRes[0]._missingAmount, 0);
            assert.equal(trapRes[0].distribution[d], expected);
        }

        // Bank cascade with 0.25 capped at 0 must cascade cleanly into 0.10/0.05/0.01 with 0 remainder
        const { core: bankCore } = make({
            denominations: USD,
            bankLimits: { 0.25: 0, 0.10: 0 },
            employees: [{ id: 1, name: 'A', amount: 0.29, paid: false }]
        });
        const bank = bankCore.calculateBankNeeds();
        assert.equal(bank.remainder, 0);
        assert.equal(bank.breakdown[0.05].final, 5);
        assert.equal(bank.breakdown[0.01].final, 4);
    });

    test('negative or NaN bank limits never produce negative withdrawals or NaN totals', () => {
        const { core } = make({
            denominations: DOP,
            bankLimits: { 2000: -5, 1000: Number.NaN, 500: 'bad' },
            employees: [{ id: 1, name: 'Ana', amount: 3500, paid: false }]
        });
        const bank = core.calculateBankNeeds();
        assert.equal(bank.breakdown[2000].final, 0, 'negative limit must clamp to 0');
        assert.equal(bank.breakdown[1000].final, 3, 'NaN limit must behave as unlimited');
        assert.equal(bank.breakdown[500].final, 1, 'non-numeric limit must behave as unlimited');
        assert.equal(bank.remainder, 0);
        for (const row of Object.values(bank.breakdown)) {
            assert.ok(Number.isFinite(row.final) && row.final >= 0);
        }
    });

    test('roundEmployeeAmounts never steals 1.00 from float-noise integer amounts like 99.99999999999999', () => {
        const res = roundEmployeeAmounts([{ id: 1, name: 'Ana', amount: 99.99999999999999 }], 'normal');
        assert.equal(res.count, 0);
        assert.equal(res.employees[0].amount, 99.99999999999999);
    });

    test('parseQuickAddLine never truncates comma-separated salaries like "Juan 4,500" to 4 (Sprint B)', () => {
        const { parseQuickAddLine } = require('../js/SplitXCore.js');
        assert.deepEqual(parseQuickAddLine('Juan 4,500.00'), { name: 'Juan', amountText: '4,500.00' });
        assert.deepEqual(parseQuickAddLine('Juan 4,500'), { name: 'Juan', amountText: '4,500' });
        assert.deepEqual(parseQuickAddLine('Ana-María 500'), { name: 'Ana-María', amountText: '500' });
        assert.equal(parseQuickAddLine('Solo Nombre'), null);
    });

    test('500-case deterministic fuzz invariant: assigned + missing === effectiveAmount to the exact cent', () => {
        let seed = 1337;
        const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

        for (let i = 0; i < 500; i++) {
            const denoms = i % 2 === 0 ? USD : DOP;
            const inv = {};
            denoms.forEach(d => { inv[d] = Math.floor(rand() * 8); });
            const emps = Array.from({ length: 4 }, (_, idx) => ({
                id: idx + 1,
                name: `E${idx}`,
                amount: Math.round(rand() * (denoms === USD ? 12000 : 400000)) / 100,
                paid: idx === 3 && i % 5 === 0
            }));
            const { core } = make({ denominations: denoms, inventory: inv, employees: emps });
            const { results } = core.calculateDistribution();
            for (const emp of results) {
                const assignedCents = Object.entries(emp.distribution).reduce((s, [d, c]) => s + Math.round(Number(d) * 100) * c, 0);
                if (emp.paid) {
                    assert.ok(assignedCents <= Math.round(emp.effectiveAmount * 100));
                } else {
                    const missingCents = Math.round((emp._missingAmount || 0) * 100);
                    assert.equal(assignedCents + missingCents, Math.round(emp.effectiveAmount * 100),
                        `case ${i} emp ${emp.name} amt=${emp.effectiveAmount} assigned=${assignedCents} missing=${missingCents}`);
                }
            }
        }
    });
});
