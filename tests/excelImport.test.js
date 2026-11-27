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

describe('pasted Excel: payroll breakdown & exported sheet round-trip', () => {
    const { createImporter } = require('../js/SplitXImport.js');
    const SheetFields = require('../js/SplitXSheetFields.js');
    const { normalizeImportedEmployee } = createImporter({
        sheetFields: SheetFields,
        parseNumber: (v) => { try { return parseMoney(v); } catch (_) { return NaN; } }
    });

    test('imports full SplitX exported Excel sheet with banner, headers, denominations, loan fund and totals', () => {
        const exported = [
            'DISTRIBUCIÓN DETALLADA POR EMPLEADO',
            'Fecha: 25/11/2026',
            '',
            '#\tNombre\tBruto\tBonif.\tDesc.\tDespues desc.\tPrestamos\tNeto\tRD$2000\tRD$1000\tEstado\tPagado',
            '1\tAna Pérez\t15000\t1500\t500\t16000\t2000\t14000\t7\t0\tOK\tNo',
            '2\tLuis Gómez\t12000\t0\t300\t11700\t0\t11700\t5\t1\tOK\tSí',
            '★\tFONDO NUEVOS PRÉSTAMOS (RESERVA)\t\t\t\t\t\t1000\t0\t1\tOK\tNo',
            '',
            '\tTOTAL NÓMINA\t27000\t1500\t800\t27700\t2000\t25700\t12\t2\t\t'
        ].join('\n');

        const result = parseExcelText(exported);
        assert.equal(result.detectedFormat, 'header');
        assert.equal(result.errors.length, 0);
        assert.equal(result.valid, 2);

        const ana = normalizeImportedEmployee(result.employees[0], 0);
        assert.equal(ana.employeeNumber, '1');
        assert.equal(ana.name, 'Ana Pérez');
        assert.equal(ana.amount, 14000);
        assert.equal(ana.paid, false);
        assert.equal(ana.payroll.gross, 15000);
        assert.equal(ana.payroll.bonuses, 1500);
        assert.equal(ana.payroll.discounts, 500);
        assert.equal(ana.payroll.afterDiscounts, 16000);
        assert.equal(ana.payroll.loans, 2000);
        assert.equal(ana.payroll.reconciled, true);

        const luis = normalizeImportedEmployee(result.employees[1], 1);
        assert.equal(luis.paid, true);
        assert.equal(luis.amount, 11700);
        assert.equal(luis.payroll.reconciled, true);
    });

    test('imports headerless 8-column payroll rows in exact SplitX exported order', () => {
        const raw = [
            '1\tAna\t10000\t500\t200\t10300\t1000\t9300',
            '2\tLuis\t8000\t0\t0\t8000\t500\t7500'
        ].join('\n');
        const result = parseExcelText(raw);
        assert.equal(result.detectedFormat, 'payroll-8');
        assert.equal(result.errors.length, 0);
        assert.equal(result.employees[0].bruto, 10000);
        assert.equal(result.employees[0].bonificaciones, 500);
        assert.equal(result.employees[0].descuentos, 200);
        assert.equal(result.employees[0].prestamos, 1000);
        assert.equal(result.employees[0].amount, 9300);
    });

    test('imports headerless 7-column payroll rows without "Despues desc."', () => {
        const raw = '1\tAna\t10000\t500\t200\t1000\t9300';
        const result = parseExcelText(raw);
        assert.equal(result.detectedFormat, 'payroll-7');
        assert.equal(result.errors.length, 0);
        assert.equal(result.employees[0].bruto, 10000);
        assert.equal(result.employees[0].prestamos, 1000);
        assert.equal(result.employees[0].amount, 9300);
    });

    test('imports custom column order when headers are present and computes net if omitted', () => {
        const raw = [
            'Nombre\tNo.\tDescuentos por préstamos\tBonificaciones\tDescuentos\tMonto Bruto',
            'Ana\tE-07\t500\t1000\t200\t10000'
        ].join('\n');
        const result = parseExcelText(raw);
        assert.equal(result.detectedFormat, 'header');
        assert.equal(result.errors.length, 0);
        assert.equal(result.employees[0].employeeNumber, 'E-07');
        assert.equal(result.employees[0].amount, 10300);
        assert.equal(result.employees[0].bruto, 10000);
        assert.equal(result.employees[0].bonificaciones, 1000);
        assert.equal(result.employees[0].descuentos, 200);
        assert.equal(result.employees[0].prestamos, 500);
    });

    test('rejects invalid or negative values inside payroll columns with exact line number', () => {
        const raw = [
            '#\tNombre\tBruto\tBonif.\tDesc.\tDespues desc.\tPrestamos\tNeto',
            '1\tAna\t10000\t-50\t0\t9950\t0\t9950',
            '2\tLuis\t10000\t0\t0\t10000\t0\t10000'
        ].join('\n');
        const result = parseExcelText(raw);
        assert.equal(result.valid, 1);
        assert.equal(result.rejected, 1);
        assert.match(result.errors[0], /Línea 2.*negativos.*Bonificaciones/i);
    });

    test('supports currency symbols from other presets in parseMoney', () => {
        assert.equal(parseMoney('€ 1.250,50'), 1250.5);
        assert.equal(parseMoney('S/ 850.00'), 850);
        assert.equal(parseMoney('£ 400.25'), 400.25);
    });

    test('headerless simple SplitX export with denomination columns and OK/No tail is NOT misclassified as payroll-8 (Sprint B)', () => {
        // # | Nombre | Monto | RD$2000 | RD$1000 | RD$500 | RD$200 | RD$100 | RD$50 | RD$25 | Estado | Pagado
        const raw = [
            '1\tAna Pérez\t5000\t2\t1\t0\t0\t0\t0\t0\tOK\tNo',
            '2\tLuis Gómez\t3500\t1\t1\t1\t0\t0\t0\t0\tOK\tSí'
        ].join('\n');
        const result = parseExcelText(raw);
        assert.equal(result.detectedFormat, 'simple');
        assert.equal(result.errors.length, 0);
        assert.equal(result.employees[0].amount, 5000);
        assert.equal(result.employees[1].amount, 3500);
    });

    test('headered import without # column leaves employeeNumber empty instead of copying employee name (Sprint B)', () => {
        const raw = [
            'Nombre\tBruto\tNeto',
            'Juan Pérez\t10000\t9500'
        ].join('\n');
        const result = parseExcelText(raw);
        assert.equal(result.errors.length, 0);
        assert.equal(result.employees[0].name, 'Juan Pérez');
        assert.equal(result.employees[0].employeeNumber, undefined);
    });

    test('re-importing 3-state SplitX exports (Pagado / En sobre / Pendiente) works with and without headers', () => {
        const headerless = [
            '1\tAna Pérez\t5000\t2\t1\t0\t0\t0\t0\t0\tOK\tPendiente',
            '2\tLuis Gómez\t3500\t1\t1\t1\t0\t0\t0\t0\tOK\tEn sobre',
            '3\tMarta Díaz\t2000\t1\t0\t0\t0\t0\t0\t0\tOK\tPagado'
        ].join('\n');
        const r1 = parseExcelText(headerless);
        assert.equal(r1.detectedFormat, 'simple');
        assert.equal(r1.errors.length, 0);
        assert.equal(r1.employees[0].amount, 5000);
        assert.equal(r1.employees[0].paid, false);
        assert.equal(r1.employees[1].amount, 3500);
        assert.equal(r1.employees[1].paid, false);
        assert.equal(r1.employees[2].amount, 2000);
        assert.equal(r1.employees[2].paid, true);

        const headered = [
            '#\tNombre\tMonto (RD$)\tRD$1000\tEstado\tPagado',
            '1\tAna\t2000\t2\tOK\tPagado',
            '2\tLuis\t1000\t1\tOK\tEn sobre',
            '3\tMarta\t1000\t1\tOK\tPendiente'
        ].join('\n');
        const r2 = parseExcelText(headered);
        assert.equal(r2.errors.length, 0);
        assert.equal(r2.employees[0].paid, true);
        assert.equal(r2.employees[1].paid, false);
        assert.equal(r2.employees[2].paid, false);
    });
});
