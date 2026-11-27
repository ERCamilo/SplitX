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
                        'content-security-policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'"
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

            // 2. Hybrid checklist mode (empty Mi Caja): left status pill marks directly Paid (✓✓) & enables undo button
            await page.locator('#employeeList button[data-card-action="advance-status"]').first().click();
            await page.waitForSelector('#employeeList button.status-paid-green[data-card-action="advance-status"]');
            await page.waitForSelector('#employeeList button[data-card-action="advance-status"] i.fa-check-double', { state: 'attached' });
            await page.waitForSelector('#employeeList button[data-card-action="revert-status"]:not([disabled])');

            // Revert Paid -> Pendiente via confirmation dialog
            await page.locator('#employeeList button[data-card-action="revert-status"]').first().click();
            await page.waitForSelector('#customDialogModal:not(.hidden)');
            await page.locator('#dialogActions button').last().click();
            await page.waitForSelector('#customDialogModal.hidden', { state: 'attached' });
            await page.waitForSelector('#employeeList button[data-card-action="revert-status"][disabled]');

            // 3. Navigate bottom bar: Mi Caja -> Banco (apply cash) -> Cuadre -> Nómina (3-state: Pendiente -> En sobre -> Pagado)
            await page.locator('#bnav-caja').click();
            assert.equal(await page.locator('#bnav-caja').evaluate(el => el.classList.contains('active')), true);
            await page.locator('#bnav-banco').click();
            assert.equal(await page.locator('#view-bank').isVisible(), true);
            await page.locator('#applyBankBtn').click();

            await page.locator('#bnav-cuadre').click();
            assert.equal(await page.locator('#view-cuadre').isVisible(), true);

            await page.locator('#bnav-nomina').click();
            assert.equal(await page.locator('#employeeList').isVisible(), true);

            // Click 1 -> En sobre (blue pill + single check) + 5s Toast Undo works
            await page.locator('#employeeList button[data-card-action="advance-status"]').first().click();
            await page.waitForSelector('#employeeList button.status-packed[data-card-action="advance-status"]');
            await page.waitForSelector('#appToast button:has-text("Deshacer")');
            await page.locator('#appToast button:has-text("Deshacer")').click();
            await page.waitForSelector('#employeeList button[data-card-action="revert-status"][disabled]');

            // Re-advance -> En sobre -> Pagado
            await page.locator('#employeeList button[data-card-action="advance-status"]').first().click();
            await page.waitForSelector('#employeeList button.status-packed[data-card-action="advance-status"]');
            await page.locator('#employeeList button[data-card-action="advance-status"]').first().click();
            await page.waitForSelector('#employeeList button.status-paid-green[data-card-action="advance-status"]');
            await page.waitForSelector('#employeeList button[data-card-action="advance-status"] i.fa-check-double', { state: 'attached' });

            // Search & Status Filter (accent-insensitive search + status pills without mutating list)
            await page.fill('#empSearchInput', 'maria');
            assert.match(await page.textContent('#employeeList'), /María Móvil/);
            await page.locator('#empFilterPending').click();
            assert.match(await page.textContent('#employeeList'), /Ningún colaborador coincide/);
            await page.locator('#employeeList button:has-text("Limpiar filtros")').click();
            assert.match(await page.textContent('#employeeList'), /María Móvil/);

            // Cuadre physical count net variance (bill swap nets to 0)
            await page.locator('#bnav-cuadre').click();
            await page.waitForSelector('#cuadreTableBody input[data-cuadre-actual="1000"]');
            await page.fill('#cuadreTableBody input[data-cuadre-actual="1000"]', '1');
            await page.waitForSelector('#cuadreVarianceBanner:not(.hidden)');
            assert.match(await page.textContent('#cuadreVarianceBanner'), /Sobran/);
            await page.locator('#bnav-nomina').click();

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
