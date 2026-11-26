const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SplitXConfigUI = require('../js/SplitXConfigUI.js');
const SplitXEditModal = require('../js/SplitXEditModal.js');

describe('SplitXEditModal pure payroll & loan calculations (#28)', () => {
    test('computePayrollAdjustment calculates fixed and percent adjustments with 2-decimal precision', () => {
        const res = SplitXEditModal.computePayrollAdjustment({
            gross: 10000,
            bonusType: 'percent',
            bonusVal: 5.5,
            discountType: 'percent',
            discountVal: 3.04,
            loans: 500,
            net: 9746
        });
        assert.equal(res.bonuses, 550);
        assert.equal(res.discounts, 304);
        assert.equal(res.afterDiscounts, 10246);
        assert.equal(res.calculatedNet, 9746);
        assert.equal(res.difference, 0);
        assert.equal(res.reconciled, true);
    });

    test('computePayrollAdjustment flags manual net discrepancy beyond 0.01', () => {
        const res = SplitXEditModal.computePayrollAdjustment({
            gross: 5000,
            bonusType: 'fixed',
            bonusVal: 200,
            discountType: 'fixed',
            discountVal: 100,
            loans: 0,
            net: 5200
        });
        assert.equal(res.calculatedNet, 5100);
        assert.equal(res.difference, 100);
        assert.equal(res.reconciled, false);
    });

    test('computeLoanInstallment computes interest from rate and total installment', () => {
        const res = SplitXEditModal.computeLoanInstallment({ principal: 1000, rate: 12.5 });
        assert.equal(res.interest, 125);
        assert.equal(res.totalCuota, 1125);
    });

    test('hasPayrollChanged detects real edits and ignores floating-point noise', () => {
        const orig = { name: 'Ana', amount: 1000, payroll: { gross: 1200, bonuses: 0, discounts: 100, loans: 100 } };
        assert.equal(SplitXEditModal.hasPayrollChanged(orig, { name: 'Ana', net: 1000.0001, gross: 1200, bonuses: 0, discounts: 100, loans: 100 }), false);
        assert.equal(SplitXEditModal.hasPayrollChanged(orig, { name: 'Ana M.', net: 1000, gross: 1200, bonuses: 0, discounts: 100, loans: 100 }), true);
        assert.equal(SplitXEditModal.hasPayrollChanged(orig, { name: 'Ana', net: 950, gross: 1200, bonuses: 0, discounts: 100, loans: 150 }), true);
    });

    test('computePayrollAdjustment clamps negative calculatedNet to 0.00 and exposes uncollectedExcess (Sprint A)', () => {
        const res = SplitXEditModal.computePayrollAdjustment({
            gross: 1000,
            bonusType: 'fixed',
            bonusVal: 0,
            discountType: 'fixed',
            discountVal: 300,
            loans: 900
        });
        assert.equal(res.calculatedNet, 0);
        assert.equal(res.uncollectedExcess, 200);
        assert.equal(res.net, 0);
    });

    test('openEditModal preserves manual unreconciled net and saveEmployeeModal rejects negative or >2 decimal values', () => {
        const elements = new Map();
        const mk = (id) => {
            const classes = new Set();
            const el = {
                id,
                value: '',
                textContent: '',
                innerHTML: '',
                className: '',
                focus: () => {},
                classList: {
                    add: (c) => classes.add(c),
                    remove: (c) => classes.delete(c),
                    toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
                    contains: (c) => classes.has(c)
                }
            };
            elements.set(id, el);
            return el;
        };
        [
            'editEmpId', 'editEmpName', 'editModalTitle', 'editModalSubtitle', 'editModalBadge',
            'revertEmpBtn', 'editEmpGross', 'editEmpBonus', 'editEmpDiscount', 'editEmpLoans',
            'editEmpNet', 'editEmpLoanPrincipal', 'editEmpLoanInterestRate', 'editEmpLoanInterestAmount',
            'editEmpLoanRemainingBalance', 'loanDetailsExpanded', 'toggleLoanDetailsText',
            'bonusTypeFixed', 'bonusTypePercent', 'bonusSymbol', 'discountTypeFixed', 'discountTypePercent',
            'discountSymbol', 'bonusCalcDisplay', 'discountCalcDisplay', 'calcFormulaNet',
            'editModalReconciledStatus', 'editModalBreakdownTotal', 'editModalBreakdownChips', 'editEmployeeModal'
        ].forEach(mk);

        const prevDoc = globalThis.document;
        globalThis.document = /** @type {any} */ ({ getElementById: (id) => elements.get(id) || null });
        try {
            const toasts = [];
            let saved = 0;
            const state = {
                denominations: [1000, 500, 100],
                employees: [{
                    id: 10,
                    name: 'Ana',
                    amount: 8500,
                    payroll: { gross: 10000, bonuses: 0, discounts: 500, loans: 500, afterDiscounts: 9500, calculatedNet: 9000, net: 8500 }
                }]
            };
            const modal = SplitXEditModal.createEditModal({
                getState: () => state,
                saveData: () => { saved++; },
                fmt: (n) => `RD$ ${Number(n).toFixed(2)}`,
                getCurrencySymbol: () => 'RD$',
                escapeHTML: (s) => String(s),
                isCoin: () => false,
                getBillStyle: () => '',
                getBillImage: () => null,
                getIdealBreakdown: () => ({ distribution: {} }),
                showToast: (m) => toasts.push(m),
                showCustomConfirm: async () => true
            });

            modal.openEditModal(10);
            assert.equal(String(elements.get('editEmpNet').value), '8500', 'openEditModal must not overwrite manual net 8500 with calculatedNet 9000');

            // Negative net must be rejected
            elements.get('editEmpNet').value = '-100';
            modal.saveEmployeeModal();
            assert.equal(saved, 0);
            assert.equal(state.employees[0].amount, 8500);

            // >2 decimal net must be rejected
            elements.get('editEmpNet').value = '8500.125';
            modal.saveEmployeeModal();
            assert.equal(saved, 0);

            // Valid name-only edit preserves 8500
            elements.get('editEmpNet').value = '8500';
            elements.get('editEmpName').value = 'Ana María';
            modal.saveEmployeeModal();
            assert.equal(saved, 1);
            assert.equal(state.employees[0].name, 'Ana María');
            assert.equal(state.employees[0].amount, 8500);
        } finally {
            globalThis.document = prevDoc;
        }
    });
});

describe('SplitXConfigUI state actions (#28)', () => {
    test('updateBillColor sanitizes hex color and persists; resetBillColor and clearBillImage mutate cleanly', () => {
        let saved = 0;
        const state = { billColors: {}, billImages: { 1000: 'data:image/png;base64,AA==' }, breakdownFormat: 'badge' };
        const ui = SplitXConfigUI.createConfigUI({
            getState: () => state,
            saveData: () => { saved++; },
            CURRENCY_PRESETS: {},
            BILL_COLORS: {},
            isCoin: () => false,
            escapeHTML: (s) => String(s),
            sanitizeHexColor: (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : ''),
            getBillImage: () => null,
            getBillStyle: () => '',
            getCurrencySymbol: () => 'RD$',
            createCardEl: () => null,
            showToast: () => {},
            showCustomConfirm: async () => true
        });

        ui.updateBillColor(1000, 'not-a-color');
        assert.equal(saved, 0);
        assert.equal(state.billColors[1000], undefined);

        ui.updateBillColor(1000, '#10b981');
        assert.equal(saved, 1);
        assert.equal(state.billColors[1000], '#10b981');

        ui.resetBillColor(1000);
        assert.equal(state.billColors[1000], undefined);

        ui.clearBillImage(1000);
        assert.equal(state.billImages[1000], undefined);

        ui.setBreakdownFormat('qty_x_denom');
        assert.equal(state.breakdownFormat, 'qty_x_denom');
    });
});
