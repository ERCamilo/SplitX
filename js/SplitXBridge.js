/**
 * SplitXBridge.js
 * Módulo de integración segura postMessage entre Sistema de Asistencia y SplitX.
 */
(function (root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        root.SplitXBridge = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const isAllowedSplitXOrigin = (origin) => {
        if (!origin) return false;
        if (origin === 'https://asistencia.erlin.do') return true;
        // Permitir localhost / 127.0.0.1 con cualquier puerto para pruebas y desarrollo
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
        return false;
    };

    const isAuthorizedSource = (eventSource, expectedOpener) => {
        // En navegador, si existe window.opener, el emisor debe ser exactamente window.opener
        if (expectedOpener && eventSource) {
            return eventSource === expectedOpener;
        }
        return true;
    };

    const createSplitXBridge = (options = {}) => {
        const {
            getState = () => ({ employees: [] }),
            setState = () => {},
            saveData = () => {},
            setCurrencyPreset = () => {},
            normalizeEmployee = (item, idx) => item,
            showCustomChoice = async () => 'replace',
            showToast = () => {},
            windowRef = (typeof window !== 'undefined' ? window : null)
        } = options;

        const processedTransfers = new Set();

        const handleMessage = async (event) => {
            // 1. Validación de origen permitido
            if (!isAllowedSplitXOrigin(event.origin)) {
                return { handled: false, reason: 'origin_not_allowed' };
            }

            // 2. Validación de ventana emisora (debe ser el opener si existe)
            const opener = windowRef?.opener || null;
            if (!isAuthorizedSource(event.source, opener)) {
                console.warn('SplitXBridge: Mensaje ignorado - event.source no coincide con window.opener');
                return { handled: false, reason: 'source_not_opener' };
            }

            if (!event.data || typeof event.data !== 'object') {
                return { handled: false, reason: 'invalid_data' };
            }

            // Manejo de SPLITX_PING -> responde SPLITX_READY inmediatamente
            if (event.data.type === 'SPLITX_PING') {
                if (event.source && typeof event.source.postMessage === 'function') {
                    try {
                        event.source.postMessage({
                            type: 'SPLITX_READY',
                            version: '1.0',
                            transferId: event.data.transferId || null
                        }, event.origin);
                    } catch (e) {
                        console.warn('SplitXBridge: Error al responder PING:', e);
                    }
                }
                return { handled: true, action: 'pong_ready' };
            }

            if (event.data.type !== 'SPLITX_IMPORT_PAYROLL') {
                return { handled: false, reason: 'unhandled_type' };
            }

            // 3. Validación de fuente emisora declarada
            if (event.data.source !== 'Sistema-de-Asistencia') {
                console.warn('SplitXBridge: Mensaje ignorado - source no reconocido:', event.data.source);
                return { handled: false, reason: 'unrecognized_source' };
            }

            const transferId = event.data.transferId;

            // 4. Validación de versión de protocolo
            if (event.data.version !== '1.0') {
                if (event.source && typeof event.source.postMessage === 'function') {
                    event.source.postMessage({
                        type: 'SPLITX_IMPORT_ERROR',
                        transferId: transferId || null,
                        error: `Versión de protocolo no soportada (${event.data.version || 'desconocida'}). Se requiere v1.0.`
                    }, event.origin);
                }
                return { handled: true, error: 'version_unsupported' };
            }

            // 5. Idempotencia y control de duplicados por transferId
            if (transferId && processedTransfers.has(transferId)) {
                console.info('SplitXBridge: Transferencia ya procesada o en curso, ignorando duplicado:', transferId);
                return { handled: true, reason: 'duplicate_transfer' };
            }
            if (transferId) {
                processedTransfers.add(transferId);
            }

            try {
                const { employees: rawEmployees, currency, period } = event.data;
                if (!Array.isArray(rawEmployees) || rawEmployees.length === 0) {
                    throw new Error('No se recibieron colaboradores en el payload.');
                }

                if (currency && typeof currency === 'string') {
                    const code = currency.toUpperCase();
                    if (['DOP', 'USD', 'EUR', 'MXN', 'COP', 'ARS', 'CLP', 'PEN', 'BRL', 'GBP', 'CHF', 'JPY', 'INR', 'PHP', 'RUB'].includes(code)) {
                        setCurrencyPreset(code);
                    }
                }

                const newEmps = rawEmployees.map((item, idx) => normalizeEmployee(item, idx));
                const state = getState();

                if (state.employees && state.employees.length > 0) {
                    const choice = await showCustomChoice({
                        title: 'Nómina recibida',
                        message: `Se recibieron ${newEmps.length} colaboradores desde Sistema de Asistencia${period && period.start ? ' (' + period.start + ' al ' + period.end + ')' : ''}. Ya tienes ${state.employees.length} en la lista actual. ¿Cómo deseas proceder?`,
                        icon: 'fa-users-gear',
                        type: 'question',
                        choices: [
                            {
                                label: 'Cancelar',
                                value: 'cancel',
                                isPrimary: false
                            },
                            {
                                label: 'Agregar al final',
                                value: 'append',
                                icon: 'fa-user-plus',
                                class: 'bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800'
                            },
                            {
                                label: 'Reemplazar todo',
                                value: 'replace',
                                icon: 'fa-rotate',
                                class: 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm'
                            }
                        ]
                    });

                    if (choice === 'cancel') {
                        if (event.source && typeof event.source.postMessage === 'function') {
                            event.source.postMessage({
                                type: 'SPLITX_IMPORT_CANCELLED',
                                transferId: transferId || null
                            }, event.origin);
                        }
                        return { handled: true, action: 'cancelled' };
                    }

                    if (choice === 'replace') {
                        state.employees = newEmps;
                    } else if (choice === 'append') {
                        state.employees = [...state.employees, ...newEmps];
                    }
                } else {
                    state.employees = newEmps;
                }

                if (state.employees.some(e => e.payroll)) {
                    state.payrollMode = 'deductions';
                }

                setState(state);
                saveData();
                showToast(`✅ ${newEmps.length} colaboradores importados desde Sistema de Asistencia.`);

                if (event.source && typeof event.source.postMessage === 'function') {
                    event.source.postMessage({
                        type: 'SPLITX_IMPORT_SUCCESS',
                        transferId: transferId || null,
                        count: newEmps.length,
                        period: period || null
                    }, event.origin);
                }

                return { handled: true, success: true, count: newEmps.length };
            } catch (err) {
                console.error('SplitXBridge postMessage error:', err);
                showToast(`❌ Error al importar nómina: ${err.message}`, 'error');
                if (event.source && typeof event.source.postMessage === 'function') {
                    event.source.postMessage({
                        type: 'SPLITX_IMPORT_ERROR',
                        transferId: transferId || null,
                        error: err.message
                    }, event.origin);
                }
                return { handled: true, error: err.message };
            }
        };

        const emitReady = () => {
            const opener = windowRef?.opener;
            if (opener && typeof opener.postMessage === 'function') {
                try {
                    let targetOpenerOrigin = '*';
                    const referrer = windowRef?.document?.referrer;
                    if (referrer) {
                        try {
                            const refOrigin = new URL(referrer).origin;
                            if (isAllowedSplitXOrigin(refOrigin)) {
                                targetOpenerOrigin = refOrigin;
                            }
                        } catch (e) {}
                    }
                    opener.postMessage({ type: 'SPLITX_READY', version: '1.0' }, targetOpenerOrigin);
                } catch (e) {
                    console.warn('SplitXBridge: no se pudo emitir SPLITX_READY a window.opener', e);
                }
            }
        };

        const attach = () => {
            if (windowRef && typeof windowRef.addEventListener === 'function') {
                windowRef.addEventListener('message', handleMessage);
                emitReady();
            }
        };

        const detach = () => {
            if (windowRef && typeof windowRef.removeEventListener === 'function') {
                windowRef.removeEventListener('message', handleMessage);
            }
        };

        return {
            handleMessage,
            emitReady,
            attach,
            detach,
            processedTransfers,
            isAllowedSplitXOrigin,
            isAuthorizedSource
        };
    };

    return {
        isAllowedSplitXOrigin,
        isAuthorizedSource,
        createSplitXBridge
    };
});
