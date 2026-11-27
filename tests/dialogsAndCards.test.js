const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SplitXDialogs = require('../js/SplitXDialogs.js');
const SplitXEmployeeCard = require('../js/SplitXEmployeeCard.js');
const SplitXCurrencies = require('../js/SplitXCurrencies.js');

const makeFakeDoc = () => {
    const byId = new Map();
    const makeEl = (id = '') => {
        const classes = new Set();
        const children = [];
        const el = {
            id,
            type: '',
            className: '',
            textContent: '',
            innerHTML: '',
            onclick: null,
            children,
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c)
            },
            appendChild: (ch) => { children.push(ch); return ch; },
            remove: () => { if (el.id) byId.delete(el.id); }
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
        assert.match(html, /data-card-action="toggle-paid"/);
        assert.match(html, /data-card-action="edit"/);
        assert.match(html, /data-card-action="remove"/);
        assert.match(html, /data-emp-id="42"/);
    });
});
