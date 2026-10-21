/**
 * Pruebas de interfaz del editor de hojas imprimibles (Chromium con Playwright).
 * Ejecutar: npm run test:e2e
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { openStudio, dragBy } = require('./helpers.js');

const cards = (s) => s.templates.find((t) => t.id === s.active.A).template;
const table = (s) => s.templates.find((t) => t.id === s.active.B).template;

describe('envelope card editor', () => {
    test('cards match SplitX; a concept next to its total is flagged and "Desglosar" fixes it', async () => {
        const { page, errors, close } = await openStudio(3);
        try {
            assert.match(await page.textContent('#ssChecksBtn'), /Cuadra con SplitX/);
            await page.locator('#ssPalette [data-pi]', { hasText: 'Descuento de ley' }).first().click();
            assert.match(await page.textContent('#ssChecksBtn'), /aviso/);
            assert.match(await page.textContent('#ssCanvasInfo'), /⚠/);
            await page.click('#ssChecksBtn');
            await page.click('[data-act="breakdown"]');
            assert.match(await page.textContent('#ssChecksBtn'), /Cuadra con SplitX/);
            assert.deepEqual(errors, []);
        } finally { await close(); }
    });

    test('quick tools add an operator to the selected cell; undo removes it', async () => {
        const { page, store, close } = await openStudio(2);
        try {
            await page.locator('#ssCardEdit [data-zone="A:1:1"]').click();
            await page.click('.ss-quick [data-act="quick-chip"][data-v="1"]');
            assert.deepEqual(cards(await store()).rows[1].cells[1].chips.map((c) => c.kind), ['field', 'op']);
            await page.keyboard.press('Control+z');
            assert.deepEqual(cards(await store()).rows[1].cells[1].chips.map((c) => c.kind), ['field']);
        } finally { await close(); }
    });

    test('a starter template plus "Ajustar al tamaño" fits a small card', async () => {
        const { page, store, close } = await openStudio(6);
        try {
            await page.click('#ssTplBtn');
            await page.click('[data-act="tpl-new"]');
            await page.click('[data-act="tpl-starter"][data-v="card-detail"]');
            await page.keyboard.press('Escape');
            await page.click('#ssPageBtn');
            await page.click('[data-set="lay.mode"][data-v="\\"size\\""]');
            await page.fill('#ssCH', '35');
            await page.dispatchEvent('#ssCH', 'input');
            await page.click('#ssPop [data-act="font-fit"]');
            const t = cards(await store());
            assert.equal(t.name, 'Sobre detallado');
            assert.ok(t.layout.fontSize < 8.5, `fontSize=${t.layout.fontSize}`);
            assert.equal((await page.textContent('#ssCanvasWarn')).trim(), '');
        } finally { await close(); }
    });
});

describe('print step', () => {
    test('a printed sheet reopens in the print step and warns when the data changed', async () => {
        const { page, close } = await openStudio(3);
        try {
            await page.click('[data-act="print-step"]');
            await page.evaluate(() => { window.print = () => window.dispatchEvent(new Event('afterprint')); });
            await page.click('[data-act="print"]');
            await page.click('[data-act="close"]');
            await page.evaluate(() => {
                const d = JSON.parse(localStorage.getItem('Split_data'));
                d.employees[1].payroll.gross += 100;
                localStorage.setItem('Split_data', JSON.stringify(d));
            });
            await page.reload({ waitUntil: 'load' });
            await page.evaluate(() => /** @type {any} */ (window).app.openSheetStudio());
            await page.waitForSelector('#ssPrint');
            const side = await page.textContent('.ss-printside');
            assert.match(side, /ya no coincide/);
            assert.match(side, /Cambió: Empleado 2 Prueba/);
            assert.match(side, /no cuadra/);
        } finally { await close(); }
    });

    test('signature sheet: footer only on the last page, column resize with undo', async () => {
        const { page, store, close } = await openStudio(40);
        try {
            await page.click('[data-act="sheet"][data-v="B"]');
            await page.click('[data-act="print-step"]');
            await page.click('.ss-printside [data-set="opt.signatures"][data-v="\\"last\\""]');
            const feet = await page.$$eval('#ssDesk .ss-page', (pages) => pages.map((p) => !!p.querySelector('.ss-sig-foot')));
            assert.ok(feet.length >= 3);
            assert.deepEqual(feet, feet.map((_, i) => i === feet.length - 1));
            const before = table(await store()).columns.map((c) => c.width);
            await dragBy(page, page.locator('#ssDesk [data-resize="tcol:2"]'), 40, 0);
            const after = table(await store()).columns.map((c) => c.width);
            assert.notDeepEqual(after, before);
            assert.equal(Math.round(after.reduce((a, b) => a + b) * 100), Math.round(before.reduce((a, b) => a + b) * 100));
            await page.keyboard.press('Control+z');
            assert.deepEqual(table(await store()).columns.map((c) => c.width), before);
        } finally { await close(); }
    });
});

describe('first-time guide', () => {
    test('shows once, and "?" brings it back', async () => {
        const { page, store, close } = await openStudio(2, { tour: true });
        try {
            await page.waitForSelector('.ss-tour');
            await page.click('[data-act="tour-next"]');
            await page.click('[data-act="tour-next"]');
            await page.click('[data-act="tour-end"]');
            assert.equal((await store()).tourDone, true);
            assert.equal(await page.locator('.ss-tour').count(), 0);
            await page.click('[data-act="tour"]');
            assert.equal(await page.locator('.ss-tour').count(), 1);
        } finally { await close(); }
    });
});
