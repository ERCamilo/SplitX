// @ts-check
/**
 * SplitXBridge.js
 * Módulo de integración segura postMessage entre Sistema de Asistencia y SplitX.
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        root.SplitXBridge = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /** @param {string | undefined | null} hostname */
    const isLocalHostname = (hostname) => !hostname || /^(localhost|127\.0\.0\.1)$/i.test(hostname);

    // Orígenes de Sistema de Asistencia: su dominio y la copia en GitHub Pages
    // (https://ercamilo.github.io/-Sistema-de-asistencia/; el origen no incluye la ruta).
    const SA_ORIGINS = ['https://asistencia.erlin.do', 'https://ercamilo.github.io'];

    /** @param {string} origin @param {{ allowLocal?: boolean }} [opts] */
    const isAllowedSplitXOrigin = (origin, { allowLocal = true } = {}) => {
        if (!origin) return false;
        if (SA_ORIGINS.includes(origin)) return true;
        // Permitir localhost / 127.0.0.1 solo cuando SplitX también corre en local (pruebas y desarrollo)
        if (allowLocal && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
        return false;
    };

    /** @param {any} eventSource @param {any} expectedOpener */
    const isAuthorizedSource = (eventSource, expectedOpener) => {
        // En navegador, si existe window.opener, el emisor debe ser exactamente window.opener
        if (expectedOpener && eventSource) {
            return eventSource === expectedOpener;
        }
        return true;
    };

    /** @param {any} event */
    const replyReady = (event) => {
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
    };

    /**
     * Cola temprana: se instala en el <head>, antes de que carguen los CDN.
     * Sistema de Asistencia deja de enviar PING a los 10 s; si SplitX solo escucha
     * tras window.onload, la nómina nunca llega y se muestran los datos viejos.
     * Esta cola responde READY al instante y guarda el payload hasta que attach() lo procese.
     * @param {any} [windowRef]
     */
    const installEarlyQueue = (windowRef = (typeof window !== 'undefined' ? window : null)) => {
        if (!windowRef || typeof windowRef.addEventListener !== 'function') return null;
        if (windowRef.__splitxEarlyQueue) return windowRef.__splitxEarlyQueue;
        const policy = { allowLocal: isLocalHostname(windowRef.location?.hostname) };
        const queue = {
            /** @type {Array<{ origin: string, source: any, data: any }>} */
            messages: [],
            active: true,
            contacted: false,
            /** @param {any} event */
            listener: (event) => {
                if (!queue.active) return;
                if (!isAllowedSplitXOrigin(event.origin, policy)) return;
                if (!isAuthorizedSource(event.source, windowRef.opener || null)) return;
                if (!event.data || typeof event.data !== 'object') return;
                if (event.data.type === 'SPLITX_PING') {
                    queue.contacted = true;
                    replyReady(event);
                } else if (event.data.type === 'SPLITX_IMPORT_PAYROLL') {
                    queue.contacted = true;
                    queue.messages.push({ origin: event.origin, source: event.source, data: event.data });
                }
            },
            stop: () => {
                queue.active = false;
                windowRef.removeEventListener('message', queue.listener);
            }
        };
        windowRef.addEventListener('message', queue.listener);
        windowRef.__splitxEarlyQueue = queue;
        return queue;
    };

    /**
     * @param {{
     *   getState?: () => any,
     *   setState?: (s: any) => void,
     *   saveData?: () => void,
     *   setCurrencyPreset?: (code: string) => void,
     *   normalizeEmployee?: (item: any, idx: number) => any,
     *   showCustomChoice?: (opts: any) => Promise<string>,
     *   showToast?: (msg: string, type?: string) => void,
     *   onImported?: ((info: any) => void) | null,
     *   windowRef?: any
     * }} [options]
     */
    const createSplitXBridge = (options = {}) => {
        const {
            getState = () => ({ employees: [] }),
            setState = () => {},
            saveData = () => {},
            setCurrencyPreset = () => {},
            normalizeEmployee = (item, _idx) => item,
            showCustomChoice = async () => 'replace',
            showToast = () => {},
            onImported = null,
            windowRef = (typeof window !== 'undefined' ? window : null)
        } = options;

        /** @type {Set<string>} */
        const processedTransfers = new Set();
        let gotPayload = false;
        const originPolicy = { allowLocal: isLocalHostname(windowRef?.location?.hostname) };

        /** @param {any} event */
        const handleMessage = async (event) => {
            // 1. Validación de origen permitido
            if (!isAllowedSplitXOrigin(event.origin, originPolicy)) {
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
                replyReady(event);
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
            gotPayload = true;

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
                const { employees: payloadEmployees, period, exportContext } = event.data;
                if (!Array.isArray(payloadEmployees) || payloadEmployees.length === 0) {
                    throw new Error('No se recibieron colaboradores en el payload.');
                }
                // Contexto general del export (empresa, período, moneda…): se copia a cada empleado que no trae el suyo.
                const hasContext = exportContext && typeof exportContext === 'object' && !Array.isArray(exportContext);
                const rawEmployees = hasContext
                    ? payloadEmployees.map(item => (item && typeof item === 'object' && !item.exportContext ? { ...item, exportContext } : item))
                    : payloadEmployees;
                const currency = event.data.currency || (hasContext ? exportContext.currency : undefined);

                const newEmps = rawEmployees.map((item, idx) => normalizeEmployee(item, idx));
                const state = getState();
                let importMode = 'replace';

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

                    if (choice !== 'replace' && choice !== 'append') {
                        // Cancelar (o cierre sin elección válida) no consume el transferId: el emisor puede reintentar
                        if (transferId) processedTransfers.delete(transferId);
                        if (event.source && typeof event.source.postMessage === 'function') {
                            event.source.postMessage({
                                type: 'SPLITX_IMPORT_CANCELLED',
                                transferId: transferId || null
                            }, event.origin);
                        }
                        return { handled: true, action: 'cancelled' };
                    }

                    importMode = choice === 'append' ? 'append' : 'replace';
                    if (choice === 'replace') {
                        state.employees = newEmps;
                        state.payrollLoanFund = 0;
                        state.bankLimits = {};
                    } else if (choice === 'append') {
                        state.employees = [...state.employees, ...newEmps];
                    }
                } else {
                    state.employees = newEmps;
                    state.payrollLoanFund = 0;
                    state.bankLimits = {};
                }

                const hasCommittedEnvelopes = importMode === 'append' && state.employees.some((/** @type {any} */ e) => e && (e.payoutStatus === 'packed' || e.payoutStatus === 'paid' || e.paid === true));

                // La moneda solo cambia cuando el usuario confirma y no hay sobres comprometidos en append
                if (!hasCommittedEnvelopes && currency && typeof currency === 'string') {
                    const code = currency.toUpperCase();
                    if (['DOP', 'USD', 'EUR', 'MXN', 'COP', 'ARS', 'CLP', 'PEN', 'BRL', 'GBP', 'CHF', 'JPY', 'INR', 'PHP', 'RUB'].includes(code)) {
                        setCurrencyPreset(code);
                    }
                }

                if (!hasCommittedEnvelopes && state.employees.some((/** @type {any} */ e) => e.payroll)) {
                    state.payrollMode = 'deductions';
                }

                setState(state);
                saveData();
                if (typeof onImported === 'function') {
                    try {
                        onImported({ employees: newEmps, period: period || null, exportContext: hasContext ? exportContext : (rawEmployees.find(e => e && typeof e.exportContext === 'object' && e.exportContext)?.exportContext || null), transferId: transferId || null, mode: importMode, count: newEmps.length, currency: currency || null });
                    } catch (e) {
                        console.warn('SplitXBridge: onImported falló (la importación sí se guardó):', e);
                    }
                }
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
                const errMsg = err instanceof Error ? err.message : String(err);
                // Un import fallido no consume el transferId: el emisor puede reintentar
                if (transferId) processedTransfers.delete(transferId);
                console.error('SplitXBridge postMessage error:', err);
                showToast(`❌ Error al importar nómina: ${errMsg}`, 'error');
                if (event.source && typeof event.source.postMessage === 'function') {
                    event.source.postMessage({
                        type: 'SPLITX_IMPORT_ERROR',
                        transferId: transferId || null,
                        error: errMsg
                    }, event.origin);
                }
                return { handled: true, error: errMsg };
            }
        };

        const referrerOrigin = () => {
            const referrer = windowRef?.document?.referrer;
            if (!referrer) return null;
            try {
                const refOrigin = new URL(referrer).origin;
                return isAllowedSplitXOrigin(refOrigin, originPolicy) ? refOrigin : null;
            } catch (e) {
                return null;
            }
        };

        /** True when this tab was opened by Sistema de Asistencia (opener + allowed referrer). */
        const openedFromSA = () => !!(windowRef?.opener && referrerOrigin());
        const receivedPayload = () => gotPayload || !!(windowRef?.__splitxEarlyQueue?.messages?.length);

        const emitReady = () => {
            const opener = windowRef?.opener;
            if (opener && typeof opener.postMessage === 'function') {
                try {
                    // Sin referrer permitido no se emite: nunca se transmite a '*'
                    const targetOpenerOrigin = referrerOrigin();
                    if (!targetOpenerOrigin) return;
                    opener.postMessage({ type: 'SPLITX_READY', version: '1.0' }, targetOpenerOrigin);
                } catch (e) {
                    console.warn('SplitXBridge: no se pudo emitir SPLITX_READY a window.opener', e);
                }
            }
        };

        const attach = async () => {
            if (!windowRef || typeof windowRef.addEventListener !== 'function') return;
            const early = windowRef.__splitxEarlyQueue;
            const buffered = early ? early.messages.splice(0) : [];
            if (early) early.stop();
            windowRef.addEventListener('message', handleMessage);
            // Procesa primero lo que SA ya envió mientras la página cargaba antes de emitir READY.
            for (const event of buffered) {
                await handleMessage(event);
            }
            emitReady();
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
            openedFromSA,
            receivedPayload,
            isAllowedSplitXOrigin,
            isAuthorizedSource
        };
    };

    return {
        isAllowedSplitXOrigin,
        isAuthorizedSource,
        installEarlyQueue,
        createSplitXBridge
    };
});
