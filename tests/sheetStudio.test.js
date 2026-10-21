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

describe('tableOptions', () => {
    test('old boolean signatures map to "all" / "none"', () => {
        assert.equal(SS.tableOptions({ signatures: true }).signatures, 'all');
        assert.equal(SS.tableOptions({ signatures: false }).signatures, 'none');
    });

    test('fills defaults for the footer labels and the signature line', () => {
        const o = SS.tableOptions({ rowHeight: 9 });
        assert.deepEqual(o.signLabels, ['Entregado por', 'Revisado por']);
        assert.equal(o.signLine, 'low');
        assert.equal(o.rowHeight, 9);
        assert.equal(o.totals, false);
    });

    test('keeps valid choices and drops unknown ones', () => {
        const o = SS.tableOptions({ signatures: 'last', signLine: 'divider', signLabels: ['Pagado por', ''] });
        assert.equal(o.signatures, 'last');
        assert.equal(o.signLine, 'divider');
        assert.deepEqual(o.signLabels, ['Pagado por']);
        assert.equal(SS.tableOptions({ signLine: 'diagonal' }).signLine, 'low');
    });

    test('the default template validates with the new options', () => {
        const t = SS.defaultTableTemplate();
        t.options.signatures = 'first';
        t.options.signLine = 'middle';
        assert.deepEqual(SS.validateTableTemplate(t), []);
        t.options.signatures = 'sometimes';
        assert.equal(SS.validateTableTemplate(t).length, 1);
    });
});

describe('logo style', () => {
    test('tableOptions keeps a valid logo style and defaults to color', () => {
        assert.equal(SS.tableOptions({}).logoStyle, 'color');
        assert.equal(SS.tableOptions({ logoStyle: 'bw' }).logoStyle, 'bw');
        assert.equal(SS.tableOptions({ logoStyle: 'sepia' }).logoStyle, 'color');
    });

    test('logoFilter maps each style to a CSS filter', () => {
        assert.equal(SS.logoFilter('color'), 'none');
        assert.equal(SS.logoFilter('bw'), 'grayscale(1) contrast(1.2)');
        assert.equal(SS.logoFilter('invert'), 'grayscale(1) contrast(1.2) invert(1)');
        assert.equal(SS.logoFilter(undefined), 'none');
    });
});

describe('tablePageSizes', () => {
    const fit = (over) => {
        const t = SS.defaultTableTemplate();
        Object.assign(t.options, over);
        return t;
    };

    test('no rows still prints one page', () => {
        assert.deepEqual(SS.tablePageSizes(fit({}), false, 0), [0]);
    });

    test('every page holds the same rows when nothing is reserved', () => {
        const t = fit({ totals: false, signatures: 'none' });
        const cap = SS.tablePageGeometry(t, false).rowsPerPage;
        assert.deepEqual(SS.tablePageSizes(t, false, cap * 2 + 1), [cap, cap, 1]);
    });

    test('footer only on the last page leaves full earlier pages', () => {
        const none = SS.tablePageSizes(fit({ totals: false, signatures: 'none' }), false, 40);
        const last = SS.tablePageSizes(fit({ totals: false, signatures: 'last' }), false, 40);
        const all = SS.tablePageSizes(fit({ totals: false, signatures: 'all' }), false, 40);
        assert.equal(last[0], none[0]);
        assert.ok(all[0] < none[0]);
        for (const sizes of [none, last, all]) assert.equal(sizes.reduce((a, b) => a + b, 0), 40);
    });

    test('footer only on the first page shortens just that page', () => {
        const t = fit({ totals: false, signatures: 'first' });
        const sizes = SS.tablePageSizes(t, false, 40);
        const cap = SS.tablePageGeometry(t, false).rowsPerPage;
        assert.ok(sizes[0] < cap);
        assert.equal(sizes[1], Math.min(cap, 40 - sizes[0]));
    });

    test('the last page keeps room for the totals and the footer', () => {
        const t = fit({ totals: true, signatures: 'last' });
        const cap = SS.tablePageGeometry(t, false).rowsPerPage;
        const sizes = SS.tablePageSizes(t, false, cap);
        assert.ok(sizes.length === 2 && sizes[1] >= 1, `sizes=${sizes}`);
        assert.equal(sizes[0] + sizes[1], cap);
    });

    test('footerOnPage follows the chosen pages', () => {
        assert.equal(SS.footerOnPage('all', 1, 3), true);
        assert.equal(SS.footerOnPage('first', 0, 3), true);
        assert.equal(SS.footerOnPage('first', 2, 3), false);
        assert.equal(SS.footerOnPage('last', 2, 3), true);
        assert.equal(SS.footerOnPage('last', 0, 3), false);
        assert.equal(SS.footerOnPage('none', 0, 1), false);
    });
});

describe('resizeColumns', () => {
    test('moves width between two neighbours and keeps the total', () => {
        const w = SS.resizeColumns([1, 2, 1], 0, 0.5);
        assert.deepEqual(w, [1.5, 1.5, 1]);
    });

    test('never shrinks a column below the minimum', () => {
        const w = SS.resizeColumns([1, 1], 0, 5);
        assert.deepEqual(w, [1.8, 0.2]);
        assert.deepEqual(SS.resizeColumns([1, 1], 0, -5), [0.2, 1.8]);
    });
});

describe('cardTotals (reconcile with SplitX)', () => {
    test('the default card matches the SplitX net', () => {
        const t = SS.defaultCardTemplate();
        const items = engine.sortRecords(employees, t.sortBy);
        const r = SS.cardTotals(engine, t, items, (e) => e.amount);
        assert.deepEqual(r.map((x) => [x.record.name, x.card, x.net, x.ok]), [['Luis', 12000, 12000, true], ['Ana', 9200, 9200, true]]);
    });

    test('flags a card whose total differs', () => {
        const t = SS.defaultCardTemplate();
        const items = engine.sortRecords(employees, t.sortBy);
        const r = SS.cardTotals(engine, t, items, (e) => (e.name === 'Ana' ? 9000 : e.amount));
        const ana = r.find((x) => x.record.name === 'Ana');
        assert.equal(ana.ok, false);
        assert.equal(ana.diff, 200);
    });

    test('a card without a running total cannot be checked', () => {
        const t = SS.defaultCardTemplate();
        t.rows = t.rows.filter((row) => !row.cells.some((c) => c.chips.some((ch) => ch.kind === 'running')));
        assert.equal(SS.cardTotals(engine, t, engine.sortRecords(employees, t.sortBy), (e) => e.amount), null);
    });
});

describe('doubleCounted', () => {
    test('a total field plus one of its concepts is flagged', () => {
        const t = SS.defaultCardTemplate();
        t.rows.push({ cells: [{ mode: 'text', chips: [{ kind: 'field', key: 'deduction:ley', as: 'label' }] }, { mode: 'number', chips: [{ kind: 'op', op: '-' }, { kind: 'field', key: 'deduction:ley' }] }] });
        const d = SS.doubleCounted(t);
        assert.deepEqual(d.map((x) => [x.total, x.concepts]), [['discounts', ['deduction:ley']]]);
    });

    test('labels alone do not count, nor a clean template', () => {
        const t = SS.defaultCardTemplate();
        assert.deepEqual(SS.doubleCounted(t), []);
        t.rows.push({ cells: [{ mode: 'text', chips: [{ kind: 'field', key: 'bonus:x', as: 'label' }] }] });
        assert.deepEqual(SS.doubleCounted(t), []);
    });
});

describe('breakDownRow', () => {
    test('replaces the total row by one row per concept, keeping existing ones', () => {
        const t = SS.defaultCardTemplate();
        const at = t.rows.findIndex((r) => r.cells.some((c) => c.chips.some((ch) => ch.key === 'discounts' && ch.as !== 'label')));
        t.rows.push({ cells: [{ mode: 'text', chips: [] }, { mode: 'number', chips: [{ kind: 'op', op: '-' }, { kind: 'field', key: 'deduction:ley' }] }] });
        const out = SS.breakDownRow(t, 'discounts', ['deduction:ley', 'deduction:equipo'], () => ({ type: 'number' }));
        const keys = out.rows.map((r) => r.cells.flatMap((c) => c.chips.filter((ch) => ch.kind === 'field' && ch.as !== 'label').map((ch) => ch.key)).join(','));
        assert.ok(!keys.includes('discounts'));
        assert.equal(keys[at], 'deduction:equipo');
        assert.equal(keys.filter((k) => k === 'deduction:ley').length, 1);
        assert.equal(out.rows[at].whenEmpty, 'hide');
    });
});

describe('print snapshot', () => {
    test('detects changed and missing employees', () => {
        const t = SS.defaultCardTemplate();
        const items = engine.sortRecords(employees, t.sortBy);
        const snap = SS.printSignatures(engine, t, items, (e) => e.employeeNumber);
        const changed = employees.map((e) => (e.name === 'Ana' ? { ...e, payroll: { ...e.payroll, gross: 11000 } } : e)).slice(0, 1).concat([]);
        const now = SS.printSignatures(engine, t, engine.sortRecords(changed, t.sortBy), (e) => e.employeeNumber);
        const d = SS.snapshotDiff(snap, now);
        assert.deepEqual(d, { changed: ['Ana'], missing: ['Luis'] });
        assert.deepEqual(SS.snapshotDiff(snap, snap), { changed: [], missing: [] });
    });
});

describe('folio in the default templates', () => {
    test('both default sheets carry the folio', () => {
        const has = (cells) => cells.some((c) => c.chips.some((ch) => ch.key === 'folio'));
        assert.ok(SS.defaultCardTemplate().rows.some((r) => has(r.cells)));
        assert.ok(has(SS.defaultTableTemplate().columns.map((c) => c.cell)));
    });
});

describe('migrateStore keeps the new per-user settings', () => {
    test('last print options, printed snapshots and the tour flag survive', () => {
        const printed = { A: { at: '2026-10-20T10:00:00Z', template: SS.defaultCardTemplate(), sigs: { 1: { name: 'Ana', sig: 'x' } } } };
        const out = SS.migrateStore({ printOpts: { mode: 'unpaid', copies: 2, ids: [1] }, printed, tourDone: true, ready: { A: true } });
        assert.deepEqual(out.printOpts, { mode: 'unpaid', copies: 2, ids: [1] });
        assert.equal(out.printed.A.sigs[1].name, 'Ana');
        assert.equal(out.tourDone, true);
        assert.deepEqual(out.ready, { A: true, B: false });
    });

    test('bad values fall back to defaults', () => {
        const out = SS.migrateStore({ printOpts: { mode: 'nope', copies: 9 }, printed: { A: 'x' }, tourDone: 'yes' });
        assert.deepEqual(out.printOpts, { mode: 'all', copies: 1, ids: [] });
        assert.deepEqual(out.printed, {});
        assert.equal(out.tourDone, false);
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

describe('smartRowFor (drop a field on the card → a whole "Concepto | Monto" row)', () => {
    const def = (key) => engine.requireField(key);

    test('bonus rows get + and hide when empty', () => {
        const row = SS.smartRowFor('bonuses', def('bonuses'), 2);
        assert.deepEqual(row, {
            whenEmpty: 'hide',
            cells: [
                { mode: 'text', chips: [{ kind: 'field', key: 'bonuses', as: 'label' }] },
                { mode: 'number', align: 'right', chips: [{ kind: 'op', op: '+' }, { kind: 'field', key: 'bonuses' }] }
            ]
        });
    });

    test('deductions and loans get − and hide when empty', () => {
        assert.equal(SS.smartRowFor('discounts', def('discounts'), 2).cells[1].chips[0].op, '-');
        assert.equal(SS.smartRowFor('loan:adelanto', { key: 'loan:adelanto', label: 'Adelanto', type: 'number' }, 2).cells[1].chips[0].op, '-');
    });

    test('plain amounts and text fields have no sign and always show', () => {
        const gross = SS.smartRowFor('gross', def('gross'), 2);
        assert.equal(gross.whenEmpty, undefined);
        assert.deepEqual(gross.cells[1].chips, [{ kind: 'field', key: 'gross' }]);
        const name = SS.smartRowFor('name', def('name'), 2);
        assert.equal(name.cells[1].mode, 'text');
    });

    test('three columns leave the middle cell empty', () => {
        const row = SS.smartRowFor('gross', def('gross'), 3);
        assert.equal(row.cells.length, 3);
        assert.deepEqual(row.cells[1].chips, []);
    });

    test('one column puts label and value in the same cell', () => {
        const row = SS.smartRowFor('bonuses', def('bonuses'), 1);
        assert.equal(row.cells.length, 1);
        assert.deepEqual(row.cells[0].chips.map((c) => c.kind), ['field', 'op', 'field']);
        assert.equal(row.cells[0].mode, 'number');
    });

    test('the created row evaluates as expected', () => {
        const out = engine.evaluateRows([
            SS.smartRowFor('gross', def('gross'), 2),
            SS.smartRowFor('discounts', def('discounts'), 2)
        ], employees[0], { index: 0 });
        assert.deepEqual(out.map((r) => r.cells.map((c) => c.text)), [['Bruto', '10,000.00'], ['Descuentos', '- 800.00']]);
    });
});

describe('smartColumnFor (drop a field on the table → a new column)', () => {
    test('money columns are numeric and summed', () => {
        assert.deepEqual(SS.smartColumnFor('gross', engine.requireField('gross')), {
            header: 'Bruto', width: 1.2, border: 'all', sum: true,
            cell: { mode: 'number', align: 'right', chips: [{ kind: 'field', key: 'gross' }] }
        });
    });

    test('text columns are wider and not summed; daily rate is not summed', () => {
        const name = SS.smartColumnFor('name', engine.requireField('name'));
        assert.equal(name.sum, false);
        assert.equal(name.width, 2);
        assert.equal(SS.smartColumnFor('dailyRate', engine.requireField('dailyRate')).sum, false);
    });
});

describe('pageSummary', () => {
    test('cards: paper, orientation, grid and card size', () => {
        assert.equal(SS.pageSummary(SS.defaultCardTemplate()), 'Carta · Vertical · 2×4 · 96×62 mm');
    });
    test('table: paper, orientation and row height', () => {
        assert.equal(SS.pageSummary(SS.defaultTableTemplate()), 'Carta · Horizontal · filas de 11 mm');
    });
});

describe('selectEmployees', () => {
    const list = [
        { id: 1, name: 'A', paid: true, payroll: { loans: 0 } },
        { id: 2, name: 'B', paid: false, payroll: { loans: 300 } },
        { id: 3, name: 'C', paid: false }
    ];
    test('modes: all, unpaid, with loan, custom', () => {
        assert.deepEqual(SS.selectEmployees(list, { mode: 'all' }).map((e) => e.id), [1, 2, 3]);
        assert.deepEqual(SS.selectEmployees(list, { mode: 'unpaid' }).map((e) => e.id), [2, 3]);
        assert.deepEqual(SS.selectEmployees(list, { mode: 'loan' }).map((e) => e.id), [2]);
        assert.deepEqual(SS.selectEmployees(list, { mode: 'custom', ids: [3, 1] }).map((e) => e.id), [1, 3]);
    });
    test('copies repeat each employee in place', () => {
        assert.deepEqual(SS.selectEmployees(list, { mode: 'unpaid', copies: 2 }).map((e) => e.id), [2, 2, 3, 3]);
    });
});

describe('createHistory (undo / redo)', () => {
    test('undo and redo walk the snapshots', () => {
        const h = SS.createHistory(10);
        h.push('v1'); h.push('v2');
        assert.equal(h.undo('v3'), 'v2');
        assert.equal(h.undo('v2'), 'v1');
        assert.equal(h.undo('v1'), null);
        assert.equal(h.redo('v1'), 'v2');
        assert.equal(h.redo('v2'), 'v3');
        assert.equal(h.redo('v3'), null);
    });
    test('a new change clears redo; the stack is capped', () => {
        const h = SS.createHistory(2);
        h.push('a'); h.push('b'); h.push('c');
        assert.equal(h.undo('d'), 'c');
        h.push('x');
        assert.equal(h.redo('y'), null);
        assert.equal(h.undo('y'), 'x');
        assert.equal(h.undo('x'), 'b');
        assert.equal(h.undo('b'), null);
    });
});

describe('paletteMatches', () => {
    test('ignores accents and case', () => {
        assert.equal(SS.paletteMatches('Préstamo/Adelanto', 'prest'), true);
        assert.equal(SS.paletteMatches('Días trabajados', 'DIAS'), true);
        assert.equal(SS.paletteMatches('Bruto', 'neto'), false);
        assert.equal(SS.paletteMatches('Bruto', ''), true);
    });
});

describe('migrateStore', () => {
    test('turns the old single-template store into named template lists', () => {
        const old = { A: SS.defaultCardTemplate(), B: SS.defaultTableTemplate(), colors: false };
        const s = SS.migrateStore(old);
        assert.equal(s.version, 2);
        assert.equal(s.templates.length, 2);
        assert.deepEqual(s.templates.map((t) => t.template.type).sort(), ['cards', 'table']);
        assert.equal(s.active.A, s.templates.find((t) => t.template.type === 'cards').id);
        assert.equal(s.colors, false);
    });
    test('empty or broken input gives one example of each type', () => {
        for (const raw of [null, {}, { templates: 'x' }]) {
            const s = SS.migrateStore(raw);
            assert.equal(s.templates.length, 2);
            assert.ok(s.active.A && s.active.B);
        }
    });
    test('drops invalid stored templates but keeps valid ones', () => {
        const good = { id: 't1', name: 'Bueno', template: SS.defaultCardTemplate() };
        const bad = { id: 't2', name: 'Malo', template: { type: 'cards' } };
        const s = SS.migrateStore({ version: 2, templates: [good, bad], active: { A: 't2' } });
        assert.deepEqual(s.templates.filter((t) => t.template.type === 'cards').map((t) => t.id), ['t1']);
        assert.equal(s.active.A, 't1');
    });
});
