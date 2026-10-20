/**
 * SplitX ↔ SheetBuilder adapter tests: preserving the "sa-splitx-payroll/v1" export extras
 * on import and exposing them (plus dynamic bonus/deduction concepts) as template fields.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SB = require('../js/SheetBuilder.js');
const SF = require('../js/SplitXSheetFields.js');

const sampleItem = () => ({
    id: 1,
    nombre: 'Ana Ejemplo (Ref #001)',
    monto: 9700,
    bruto: 10000,
    bonificaciones: 500,
    descuentos: 800,
    prestamos: 0,
    sourceEmployeeId: 'EMP-DEMO-1',
    employeeNumber: '001',
    employeeName: 'Ana Ejemplo',
    workDays: { unit: 'equivalent-day', regular: 10, overtime: 0, holiday: 0, restDay: 0, total: 10 },
    positions: [{ id: 'PUESTO-DEMO', name: 'Albañil', leaderId: 'LIDER-DEMO', workDays: { total: 10 } }],
    leaders: [{ id: 'LIDER-DEMO', name: 'Líder de ejemplo', number: '10' }],
    bonusDetails: [
        { id: 'asistencia', concept: 'Bono de asistencia', type: 'fixed', value: 500, amount: 500, signedAmount: 500 }
    ],
    deductionDetails: [
        { id: 'ley', concept: 'Descuento de ley', type: 'percentage', value: 3, amount: 300, signedAmount: -300, baseAmount: 10000 },
        { id: 'equipo', concept: 'Reparación de equipo', type: 'fixed', value: 500, amount: 500, signedAmount: -500 }
    ],
    exportContext: {
        schema: 'sa-splitx-payroll/v1',
        period: { start: '2026-10-01', end: '2026-10-15' },
        currency: 'DOP',
        projectName: 'Obra Centro',
        totals: { employeeCount: 1, net: 9700 },
        companyName: 'Constructora Ejemplo',
        payrollName: 'Nómina período 01/10/2026 - 15/10/2026'
    }
});

// What SplitX's normalizeImportedEmployee produces, plus the preserved extras.
const toEmployee = (item) => ({
    id: item.id,
    name: item.nombre,
    amount: item.monto,
    payroll: {
        gross: item.bruto,
        bonuses: item.bonificaciones,
        discounts: item.descuentos,
        afterDiscounts: item.bruto + item.bonificaciones - item.descuentos,
        loans: item.prestamos,
        loanDetails: null
    },
    ...SF.pickImportExtras(item)
});

describe('pickImportExtras', () => {
    test('keeps identity, work days, positions, leaders and concept details', () => {
        const extras = SF.pickImportExtras(sampleItem());
        assert.equal(extras.employeeNumber, '001');
        assert.equal(extras.employeeName, 'Ana Ejemplo');
        assert.equal(extras.sourceEmployeeId, 'EMP-DEMO-1');
        assert.equal(extras.workDays.total, 10);
        assert.deepEqual(extras.positions, [{ id: 'PUESTO-DEMO', name: 'Albañil', days: 10 }]);
        assert.deepEqual(extras.leaders, [{ id: 'LIDER-DEMO', name: 'Líder de ejemplo', number: '10' }]);
        assert.deepEqual(extras.deductionDetails[0], { id: 'ley', concept: 'Descuento de ley', type: 'percentage', value: 3, amount: 300 });
    });

    test('keeps the export context but drops the stale totals', () => {
        const { exportContext } = SF.pickImportExtras(sampleItem());
        assert.equal(exportContext.companyName, 'Constructora Ejemplo');
        assert.deepEqual(exportContext.period, { start: '2026-10-01', end: '2026-10-15' });
        assert.equal(exportContext.totals, undefined);
    });

    test('returns nothing for a plain legacy item', () => {
        assert.deepEqual(SF.pickImportExtras({ nombre: 'X', monto: 5 }), {});
    });

    test('derives a stable id from the concept when the id is missing', () => {
        const { deductionDetails } = SF.pickImportExtras({ deductionDetails: [{ concept: 'Pérdida de Equipo', amount: 50 }] });
        assert.equal(deductionDetails[0].id, 'perdida_de_equipo');
    });

    test('ignores malformed detail entries', () => {
        const { bonusDetails } = SF.pickImportExtras({ bonusDetails: [null, 'x', { concept: '', amount: 1 }, { id: 'ok', amount: '20' }] });
        assert.deepEqual(bonusDetails, [{ id: 'ok', concept: 'ok', type: 'fixed', value: 20, amount: 20 }]);
    });
});

describe('sumDetailAmounts', () => {
    test('adds amounts, or returns undefined when there are no details', () => {
        assert.equal(SF.sumDetailAmounts(sampleItem().deductionDetails), 800);
        assert.equal(SF.sumDetailAmounts(undefined), undefined);
    });
});

describe('Field set', () => {
    const emp = toEmployee(sampleItem());
    const set = SF.createFieldSet({ records: [emp] });
    const engine = SB.createEngine({ fields: set.fields, resolveField: set.resolveField, locale: 'en-US' });
    const value = (key) => engine.evaluateCell({ mode: 'text', chips: [{ kind: 'field', key }] }, emp, { index: 4 }, null).text;
    const label = (key) => engine.evaluateCell({ mode: 'text', chips: [{ kind: 'field', key, as: 'label' }] }, emp, { index: 4 }, null).text;

    test('identity fields prefer the export data', () => {
        assert.equal(value('no'), '001');
        assert.equal(value('name'), 'Ana Ejemplo');
        assert.equal(value('firstName'), 'Ana');
    });

    test('No. falls back to list position', () => {
        const legacy = { name: 'Luis Gil', amount: 100 };
        assert.equal(engine.evaluateCell({ mode: 'text', chips: [{ kind: 'field', key: 'no' }] }, legacy, { index: 4 }, null).text, '5');
    });

    test('money and work-day fields', () => {
        assert.equal(value('net'), '9,700.00');
        assert.equal(value('gross'), '10,000.00');
        assert.equal(value('loans'), '0.00');
        assert.equal(label('loans'), 'Préstamo/Adelanto');
        assert.equal(value('days'), '10');
        assert.equal(value('dailyRate'), '1,000.00');
    });

    test('context fields for sheet headers', () => {
        assert.equal(value('company'), 'Constructora Ejemplo');
        assert.equal(value('period'), '01/10/2026 - 15/10/2026');
        assert.equal(value('position'), 'Albañil');
        assert.equal(value('leader'), 'Líder de ejemplo');
    });

    test('dynamic concept fields use the concept as label and the amount as value', () => {
        assert.equal(label('deduction:equipo'), 'Reparación de equipo');
        assert.equal(value('deduction:equipo'), '500.00');
        assert.equal(value('bonus:asistencia'), '500.00');
    });

    test('a concept the employee does not have is empty (0)', () => {
        const other = toEmployee({ ...sampleItem(), deductionDetails: [] });
        const r = engine.evaluateRows([{ whenEmpty: 'hide', cells: [{ mode: 'number', chips: [{ kind: 'field', key: 'deduction:equipo' }] }] }], other, { index: 0 });
        assert.equal(r[0].hidden, true);
    });

    test('concepts unknown to the catalog fall back to their id as label', () => {
        assert.equal(label('deduction:no_existe'), 'no_existe');
    });

    test('daily rate is empty when days are unknown', () => {
        const legacy = { name: 'X', amount: 100, payroll: { gross: 100 } };
        assert.equal(engine.evaluateCell({ mode: 'text', chips: [{ kind: 'field', key: 'dailyRate' }] }, legacy, { index: 0 }, null).text, '0.00');
    });

    test('getNetAmount lets the host decide the effective net', () => {
        const custom = SF.createFieldSet({ records: [emp], getNetAmount: () => 1234 });
        const e2 = SB.createEngine({ fields: custom.fields, locale: 'en-US' });
        assert.equal(e2.evaluateCell({ mode: 'number', chips: [{ kind: 'field', key: 'net' }] }, emp, { index: 0 }, null).value, 1234);
    });

    test('listConcepts exposes imported concepts for the chip palette', () => {
        assert.deepEqual(set.listConcepts().map((c) => [c.key, c.label]), [
            ['bonus:asistencia', 'Bono de asistencia'],
            ['deduction:ley', 'Descuento de ley'],
            ['deduction:equipo', 'Reparación de equipo']
        ]);
    });
});

describe('Non-monetary fields', () => {
    test('day and balance fields are flagged noTotal so they never start the running total', () => {
        const { fields } = SF.createFieldSet();
        const flagged = fields.filter((f) => f.noTotal).map((f) => f.key);
        assert.deepEqual(flagged, ['loanBalance', 'loanBalanceBefore', 'loanBalanceAfter', 'days', 'daysRegular', 'daysOvertime', 'daysHoliday', 'daysRest', 'dailyRate']);
    });
});

describe('Export v1 loans and position rates', () => {
    const loanItem = () => ({
        ...sampleItem(),
        monto: 9200,
        prestamos: 500,
        positions: [{ id: 'PUESTO-DEMO', name: 'Albañil', workDays: { total: 10 }, dailyRate: 1000 }],
        loanBreakdown: [{
            loanId: 'PRESTAMO-DEMO', concept: 'Adelanto de salario', status: 'proposed',
            balanceBefore: 3000, deductionAmount: 500, principalAmount: 500, interestAmount: 0,
            projectedBalanceAfter: 2500, currentBalance: 3000
        }],
        loanSummary: {
            scope: 'selected-loans', projectionAvailable: true, balanceBefore: 3000, deductionAmount: 500,
            principalAmount: 500, interestAmount: 0, projectedBalanceAfter: 2500,
            totalOutstandingBalance: 3000, projectedTotalOutstandingBalance: 2500
        }
    });
    const toLoanEmployee = (item) => ({ ...toEmployee(item), payroll: { ...toEmployee(item).payroll, loans: item.prestamos } });

    test('pickImportExtras keeps loan items, the loan summary and position daily rates', () => {
        const x = SF.pickImportExtras(loanItem());
        assert.deepEqual(x.positions, [{ id: 'PUESTO-DEMO', name: 'Albañil', days: 10, dailyRate: 1000 }]);
        assert.deepEqual(x.loanItems, [{
            id: 'PRESTAMO-DEMO', concept: 'Adelanto de salario', status: 'proposed', amount: 500,
            principal: 500, interest: 0, balanceBefore: 3000, balanceAfter: 2500
        }]);
        assert.deepEqual(x.loanSummary, { balanceBefore: 3000, amount: 500, balanceAfter: 2500, totalOutstanding: 3000, totalOutstandingAfter: 2500 });
    });

    test('sumLoanAmounts adds deduction amounts', () => {
        assert.equal(SF.sumLoanAmounts(loanItem().loanBreakdown), 500);
        assert.equal(SF.sumLoanAmounts(undefined), undefined);
    });

    const emp = toLoanEmployee(loanItem());
    const set = SF.createFieldSet({ records: [emp] });
    const engine = SB.createEngine({ fields: set.fields, resolveField: set.resolveField, locale: 'en-US' });
    const value = (key, r = emp) => engine.evaluateCell({ mode: 'text', chips: [{ kind: 'field', key }] }, r, { index: 0 }, null).text;
    const label = (key) => engine.evaluateCell({ mode: 'text', chips: [{ kind: 'field', key, as: 'label' }] }, emp, { index: 0 }, null).text;

    test('daily rate comes from the position rate when the export sends it', () => {
        const odd = toLoanEmployee({ ...loanItem(), bruto: 10450 });
        assert.equal(value('dailyRate', odd), '1,000.00');
    });

    test('several positions give a day-weighted daily rate', () => {
        const multi = toLoanEmployee({ ...loanItem(), positions: [
            { id: 'a', name: 'Albañil', workDays: { total: 6 }, dailyRate: 1000 },
            { id: 'b', name: 'Maestro', workDays: { total: 4 }, dailyRate: 1500 }
        ] });
        assert.equal(value('dailyRate', multi), '1,200.00');
        assert.equal(value('position', multi), 'Albañil, Maestro');
    });

    test('balance before and after this payment', () => {
        assert.equal(label('loanBalanceBefore'), 'Saldo antes del pago');
        assert.equal(value('loanBalanceBefore'), '3,000.00');
        assert.equal(value('loanBalanceAfter'), '2,500.00');
    });

    test('each loan becomes a dynamic loan:<id> field labelled with its concept', () => {
        assert.equal(label('loan:PRESTAMO-DEMO'), 'Adelanto de salario');
        assert.equal(value('loan:PRESTAMO-DEMO'), '500.00');
        assert.ok(set.listConcepts().some((c) => c.key === 'loan:PRESTAMO-DEMO'));
    });

    test('loan balance fields are not monetary totals', () => {
        const flagged = set.fields.filter((f) => f.noTotal).map((f) => f.key);
        assert.ok(flagged.includes('loanBalanceBefore') && flagged.includes('loanBalanceAfter'));
    });
});
