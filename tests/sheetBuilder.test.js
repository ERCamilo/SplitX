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
        const r = engine.evaluateLine({ mode: 'number', chips: [num(2), op('+'), num(3), op('*'), num(4)] }, record, ctx, null);
        assert.equal(r.value, 14);
    });

    test('supports parentheses', () => {
        const r = engine.evaluateLine({ mode: 'number', chips: [{ kind: 'paren', paren: '(' }, num(2), op('+'), num(3), { kind: 'paren', paren: ')' }, op('*'), num(4)] }, record, ctx, null);
        assert.equal(r.value, 20);
    });

    test('calculator-style percent: a - 3% subtracts 3% of a', () => {
        const r = engine.evaluateLine({ mode: 'number', chips: [f('net'), op('-'), num(3, true)] }, record, ctx, null);
        assert.equal(r.value, 9700);
    });

    test('percent after multiplication is a plain fraction', () => {
        const r = engine.evaluateLine({ mode: 'number', chips: [f('net'), op('*'), num(3, true)] }, record, ctx, null);
        assert.equal(r.value, 300);
    });

    test('division by zero yields an error instead of throwing', () => {
        const r = engine.evaluateLine({ mode: 'number', chips: [num(5), op('/'), num(0)] }, record, ctx, null);
        assert.ok(r.error);
        assert.equal(r.text, '—');
    });

    test('malformed expression yields an error', () => {
        const r = engine.evaluateLine({ mode: 'number', chips: [num(5), op('+')] }, record, ctx, null);
        assert.ok(r.error);
    });

    test('missing numeric field counts as 0', () => {
        const r = engine.evaluateLine({ mode: 'number', chips: [f('net'), op('-'), f('food')] }, { name: 'X', net: 100 }, ctx, null);
        assert.equal(r.value, 100);
    });

    test('unknown field yields an error', () => {
        const r = engine.evaluateLine({ mode: 'number', chips: [f('nope')] }, record, ctx, null);
        assert.ok(r.error);
    });

    test('floating point noise is rounded away', () => {
        const r = engine.evaluateLine({ mode: 'number', chips: [num(0.1), op('+'), num(0.2)] }, record, ctx, null);
        assert.equal(r.value, 0.3);
    });
});

describe('Text lines', () => {
    test('joins chips with spaces and formats numeric fields', () => {
        const r = engine.evaluateLine({ mode: 'text', chips: [f('no'), txt('-'), f('firstName')] }, record, ctx, null);
        assert.equal(r.text, '1 - Juan');
    });

    test('formats numbers inside text lines with the field decimals', () => {
        const r = engine.evaluateLine({ mode: 'text', chips: [txt('Neto:'), f('net')] }, record, ctx, null);
        assert.equal(r.text, 'Neto: 10,000.00');
    });
});

describe('Running total across a card (the envelope example)', () => {
    // [No.] - [primer nombre]
    // [monto neto] - [3%]
    // - [comida]
    // [total hasta ahora]
    // - [prestamo]
    // [total hasta ahora]
    const lines = [
        { mode: 'text', chips: [f('no'), txt('-'), f('firstName')] },
        { mode: 'number', chips: [f('net'), op('-'), num(3, true)] },
        { mode: 'number', chips: [op('-'), f('food')] },
        { mode: 'number', chips: [running] },
        { mode: 'number', chips: [op('-'), f('loan')] },
        { mode: 'number', chips: [running] }
    ];

    test('produces the expected values', () => {
        const out = engine.evaluateLines(lines, record, ctx);
        assert.deepEqual(out.map((l) => l.text), [
            '1 - Juan',
            '9,700.00',
            '- 500.00',
            '9,200.00',
            '- 1,200.00',
            '8,000.00'
        ]);
        assert.equal(out[5].value, 8000);
    });

    test('first plain numeric line sets the total, later plain ones do not', () => {
        const out = engine.evaluateLines([
            { mode: 'number', chips: [f('net')] },
            { mode: 'number', chips: [num(15)] },
            { mode: 'number', chips: [running] }
        ], record, ctx);
        assert.equal(out[2].value, 10000);
    });

    test('explicit total=set overrides the running total', () => {
        const out = engine.evaluateLines([
            { mode: 'number', chips: [f('net')] },
            { mode: 'number', chips: [num(15)], total: 'set' },
            { mode: 'number', chips: [running] }
        ], record, ctx);
        assert.equal(out[2].value, 15);
    });

    test('total=ignore on an operator line shows it without applying it', () => {
        const out = engine.evaluateLines([
            { mode: 'number', chips: [f('net')] },
            { mode: 'number', chips: [op('-'), f('food')], total: 'ignore' },
            { mode: 'number', chips: [running] }
        ], record, ctx);
        assert.equal(out[2].value, 10000);
    });

    test('expression and both display modes', () => {
        const [a, b] = engine.evaluateLines([
            { mode: 'number', chips: [f('net'), op('-'), num(3, true)], show: 'expression' },
            { mode: 'number', chips: [txt('Comida'), op('-'), f('food')], show: 'both' }
        ], record, ctx);
        assert.equal(a.text, '10,000.00 - 3%');
        assert.equal(b.text, 'Comida - 500.00 = 9,200.00');
    });

    test('result mode keeps leading text as a label', () => {
        const [, b] = engine.evaluateLines([
            { mode: 'number', chips: [f('net')] },
            { mode: 'number', chips: [txt('Comida:'), op('-'), f('food')] }
        ], record, ctx);
        assert.equal(b.text, 'Comida: - 500.00');
    });
});

describe('Template validation', () => {
    const valid = {
        version: 1,
        type: 'cards',
        name: 'Sobre',
        lines: [{ mode: 'text', chips: [f('name')] }],
        layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 2, rows: 4 }
    };

    test('accepts a well-formed template', () => {
        assert.deepEqual(SB.validateTemplate(valid).errors, []);
    });

    test('rejects unknown chip kinds and operators', () => {
        const bad = JSON.parse(JSON.stringify(valid));
        bad.lines[0].chips.push({ kind: 'script', value: 'alert(1)' }, { kind: 'op', op: '^' });
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
            lines: [{ mode: 'text', chips: [f('no'), f('firstName')] }],
            layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 2, rows: 1 }
        };
        const out = engine.renderCards(template, [{ name: 'Ana Ruiz' }, { name: 'Luis Gil' }, { name: 'Eva Paz' }]);
        assert.equal(out.pages.length, 2);
        assert.deepEqual(out.pages[0].map((c) => c[0].text), ['1 Ana', '2 Luis']);
        assert.equal(out.pages[1][0][0].text, '3 Eva');
    });
});
