/**
 * SheetBuilder core tests: chip formulas, running totals, formatting,
 * template validation and print layout. Runs against the compiled js/SheetBuilder.js.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SB = require('../js/SheetBuilder.js');

const fields = [
    { key: 'no', label: 'No.', type: 'number', decimals: 0, get: (r, ctx) => ctx.index + 1 },
    { key: 'name', label: 'Nombre', type: 'text', get: (r) => r.name },
    { key: 'firstName', label: 'Primer nombre', type: 'text', get: (r) => String(r.name).split(/\s+/)[0] },
    { key: 'net', label: 'Monto neto', type: 'number', get: (r) => r.net },
    { key: 'food', label: 'Comida', type: 'number', get: (r) => r.food },
    { key: 'loan', label: 'Préstamo', type: 'number', get: (r) => r.loan }
];
const engine = SB.createEngine({ fields, locale: 'en-US', decimals: 2 });
const record = { name: 'Juan Pérez', net: 10000, food: 500, loan: 1200 };
const ctx = { index: 0 };

const f = (key) => ({ kind: 'field', key });
const op = (o) => ({ kind: 'op', op: o });
const num = (value, percent) => (percent ? { kind: 'number', value, percent: true } : { kind: 'number', value });
const txt = (value) => ({ kind: 'text', value });
const running = { kind: 'running' };

describe('Formula evaluation', () => {
    test('respects operator precedence', () => {
        const r = engine.evaluateCell({ mode: 'number', chips: [num(2), op('+'), num(3), op('*'), num(4)] }, record, ctx, null);
        assert.equal(r.value, 14);
    });

    test('supports parentheses', () => {
        const r = engine.evaluateCell({ mode: 'number', chips: [{ kind: 'paren', paren: '(' }, num(2), op('+'), num(3), { kind: 'paren', paren: ')' }, op('*'), num(4)] }, record, ctx, null);
        assert.equal(r.value, 20);
    });

    test('calculator-style percent: a - 3% subtracts 3% of a', () => {
        const r = engine.evaluateCell({ mode: 'number', chips: [f('net'), op('-'), num(3, true)] }, record, ctx, null);
        assert.equal(r.value, 9700);
    });

    test('percent after multiplication is a plain fraction', () => {
        const r = engine.evaluateCell({ mode: 'number', chips: [f('net'), op('*'), num(3, true)] }, record, ctx, null);
        assert.equal(r.value, 300);
    });

    test('division by zero yields an error instead of throwing', () => {
        const r = engine.evaluateCell({ mode: 'number', chips: [num(5), op('/'), num(0)] }, record, ctx, null);
        assert.ok(r.error);
        assert.equal(r.text, '—');
    });

    test('malformed expression yields an error', () => {
        const r = engine.evaluateCell({ mode: 'number', chips: [num(5), op('+')] }, record, ctx, null);
        assert.ok(r.error);
    });

    test('missing numeric field counts as 0', () => {
        const r = engine.evaluateCell({ mode: 'number', chips: [f('net'), op('-'), f('food')] }, { name: 'X', net: 100 }, ctx, null);
        assert.equal(r.value, 100);
    });

    test('unknown field yields an error', () => {
        const r = engine.evaluateCell({ mode: 'number', chips: [f('nope')] }, record, ctx, null);
        assert.ok(r.error);
    });

    test('floating point noise is rounded away', () => {
        const r = engine.evaluateCell({ mode: 'number', chips: [num(0.1), op('+'), num(0.2)] }, record, ctx, null);
        assert.equal(r.value, 0.3);
    });
});

describe('Text lines', () => {
    test('joins chips with spaces and formats numeric fields', () => {
        const r = engine.evaluateCell({ mode: 'text', chips: [f('no'), txt('-'), f('firstName')] }, record, ctx, null);
        assert.equal(r.text, '1 - Juan');
    });

    test('formats numbers inside text lines with the field decimals', () => {
        const r = engine.evaluateCell({ mode: 'text', chips: [txt('Neto:'), f('net')] }, record, ctx, null);
        assert.equal(r.text, 'Neto: 10,000.00');
    });
});

const row = (...cells) => ({ cells });
const rows = (...cells) => cells.map((c) => row(c));
const texts = (out) => out.map((r) => r.cells.map((c) => c.text).join(' | '));

describe('Running total across a card (the envelope example)', () => {
    // [No.] - [primer nombre]
    // [monto neto] - [3%]
    // - [comida]
    // [total hasta ahora]
    // - [prestamo]
    // [total hasta ahora]
    const lines = rows(
        { mode: 'text', chips: [f('no'), txt('-'), f('firstName')] },
        { mode: 'number', chips: [f('net'), op('-'), num(3, true)] },
        { mode: 'number', chips: [op('-'), f('food')] },
        { mode: 'number', chips: [running] },
        { mode: 'number', chips: [op('-'), f('loan')] },
        { mode: 'number', chips: [running] }
    );

    test('produces the expected values', () => {
        const out = engine.evaluateRows(lines, record, ctx);
        assert.deepEqual(texts(out), [
            '1 - Juan',
            '9,700.00',
            '- 500.00',
            '9,200.00',
            '- 1,200.00',
            '8,000.00'
        ]);
        assert.equal(out[5].cells[0].value, 8000);
    });

    test('first plain numeric line sets the total, later plain ones do not', () => {
        const out = engine.evaluateRows(rows(
            { mode: 'number', chips: [f('net')] },
            { mode: 'number', chips: [num(15)] },
            { mode: 'number', chips: [running] }
        ), record, ctx);
        assert.equal(out[2].cells[0].value, 10000);
    });

    test('explicit total=set overrides the running total', () => {
        const out = engine.evaluateRows(rows(
            { mode: 'number', chips: [f('net')] },
            { mode: 'number', chips: [num(15)], total: 'set' },
            { mode: 'number', chips: [running] }
        ), record, ctx);
        assert.equal(out[2].cells[0].value, 15);
    });

    test('total=ignore on an operator line shows it without applying it', () => {
        const out = engine.evaluateRows(rows(
            { mode: 'number', chips: [f('net')] },
            { mode: 'number', chips: [op('-'), f('food')], total: 'ignore' },
            { mode: 'number', chips: [running] }
        ), record, ctx);
        assert.equal(out[2].cells[0].value, 10000);
    });

    test('expression and both display modes', () => {
        const [a, b] = engine.evaluateRows(rows(
            { mode: 'number', chips: [f('net'), op('-'), num(3, true)], show: 'expression' },
            { mode: 'number', chips: [txt('Comida'), op('-'), f('food')], show: 'both' }
        ), record, ctx).map((r) => r.cells[0]);
        assert.equal(a.text, '10,000.00 - 3%');
        assert.equal(b.text, 'Comida - 500.00 = 9,200.00');
    });

    test('result mode keeps leading text as a label', () => {
        const [, b] = engine.evaluateRows(rows(
            { mode: 'number', chips: [f('net')] },
            { mode: 'number', chips: [txt('Comida:'), op('-'), f('food')] }
        ), record, ctx).map((r) => r.cells[0]);
        assert.equal(b.text, 'Comida: - 500.00');
    });
});

describe('Template validation', () => {
    const valid = {
        version: 1,
        type: 'cards',
        name: 'Sobre',
        columns: [1],
        rows: [{ cells: [{ mode: 'text', chips: [f('name')] }] }],
        layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 2, rows: 4 }
    };

    test('accepts a well-formed template', () => {
        assert.deepEqual(SB.validateTemplate(valid).errors, []);
    });

    test('rejects unknown chip kinds and operators', () => {
        const bad = JSON.parse(JSON.stringify(valid));
        bad.rows[0].cells[0].chips.push({ kind: 'script', value: 'alert(1)' }, { kind: 'op', op: '^' });
        assert.equal(SB.validateTemplate(bad).errors.length, 2);
    });

    test('rejects non-object input', () => {
        assert.ok(SB.validateTemplate('nope').errors.length > 0);
    });

    test('round-trips through JSON', () => {
        const parsed = SB.parseTemplate(SB.serializeTemplate(valid));
        assert.deepEqual(parsed, valid);
    });

    test('parseTemplate throws on invalid templates', () => {
        assert.throws(() => SB.parseTemplate('{"type":"cards"}'));
    });
});

describe('Print layout', () => {
    test('grid mode splits the printable area', () => {
        const l = SB.computeLayout({ paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 2, rows: 4 });
        assert.equal(l.perPage, 8);
        assert.equal(l.cardWidth, (215.9 - 20 - 4) / 2);
        assert.equal(l.cardHeight, (279.4 - 20 - 12) / 4);
    });

    test('size mode fits as many cards as possible', () => {
        const l = SB.computeLayout({ paper: 'a4', orientation: 'portrait', margin: 10, gap: 5, mode: 'size', cardWidth: 90, cardHeight: 50 });
        assert.equal(l.cols, 2);
        assert.equal(l.rows, 5);
        assert.equal(l.perPage, 10);
    });

    test('landscape swaps paper dimensions', () => {
        const l = SB.computeLayout({ paper: 'letter', orientation: 'landscape', margin: 0, gap: 0, mode: 'grid', cols: 1, rows: 1 });
        assert.equal(l.pageWidth, 279.4);
        assert.equal(l.pageHeight, 215.9);
    });

    test('a card larger than the page still yields one per page', () => {
        const l = SB.computeLayout({ paper: 'a4', orientation: 'portrait', margin: 10, gap: 5, mode: 'size', cardWidth: 500, cardHeight: 500 });
        assert.equal(l.perPage, 1);
    });

    test('paginate chunks items by perPage', () => {
        assert.deepEqual(SB.paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
        assert.deepEqual(SB.paginate([], 2), []);
    });
});

describe('Rendering cards for many records', () => {
    test('renderCards evaluates every record with its index', () => {
        const template = {
            version: 1,
            type: 'cards',
            name: 't',
            columns: [1],
            rows: [{ cells: [{ mode: 'text', chips: [f('no'), f('firstName')] }] }],
            layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 2, rows: 1 }
        };
        const out = engine.renderCards(template, [{ name: 'Ana Ruiz' }, { name: 'Luis Gil' }, { name: 'Eva Paz' }]);
        assert.equal(out.pages.length, 2);
        assert.deepEqual(out.pages[0].map((c) => c[0].cells[0].text), ['1 Ana', '2 Luis']);
        assert.equal(out.pages[1][0][0].cells[0].text, '3 Eva');
    });
});

describe('Label/value chips and multi-column rows', () => {
    const label = (key) => ({ kind: 'field', key, as: 'label' });

    test('a field chip can print its label or its value', () => {
        const [r] = engine.evaluateRows([row(
            { mode: 'text', chips: [label('net')] },
            { mode: 'number', chips: [f('net')] }
        )], record, ctx);
        assert.deepEqual(r.cells.map((c) => c.text), ['Monto neto', '10,000.00']);
    });

    test('label chips are ignored by the calculator', () => {
        const r = engine.evaluateCell({ mode: 'number', chips: [label('food'), op('-'), f('food')] }, record, ctx, 1000);
        assert.equal(r.text, 'Comida - 500.00');
        assert.equal(r.total, 500);
    });

    test('running total flows left to right across cells', () => {
        const out = engine.evaluateRows([
            row({ mode: 'text', chips: [label('net')] }, { mode: 'number', chips: [f('net')] }),
            row({ mode: 'text', chips: [label('loan')] }, { mode: 'number', chips: [op('-'), f('loan')] }),
            row({ mode: 'text', chips: [txt('Total')] }, { mode: 'number', chips: [running] })
        ], record, ctx);
        assert.equal(out[2].cells[1].text, '8,800.00');
    });
});

describe('Empty rows', () => {
    const label = (key) => ({ kind: 'field', key, as: 'label' });
    const noLoan = { name: 'Ana', net: 5000, food: 0, loan: 0 };
    const loanRow = (whenEmpty) => ({
        whenEmpty,
        cells: [{ mode: 'text', chips: [label('loan')] }, { mode: 'number', chips: [op('-'), f('loan')] }]
    });

    test('hide removes the row when all its value fields are empty', () => {
        const [r] = engine.evaluateRows([loanRow('hide')], noLoan, ctx);
        assert.equal(r.hidden, true);
    });

    test('dash keeps the label but prints - for values', () => {
        const [r] = engine.evaluateRows([loanRow('dash')], noLoan, ctx);
        assert.equal(r.hidden, false);
        assert.deepEqual(r.cells.map((c) => c.text), ['Préstamo', '-']);
    });

    test('show (default) prints the zero value', () => {
        const [r] = engine.evaluateRows([loanRow(undefined)], noLoan, ctx);
        assert.equal(r.cells[1].text, '- 0.00');
    });

    test('a row with a non-empty value is never hidden', () => {
        const [r] = engine.evaluateRows([loanRow('hide')], record, ctx);
        assert.equal(r.hidden, false);
        assert.equal(r.cells[1].text, '- 1,200.00');
    });

    test('a hidden row does not change the running total', () => {
        const out = engine.evaluateRows([
            row({ mode: 'number', chips: [f('net')] }),
            loanRow('hide'),
            row({ mode: 'number', chips: [running] })
        ], noLoan, ctx);
        assert.equal(out[2].cells[0].value, 5000);
    });

    test('rows with only labels or literals are never considered empty', () => {
        const [r] = engine.evaluateRows([{ whenEmpty: 'hide', cells: [{ mode: 'text', chips: [txt('Firma:')] }] }], noLoan, ctx);
        assert.equal(r.hidden, false);
    });
});

describe('Dynamic fields (imported concepts)', () => {
    const dynEngine = SB.createEngine({
        fields,
        locale: 'en-US',
        resolveField: (key) => {
            const m = /^discount:(.+)$/.exec(key);
            if (!m) return undefined;
            return { key, label: m[1].replace(/_/g, ' '), type: 'number', get: (r) => r.discounts?.[m[1]] };
        }
    });
    const withConcept = { ...record, discounts: { perdida_de_equipo: 350 } };

    test('resolves fields that were not declared up front', () => {
        const [r] = dynEngine.evaluateRows([row(
            { mode: 'text', chips: [{ kind: 'field', key: 'discount:perdida_de_equipo', as: 'label' }] },
            { mode: 'number', chips: [f('discount:perdida_de_equipo')] }
        )], withConcept, ctx);
        assert.deepEqual(r.cells.map((c) => c.text), ['perdida de equipo', '350.00']);
    });

    test('a concept missing for this employee is empty, so the row can hide', () => {
        const [r] = dynEngine.evaluateRows([{ whenEmpty: 'hide', cells: [{ mode: 'number', chips: [f('discount:perdida_de_equipo')] }] }], record, ctx);
        assert.equal(r.hidden, true);
    });

    test('keys the resolver does not know still error', () => {
        const r = dynEngine.evaluateCell({ mode: 'number', chips: [f('typo')] }, record, ctx, null);
        assert.ok(r.error);
    });
});

describe('Template grid validation', () => {
    const base = () => ({
        version: 1, type: 'cards', name: 't', columns: [2, 1],
        rows: [{ cells: [{ mode: 'text', chips: [] }, { mode: 'number', chips: [f('net')] }] }],
        layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 2, rows: 4 }
    });

    test('accepts a two-column card', () => {
        assert.deepEqual(SB.validateTemplate(base()).errors, []);
    });

    test('rejects rows whose spans exceed the column count', () => {
        const t = base();
        t.rows[0].cells[0].span = 2;
        assert.equal(SB.validateTemplate(t).errors.length, 1);
    });

    test('rejects invalid whenEmpty and column widths', () => {
        const t = base();
        t.rows[0].whenEmpty = 'explode';
        t.columns = [0];
        assert.equal(SB.validateTemplate(t).errors.length, 2);
    });
});

describe('Auto decimals', () => {
    const e = SB.createEngine({
        locale: 'en-US',
        fields: [{ key: 'days', label: 'Días', type: 'number', decimals: 'auto', get: (r) => r.days }]
    });
    const show = (days) => e.evaluateCell({ mode: 'text', chips: [{ kind: 'field', key: 'days' }] }, { days }, { index: 0 }, null).text;

    test('prints whole numbers without decimals and keeps up to two otherwise', () => {
        assert.equal(show(10), '10');
        assert.equal(show(10.5), '10.5');
        assert.equal(show(2.125), '2.13');
    });
});

describe('Non-monetary fields and single-field formatting', () => {
    const e = SB.createEngine({
        locale: 'en-US',
        fields: [
            { key: 'days', label: 'Días', type: 'number', decimals: 'auto', noTotal: true, get: (r) => r.days },
            { key: 'gross', label: 'Bruto', type: 'number', get: (r) => r.gross }
        ]
    });
    const rec = { days: 10.5, gross: 10000 };
    const cell = (chips, extra) => ({ mode: 'number', chips, ...extra });
    const fd = (key) => ({ kind: 'field', key });

    test('a number cell holding a single field uses that field decimals', () => {
        assert.equal(e.evaluateCell(cell([fd('days')]), rec, { index: 0 }, null).text, '10.5');
    });

    test('noTotal fields never start the running total', () => {
        const out = e.evaluateRows([
            { cells: [cell([fd('days')])] },
            { cells: [cell([fd('gross')])] },
            { cells: [cell([{ kind: 'running' }])] }
        ], rec, { index: 0 });
        assert.equal(out[2].cells[0].value, 10000);
    });

    test('total=set still forces a noTotal cell to set the total', () => {
        const out = e.evaluateRows([
            { cells: [cell([fd('days')], { total: 'set' })] },
            { cells: [cell([{ kind: 'running' }])] }
        ], rec, { index: 0 });
        assert.equal(out[1].cells[0].value, 10.5);
    });
});

describe('Row line above', () => {
    test('lineAbove must be boolean', () => {
        const t = {
            version: 1, type: 'cards', name: 't', columns: [1],
            rows: [{ lineAbove: 'yes', cells: [{ mode: 'text', chips: [] }] }],
            layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 2, rows: 4 }
        };
        assert.equal(SB.validateTemplate(t).errors.length, 1);
        t.rows[0].lineAbove = true;
        assert.deepEqual(SB.validateTemplate(t).errors, []);
    });
});
