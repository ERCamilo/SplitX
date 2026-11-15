/**
 * Early handshake queue: SplitX must answer SA's PING and keep the payroll payload
 * even while the page is still loading (before app.init attaches the full bridge).
 * Without it, SA stops pinging after 10 s and SplitX shows the stale saved payroll.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { installEarlyQueue, createSplitXBridge } = require('../js/SplitXBridge.js');

const SA = 'https://asistencia.erlin.do';

const makeWindow = ({ hostname = 'splitx.erlin.do', referrer = SA + '/nomina' } = {}) => {
    const posted = [];
    const opener = { postMessage: (msg, targetOrigin) => posted.push({ msg, targetOrigin }) };
    const listeners = new Set();
    const win = {
        opener,
        document: { referrer },
        location: { hostname },
        addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
        removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); },
        dispatch: async (event) => { for (const fn of [...listeners]) await fn(event); }
    };
    return { win, opener, posted, listeners };
};

const ping = (opener, origin = SA) => ({ origin, source: opener, data: { type: 'SPLITX_PING', transferId: 'tx1', source: 'Sistema-de-Asistencia', version: '1.0' } });
const payload = (opener, transferId = 'tx1', origin = SA) => ({
    origin,
    source: opener,
    data: {
        type: 'SPLITX_IMPORT_PAYROLL', source: 'Sistema-de-Asistencia', version: '1.0', transferId,
        period: { start: '2026-11-01', end: '2026-11-15' },
        employees: [{ nombre: 'Ana', monto: 100 }, { nombre: 'Luis', monto: 50 }]
    }
});

const makeBridge = (win, extra = {}) => {
    let state = { employees: [{ id: 9, name: 'Viejo', amount: 1 }] };
    const bridge = createSplitXBridge({
        getState: () => state,
        setState: (s) => { state = s; },
        normalizeEmployee: (item, idx) => ({ id: idx + 1, name: item.nombre, amount: item.monto }),
        showCustomChoice: async () => 'replace',
        windowRef: win,
        ...extra
    });
    return { bridge, getState: () => state };
};

describe('installEarlyQueue', () => {
    test('answers PING with READY right away, before the app has loaded', async () => {
        const { win, opener, posted } = makeWindow();
        installEarlyQueue(win);
        await win.dispatch(ping(opener));
        assert.equal(posted.length, 1);
        assert.equal(posted[0].msg.type, 'SPLITX_READY');
        assert.equal(posted[0].msg.transferId, 'tx1');
        assert.equal(posted[0].targetOrigin, SA);
    });

    test('buffers the payroll payload until the bridge attaches', async () => {
        const { win, opener } = makeWindow();
        const queue = installEarlyQueue(win);
        await win.dispatch(payload(opener));
        assert.equal(queue.messages.length, 1);
        assert.equal(queue.messages[0].data.transferId, 'tx1');
    });

    test('ignores messages from other origins or from a window that is not the opener', async () => {
        const { win, opener, posted } = makeWindow();
        const queue = installEarlyQueue(win);
        await win.dispatch(ping(opener, 'https://evil.example'));
        await win.dispatch(payload(opener, 'tx1', 'https://evil.example'));
        await win.dispatch(payload({ postMessage() {} }));
        await win.dispatch({ origin: SA, source: opener, data: 'not-an-object' });
        assert.equal(posted.length, 0);
        assert.equal(queue.messages.length, 0);
    });

    test('is idempotent: installing twice keeps a single listener', () => {
        const { win, listeners } = makeWindow();
        const a = installEarlyQueue(win);
        const b = installEarlyQueue(win);
        assert.equal(a, b);
        assert.equal(listeners.size, 1);
    });

    test('records whether SA reached the page', async () => {
        const { win, opener } = makeWindow();
        const queue = installEarlyQueue(win);
        assert.equal(queue.contacted, false);
        await win.dispatch(ping(opener));
        assert.equal(queue.contacted, true);
    });
});

describe('attach() takes over from the early queue', () => {
    test('replays the buffered payload so the new payroll replaces the saved one', async () => {
        const { win, opener, posted, listeners } = makeWindow();
        installEarlyQueue(win);
        await win.dispatch(ping(opener));
        await win.dispatch(payload(opener));
        const { bridge, getState } = makeBridge(win);
        await bridge.attach();
        assert.deepEqual(getState().employees.map(e => e.name), ['Ana', 'Luis']);
        assert.ok(posted.some(p => p.msg.type === 'SPLITX_IMPORT_SUCCESS' && p.msg.transferId === 'tx1'));
        // Only the full bridge listens now.
        assert.equal(listeners.size, 1);
        assert.equal(win.__splitxEarlyQueue.active, false);
    });

    test('a payload that arrives after attach is handled by the full bridge', async () => {
        const { win, opener } = makeWindow();
        installEarlyQueue(win);
        const { bridge, getState } = makeBridge(win);
        await bridge.attach();
        await win.dispatch(payload(opener, 'tx2'));
        assert.equal(getState().employees.length, 2);
    });

    test('duplicate buffered payloads with the same transferId import once', async () => {
        const { win, opener, posted } = makeWindow();
        installEarlyQueue(win);
        await win.dispatch(payload(opener));
        await win.dispatch(payload(opener));
        const { bridge } = makeBridge(win);
        await bridge.attach();
        assert.equal(posted.filter(p => p.msg.type === 'SPLITX_IMPORT_SUCCESS').length, 1);
    });

    test('works without an early queue (old load order)', async () => {
        const { win, opener } = makeWindow();
        const { bridge, getState } = makeBridge(win);
        await bridge.attach();
        await win.dispatch(payload(opener));
        assert.equal(getState().employees.length, 2);
    });
});

describe('onImported and status', () => {
    test('onImported receives what was imported and how', async () => {
        const { win, opener } = makeWindow();
        const seen = [];
        const { bridge } = makeBridge(win, { onImported: (info) => seen.push(info) });
        await bridge.handleMessage(payload(opener, 'tx9'));
        assert.equal(seen.length, 1);
        assert.equal(seen[0].transferId, 'tx9');
        assert.equal(seen[0].mode, 'replace');
        assert.equal(seen[0].count, 2);
        assert.deepEqual(seen[0].period, { start: '2026-11-01', end: '2026-11-15' });
        assert.equal(seen[0].employees.length, 2);
    });

    test('onImported gets the context from the employees when SA spreads it at the top level', async () => {
        const { win, opener } = makeWindow();
        const seen = [];
        const { bridge } = makeBridge(win, { onImported: (info) => seen.push(info) });
        const ctx = { payrollName: 'Nómina 1-15 nov', companyName: 'Empresa', currency: 'DOP', period: { start: '2026-11-01', end: '2026-11-15' } };
        const msg = payload(opener, 'tx10');
        msg.data = { ...msg.data, ...ctx, employees: msg.data.employees.map(e => ({ ...e, exportContext: ctx })) };
        await bridge.handleMessage(msg);
        assert.equal(seen[0].exportContext.payrollName, 'Nómina 1-15 nov');
    });

    test('onImported is not called when the user cancels', async () => {
        const { win, opener } = makeWindow();
        const seen = [];
        const { bridge } = makeBridge(win, { onImported: (info) => seen.push(info), showCustomChoice: async () => 'cancel' });
        await bridge.handleMessage(payload(opener));
        assert.equal(seen.length, 0);
    });

    test('a failing onImported does not break the import', async () => {
        const { win, opener, posted } = makeWindow();
        const { bridge, getState } = makeBridge(win, { onImported: () => { throw new Error('quota'); } });
        const res = await bridge.handleMessage(payload(opener));
        assert.equal(res.success, true);
        assert.equal(getState().employees.length, 2);
        assert.ok(posted.some(p => p.msg.type === 'SPLITX_IMPORT_SUCCESS'));
    });

    test('openedFromSA is true only for an SA opener and referrer', () => {
        assert.equal(makeBridge(makeWindow().win).bridge.openedFromSA(), true);
        assert.equal(makeBridge(makeWindow({ referrer: '' }).win).bridge.openedFromSA(), false);
        assert.equal(makeBridge(makeWindow({ referrer: 'https://evil.example/' }).win).bridge.openedFromSA(), false);
        const noOpener = makeWindow().win;
        noOpener.opener = null;
        assert.equal(makeBridge(noOpener).bridge.openedFromSA(), false);
    });

    test('receivedPayload flips once SA delivers an import (early or late)', async () => {
        const { win, opener } = makeWindow();
        installEarlyQueue(win);
        const { bridge } = makeBridge(win);
        assert.equal(bridge.receivedPayload(), false);
        await win.dispatch(payload(opener));
        await bridge.attach();
        assert.equal(bridge.receivedPayload(), true);
    });
});
