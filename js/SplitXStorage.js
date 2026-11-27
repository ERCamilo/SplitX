// @ts-check
/**
 * SplitXStorage.js
 * Adaptador de persistencia tolerante a fallos para SplitX:
 * - Fallback en memoria por clave (Map), nunca sobrescribe otras claves.
 * - Distingue QuotaExceededError de almacenamiento bloqueado (p. ej. file:// o modo privado).
 * - Centraliza todas las claves persistidas para limpieza completa (resetAll).
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXStorage = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const KEYS = Object.freeze({
        DATA: 'Split_data',
        CORRUPT_BACKUP: 'Split_data_corrupt_backup',
        HISTORY: 'Split_import_history',
        SHEETS: 'Split_sheets_v2',
        SHEETS_LEGACY: 'Split_sheets_v1',
        DOCUMENTS: 'Split_documents_v1'
    });

    const ALL_KEYS = Object.freeze(Object.values(KEYS));

    /** @param {unknown} err */
    const isQuotaError = (err) => {
        if (!err || typeof err !== 'object') return false;
        const e = /** @type {any} */ (err);
        if (e.code === 22 || e.code === 1014) return true;
        const name = String(e.name || '');
        const msg = String(e.message || '');
        return /quota|NS_ERROR_DOM_QUOTA_REACHED/i.test(name + ' ' + msg);
    };

    /**
     * @param {{
     *   backend?: { getItem: (k: string) => string | null, setItem: (k: string, v: string) => void, removeItem: (k: string) => void } | null,
     *   onError?: (info: { reason: 'quota' | 'blocked', key: string, error: unknown }) => void
     * }} [options]
     */
    const createStorage = (options = {}) => {
        const backend = options.backend !== undefined
            ? options.backend
            : (typeof localStorage !== 'undefined' ? localStorage : null);
        const onError = typeof options.onError === 'function' ? options.onError : null;
        /** @type {Map<string, string>} */
        const memStore = new Map();

        /** @param {string} key @returns {string | null} */
        const get = (key) => {
            // memStore holds only newer writes that failed to persist to backend (set() clears it on success)
            if (memStore.has(key)) return memStore.get(key) ?? null;
            if (backend) {
                try {
                    const val = backend.getItem(key);
                    if (val !== null && val !== undefined) return val;
                } catch (_) {
                    return null;
                }
            }
            return null;
        };

        /** @param {string} key @param {string} value @returns {{ ok: boolean, reason?: 'quota' | 'blocked' }} */
        const set = (key, value) => {
            const strVal = String(value);
            if (backend) {
                try {
                    backend.setItem(key, strVal);
                    memStore.delete(key);
                    return { ok: true };
                } catch (err) {
                    memStore.set(key, strVal);
                    const reason = isQuotaError(err) ? 'quota' : 'blocked';
                    if (onError) onError({ reason, key, error: err });
                    return { ok: false, reason };
                }
            }
            memStore.set(key, strVal);
            return { ok: false, reason: 'blocked' };
        };

        /** @param {string} key */
        const remove = (key) => {
            memStore.delete(key);
            if (backend) {
                try { backend.removeItem(key); } catch (_) { /* noop */ }
            }
        };

        /** Limpia todas las claves conocidas de SplitX (nómina, historial, plantillas y documentos PII). */
        const clearAll = () => {
            for (const key of ALL_KEYS) {
                remove(key);
            }
        };

        return {
            KEYS,
            ALL_KEYS,
            get,
            set,
            remove,
            clearAll,
            getItem: get,
            setItem: set,
            removeItem: remove
        };
    };

    return { KEYS, ALL_KEYS, isQuotaError, createStorage };
});
