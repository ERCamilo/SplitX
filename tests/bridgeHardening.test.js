/**
 * SplitXBridge hardening tests: localhost gating, targetOrigin, dedup semantics.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedSplitXOrigin, createSplitXBridge } = require('../js/SplitXBridge.js');

const makeBridge = ({ hostname, referrer = '', choice = 'replace' } = {}) => {
    const posted = [];
    const opener = { postMessage: (msg, targetOrigin) => posted.push({ msg, targetOrigin }) };
    let state = { employees: [] };
    const windowRef = {
        opener,
        document: { referrer },
        location: hostname === undefined ? undefined : { hostname },
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    const bridge = createSplitXBridge({
        getState: () => state,
        setState: (s) => { state = s; },
        normalizeEmployee: (item, idx) => ({ id: idx + 1, name: item.nombre, amount: item.monto }),
        showCustomChoice: async () => choice,
        windowRef
    });
    return { bridge, opener, posted, getState: () => state };
};

const importMsg = (opener, transferId, origin = 'https://asistencia.erlin.do', employees = [{ nombre: 'Ana', monto: 10 }]) => ({
    origin,
    source: opener,
    data: { type: 'SPLITX_IMPORT_PAYROLL', source: 'Sistema-de-Asistencia', version: '1.0', transferId, employees }
});

describe('localhost origins are only trusted on local hosts', () => {
    test('isAllowedSplitXOrigin rejects localhost when allowLocal is false', () => {
        assert.equal(isAllowedSplitXOrigin('http://localhost:3000', { allowLocal: false }), false);
        assert.equal(isAllowedSplitXOrigin('https://asistencia.erlin.do', { allowLocal: false }), true);
        assert.equal(isAllowedSplitXOrigin('http://localhost:3000'), true);
    });

    test('bridge running on production host ignores localhost senders', async () => {
        const { bridge, opener, getState } = makeBridge({ hostname: 'splitx.erlin.do' });
        const res = await bridge.handleMessage(importMsg(opener, 't1', 'http://localhost:3000'));
        assert.equal(res.handled, false);
        assert.equal(res.reason, 'origin_not_allowed');
        assert.equal(getState().employees.length, 0);
    });

    test('bridge running on localhost still accepts localhost senders', async () => {
        const { bridge, opener } = makeBridge({ hostname: 'localhost' });
        const res = await bridge.handleMessage(importMsg(opener, 't2', 'http://localhost:3000'));
        assert.equal(res.success, true);
    });
});

describe('emitReady never broadcasts to "*"', () => {
    test('does not post when the referrer is missing', () => {
        const { bridge, posted } = makeBridge({ hostname: 'splitx.erlin.do', referrer: '' });
        bridge.emitReady();
        assert.equal(posted.length, 0);
    });

    test('does not post when the referrer origin is not allowed', () => {
        const { bridge, posted } = makeBridge({ hostname: 'splitx.erlin.do', referrer: 'https://evil.com/page' });
        bridge.emitReady();
        assert.equal(posted.length, 0);
    });

    test('posts to the allowed referrer origin', () => {
        const { bridge, posted } = makeBridge({ hostname: 'splitx.erlin.do', referrer: 'https://asistencia.erlin.do/nomina' });
        bridge.emitReady();
        assert.equal(posted.length, 1);
        assert.equal(posted[0].targetOrigin, 'https://asistencia.erlin.do');
    });
});

describe('transferId is only consumed by a completed import', () => {
    test('cancelled transfer can be retried with the same transferId', async () => {
        const first = makeBridge({ hostname: 'splitx.erlin.do', choice: 'cancel' });
        first.getState().employees.push({ id: 99, name: 'Existente', amount: 1 });
        const res1 = await first.bridge.handleMessage(importMsg(first.opener, 'tx_cancel'));
        assert.equal(res1.action, 'cancelled');
        assert.equal(first.bridge.processedTransfers.has('tx_cancel'), false);
    });

    test('failed transfer can be retried with the same transferId', async () => {
        const { bridge, opener } = makeBridge({ hostname: 'splitx.erlin.do' });
        const bad = await bridge.handleMessage(importMsg(opener, 'tx_fail', undefined, []));
        assert.ok(bad.error);
        const retry = await bridge.handleMessage(importMsg(opener, 'tx_fail'));
        assert.equal(retry.success, true);
    });

    test('concurrent duplicate while the prompt is open is still ignored', async () => {
        let release;
        const gate = new Promise(r => { release = r; });
        const { opener } = makeBridge();
        const posted = [];
        let state = { employees: [{ id: 1, name: 'X', amount: 1 }] };
        const bridge = createSplitXBridge({
            getState: () => state,
            setState: (s) => { state = s; },
            normalizeEmployee: (item) => ({ id: 2, name: item.nombre, amount: item.monto }),
            showCustomChoice: () => gate.then(() => 'append'),
            windowRef: { opener, document: { referrer: '' }, addEventListener() {}, removeEventListener() {} }
        });
        const p1 = bridge.handleMessage(importMsg(opener, 'tx_dup'));
        const dup = await bridge.handleMessage(importMsg(opener, 'tx_dup'));
        assert.equal(dup.reason, 'duplicate_transfer');
        release();
        const r1 = await p1;
        assert.equal(r1.success, true);
        assert.equal(state.employees.length, 2);
        void posted;
    });
});

describe('currency is applied only after the user confirms the import', () => {
    const run = async (choice) => {
        const currencies = [];
        const opener = { postMessage() {} };
        let state = { employees: [{ id: 1, name: 'Existente', amount: 1 }] };
        const bridge = createSplitXBridge({
            getState: () => state,
            setState: (s) => { state = s; },
            setCurrencyPreset: (code) => currencies.push(code),
            normalizeEmployee: (item) => ({ id: 2, name: item.nombre, amount: item.monto }),
            showCustomChoice: async () => choice,
            windowRef: { opener, document: { referrer: '' }, addEventListener() {}, removeEventListener() {} }
        });
        const msg = importMsg(opener, `tx_cur_${choice}`);
        msg.data.currency = 'EUR';
        await bridge.handleMessage(msg);
        return currencies;
    };

    test('cancel leaves the current currency untouched', async () => {
        assert.deepEqual(await run('cancel'), []);
    });

    test('replace switches the currency', async () => {
        assert.deepEqual(await run('replace'), ['EUR']);
    });
});
