const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./server.js');
const { loadPlaywright } = require('./helpers.js');

const open = async () => {
    const server = await startServer();
    const browser = await loadPlaywright().chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', e => { if (!/tailwind/i.test(e.message)) errors.push(e.message); });
    await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
    await page.goto(server.url + '/index.html', { waitUntil: 'load' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => window.app.openImportModal());
    const close = async () => { await browser.close(); await server.close(); };
    return { page, errors, close };
};
const employees = page => page.evaluate(() => JSON.parse(localStorage.getItem('Split_data') || '{}').employees || []);

describe('Excel paste: precision and all-or-nothing import', () => {
    test('mixed rows are rejected atomically, with visible line errors and intact paste', async () => {
        const { page, errors, close } = await open();
        try {
            const text = '1\tAna\t1.300,00\n2\tLuis\t1,300\n3\tMarta\t700.00';
            await page.fill('#jsonImportInput', text);
            await page.waitForFunction(() => document.getElementById('importErrorMsg').textContent.includes('1 rechazadas'));
            assert.match(await page.textContent('#importErrorMsg'), /3 filas: 2 válidas, 1 rechazadas/);
            assert.match(await page.textContent('#importErrorMsg'), /Línea 2.*ambiguo/i);
            await page.evaluate(() => window.app.processImport());
            assert.deepEqual(await employees(page), [], 'a mixed payroll cannot partially enter saved state');
            assert.equal(await page.inputValue('#jsonImportInput'), text, 'paste remains for correction');
            assert.equal(await page.locator('#importModal').isVisible(), true);
            assert.deepEqual(errors, []);
        } finally { await close(); }
    });
    test('explicit English format resolves a grouped amount and imports all employees', async () => {
        const { page, errors, close } = await open();
        try {
            await page.fill('#jsonImportInput', '1\tAna\t1,300\n2\tLuis\t2,500');
            assert.match(await page.textContent('#importErrorMsg'), /ambiguo/i);
            await page.selectOption('#excelAmountFormat', 'en');
            await page.waitForFunction(() => document.getElementById('importErrorMsg').classList.contains('hidden'));
            await page.evaluate(() => window.app.processImport());
            assert.deepEqual((await employees(page)).map(x => x.amount), [1300, 2500]);
            assert.deepEqual(errors, []);
        } finally { await close(); }
    });
    test('European amounts work without choosing a format and invalid JSON amount blocks import', async () => {
        const { page, errors, close } = await open();
        try {
            await page.fill('#jsonImportInput', '1\tAna\t1.300,00');
            await page.evaluate(() => window.app.processImport());
            assert.equal((await employees(page))[0].amount, 1300);
            await page.evaluate(() => window.app.openImportModal());
            await page.evaluate(() => window.app.switchImportTab('json'));
            await page.fill('#jsonImportInput', '[{"nombre":"Luis","monto":"1,300"}]');
            await page.evaluate(() => window.app.processImport());
            assert.equal((await employees(page)).length, 1);
            assert.match(await page.textContent('#importErrorMsg'), /ambiguo/i);
            assert.deepEqual(errors, []);
        } finally { await close(); }
    });
});
