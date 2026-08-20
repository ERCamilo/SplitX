/**
 * SplitX postMessage Receiver & Security Integration Tests
 * Evaluates the real production SplitXBridge module.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedSplitXOrigin, isAuthorizedSource, createSplitXBridge } = require('../js/SplitXBridge.js');

describe('SplitXBridge Production Security Contract', () => {
    let mockState;
    let postedMessages;
    let savedDataCalled;
    let bridge;
    let mockOpener;
    let mockWindow;

    const normalizeEmployee = (item, idx) => ({
        id: idx + 1,
        name: item.nombre || item.name,
        amount: item.monto || item.amount || 0,
        payroll: {
            gross: item.bruto || 0,
            bonuses: item.bonificaciones || 0,
            discounts: item.descuentos || 0,
            loans: item.prestamos || 0,
            loanDetails: item.loanDetails || {
                principal: item.prestamoCapital || item.prestamos || 0,
                interestAmount: item.prestamoInteres || 0,
                remainingBalance: item.saldoPendiente || 0
            }
        }
    });

    beforeEach(() => {
        mockState = { employees: [], currency: 'DOP', payrollMode: 'normal' };
        postedMessages = [];
        savedDataCalled = false;

        mockOpener = {
            postMessage: (msg, targetOrigin) => postedMessages.push({ msg, targetOrigin })
        };

        mockWindow = {
            opener: mockOpener,
            document: { referrer: 'https://asistencia.erlin.do' },
            addEventListener: () => {},
            removeEventListener: () => {}
        };

        bridge = createSplitXBridge({
            getState: () => mockState,
            setState: (newState) => { mockState = newState; },
            saveData: () => { savedDataCalled = true; },
            setCurrencyPreset: (code) => { mockState.currency = code; },
            normalizeEmployee,
            showCustomChoice: async () => 'replace',
            showToast: () => {},
            windowRef: mockWindow
        });
    });

    test('isAllowedSplitXOrigin allows asistencia.erlin.do, localhost and 127.0.0.1', () => {
        assert.equal(isAllowedSplitXOrigin('https://asistencia.erlin.do'), true);
        assert.equal(isAllowedSplitXOrigin('http://localhost:3000'), true);
        assert.equal(isAllowedSplitXOrigin('http://127.0.0.1:8080'), true);
        assert.equal(isAllowedSplitXOrigin('https://localhost'), true);
        assert.equal(isAllowedSplitXOrigin('https://malicious-site.com'), false);
        assert.equal(isAllowedSplitXOrigin('http://evil.com'), false);
        assert.equal(isAllowedSplitXOrigin(''), false);
        assert.equal(isAllowedSplitXOrigin(null), false);
    });

    test('isAuthorizedSource verifies that event.source matches window.opener', () => {
        const fakeSource = { postMessage: () => {} };
        assert.equal(isAuthorizedSource(mockOpener, mockOpener), true);
        assert.equal(isAuthorizedSource(fakeSource, mockOpener), false);
        assert.equal(isAuthorizedSource(fakeSource, null), true);
    });

    test('responds to SPLITX_PING with SPLITX_READY and transferId', async () => {
        const result = await bridge.handleMessage({
            origin: 'https://asistencia.erlin.do',
            source: mockOpener,
            data: {
                type: 'SPLITX_PING',
                transferId: 'tx_ping_123',
                version: '1.0'
            }
        });

        assert.equal(result.handled, true);
        assert.equal(result.action, 'pong_ready');
        assert.equal(postedMessages.length, 1);
        assert.equal(postedMessages[0].msg.type, 'SPLITX_READY');
        assert.equal(postedMessages[0].msg.transferId, 'tx_ping_123');
        assert.equal(postedMessages[0].targetOrigin, 'https://asistencia.erlin.do');
    });

    test('ignores messages from unauthorized origins', async () => {
        const result = await bridge.handleMessage({
            origin: 'https://malicious-site.com',
            source: mockOpener,
            data: {
                type: 'SPLITX_IMPORT_PAYROLL',
                source: 'Sistema-de-Asistencia',
                version: '1.0',
                transferId: 'tx_123',
                employees: [{ nombre: 'Juan', monto: 500 }]
            }
        });

        assert.equal(result.handled, false);
        assert.equal(result.reason, 'origin_not_allowed');
        assert.equal(mockState.employees.length, 0);
        assert.equal(postedMessages.length, 0);
    });

    test('ignores messages where event.source is not window.opener', async () => {
        const otherWindow = { postMessage: () => {} };
        const result = await bridge.handleMessage({
            origin: 'https://asistencia.erlin.do',
            source: otherWindow,
            data: {
                type: 'SPLITX_IMPORT_PAYROLL',
                source: 'Sistema-de-Asistencia',
                version: '1.0',
                transferId: 'tx_123',
                employees: [{ nombre: 'Juan', monto: 500 }]
            }
        });

        assert.equal(result.handled, false);
        assert.equal(result.reason, 'source_not_opener');
        assert.equal(mockState.employees.length, 0);
        assert.equal(postedMessages.length, 0);
    });

    test('accepts payroll import from https://asistencia.erlin.do, normalizes and responds with SPLITX_IMPORT_SUCCESS', async () => {
        const result = await bridge.handleMessage({
            origin: 'https://asistencia.erlin.do',
            source: mockOpener,
            data: {
                type: 'SPLITX_IMPORT_PAYROLL',
                source: 'Sistema-de-Asistencia',
                version: '1.0',
                transferId: 'tx_prod_1',
                currency: 'USD',
                period: { start: '2026-08-01', end: '2026-08-15' },
                employees: [
                    { nombre: 'Ana', monto: 1200, prestamoCapital: 1000, prestamoInteres: 200 }
                ]
            }
        });

        assert.equal(result.handled, true);
        assert.equal(result.success, true);
        assert.equal(mockState.employees.length, 1);
        assert.equal(mockState.currency, 'USD');
        assert.equal(mockState.payrollMode, 'deductions');
        assert.equal(savedDataCalled, true);
        assert.equal(postedMessages.length, 1);
        assert.equal(postedMessages[0].targetOrigin, 'https://asistencia.erlin.do');
        assert.equal(postedMessages[0].msg.type, 'SPLITX_IMPORT_SUCCESS');
        assert.equal(postedMessages[0].msg.transferId, 'tx_prod_1');
    });

    test('rejects incompatible protocol versions with SPLITX_IMPORT_ERROR', async () => {
        const result = await bridge.handleMessage({
            origin: 'http://127.0.0.1:8080',
            source: mockOpener,
            data: {
                type: 'SPLITX_IMPORT_PAYROLL',
                source: 'Sistema-de-Asistencia',
                version: '2.0',
                transferId: 'tx_incompat',
                employees: [{ nombre: 'Carlos', monto: 800 }]
            }
        });

        assert.equal(result.handled, true);
        assert.equal(result.error, 'version_unsupported');
        assert.equal(postedMessages.length, 1);
        assert.equal(postedMessages[0].msg.type, 'SPLITX_IMPORT_ERROR');
        assert.equal(postedMessages[0].msg.transferId, 'tx_incompat');
        assert.equal(postedMessages[0].targetOrigin, 'http://127.0.0.1:8080');
    });

    test('idempotency: ignores duplicate payload with same transferId', async () => {
        const payload = {
            origin: 'http://localhost:3000',
            source: mockOpener,
            data: {
                type: 'SPLITX_IMPORT_PAYROLL',
                source: 'Sistema-de-Asistencia',
                version: '1.0',
                transferId: 'tx_unique_100',
                employees: [{ nombre: 'Pedro', monto: 1500 }]
            }
        };

        const firstResult = await bridge.handleMessage(payload);
        assert.equal(firstResult.handled, true);
        assert.equal(firstResult.success, true);
        assert.equal(postedMessages.length, 1);

        const duplicateResult = await bridge.handleMessage(payload);
        assert.equal(duplicateResult.handled, true);
        assert.equal(duplicateResult.reason, 'duplicate_transfer');
        assert.equal(postedMessages.length, 1);
        assert.equal(mockState.employees.length, 1);
    });
});
