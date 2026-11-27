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

    test('exportToExcel and exportToPDF fail gracefully offline without throwing or leaking payroll PII (Issue #12)', async () => {
        const alerts = [];
        const exporter = SplitXExport.createExporter({
            getState: () => ({ denominations: [1000, 500], payrollMode: 'deductions' }),
            getCurrencySymbol: () => 'RD$',
            calculateDistribution: () => ({
                results: [{ id: 1, name: 'Juan Pérez Secreto', amount: 1500, paid: false, status: 'ok', distribution: { 1000: 1, 500: 1 } }],
                loanFundResult: { amount: 0, distribution: {}, status: 'ok', missingAmount: 0 }
            }),
            calculateBankNeeds: () => ({ breakdown: { 1000: { final: 1 }, 500: { final: 1 } }, remainder: 0 }),
            getPayrollSummary: () => ({ count: 0, gross: 0, bonuses: 0, discounts: 0, loans: 0, net: 0 }),
            getEffectiveEmployeeAmount: (e) => e.amount,
            showCustomAlert: (opts) => alerts.push(opts)
        });

        await exporter.exportToExcel();
        await exporter.exportToPDF();

        assert.equal(alerts.length, 2);
        assert.match(alerts[0].title, /Excel no disponible/i);
        assert.match(alerts[1].title, /PDF no disponible/i);
        for (const alert of alerts) {
            assert.equal(alert.type, 'danger');
            assert.equal(alert.message.includes('Juan Pérez Secreto'), false, 'error alert must never expose payroll PII');
        }
    });

    test('computePdfEmpTableLayout fits ALL denominations within A4 landscape (269 mm) without overflow or currency prefix (Sprint C)', () => {
        for (const denoms of [
            [2000, 1000, 500, 200, 100, 50, 25, 10, 5, 1],
            [500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1],
            [1000, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05],
            [10000, 5000, 2000, 1000, 500, 200, 100, 50, 25, 20, 10, 5, 2, 1, 0.5, 0.25]
        ]) {
            const layout = SplitXExport.computePdfEmpTableLayout(denoms, 297, 14);
            assert.equal(layout.headers.length, denoms.length);
            assert.deepEqual(layout.headers, denoms.map(String), 'denom headers must show only the denomination number');
            const totalW = layout.numW + layout.nameW + layout.netW + layout.denomColW * denoms.length;
            assert.ok(totalW <= layout.usableW + 0.001, `overflow for ${denoms.length} denoms: ${totalW} > ${layout.usableW}`);
            assert.ok(layout.nameW >= 36, `name column too narrow: ${layout.nameW}`);
            assert.ok(layout.denomColW >= 8, `denom column too narrow: ${layout.denomColW}`);
        }
    });

    test('buildCSVContent in normal mode does not report loans as deducted (Sprint C)', () => {
        const csv = SplitXExport.buildCSVContent({
            currencySymbol: 'RD$',
            data: {
                payrollMode: 'normal',
                denoms: [1000],
                summary: { 1000: 1 },
                empRows: [{ idx: 1, name: 'Ana', amount: 1000, paid: false, status: 'ok', payroll: { gross: 1000, bonuses: 0, discounts: 0, afterDiscounts: 1000, loans: 200 }, 1000: 1 }],
                payrollSummary: { count: 1, gross: 1000, bonuses: 0, discounts: 0, afterDiscounts: 1000, loans: 200, net: 1000 },
                loanFundResult: { amount: 0, distribution: {}, status: 'ok', missingAmount: 0 },
                loanFundAmount: 0,
                loanFundMissing: 0,
                loanFundDistribution: {},
                bankData: { breakdown: {}, remainder: 0 },
                bankSummary: { 1000: 0 },
                totalToWithdraw: 0
            }
        });
        assert.match(csv, /1,Ana,1000,0,0,1000,0,1000,/, 'CSV employee row in normal mode must report 0 deducted loans to match footer');
        assert.match(csv, /Total Préstamos Descontados en Nómina.*,0/);
        assert.equal(/Recaudación Restante en Empresa,200/.test(csv), false);
    });

    test('buildCSVContent reflects 3-state payoutStatus (Pendiente / En sobre / Pagado)', () => {
        const csv = SplitXExport.buildCSVContent({
            currencySymbol: 'RD$',
            data: {
                payrollMode: 'normal',
                denoms: [1000],
                summary: { 1000: 2 },
                empRows: [
                    { idx: 1, name: 'Ana', amount: 1000, paid: true, payoutStatus: 'paid', status: 'ok', 1000: 1 },
                    { idx: 2, name: 'Luis', amount: 1000, paid: false, payoutStatus: 'packed', status: 'ok', 1000: 1 },
                    { idx: 3, name: 'Marta', amount: 1000, paid: false, payoutStatus: 'pending', status: 'ok', 1000: 1 }
                ],
                payrollSummary: { count: 0, gross: 0, bonuses: 0, discounts: 0, loans: 0, net: 0 },
                loanFundResult: { amount: 0, distribution: {}, status: 'ok', missingAmount: 0 },
                loanFundAmount: 0,
                loanFundMissing: 0,
                loanFundDistribution: {},
                bankData: { breakdown: {}, remainder: 0 },
                bankSummary: { 1000: 0 },
                totalToWithdraw: 0
            }
        });
        assert.match(csv, /Ana,1000,Pagado,/);
        assert.match(csv, /Luis,1000,En sobre,/);
        assert.match(csv, /Marta,1000,Pendiente,/);
    });

    test('buildExportData and buildCSVContent avoid IEEE-754 float drift on decimal coins and include Cuadre & missing cash summary (Sprint F)', () => {
        const data = SplitXExport.buildExportData({
            state: {
                payrollMode: 'normal',
                denominations: [0.25, 0.10, 0.05],
                inventory: { 0.25: 1, 0.10: 1, 0.05: 0 }
            },
            calculateDistribution: () => ({
                results: [
                    { id: 1, name: 'Ana', amount: 0.10, paid: false, payoutStatus: 'packed', status: 'ok', distribution: { 0.10: 1 }, lockedDistribution: { 0.10: 1 }, _missingAmount: 0 },
                    { id: 2, name: 'Luis', amount: 0.20, paid: false, payoutStatus: 'pending', status: 'error', distribution: {}, _missingAmount: 0.20 }
                ],
                loanFundResult: { amount: 0, distribution: {}, status: 'ok', missingAmount: 0 }
            }),
            calculateBankNeeds: () => ({
                breakdown: { 0.25: { final: 0 }, 0.10: { final: 3 }, 0.05: { final: 0 } },
                remainder: 0
            }),
            getPayrollSummary: () => ({ count: 0, gross: 0, bonuses: 0, discounts: 0, loans: 0, net: 0 }),
            getEffectiveEmployeeAmount: (e) => e.amount
        });

        // 3 * 0.10 in float is 0.30000000000000004; integer-cent arithmetic must yield exact 0.3
        assert.equal(data.totalToWithdraw, 0.3);
        assert.ok(data.ledgerSummary, 'buildExportData must include ledgerSummary');
        assert.equal(data.ledgerSummary.totalBox, 0.35);
        assert.equal(data.ledgerSummary.packedTotal, 0.1);
        assert.equal(data.ledgerSummary.pendingTotal, 0.2);
        assert.equal(data.ledgerSummary.totalMissing, 0.2);

        const csv = SplitXExport.buildCSVContent({ data, currencySymbol: 'US$' });
        assert.equal(csv.includes('0.30000000000000004'), false, 'CSV must never emit IEEE-754 drift artifacts');
        assert.match(csv, /Total Nómina,0\.3\b/);
        assert.match(csv, /TOTAL A RETIRAR DEL BANCO.*,0\.3\b/);
        assert.match(csv, /Caja inicial,0\.35\b/);
        assert.match(csv, /En sobre,0\.1\b/);
        assert.match(csv, /Suelto en mesa,0\.25\b/);
        assert.match(csv, /FALTANTE EN CAJA,0\.2\b/);

        // Sprint G (EGM Round 3 High #3 / #6): externally-paid employees must separate Pagados de caja vs Pagados sin caja
        const extData = SplitXExport.buildExportData({
            state: {
                payrollMode: 'normal',
                denominations: [1000],
                inventory: { 1000: 5 }
            },
            calculateDistribution: () => ({
                results: [
                    { id: 1, name: 'ExtPaid', amount: 2000, paid: true, payoutStatus: 'paid', status: 'ok', distribution: {}, lockedDistribution: null, _missingAmount: 0 }
                ],
                loanFundResult: { amount: 0, distribution: {}, status: 'ok', missingAmount: 0 }
            }),
            calculateBankNeeds: () => ({ breakdown: { 1000: { final: 0 } }, remainder: 0 }),
            getPayrollSummary: () => ({ count: 0, gross: 0, bonuses: 0, discounts: 0, loans: 0, net: 0 }),
            getEffectiveEmployeeAmount: (e) => e.amount
        });
        assert.equal(extData.ledgerSummary.paidFromBoxTotal, 0);
        assert.equal(extData.ledgerSummary.paidExternalTotal, 2000);
        const extCsv = SplitXExport.buildCSVContent({ data: extData, currencySymbol: 'RD$' });
        assert.match(extCsv, /Pagado de caja,0\b/);
        assert.match(extCsv, /Pagado sin caja.*,2000\b/);
    });

    test('loadScriptOnce removes failed <script> tag so retry after transient network error succeeds (Sprint C)', async () => {
        const scripts = [];
        const prevDoc = globalThis.document;
        const prevXlsx = globalThis.XLSX;
        globalThis.XLSX = undefined;
        globalThis.document = /** @type {any} */ ({
            querySelector: (sel) => scripts.find((s) => sel.includes(s.attr)) || null,
            createElement: () => {
                const s = {
                    attr: '',
                    setAttribute: (k) => { s.attr = k; },
                    addEventListener: () => {},
                    remove: () => { const i = scripts.indexOf(s); if (i >= 0) scripts.splice(i, 1); }
                };
                return s;
            },
            head: {
                appendChild: (s) => {
                    scripts.push(s);
                    if (scripts.length === 1 && !globalThis.__secondAttempt) {
                        globalThis.__secondAttempt = true;
                        setTimeout(() => s.onerror && s.onerror(), 0);
                    } else {
                        globalThis.XLSX = { utils: { book_new: () => ({}), aoa_to_sheet: () => ({}), book_append_sheet: () => {} }, writeFile: () => {} };
                        setTimeout(() => s.onload && s.onload(), 0);
                    }
                }
            }
        });
        try {
            const alerts = [];
            const exporter = SplitXExport.createExporter({
                getState: () => ({ denominations: [1000], payrollMode: 'normal' }),
                getCurrencySymbol: () => 'RD$',
                calculateDistribution: () => ({ results: [], loanFundResult: { amount: 0, distribution: {}, status: 'ok', missingAmount: 0 } }),
                calculateBankNeeds: () => ({ breakdown: { 1000: { final: 0 } }, remainder: 0 }),
                getPayrollSummary: () => ({ count: 0, gross: 0, bonuses: 0, discounts: 0, loans: 0, net: 0 }),
                getEffectiveEmployeeAmount: (e) => e.amount,
                showCustomAlert: (o) => alerts.push(o)
            });

            await exporter.exportToExcel();
            assert.equal(alerts.length, 1, 'first offline attempt should alert');
            assert.equal(scripts.length, 0, 'failed <script> must be removed from document.head so retries do not hang');

            await exporter.exportToExcel();
            assert.equal(alerts.length, 1, 'second attempt after network recovery must succeed without hanging');
        } finally {
            delete globalThis.__secondAttempt;
            globalThis.document = prevDoc;
            globalThis.XLSX = prevXlsx;
        }
    });
});
