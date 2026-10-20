/**
 * SheetStudio pure helpers: default templates, table-template validation,
 * signature-sheet pagination, column totals, print page size and chip categories.
 * The DOM editor itself is exercised in the browser; these cover the logic it relies on.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SB = require('../js/SheetBuilder.js');
const SF = require('../js/SplitXSheetFields.js');
const SS = require('../js/SheetStudio.js');

const employees = [
    { name: 'Ana', amount: 9200, employeeNumber: '002', workDays: { total: 10.5 }, payroll: { gross: 10000, bonuses: 500, discounts: 800, afterDiscounts: 9700, loans: 500 } },
    { name: 'Luis', amount: 12000, employeeNumber: '001', workDays: { total: 12 }, payroll: { gross: 12000, bonuses: 0, discounts: 0, afterDiscounts: 12000, loans: 0 } }
];
const set = SF.createFieldSet({ records: employees });
const engine = SB.createEngine({ fields: set.fields, resolveField: set.resolveField, locale: 'en-US' });

describe('default templates', () => {
    test('the envelope card template is valid', () => {
        assert.deepEqual(SB.validateTemplate(SS.defaultCardTemplate()).errors, []);
    });

    test('the signature sheet template is valid', () => {
        assert.deepEqual(SS.validateTableTemplate(SS.defaultTableTemplate()), []);
    });

    test('each call returns a fresh copy', () => {
        const a = SS.defaultCardTemplate();
        a.rows.pop();
        assert.notEqual(SS.defaultCardTemplate().rows.length, a.rows.length);
    });
});

describe('validateTableTemplate', () => {
    test('rejects non-objects and missing columns', () => {
        assert.ok(SS.validateTableTemplate(null).length > 0);
        assert.ok(SS.validateTableTemplate({ type: 'table', title: [], columns: [] }).length > 0);
    });

    test('rejects invalid borders and chips', () => {
        const t = SS.defaultTableTemplate();
        t.columns[0].border = 'thick';
        t.columns[1].cell.chips.push({ kind: 'script' });
        assert.equal(SS.validateTableTemplate(t).length, 2);
    });

    test('rejects a non-positive row height', () => {
        const t = SS.defaultTableTemplate();
        t.options.rowHeight = 0;
        assert.equal(SS.validateTableTemplate(t).length, 1);
    });
});

describe('tablePageGeometry', () => {
    test('landscape letter swaps the paper and fits rows by height', () => {
        const t = SS.defaultTableTemplate();
        const g = SS.tablePageGeometry(t, false);
        assert.equal(g.pageWidth, 279.4);
        assert.equal(g.pageHeight, 215.9);
        assert.ok(g.rowsPerPage >= 8 && g.rowsPerPage <= 14, `rowsPerPage=${g.rowsPerPage}`);
    });

    test('taller rows and a logo leave fewer rows per page', () => {
        const t = SS.defaultTableTemplate();
        const base = SS.tablePageGeometry(t, false).rowsPerPage;
        t.options.rowHeight = 20;
        assert.ok(SS.tablePageGeometry(t, true).rowsPerPage < base);
    });

    test('always at least one row per page', () => {
        const t = SS.defaultTableTemplate();
        t.options.rowHeight = 30;
        t.layout.margin = 40;
        assert.equal(SS.tablePageGeometry(t, true).rowsPerPage >= 1, true);
    });
});

describe('columnTotals', () => {
    test('sums only the columns marked to sum', () => {
        const t = SS.defaultTableTemplate();
        const items = engine.sortRecords(employees, t.sortBy);
        const totals = SS.columnTotals(engine, t, items);
        const byHeader = Object.fromEntries(t.columns.map((c, i) => [c.header, totals[i]]));
        assert.equal(byHeader['Días'], 22.5);
        assert.equal(byHeader['Monto entregado'], 21700);
        assert.equal(byHeader['Nombre'], null);
    });
});

describe('sorting by employee number', () => {
    test('the default table sorts by No.', () => {
        const t = SS.defaultTableTemplate();
        const names = engine.sortRecords(employees, t.sortBy).map((x) => x.record.name);
        assert.deepEqual(names, ['Luis', 'Ana']);
    });
});

describe('printPageRule', () => {
    test('portrait and landscape page sizes', () => {
        assert.equal(SS.printPageRule('letter', 'portrait'), '@page { size: 215.9mm 279.4mm; margin: 0; }');
        assert.equal(SS.printPageRule('a4', 'landscape'), '@page { size: 297mm 210mm; margin: 0; }');
    });
});

describe('catOf', () => {
    test('money categories drive the green / red / amber colors', () => {
        assert.equal(SS.catOf('bonuses'), 'bonus');
        assert.equal(SS.catOf('bonus:asistencia'), 'bonus');
        assert.equal(SS.catOf('discounts'), 'deduction');
        assert.equal(SS.catOf('deduction:ley'), 'deduction');
        assert.equal(SS.catOf('loans'), 'loan');
        assert.equal(SS.catOf('loan:adelanto_de_salario'), 'loan');
        assert.equal(SS.catOf('loanBalanceAfter'), 'loan');
        assert.equal(SS.catOf('gross'), 'field');
    });
});
