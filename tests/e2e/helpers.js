/**
 * Utilidades de las pruebas de interfaz: abren SplitX en Chromium, importan empleados de ejemplo
 * y abren el editor de hojas. Las peticiones a otros dominios (CDN) se bloquean: todo es local.
 */
const { startServer } = require('./server.js');

/** @returns {typeof import('playwright')} */
const loadPlaywright = () => {
    try { return require('playwright'); } catch (e) { return require('/opt/node-tools/node_modules/playwright'); }
};

/** Exportación sa-splitx-payroll/v1 con n empleados; uno de cada tres tiene adelanto. */
const sampleExport = (n) => Array.from({ length: n }, (_, i) => {
    const gross = 10000 + i * 250;
    const bonus = i % 2 ? 500 : 0;
    const loan = i % 3 === 0 ? 500 : 0;
    const discounts = Math.round(gross * 0.03) + 500;
    return {
        id: i + 1,
        nombre: `Empleado ${i + 1}`,
        monto: gross + bonus - discounts - loan,
        bruto: gross,
        bonificaciones: bonus,
        descuentos: discounts,
        prestamos: loan,
        employeeNumber: String(i + 1).padStart(3, '0'),
        employeeName: `Empleado ${i + 1} Prueba`,
        workDays: { unit: 'equivalent-day', regular: 10, total: 10 + (i % 2) / 2 },
        bonusDetails: bonus ? [{ id: 'asistencia', concept: 'Bono de asistencia', type: 'fixed', value: bonus, amount: bonus }] : [],
        deductionDetails: [
            { id: 'ley', concept: 'Descuento de ley', type: 'percentage', value: 3, amount: Math.round(gross * 0.03) },
            { id: 'equipo', concept: 'Reparación de equipo', type: 'fixed', value: 500, amount: 500 }
        ],
        exportContext: {
            schema: 'sa-splitx-payroll/v1', period: { start: '2026-10-01', end: '2026-10-15' }, currency: 'DOP',
            projectName: 'Obra Centro', companyName: 'Constructora Ejemplo', payrollName: 'Nómina de prueba'
        }
    };
});

/**
 * Abre SplitX limpio, importa `employees` empleados y abre el editor de hojas.
 * @param {number} employees
 */
const openStudio = async (employees = 3, { tour = false } = {}) => {
    const { chromium } = loadPlaywright();
    const server = await startServer();
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => { if (!/tailwind/i.test(e.message)) errors.push(e.message); });
    await page.route('**/*', (route) => (route.request().url().startsWith(server.url) ? route.continue() : route.abort()));
    await page.goto(`${server.url}/index.html`, { waitUntil: 'load' });
    await page.evaluate((skipTour) => {
        localStorage.clear();
        if (skipTour) localStorage.setItem('Split_sheets_v2', JSON.stringify({ tourDone: true }));
    }, !tour);
    await page.reload({ waitUntil: 'load' });
    await importEmployees(page, sampleExport(employees));
    await page.evaluate(() => /** @type {any} */ (window).app.openSheetStudio());
    await page.waitForSelector('#ssBar');
    const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('Split_sheets_v2') || 'null'));
    const close = async () => { await browser.close(); await server.close(); };
    return { page, errors, store, close };
};

const importEmployees = async (page, data) => {
    await page.evaluate(() => { const app = /** @type {any} */ (window).app; app.openImportModal(); app.switchImportTab('json'); });
    await page.fill('#jsonImportInput', JSON.stringify(data));
    await page.evaluate(() => /** @type {any} */ (window).app.processImport());
    await page.waitForFunction(() => (JSON.parse(localStorage.getItem('Split_data') || '{}').employees || []).length > 0);
};

/** Arrastra con el ratón el centro de `locator` dx/dy píxeles. */
const dragBy = async (page, locator, dx, dy) => {
    const b = await locator.boundingBox();
    const x = b.x + b.width / 2; const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
};

module.exports = { openStudio, sampleExport, importEmployees, dragBy, loadPlaywright };
