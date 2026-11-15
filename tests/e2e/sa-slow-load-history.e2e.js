/**
 * Apertura desde Sistema de Asistencia (SA) con los CDN lentos: SA deja de intentar
 * a los pocos segundos, así que SplitX debe responder al PING antes de que termine de cargar.
 * Antes del arreglo se abría con la nómina vieja guardada.
 * Ejecutar: npm run test:e2e
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./server.js');
const { loadPlaywright, sampleExport } = require('./helpers.js');

const SA_ORIGIN = 'http://localhost:7391';

/** Página mínima que imita sendToSplitX de SA: abre SplitX, PING cada 200 ms, nómina tras READY, se rinde a los giveUpMs. */
const saPage = (splitxUrl, payload, giveUpMs) => `<!doctype html><meta charset="utf-8"><title>SA</title>
<button id="send">Enviar a SplitX</button><p id="log"></p>
<script>
document.getElementById('send').onclick = () => {
  const target = new URL(${JSON.stringify(splitxUrl)}).origin;
  const payload = ${JSON.stringify(payload)};
  const w = window.open(${JSON.stringify(splitxUrl)}, '_blank');
  let sent = false, done = false;
  const log = (t) => { document.getElementById('log').textContent += t + ' '; };
  const onMsg = (e) => {
    if (e.origin !== target || e.source !== w || !e.data) return;
    if (e.data.type === 'SPLITX_READY' && !sent && payload) { sent = true; w.postMessage(payload, target); log('sent'); }
    if (e.data.type === 'SPLITX_IMPORT_SUCCESS') { done = true; log('success'); }
  };
  window.addEventListener('message', onMsg);
  const ping = setInterval(() => { if (!sent) { try { w.postMessage({ type: 'SPLITX_PING', transferId: 'tx-e2e', source: 'Sistema-de-Asistencia', version: '1.0' }, target); } catch (e) {} } }, 200);
  setTimeout(() => { clearInterval(ping); if (!done) { window.removeEventListener('message', onMsg); log('gave-up'); } }, ${giveUpMs});
};
</script>`;

const payloadFor = (employees) => ({
    type: 'SPLITX_IMPORT_PAYROLL', transferId: 'tx-e2e', source: 'Sistema-de-Asistencia', version: '1.0',
    ...employees[0].exportContext, employees
});

/**
 * Prepara SplitX con una nómina vieja guardada y abre la página falsa de SA.
 * Los CDN tardan cdnDelayMs (como una conexión lenta) y luego fallan.
 */
const setup = async ({ payload, giveUpMs = 1500, cdnDelayMs = 2500 } = {}) => {
    const { chromium } = loadPlaywright();
    const server = await startServer();
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    const splitxUrl = `${server.url}/index.html`;
    await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith(server.url)) return route.continue();
        if (url.startsWith(SA_ORIGIN)) return route.fulfill({ contentType: 'text/html', body: saPage(splitxUrl, payload, giveUpMs) });
        await new Promise((r) => setTimeout(r, cdnDelayMs));
        return route.abort().catch(() => {});
    });
    // Nómina vieja guardada en SplitX.
    const seed = await context.newPage();
    await seed.goto(splitxUrl, { waitUntil: 'load' });
    await seed.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('Split_data', JSON.stringify({ employees: [{ id: 1, name: 'Nómina vieja', amount: 1, paid: false }] }));
        localStorage.setItem('Split_sheets_v2', JSON.stringify({ tourDone: true }));
    });
    await seed.close();
    const sa = await context.newPage();
    sa.on('pageerror', (e) => errors.push('SA: ' + e.message));
    await sa.goto(`${SA_ORIGIN}/sa.html`);
    const [splitx] = await Promise.all([context.waitForEvent('page'), sa.click('#send')]);
    splitx.on('pageerror', (e) => { if (!/tailwind/i.test(e.message)) errors.push(e.message); });
    const names = () => splitx.evaluate(() => (JSON.parse(localStorage.getItem('Split_data') || '{}').employees || []).map((e) => e.name));
    const close = async () => { await browser.close(); await server.close(); };
    return { sa, splitx, errors, names, close };
};

describe('opening SplitX from Sistema de Asistencia', () => {
    test('slow CDN: the new payroll still arrives and replaces the saved one', async () => {
        const { sa, splitx, errors, names, close } = await setup({ payload: payloadFor(sampleExport(3)) });
        try {
            await splitx.waitForSelector('#customDialogModal:not(.hidden)', { timeout: 15000 });
            await splitx.getByRole('button', { name: 'Reemplazar todo' }).click();
            await splitx.waitForFunction(() => (JSON.parse(localStorage.getItem('Split_data') || '{}').employees || []).length === 3);
            assert.deepEqual(await names(), ['Empleado 1', 'Empleado 2', 'Empleado 3']);
            // SA got READY in time (it would have given up otherwise).
            assert.match(await sa.textContent('#log'), /sent/);
            // The import is in the history and marked as the loaded payroll.
            await splitx.evaluate(() => /** @type {any} */ (window).app.openHistoryModal());
            const item = splitx.locator('#historyList .history-item').first();
            assert.match(await item.textContent(), /Nómina de prueba/);
            assert.match(await item.textContent(), /Cargada/);
            assert.match(await item.textContent(), /Sistema de Asistencia/);
            // Tailwind is blocked in tests, so check the class rather than visibility.
            await splitx.waitForTimeout(5500);
            assert.equal(await splitx.evaluate(() => document.getElementById('saStaleBanner').classList.contains('hidden')), true);
            assert.deepEqual(errors, []);
        } finally { await close(); }
    });

    test('no payroll from SA: a banner says the saved payroll is shown', async () => {
        const { splitx, errors, names, close } = await setup({ payload: null, giveUpMs: 500, cdnDelayMs: 300 });
        try {
            await splitx.waitForSelector('#saStaleBanner:not(.hidden)', { timeout: 15000 });
            assert.match(await splitx.textContent('#saStaleText'), /No llegó una nómina nueva/);
            assert.deepEqual(await names(), ['Nómina vieja']);
            assert.deepEqual(errors, []);
        } finally { await close(); }
    });
});

describe('import history', () => {
    test('an older payroll can be loaded again from the history', async () => {
        const { chromium } = loadPlaywright();
        const server = await startServer();
        const browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
        const errors = [];
        page.on('pageerror', (e) => { if (!/tailwind/i.test(e.message)) errors.push(e.message); });
        await page.route('**/*', (route) => (route.request().url().startsWith(server.url) ? route.continue() : route.abort()));
        try {
            await page.goto(`${server.url}/index.html`, { waitUntil: 'load' });
            await page.evaluate(() => { localStorage.clear(); localStorage.setItem('Split_sheets_v2', JSON.stringify({ tourDone: true })); });
            await page.reload({ waitUntil: 'load' });
            const importJson = async (data) => {
                await page.evaluate(() => { const app = /** @type {any} */ (window).app; app.openImportModal(); app.switchImportTab('json'); });
                await page.fill('#jsonImportInput', JSON.stringify(data));
                await page.evaluate(() => { /** @type {any} */ (window).app.processImport(); });
            };
            const first = sampleExport(2);
            await importJson(first);
            await page.click('#postImportModal button:has-text("Manual")');
            const second = sampleExport(4).map((e) => ({ ...e, exportContext: { ...e.exportContext, payrollName: 'Nómina siguiente', period: { start: '2026-10-16', end: '2026-10-31' } } }));
            await importJson(second);
            await page.click('#customDialogModal button:has-text("Reemplazar lista")');
            await page.click('#postImportModal button:has-text("Manual")');

            await page.click('#historyBtn');
            const items = page.locator('#historyList .history-item');
            assert.equal(await items.count(), 2);
            assert.match(await items.nth(0).textContent(), /Nómina siguiente.*Cargada/s);
            assert.match(await items.nth(0).textContent(), /16 oct – 31 oct 2026/);
            assert.match(await items.nth(1).textContent(), /Nómina de prueba/);

            await items.nth(1).locator('button:has-text("Cargar")').click();
            await page.click('#customDialogModal button:has-text("Reemplazar lista")');
            await page.click('#postImportModal button:has-text("Manual")');
            const names = await page.evaluate(() => JSON.parse(localStorage.getItem('Split_data')).employees.map((e) => e.name));
            assert.deepEqual(names, ['Empleado 1', 'Empleado 2']);

            await page.click('#historyBtn');
            assert.match(await items.nth(1).textContent(), /Cargada/);
            assert.doesNotMatch(await items.nth(0).textContent(), /Cargada/);
            assert.deepEqual(errors, []);
        } finally { await browser.close(); await server.close(); }
    });
});
