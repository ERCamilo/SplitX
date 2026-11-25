const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SplitXStorage = require('../js/SplitXStorage.js');
const SplitXCurrencies = require('../js/SplitXCurrencies.js');
const SplitXExport = require('../js/SplitXExport.js');
const SheetStudio = require('../js/SheetStudio.js');

describe('SplitXStorage (Issue #30)', () => {
    test('memory fallback stores keys independently without overwriting each other', () => {
        const errors = [];
        const failingBackend = {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('SecurityError'); },
            removeItem: () => { throw new Error('SecurityError'); }
        };
        const st = SplitXStorage.createStorage({ backend: failingBackend, onError: (e) => errors.push(e) });
        st.set(SplitXStorage.KEYS.DATA, '{"employees":[]}');
        st.set(SplitXStorage.KEYS.CORRUPT_BACKUP, 'corrupt-raw');
        assert.equal(st.get(SplitXStorage.KEYS.DATA), '{"employees":[]}');
        assert.equal(st.get(SplitXStorage.KEYS.CORRUPT_BACKUP), 'corrupt-raw');
        assert.equal(errors[0].reason, 'blocked');
    });

    test('distinguishes QuotaExceededError from blocked storage', () => {
        const errors = [];
        const quotaBackend = {
            getItem: () => null,
            setItem: () => { const e = new Error('Storage full'); e.name = 'QuotaExceededError'; throw e; },
            removeItem: () => {}
        };
        const st = SplitXStorage.createStorage({ backend: quotaBackend, onError: (e) => errors.push(e) });
        const res = st.set(SplitXStorage.KEYS.DATA, 'x');
        assert.equal(res.ok, false);
        assert.equal(res.reason, 'quota');
        assert.equal(errors[0].reason, 'quota');
    });

    test('clearAll removes every SplitX key including history, sheets and PII documents', () => {
        const backing = new Map();
        const backend = {
            getItem: (k) => backing.get(k) ?? null,
            setItem: (k, v) => backing.set(k, v),
            removeItem: (k) => backing.delete(k)
        };
        const st = SplitXStorage.createStorage({ backend });
        for (const k of SplitXStorage.ALL_KEYS) st.set(k, 'secret');
        st.clearAll();
        for (const k of SplitXStorage.ALL_KEYS) {
            assert.equal(st.get(k), null, k + ' must be cleared');
        }
        assert.equal(backing.size, 0);
    });
});

describe('SplitXCurrencies & security sanitization (Issue #29)', () => {
    test('sanitizeCurrencySymbol strips HTML/XSS payloads and bounds length', () => {
        assert.equal(SplitXCurrencies.sanitizeCurrencySymbol('<img src=x onerror=alert(1)>'), 'img src=x ');
        assert.equal(SplitXCurrencies.sanitizeCurrencySymbol('  RD$  '), 'RD$');
        assert.equal(SplitXCurrencies.sanitizeCurrencySymbol(''), '$');
    });

    test('sanitizeHexColor rejects CSS injection payloads', () => {
        assert.equal(SplitXCurrencies.sanitizeHexColor('#10b981'), '#10b981');
        assert.equal(SplitXCurrencies.sanitizeHexColor('#fff'), '#fff');
        assert.equal(SplitXCurrencies.sanitizeHexColor('red;background:url(evil)'), '');
    });

    test('isSafeBillImage allows local paths and raster data URIs, rejects SVG and CSS injection', () => {
        assert.equal(SplitXCurrencies.isSafeBillImage('imagenes/DOP/billetes/1000pesos.jpg'), true);
        assert.equal(SplitXCurrencies.isSafeBillImage('data:image/png;base64,AAAA'), true);
        assert.equal(SplitXCurrencies.isSafeBillImage('data:image/svg+xml;base64,AAAA'), false);
        assert.equal(SplitXCurrencies.isSafeBillImage("x');background:red"), false);
        assert.equal(SplitXCurrencies.isSafeBillImage('imagenes/../../etc/passwd.png'), false);
    });

    test('SheetStudio.migrateStore rejects SVG data URI logos and accepts PNG/JPEG', () => {
        const bad = SheetStudio.migrateStore({ logo: 'data:image/svg+xml;base64,PHN2Zz4=' });
        assert.equal(bad.logo, null);
        const good = SheetStudio.migrateStore({ logo: 'data:image/png;base64,iVBORw0KGgo=' });
        assert.equal(good.logo, 'data:image/png;base64,iVBORw0KGgo=');
    });
});

describe('SplitXExport CSV injection protection & currency formatting (Issues #26 & #29)', () => {
    test('csvCell neutralizes formula injection and escapes double quotes', () => {
        assert.equal(SplitXExport.csvCell('=cmd|"/C calc"!A0'), '"\'=cmd|""/C calc""!A0"');
        assert.equal(SplitXExport.csvCell('+SUM(A1:A2)'), '"\'+SUM(A1:A2)"');
        assert.equal(SplitXExport.csvCell('-2+3'), '"\'-2+3"');
        assert.equal(SplitXExport.csvCell('@malicious'), '"\'@malicious"');
        assert.equal(SplitXExport.csvCell('Ana "La Jefa" Pérez'), '"Ana ""La Jefa"" Pérez"');
        assert.equal(SplitXExport.csvCell(1500.5), '1500.5');
    });

    test('buildCSVContent uses dynamic currency symbol and escapes malicious employee names', () => {
        const csv = SplitXExport.buildCSVContent({
            currencySymbol: '€',
            data: {
                denoms: [100, 50],
                summary: { 100: 1, 50: 1 },
                empRows: [{ idx: 1, name: '=HYPERLINK("evil")', amount: 150, paid: false, status: 'ok', 100: 1, 50: 1 }],
                payrollSummary: { count: 0, gross: 0, bonuses: 0, discounts: 0, loans: 0, net: 0 },
                loanFundResult: { amount: 0, distribution: {}, status: 'ok', missingAmount: 0 },
                loanFundAmount: 0,
                loanFundMissing: 0,
                loanFundDistribution: {},
                bankData: { breakdown: {}, remainder: 0 },
                bankSummary: { 100: 0, 50: 0 },
                totalToWithdraw: 0
            }
        });
        assert.match(csv, /Monto \(€\)/);
        assert.match(csv, /"'=HYPERLINK\(""evil""\)"/);
    });

    test('isoDateTag formats local YYYY-MM-DD deterministically', () => {
        assert.equal(SplitXExport.isoDateTag(new Date(2026, 10, 5)), '2026-11-05');
    });
});
