/**
 * SplitXImport: normalization of imported employees (JSON / bridge payloads).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createImporter } = require('../js/SplitXImport.js');
const SheetFields = require('../js/SplitXSheetFields.js');

const parseNumber = (s) => parseFloat(String(s).replace(/,/g, ''));
const { normalizeImportedEmployee: normalize, hasPayrollFields } = createImporter({ sheetFields: SheetFields, parseNumber });

describe('normalizeImportedEmployee: basics', () => {
    test('simple employee keeps name and amount and has no payroll', () => {
        const e = normalize({ nombre: 'Ana', monto: 500 }, 0);
        assert.equal(e.name, 'Ana');
        assert.equal(e.amount, 500);
        assert.equal(e.payroll, undefined);
    });

    test('computes net from gross + bonuses - discounts - loans', () => {
        const e = normalize({ nombre: 'Ana', bruto: 1000, bonificaciones: 100, descuentos: 50, prestamos: 200 }, 0);
        assert.equal(e.amount, 850);
        assert.equal(e.payroll.reconciled, true);
    });

    test('flags an amount that does not reconcile with the payroll math', () => {
        const e = normalize({ nombre: 'Ana', bruto: 1000, monto: 900 }, 0);
        assert.equal(e.payroll.reconciled, false);
        assert.equal(e.payroll.difference, -100);
    });

    test('rejects missing names and negative amounts', () => {
        assert.throws(() => normalize({ monto: 5 }, 0), /Elemento #1: Falta nombre/);
        assert.throws(() => normalize({ nombre: 'X', monto: -5 }, 2), /Elemento #3: Monto inválido/);
    });

    test('non-object items fail with a clear message instead of a TypeError', () => {
        for (const bad of [null, 42, 'texto', [1]]) {
            assert.throws(() => normalize(bad, 1), /Elemento #2: .*objeto/i);
        }
    });
});

describe('sa-splitx-payroll/v1 concept details', () => {
    const item = {
        employeeNumber: 'E-001',
        employeeName: 'Ana Pérez',
        nombre: 'Ana Pérez',
        bruto: 1000,
        bonusDetails: [{ id: 'b1', concept: 'Bono', amount: 100 }],
        deductionDetails: [{ id: 'd1', concept: 'AFP', amount: 50 }],
        loanBreakdown: [
            { loanId: 'L1', concept: 'Adelanto', deductionAmount: 120, principalAmount: 100, interestAmount: 20, balanceBefore: 600, projectedBalanceAfter: 500 },
            { loanId: 'L2', concept: 'Préstamo', deductionAmount: 80, principalAmount: 60, interestAmount: 20, balanceBefore: 400, projectedBalanceAfter: 320 }
        ],
        loanSummary: { balanceBefore: 1000, deductionAmount: 200, projectedBalanceAfter: 820 }
    };

    test('totals are derived from the concept lists', () => {
        const e = normalize(item, 0);
        assert.equal(e.payroll.bonuses, 100);
        assert.equal(e.payroll.discounts, 50);
        assert.equal(e.payroll.loans, 200);
        assert.equal(e.amount, 850);
        assert.equal(e.employeeNumber, 'E-001');
    });

    test('loan principal, interest and remaining balance come from loanBreakdown/loanSummary', () => {
        const { loanDetails } = normalize(item, 0).payroll;
        assert.equal(loanDetails.principal, 160);
        assert.equal(loanDetails.interestAmount, 40);
        assert.equal(loanDetails.interestRate, 25);
        assert.equal(loanDetails.remainingBalance, 820);
    });

    test('remaining balance falls back to the sum of per-loan balances when there is no summary', () => {
        const { loanSummary, ...noSummary } = item;
        assert.equal(normalize(noSummary, 0).payroll.loanDetails.remainingBalance, 820);
    });

    test('explicit loan fields win over derived ones', () => {
        const e = normalize({ ...item, prestamoCapital: 190, prestamoInteres: 10, saldoPendiente: 5 }, 0);
        assert.equal(e.payroll.loanDetails.principal, 190);
        assert.equal(e.payroll.loanDetails.interestAmount, 10);
        assert.equal(e.payroll.loanDetails.remainingBalance, 5);
    });

    test('empty concept lists do not turn a plain employee into a payroll employee', () => {
        assert.equal(hasPayrollFields({ nombre: 'X', monto: 300, loanBreakdown: [], bonusDetails: [], deductionDetails: [] }), false);
        const e = normalize({ nombre: 'X', monto: 300, loanBreakdown: [], bonusDetails: [] }, 0);
        assert.equal(e.payroll, undefined);
        assert.equal(e.amount, 300);
    });

    test('a non-empty concept list does count as payroll data', () => {
        assert.equal(hasPayrollFields({ nombre: 'X', bonusDetails: [{ id: 'a', concept: 'c', amount: 1 }] }), true);
    });
});
