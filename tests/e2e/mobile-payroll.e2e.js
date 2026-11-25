const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./server.js');
const { loadPlaywright } = require('./helpers.js');

describe('mobile payroll workflow at 390x844', () => {
    test('adds employee via mobile drawer, switches bottom nav views, and opens operations/backup modal', async () => {
        const server = await startServer();
        const browser = await loadPlaywright().chromium.launch();
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = [];
        const cspViolations = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (msg) => {
            if (/Content Security Policy/i.test(msg.text())) cspViolations.push(msg.text());
        });
        await page.route('**/*', async (route) => {
            const url = route.request().url();
            if (!url.startsWith(server.url)) return route.abort();
            if (url.endsWith('/index.html')) {
                const response = await route.fetch();
                return route.fulfill({
                    response,
                    headers: {
                        ...response.headers(),
                        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'"
                    }
                });
            }
            return route.continue();
        });

        try {
            await page.goto(`${server.url}/index.html`, { waitUntil: 'load' });
            await page.evaluate(() => localStorage.clear());
            await page.reload({ waitUntil: 'load' });

            const layout = await page.evaluate(() => {
                const offenders = [];
                for (const el of document.querySelectorAll('*')) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.right > window.innerWidth + 2) {
                        offenders.push(`${el.tagName}#${el.id || ''}.${String(el.className || '').slice(0, 40)} right=${Math.round(r.right)}`);
                        if (offenders.length >= 5) break;
                    }
                }
                return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, offenders };
            });
            assert.ok(
                layout.scrollWidth <= layout.innerWidth + 2,
                `initial mobile payroll view overflowed horizontally: scrollWidth=${layout.scrollWidth} innerWidth=${layout.innerWidth} offenders=${JSON.stringify(layout.offenders)}`
            );

            // 1. Add employee via mobile FAB + drawer
            await page.locator('button.fab[aria-label="Agregar empleado"]').click();
            await page.waitForSelector('#addDrawer.open');
            await page.fill('#empNameMobile', 'María Móvil');
            await page.fill('#empAmountMobile', '2500');
            await page.locator('#addDrawer button:has-text("Agregar a la Nómina")').click();

            await page.waitForFunction(() => document.getElementById('employeeList')?.textContent?.includes('María Móvil'));
            assert.match(await page.textContent('#employeeList'), /María Móvil/);

            // 2. Toggle paid via delegated accessible button
            await page.locator('#employeeList button[aria-label="Marcar como pagado"]').first().click();
            await page.waitForSelector('#employeeList button[aria-label="Marcar como pendiente"]');

            // 3. Navigate bottom bar: Mi Caja -> Banco -> Nómina
            await page.locator('#bnav-caja').click();
            assert.equal(await page.locator('#bnav-caja').evaluate(el => el.classList.contains('active')), true);
            await page.locator('#bnav-banco').click();
            assert.equal(await page.locator('#view-bank').isVisible(), true);
            await page.locator('#bnav-nomina').click();
            assert.equal(await page.locator('#employeeList').isVisible(), true);

            // 4. Open & close Operations / Backup modal via accessible aria-label buttons
            await page.locator('nav button[aria-label="Operaciones de nómina"]').click();
            await page.waitForSelector('#operationsModal:not(.hidden)');
            assert.match(await page.textContent('#operationsModal'), /Guardar Respaldo/);
            assert.match(await page.textContent('#operationsModal'), /Purgar Datos Personales/);
            await page.locator('#operationsModal button[aria-label="Cerrar operaciones"]').click();
            await page.waitForSelector('#operationsModal.hidden', { state: 'attached' });

            assert.deepEqual(errors, []);
            assert.deepEqual(cspViolations, [], 'strict script-src self CSP must produce zero violations');
        } finally {
            await browser.close();
            await server.close();
        }
    });
});
