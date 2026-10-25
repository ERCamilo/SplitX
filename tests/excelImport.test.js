const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseMoney, parseExcelText } = require('../js/SplitXExcelImport.js');

describe('monetary parser: locale and safety', () => {
    for (const [raw, expected] of [
        ['1.300,00', 1300], ['1,300.00', 1300], ['1.300.000,50', 1300000.50],
        ['1,300,000.50', 1300000.50], ['1300,50', 1300.50],
        ['1300.50', 1300.50], ['RD$ 1.300,00', 1300], ['USD 1,300.00', 1300],
        [' 1 234,50 ', 1234.50], ['0', 0], ['-100.25', -100.25]
    ]) test('accepts ' + raw, () => assert.equal(parseMoney(raw), expected));

    test('ambiguous single separators require explicit format', () => {
        for (const v of ['1,300', '1.300', '25,000', '25.000']) {
            assert.throws(() => parseMoney(v), /ambiguo/i, v);
        }
        assert.equal(parseMoney('1,300', { format: 'en' }), 1300);
        assert.throws(() => parseMoney('1,300', { format: 'es' }), /formato/i);
        assert.equal(parseMoney('1.300', { format: 'es' }), 1300);
        assert.throws(() => parseMoney('1.300', { format: 'en' }), /formato/i);
    });

    test('never accepts truncated or malformed amounts', () => {
        for (const v of ['1.300,00foo', '500abc', '1,23,45', '1.30.000', '123.4567',
            '1,300.00.00', '3e8', 'Infinity', '$25xx', '3,2,1', '']) {
            assert.throws(() => parseMoney(v), /monto|formato|agrupación/i, v);
        }
    });

    test('rejects unsafe precision and nonfinite numbers', () => {
        for (const v of [NaN, Infinity, -Infinity, 12.345, '999999999999999999999']) {
            assert.throws(() => parseMoney(v));
        }
    });

    test('preserves cents exactly within safe representable range', () => {
        assert.equal(parseMoney('0,30'), 0.30);
        assert.equal(parseMoney('0.05'), 0.05);
    });
});

describe('pasted Excel: no invisible row loss', () => {
    test('keeps original line numbers and reports mixed errors', () => {
        const result = parseExcelText('1\tAna\t1.300,00\n\n2\tLuis\t1,300\n3\tMarta\t200.50\n4\t\t500');
        assert.equal(result.rows, 4);
        assert.equal(result.valid, 2);
        assert.equal(result.rejected, 2);
        assert.deepEqual(result.employees.map(e => e.amount), [1300, 200.5]);
        assert.match(result.errors[0], /Línea 3.*ambiguo/i);
        assert.match(result.errors[1], /Línea 5.*Nombre vacío/);
    });

    test('resolves ambiguous amounts when the selected format is explicit', () => {
        const result = parseExcelText('1\tAna\t1,300\n2\tLuis\t2,500', { format: 'en' });
        assert.equal(result.errors.length, 0);
        assert.deepEqual(result.employees.map(e => e.amount), [1300, 2500]);
    });

    test('rejects negative salary without deleting valid rows from preview', () => {
        const result = parseExcelText('1\tAna\t-3.00\n2\tLuis\t4.00');
        assert.equal(result.valid, 1);
        assert.equal(result.rejected, 1);
        assert.match(result.errors[0], /negativo/i);
    });

    test('rejects invalid grouping in selected format', () => {
        const result = parseExcelText('1\tAna\t1.300,00', { format: 'en' });
        assert.equal(result.valid, 0);
        assert.equal(result.rejected, 1);
    });
});
