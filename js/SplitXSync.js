// @ts-check
/**
 * SplitXSync.js
 * Máquina de estados Compare-And-Swap (CAS) multi-pestaña (_rev / _epoch):
 * - Impide que una pestaña desactualizada sobrescriba silenciosamente pagos recientes o respaldos restaurados.
 * - Garantiza bloqueo en re-entrada, cancelación segura con Escape y lectura fresca (cero TOCTOU) en overwrite.
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXSync = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * Genera un identificador de época único para detectar restauraciones o sobrescrituras entre pestañas.
     * @param {() => number} [nowFn]
     * @param {() => number} [randFn]
     * @returns {string}
     */
    const mintEpoch = (nowFn = Date.now, randFn = Math.random) =>
        `${nowFn().toString(36)}-${randFn().toString(36).slice(2, 6)}`;

    /**
     * Evalúa de forma pura si el almacenamiento diverge respecto al último estado conocido en esta pestaña.
     * @param {{
     *   storedData: any,
     *   localRev: number,
     *   lastKnownRev: number,
     *   lastKnownEpoch: string
     * }} params
     */
    const detectConflict = ({ storedData, localRev, lastKnownRev, lastKnownEpoch }) => {
        const storedRev = Number(storedData?._rev) || 0;
        const storedEpoch = typeof storedData?._epoch === 'string' ? storedData._epoch : '';
        const revDiverged = storedRev > Math.max(Number(localRev) || 0, Number(lastKnownRev) || 0);
        const epochDiverged = Boolean(storedEpoch && lastKnownEpoch && storedEpoch !== lastKnownEpoch);
        return {
            diverged: revDiverged || epochDiverged,
            revDiverged,
            epochDiverged,
            storedRev,
            storedEpoch
        };
    };

    /**
     * Evalúa si un evento `storage` proveniente de otra pestaña representa un avance real.
     * @param {{ incomingData: any, lastKnownRev: number, lastKnownEpoch: string }} params
     */
    const isExternalStorageChange = ({ incomingData, lastKnownRev, lastKnownEpoch }) => {
        if (!incomingData || typeof incomingData !== 'object') return false;
        const incomingRev = Number(incomingData._rev) || 0;
        const incomingEpoch = typeof incomingData._epoch === 'string' ? incomingData._epoch : '';
        return incomingRev > (Number(lastKnownRev) || 0) || Boolean(incomingEpoch && incomingEpoch !== lastKnownEpoch);
    };

    /**
     * Crea el controlador de sincronización CAS con dependencias inyectables.
     * @param {{
     *   getState: () => any,
     *   readRaw: () => string | null,
     *   writeRaw: (serialized: string) => void,
     *   parseSavedState: (raw: string) => { ok: boolean, data?: any },
     *   schemaVersion: number,
     *   showCustomChoice: (opts: any) => Promise<any>,
     *   onReload: () => void,
     *   onBeforeCommit?: (opts: { fromHistory?: boolean }) => void,
     *   onAfterCommit?: (opts: { fromHistory?: boolean }) => void,
     *   onConflictBlocked?: () => void,
     *   mintEpochFn?: () => string
     * }} deps
     */
    const createSyncController = (deps) => {
        let lastKnownRev = 0;
        let lastKnownEpoch = '';
        let conflictModalOpen = false;
        const nextEpoch = typeof deps.mintEpochFn === 'function' ? deps.mintEpochFn : () => mintEpoch();

        /** @param {any} data */
        const syncFromLoaded = (data) => {
            lastKnownRev = Number(data?._rev) || 0;
            lastKnownEpoch = typeof data?._epoch === 'string' ? data._epoch : '';
        };

        /**
         * @param {number} [forceRevBase]
         * @param {{ fromHistory?: boolean }} [opts]
         */
        const commit = (forceRevBase = 0, opts = {}) => {
            const state = deps.getState();
            state.schemaVersion = deps.schemaVersion;
            const nextRev = Math.max(Number(state._rev) || 0, lastKnownRev, forceRevBase) + 1;
            state._rev = nextRev;
            if (!state._epoch) state._epoch = lastKnownEpoch || nextEpoch();
            lastKnownRev = nextRev;
            lastKnownEpoch = state._epoch;
            if (typeof deps.onBeforeCommit === 'function') deps.onBeforeCommit(opts);
            deps.writeRaw(JSON.stringify(state));
            if (typeof deps.onAfterCommit === 'function') deps.onAfterCommit(opts);
        };

        /**
         * Guarda el estado usando Compare-And-Swap. Devuelve `true` si se escribió, `false` si se bloqueó por conflicto.
         * @param {{ fromHistory?: boolean }} [opts]
         * @returns {boolean}
         */
        const save = (opts = {}) => {
            const state = deps.getState();
            try {
                const rawStored = deps.readRaw();
                if (rawStored) {
                    const parsedStored = deps.parseSavedState(rawStored);
                    if (parsedStored.ok && parsedStored.data) {
                        const conflict = detectConflict({
                            storedData: parsedStored.data,
                            localRev: Number(state._rev) || 0,
                            lastKnownRev,
                            lastKnownEpoch
                        });
                        if (conflict.diverged) {
                            // ALWAYS block write on divergence (including re-entrant calls while modal is open)
                            if (!conflictModalOpen) {
                                conflictModalOpen = true;
                                deps.showCustomChoice({
                                    title: 'Cambios detectados en otra pestaña',
                                    message: 'Otra pestaña modificó la nómina o restauró un respaldo. Si guardas desde aquí podrías sobrescribir pagos recientes. ¿Cómo deseas proceder?',
                                    icon: 'fa-triangle-exclamation',
                                    type: 'warning',
                                    choices: [
                                        {
                                            label: 'Cancelar (no guardar)',
                                            value: 'cancel',
                                            isPrimary: false
                                        },
                                        {
                                            label: 'Sobrescribir con esta pestaña',
                                            value: 'overwrite',
                                            icon: 'fa-triangle-exclamation',
                                            class: 'bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800'
                                        },
                                        {
                                            label: 'Recargar datos recientes',
                                            value: 'reload',
                                            icon: 'fa-rotate',
                                            isPrimary: true,
                                            class: 'bg-blue-600 hover:bg-blue-700 text-white'
                                        }
                                    ]
                                }).then((action) => {
                                    conflictModalOpen = false;
                                    if (action === 'reload') {
                                        deps.onReload();
                                    } else if (action === 'overwrite') {
                                        // Re-read latest revision (eliminates TOCTOU) and mint a brand-new epoch
                                        let latestRev = conflict.storedRev;
                                        try {
                                            const latestRaw = deps.readRaw();
                                            const latestParsed = latestRaw ? deps.parseSavedState(latestRaw) : null;
                                            if (latestParsed?.ok && latestParsed.data) {
                                                latestRev = Math.max(latestRev, Number(latestParsed.data._rev) || 0);
                                            }
                                        } catch (_) { /* keep conflict.storedRev */ }
                                        const freshEpoch = nextEpoch();
                                        lastKnownEpoch = freshEpoch;
                                        deps.getState()._epoch = freshEpoch;
                                        commit(latestRev, opts);
                                    }
                                    // Escape / 'cancel' / falsy -> safe no-op, storage remains untouched
                                });
                            }
                            if (typeof deps.onConflictBlocked === 'function') deps.onConflictBlocked();
                            return false;
                        }
                    }
                }
            } catch (_) { /* storage unavailable -> fallback to normal write */ }

            commit(0, opts);
            return true;
        };

        /**
         * Evalúa el `event.newValue` de un evento `storage` entre pestañas.
         * @param {string | null | undefined} rawNewValue
         * @returns {boolean}
         */
        const handleExternalStorage = (rawNewValue) => {
            if (!rawNewValue) return false;
            const incoming = deps.parseSavedState(rawNewValue);
            if (!incoming.ok || !incoming.data) return false;
            return isExternalStorageChange({
                incomingData: incoming.data,
                lastKnownRev,
                lastKnownEpoch
            });
        };

        const getTrackingState = () => ({ lastKnownRev, lastKnownEpoch, conflictModalOpen });

        return { syncFromLoaded, save, handleExternalStorage, getTrackingState };
    };

    return { mintEpoch, detectConflict, isExternalStorageChange, createSyncController };
});
