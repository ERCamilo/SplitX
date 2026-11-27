const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SplitXDialogs = require('../js/SplitXDialogs.js');
const SplitXEmployeeCard = require('../js/SplitXEmployeeCard.js');
const SplitXCurrencies = require('../js/SplitXCurrencies.js');

const makeFakeDoc = () => {
    const byId = new Map();
    const makeEl = (id = '') => {
        const classes = new Set();
        const attrs = new Map();
        const children = [];
        const el = {
            id,
            type: '',
            className: '',
            textContent: '',
            innerHTML: '',
            onclick: null,
            children,
            setAttribute: (k, v) => attrs.set(k, String(v)),
            getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
            addEventListener: () => {},
            contains: () => false,
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c)
            },
            appendChild: (ch) => {
                children.push(ch);
                if (ch && ch.id) byId.set(ch.id, ch);
                return ch;
            },
            remove: () => {
                if (el.id) byId.delete(el.id);
                const idx = body.children.indexOf(el);
                if (idx >= 0) body.children.splice(idx, 1);
            }
        };
        if (id) byId.set(id, el);
        return el;
    };
    const modal = makeEl('customDialogModal');
    modal.classList.add('hidden');
    makeEl('dialogIconContainer');
    makeEl('dialogIcon');
    makeEl('dialogTitle');
    makeEl('dialogMessage');
    makeEl('dialogActions');
    const body = makeEl('body');

    return {
        body,
        byId,
        getElementById: (id) => byId.get(id) || null,
        createElement: () => makeEl()
    };
};

describe('SplitXDialogs (Issue #28 extraction)', () => {
    test('showCustomConfirm escapes HTML, preserves newlines, and resolves chosen button value', async () => {
        const doc = makeFakeDoc();
        const dialogs = SplitXDialogs.createDialogs({ documentRef: doc, escapeHTML: SplitXCurrencies.escapeHTML });
        const promise = dialogs.showCustomConfirm({
            title: 'Confirmar',
            message: 'Linea 1 <script>x</script>\nLinea 2',
            confirmText: 'Sí <ok>',
            cancelText: 'No'
        });

        assert.equal(doc.byId.get('customDialogModal').classList.contains('hidden'), false);
        assert.match(doc.byId.get('dialogMessage').innerHTML, /Linea 1 &lt;script&gt;x&lt;\/script&gt;<br>Linea 2/);
        const buttons = doc.byId.get('dialogActions').children;
        assert.equal(buttons.length, 2);
        assert.match(buttons[1].innerHTML, /Sí &lt;ok&gt;/);

        buttons[1].onclick();
        assert.equal(await promise, true);
        assert.equal(doc.byId.get('customDialogModal').classList.contains('hidden'), true);
    });

    test('showToast escapes message and replaces previous toast', () => {
        const doc = makeFakeDoc();
        const dialogs = SplitXDialogs.createDialogs({ documentRef: doc, escapeHTML: SplitXCurrencies.escapeHTML, toastMs: 0 });
        dialogs.showToast('Hola <b>mundo</b>', 'success');
        assert.equal(doc.body.children.length, 1);
        assert.match(doc.body.children[0].innerHTML, /Hola &lt;b&gt;mundo&lt;\/b&gt;/);
    });

    test('showToast supports optional action button (Undo) that fires at most once and dismisses toast (Sprint F)', () => {
        const doc = makeFakeDoc();
        const dialogs = SplitXDialogs.createDialogs({ documentRef: doc, escapeHTML: SplitXCurrencies.escapeHTML, toastMs: 0 });
        let calls = 0;
        dialogs.showToast('Sobre apartado: Ana', 'success', {
            actionLabel: 'Deshacer',
            onAction: () => { calls += 1; }
        });
        const toast = doc.byId.get('appToast');
        assert.ok(toast, 'toast must be mounted with id appToast');
        const actionBtn = toast.children.find((ch) => ch.textContent === 'Deshacer');
        assert.ok(actionBtn, 'toast must render a clickable Deshacer action button');
        actionBtn.onclick();
        actionBtn.onclick();
        assert.equal(calls, 1, 'onAction must fire exactly once even on double-click');
        assert.equal(doc.byId.get('appToast'), undefined, 'toast must dismiss itself after action');
    });

    test('showToast renders an accessible close button (×) that dismisses immediately without waiting', () => {
        const doc = makeFakeDoc();
        const dialogs = SplitXDialogs.createDialogs({ documentRef: doc, escapeHTML: SplitXCurrencies.escapeHTML, toastMs: 60000 });
        dialogs.showToast('Notificación larga', 'info');
        const toast = doc.byId.get('appToast');
        assert.ok(toast, 'toast must be mounted');
        const closeBtn = toast.children.find((ch) => ch.getAttribute && ch.getAttribute('aria-label') === 'Cerrar notificación');
        assert.ok(closeBtn, 'toast must include a close button with aria-label="Cerrar notificación"');
        closeBtn.onclick();
        assert.equal(doc.byId.get('appToast'), undefined, 'clicking × must dismiss toast immediately');
    });

    test('concurrent showCustomDialog calls queue FIFO so no Promise is stranded (Sprint B)', async () => {
        const doc = makeFakeDoc();
        const dialogs = SplitXDialogs.createDialogs({ documentRef: doc, escapeHTML: SplitXCurrencies.escapeHTML });
        const p1 = dialogs.showCustomConfirm({ title: 'Primero', message: 'M1' });
        const p2 = dialogs.showCustomConfirm({ title: 'Segundo', message: 'M2' });

        // First dialog is visible now
        assert.equal(doc.byId.get('dialogTitle').textContent, 'Primero');
        doc.byId.get('dialogActions').children[1].onclick();
        assert.equal(await p1, true);

        // Second dialog automatically opens next and resolves cleanly
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(doc.byId.get('dialogTitle').textContent, 'Segundo');
        assert.equal(doc.byId.get('customDialogModal').classList.contains('hidden'), false);
        doc.byId.get('dialogActions').children[0].onclick();
        assert.equal(await p2, false);
    });
});

describe('SplitXEmployeeCard & Smart Advisor (Issue #28 extraction)', () => {
    test('generateSmartAdvisorData computes surplus and deficit cleanly', () => {
        const res = SplitXEmployeeCard.generateSmartAdvisorData(
            [1000, 500, 100],
            { 1000: 2, 500: 0, 100: 1 },
            [
                { id: 1, paid: false, _missingAmount: 600 },
                { id: 2, paid: true, _missingAmount: 500 }
            ]
        );
        assert.deepEqual(res.surplus, [{ denom: 1000, count: 2 }, { denom: 100, count: 1 }]);
        assert.deepEqual(res.deficit, [{ denom: 500, count: 1 }, { denom: 100, count: 1 }]);
    });

    test('generateSmartAdvisorData handles decimal coin deficits (0.29, 0.30) without float undercount (Sprint A)', () => {
        const res = SplitXEmployeeCard.generateSmartAdvisorData(
            [0.25, 0.10, 0.05, 0.01],
            { 0.25: 0, 0.10: 0, 0.05: 0, 0.01: 0 },
            [
                { id: 1, paid: false, _missingAmount: 0.29 },
                { id: 2, paid: false, _missingAmount: 0.30 }
            ]
        );
        const byDenom = Object.fromEntries(res.deficit.map((x) => [x.denom, x.count]));
        assert.equal(byDenom[0.25], 2);
        assert.equal(byDenom[0.05], 1);
        assert.equal(byDenom[0.01], 4);
    });

    test('generateSmartAdvisorData includes loanFundResult deficits when employees are covered (Sprint D)', () => {
        const res = SplitXEmployeeCard.generateSmartAdvisorData(
            [1000, 500, 200, 100],
            { 1000: 1, 500: 0, 200: 0, 100: 0 },
            [{ id: 1, paid: false, _missingAmount: 0 }],
            { amount: 700, status: 'error', missingAmount: 700 }
        );
        assert.deepEqual(res.surplus, [{ denom: 1000, count: 1 }]);
        assert.deepEqual(res.deficit, [{ denom: 500, count: 1 }, { denom: 200, count: 1 }]);
    });

    test('buildEmployeeCardHTML escapes employee name, uses dynamic currency symbol, and emits data-card-action hooks', () => {
        const state = {
            currency: 'EUR',
            currencySymbol: '€',
            denominations: [100, 50, 10],
            coinDenoms: [10],
            billColors: {},
            billImages: {},
            useDefaultImages: false,
            roundCoins: true,
            breakdownColumns: 5,
            breakdownSize: 'normal',
            breakdownFormat: 'badge',
            payrollMode: 'deductions'
        };
        const html = SplitXEmployeeCard.buildEmployeeCardHTML({
            emp: {
                id: 42,
                name: 'Ana <img src=x>',
                amount: 150,
                paid: false,
                status: 'ok',
                distribution: { 100: 1, 50: 1 },
                payroll: { gross: 200, bonuses: 0, discounts: 0, afterDiscounts: 200, loans: 50 }
            },
            index: 0,
            isPreview: false,
            state,
            expandedEmpCards: new Set(),
            getEffectiveEmployeeAmount: (e) => e.amount,
            fmt: (n) => `€ ${Number(n).toFixed(2)}`,
            fmtNum: (n) => Number(n).toFixed(2)
        });

        assert.match(html, /Ana &lt;img src=x&gt;/);
        assert.match(html, /€ 150\.00/);
        assert.equal(/\$\s*150/.test(html), false, 'must not hardcode $');
        assert.match(html, /data-card-action="advance-status"/);
        assert.match(html, /data-card-action="revert-status"/);
        assert.match(html, /data-card-action="edit"/);
        assert.match(html, /data-card-action="remove"/);
        assert.match(html, /data-emp-id="42"/);
    });

    test('buildEmployeeCardHTML renders 3-state icons, pins actions bar outside content, and toggles SA ref vs order number', () => {
        const baseState = {
            currency: 'DOP',
            currencySymbol: 'RD$',
            denominations: [1000, 500],
            coinDenoms: [25],
            billColors: {},
            billImages: {},
            useDefaultImages: false,
            roundCoins: true,
            breakdownColumns: 5,
            breakdownSize: 'normal',
            breakdownFormat: 'badge',
            payrollMode: 'normal',
            statusColorScheme: 'traffic',
            cardNumberMode: 'ref'
        };
        const render = (emp, stateOverrides = {}) => SplitXEmployeeCard.buildEmployeeCardHTML({
            emp,
            index: 3,
            isPreview: false,
            state: { ...baseState, ...stateOverrides },
            expandedEmpCards: new Set(),
            getEffectiveEmployeeAmount: (e) => e.amount,
            fmt: (n) => `RD$ ${Number(n).toFixed(2)}`,
            fmtNum: (n) => Number(n).toFixed(2)
        });

        // Pending (traffic default: amber + clock icon, SA employeeNumber on pill, actions bar sibling of content)
        const pendingHtml = render({
            id: 1, _originalIndex: 0, employeeNumber: '003', employeeName: 'Miguel Rodríguez',
            name: 'Miguel Rodríguez (Ref #003)', amount: 1500, paid: false, payoutStatus: 'pending',
            status: 'ok', distribution: { 1000: 1, 500: 1 }
        });
        assert.match(pendingHtml, /status-amber/);
        assert.match(pendingHtml, /fa-clock/);
        assert.match(pendingHtml, />003</);
        assert.match(pendingHtml, /disabled[^>]*data-card-action="revert-status"|data-card-action="revert-status"[^>]*disabled/);
        // Actions bar must appear AFTER closing emp-card-content (sibling, never nested inside)
        const contentStart = pendingHtml.indexOf('<div class="emp-card-content">');
        const actionsStart = pendingHtml.indexOf('<div class="emp-actions-bar">');
        assert.ok(contentStart > 0 && actionsStart > contentStart);
        const between = pendingHtml.slice(contentStart, actionsStart);
        const opens = (between.match(/<div\b/g) || []).length;
        const closes = (between.match(/<\/div>/g) || []).length;
        assert.equal(opens, closes, 'emp-card-content must be closed BEFORE emp-actions-bar begins');

        // Error state -> triangle-exclamation
        const errHtml = render({
            id: 2, _originalIndex: 1, name: 'Pedro', amount: 1500, paid: false, payoutStatus: 'pending',
            status: 'error', _missingAmount: 500, distribution: { 1000: 1 }
        });
        assert.match(errHtml, /status-red/);
        assert.match(errHtml, /fa-triangle-exclamation/);

        // Packed state -> blue + single check + En sobre badge + active undo button
        const packedHtml = render({
            id: 3, _originalIndex: 2, employeeNumber: '005', name: 'Luis', amount: 1000, paid: false,
            payoutStatus: 'packed', status: 'ok', distribution: { 1000: 1 }
        }, { cardNumberMode: 'order' });
        assert.match(packedHtml, /status-packed/);
        assert.match(packedHtml, /fa-check(?!-double)/);
        assert.match(packedHtml, /En sobre/);
        assert.match(packedHtml, />3</, 'order mode must display stable 1-based original order');
        assert.match(packedHtml, /Ref #005/);

        // Paid state -> green in traffic palette, gray in classic palette, both with double check
        const paidTraffic = render({
            id: 4, _originalIndex: 3, name: 'Ana', amount: 1000, paid: true, payoutStatus: 'paid',
            status: 'ok', distribution: { 1000: 1 }
        }, { statusColorScheme: 'traffic' });
        assert.match(paidTraffic, /status-paid-green/);
        assert.match(paidTraffic, /fa-check-double/);

        const paidClassic = render({
            id: 4, _originalIndex: 3, name: 'Ana', amount: 1000, paid: true, payoutStatus: 'paid',
            status: 'ok', distribution: { 1000: 1 }
        }, { statusColorScheme: 'classic' });
        assert.match(paidClassic, /status-paid\b/);
        assert.match(paidClassic, /fa-check-double/);

        // Sprint E: zero-chip opacity in qty_x_denom must be in style="...", never inside class="..."
        const qtyFmtHtml = render({
            id: 5, _originalIndex: 4, employeeNumber: '009', employeeName: 'Juan Pérez',
            name: 'Juan Pérez (Ref #009)', originalData: { name: 'Juan Pérez (Ref #009)' },
            isEdited: true, amount: 1000, paid: false, payoutStatus: 'pending',
            status: 'ok', distribution: { 1000: 1 }
        }, { breakdownFormat: 'qty_x_denom', breakdownShowZeros: true });
        assert.match(qtyFmtHtml, /style="opacity:0\.25;filter:grayscale\(100%\);"/);
        assert.equal(/class="[^"]*opacity:0\.25/.test(qtyFmtHtml), false, 'CSS opacity must not be injected into class attribute');
        assert.match(qtyFmtHtml, />Juan Pérez<\/h3>/, 'editing only bonus/loan must preserve clean employeeName');

        // Sprint G (EGM Round 3 Blocker #2): defense-in-depth against malicious breakdownColumns & prototype breakdownSize
        const xssCardHtml = render({
            id: 6, _originalIndex: 5, name: 'Test', amount: 1000, paid: false, payoutStatus: 'pending',
            status: 'ok', distribution: { 1000: 1 }
        }, {
            breakdownColumns: '"><img src=x onerror=alert(1)><div style="',
            breakdownSize: 'constructor'
        });
        assert.equal(xssCardHtml.includes('<img'), false, 'breakdownColumns must never allow HTML injection');
        assert.match(xssCardHtml, /repeat\(5,\s*max-content\)/);
        assert.match(xssCardHtml, /chip-size-normal/);
    });
});
