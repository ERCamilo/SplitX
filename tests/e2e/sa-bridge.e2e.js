/**
 * Contract-level SA -> SplitX browser checks.
 * Fake sender is served under the exact allowed SA origin; NO live SA account or
 * private payroll data is used. Receiver is the unmodified SplitX app in Chromium.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPlaywright } = require('./helpers.js');
const { startServer } = require('./server.js');

const SA_ORIGIN = 'https://asistencia.erlin.do';

const setup = async () => {
    const server = await startServer();
    const { chromium } = loadPlaywright();
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, ignoreHTTPSErrors: true });
    const errors = [];
    context.on('page', page => page.on('pageerror', e => {
        if (!/tailwind/i.test(e.message)) errors.push(e.message);
    }));
    await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(SA_ORIGIN + '/')) return route.fulfill({
            status: 200, contentType: 'text/html', body: '<!doctype html><html><head><title>Emisor SA simulado</title></head><body>Emisor de prueba</body></html>'
        });
        if (url.startsWith(server.url + '/')) return route.continue();
        return route.abort();
    });
    const close = async () => { await browser.close(); await server.close(); };
    return { context, server, errors, close };
};

describe('SA cross-origin postMessage to the real SplitX browser app', () => {
    test('receives payroll, acknowledges sender, persists names and prints folio', async () => {
        const { context, server, errors, close } = await setup();
        try {
            const sender = await context.newPage();
            await sender.goto(SA_ORIGIN + '/fake-payroll-sender', { waitUntil: 'load' });
            const popupPromise = sender.waitForEvent('popup');
            await sender.evaluate((url) => {
                window.__saAcks = [];
                window.addEventListener('message', (event) => {
                    window.__saAcks.push({ ...event.data, origin: event.origin });
                });
                window.splitxPopup = window.open(url, '_blank');
            }, server.url + '/index.html');
            const receiver = await popupPromise;
            await receiver.waitForLoadState('load');
            await receiver.waitForFunction(() => Boolean(window.app));

            await sender.evaluate((targetOrigin) => {
                window.splitxPopup.postMessage({
                    type: 'SPLITX_PING', transferId: 'qa_ping', version: '1.0'
                }, targetOrigin);
            }, server.url);
            await sender.waitForFunction(() => window.__saAcks.some(m => m.type === 'SPLITX_READY' && m.transferId === 'qa_ping'));

            const employee = {
                nombre: 'Ana Ejemplo (Ref #001)', monto: 9200, bruto: 10000,
                bonificaciones: 500, descuentos: 800, prestamos: 500,
                employeeNumber: '001', employeeName: 'Ana Ejemplo',
                workDays: { unit: 'equivalent-day', regular: 10, overtime: 0, total: 10 },
                loanBreakdown: [{
                    loanId: 'L1', concept: 'Adelanto', deductionAmount: 500,
                    principalAmount: 400, interestAmount: 100, balanceAfter: 1200
                }],
                loanSummary: { projectedBalanceAfter: 1200 }
            };
            const payroll = {
                type: 'SPLITX_IMPORT_PAYROLL', source: 'Sistema-de-Asistencia',
                version: '1.0', transferId: 'qa_sa_payroll_1', currency: 'DOP',
                period: { start: '2026-10-01', end: '2026-10-15' },
                exportContext: {
                    schema: 'sa-splitx-payroll/v1', projectName: 'Obra Centro',
                    companyName: 'Empresa de prueba',
                    period: { start: '2026-10-01', end: '2026-10-15' }, currency: 'DOP'
                },
                employees: [employee]
            };
            await sender.evaluate(({ payload, targetOrigin }) => {
                window.splitxPopup.postMessage(payload, targetOrigin);
            }, { payload: payroll, targetOrigin: server.url });
            await sender.waitForFunction(() => window.__saAcks.some(m => m.type === 'SPLITX_IMPORT_SUCCESS' && m.transferId === 'qa_sa_payroll_1'));

            const ack = await sender.evaluate(() => window.__saAcks.find(m => m.type === 'SPLITX_IMPORT_SUCCESS'));
            assert.equal(ack.count, 1);
            assert.equal(ack.origin, new URL(server.url).origin);
            const snapshot = await receiver.evaluate(() => JSON.parse(localStorage.getItem('Split_data') || '{}'));
            assert.equal(snapshot.employees.length, 1);
            assert.equal(snapshot.employees[0].employeeNumber, '001');
            assert.equal(snapshot.employees[0].payroll.loanDetails.remainingBalance, 1200);
            assert.equal(snapshot.employees[0].payroll.loanDetails.principal, 400);
            assert.equal(snapshot.employees[0].payroll.loanDetails.interestAmount, 100);
            await receiver.evaluate(() => window.app.openSheetStudio());
            await receiver.waitForSelector('#ssBar');
            await receiver.click('[data-act="sheet"][data-v="B"]');
            const sheetText = await receiver.textContent('#ssCanvas');
            assert.match(sheetText, /Ana Ejemplo/);
            await receiver.reload({ waitUntil: 'load' });
            const afterReload = await receiver.evaluate(() => JSON.parse(localStorage.getItem('Split_data') || '{}'));
            assert.equal(afterReload.employees[0].name, employee.nombre);
            assert.deepEqual(errors, []);
        } finally { await close(); }
    });

    test('corrupt state is backed up and app still starts', async () => {
        const { context, server, errors, close } = await setup();
        try {
            const page = await context.newPage();
            await page.goto(server.url + '/index.html', { waitUntil: 'load' });
            const corrupt = '{"employees":[{"id":1';
            await page.evaluate(value => localStorage.setItem('Split_data', value), corrupt);
            await page.reload({ waitUntil: 'load' });
            const data = await page.evaluate(() => ({
                backup: localStorage.getItem('Split_data_corrupt_backup'),
                appReady: typeof window.app?.openSheetStudio === 'function'
            }));
            assert.equal(data.backup, corrupt);
            assert.equal(data.appReady, true);
            assert.deepEqual(errors, []);
        } finally { await close(); }
    });
});
