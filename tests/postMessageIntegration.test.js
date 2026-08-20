/**
 * SplitX postMessage Receiver & Security Integration Tests
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

describe('SplitX postMessage Receiver Security Contract', () => {
    let mockState;
    let processedTransfers;
    let postedMessages;
    let savedDataCalled;

    const isAllowedSplitXOrigin = (origin) => {
        if (!origin) return false;
        if (origin === 'https://asistencia.erlin.do') return true;
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
        return false;
    };

    const normalizeImportedEmployee = (item, idx) => ({
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

    const createHandler = () => {
        return async (event) => {
            if (!isAllowedSplitXOrigin(event.origin)) {
                return { ignored: true, reason: 'origin_not_allowed' };
            }
            if (!event.data || typeof event.data !== 'object') return { ignored: true, reason: 'invalid_data' };
            if (event.data.type !== 'SPLITX_IMPORT_PAYROLL') return { ignored: true, reason: 'unhandled_type' };

            if (event.data.source !== 'Sistema-de-Asistencia') {
                return { ignored: true, reason: 'unrecognized_source' };
            }

            if (event.data.version !== '1.0') {
                if (event.source && typeof event.source.postMessage === 'function') {
                    event.source.postMessage({
                        type: 'SPLITX_IMPORT_ERROR',
                        transferId: event.data.transferId || null,
                        error: `Versión de protocolo no soportada (${event.data.version || 'desconocida'}). Se requiere v1.0.`
                    }, event.origin);
                }
                return { error: 'version_unsupported' };
            }

            const transferId = event.data.transferId;
            if (transferId && processedTransfers.has(transferId)) {
                return { ignored: true, reason: 'duplicate_transfer' };
            }
            if (transferId) {
                processedTransfers.add(transferId);
            }

            const { employees: rawEmployees, currency, period } = event.data;
            if (!Array.isArray(rawEmployees) || rawEmployees.length === 0) {
                throw new Error('No se recibieron colaboradores en el payload.');
            }

            if (currency) mockState.currency = currency;
            const newEmps = rawEmployees.map((item, idx) => normalizeImportedEmployee(item, idx));
            mockState.employees = newEmps;
            mockState.payrollMode = 'deductions';
            savedDataCalled = true;

            if (event.source && typeof event.source.postMessage === 'function') {
                event.source.postMessage({
                    type: 'SPLITX_IMPORT_SUCCESS',
                    transferId: transferId || null,
                    count: newEmps.length,
                    period: period || null
                }, event.origin);
            }
            return { success: true, count: newEmps.length };
        };
    };

    beforeEach(() => {
        mockState = { employees: [], currency: 'DOP', payrollMode: 'normal' };
        processedTransfers = new Set();
        postedMessages = [];
        savedDataCalled = false;
    });

    test('ignores messages from unauthorized origins', async () => {
        const handler = createHandler();
        const mockSource = { postMessage: (msg, targetOrigin) => postedMessages.push({ msg, targetOrigin }) };

        const result = await handler({
            origin: 'https://malicious-site.com',
            source: mockSource,
            data: {
                type: 'SPLITX_IMPORT_PAYROLL',
                source: 'Sistema-de-Asistencia',
                version: '1.0',
                transferId: 'tx_123',
                employees: [{ nombre: 'Juan', monto: 500 }]
            }
        });

        assert.equal(result.ignored, true);
        assert.equal(result.reason, 'origin_not_allowed');
        assert.equal(mockState.employees.length, 0);
        assert.equal(postedMessages.length, 0);
    });

    test('accepts messages from https://asistencia.erlin.do and localhost/127.0.0.1', async () => {
        const handler = createHandler();
        const mockSource = { postMessage: (msg, targetOrigin) => postedMessages.push({ msg, targetOrigin }) };

        const result = await handler({
            origin: 'https://asistencia.erlin.do',
            source: mockSource,
            data: {
                type: 'SPLITX_IMPORT_PAYROLL',
                source: 'Sistema-de-Asistencia',
                version: '1.0',
                transferId: 'tx_prod_1',
                currency: 'USD',
                employees: [
                    { nombre: 'Ana', monto: 1200, prestamoCapital: 1000, prestamoInteres: 200 }
                ]
            }
        });

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
        const handler = createHandler();
        const mockSource = { postMessage: (msg, targetOrigin) => postedMessages.push({ msg, targetOrigin }) };

        const result = await handler({
            origin: 'http://127.0.0.1:8080',
            source: mockSource,
            data: {
                type: 'SPLITX_IMPORT_PAYROLL',
                source: 'Sistema-de-Asistencia',
                version: '2.0',
                transferId: 'tx_incompat',
                employees: [{ nombre: 'Carlos', monto: 800 }]
            }
        });

        assert.equal(result.error, 'version_unsupported');
        assert.equal(postedMessages.length, 1);
        assert.equal(postedMessages[0].msg.type, 'SPLITX_IMPORT_ERROR');
        assert.equal(postedMessages[0].msg.transferId, 'tx_incompat');
        assert.equal(postedMessages[0].targetOrigin, 'http://127.0.0.1:8080');
    });

    test('idempotency: ignores duplicate payload with same transferId', async () => {
        const handler = createHandler();
        const mockSource = { postMessage: (msg, targetOrigin) => postedMessages.push({ msg, targetOrigin }) };

        const payload = {
            origin: 'http://localhost:3000',
            source: mockSource,
            data: {
                type: 'SPLITX_IMPORT_PAYROLL',
                source: 'Sistema-de-Asistencia',
                version: '1.0',
                transferId: 'tx_unique_100',
                employees: [{ nombre: 'Pedro', monto: 1500 }]
            }
        };

        const firstResult = await handler(payload);
        assert.equal(firstResult.success, true);
        assert.equal(postedMessages.length, 1);

        const duplicateResult = await handler(payload);
        assert.equal(duplicateResult.ignored, true);
        assert.equal(duplicateResult.reason, 'duplicate_transfer');
        assert.equal(postedMessages.length, 1);
        assert.equal(mockState.employees.length, 1);
    });
});
