// @ts-check
/**
 * SplitXState.js
 * Carga resiliente del estado persistido (Split_data) y gestión segura de copia dañada (Issue #9).
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXState = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SCHEMA_VERSION = 1;

    /** @param {unknown} v */
    const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

    /**
     * Nunca lanza: un valor corrupto (JSON roto o estructura incompatible) devuelve
     * { ok: false, data: null, backup } para poder respaldarlo y arrancar limpio.
     * @param {string | null | undefined} raw
     * @returns {{ ok: true, data: Record<string, any> | null, backup?: undefined } | { ok: false, data: null, backup: string }}
     */
    const parseSavedState = (raw) => {
        if (raw === null || raw === undefined || raw === '') return { ok: true, data: null };
        try {
            const data = JSON.parse(raw);
            if (isPlainObj(data)) {
                const employeesValid = data.employees === undefined || Array.isArray(data.employees);
                const inventoryValid = data.inventory === undefined || isPlainObj(data.inventory);
                const bankLimitsValid = data.bankLimits === undefined || isPlainObj(data.bankLimits);
                if (employeesValid && inventoryValid && bankLimitsValid) {
                    return { ok: true, data };
                }
            }
        } catch (_e) {}
        return { ok: false, data: null, backup: String(raw) };
    };

    /**
     * Carga Split_data desde almacenamiento; si está dañado, preserva Split_data_corrupt_backup
     * sin sobrescribir una copia previa no recuperada e informa explícitamente si la escritura falló.
     * @param {{ get: (k: string) => string | null, set: (k: string, v: string) => { ok?: boolean, reason?: string | null } | void }} storage
     * @param {{ DATA: string, CORRUPT_BACKUP: string }} keys
     */
    const loadOrRecoverState = (storage, keys) => {
        const raw = storage.get(keys.DATA);
        const parsed = parseSavedState(raw);
        if (parsed.ok) {
            return {
                ok: true,
                data: parsed.data,
                backupSaved: false,
                preservedExisting: false,
                backupError: null,
                rawBackup: null
            };
        }

        const existingBackup = storage.get(keys.CORRUPT_BACKUP);
        if (existingBackup) {
            return {
                ok: false,
                data: null,
                backupSaved: true,
                preservedExisting: true,
                backupError: null,
                rawBackup: existingBackup
            };
        }

        const writeRes = storage.set(keys.CORRUPT_BACKUP, parsed.backup);
        if (writeRes && writeRes.ok === false) {
            return {
                ok: false,
                data: null,
                backupSaved: false,
                preservedExisting: false,
                backupError: writeRes.reason || 'blocked',
                rawBackup: parsed.backup
            };
        }

        return {
            ok: false,
            data: null,
            backupSaved: true,
            preservedExisting: false,
            backupError: null,
            rawBackup: parsed.backup
        };
    };

    /**
     * Devuelve la copia dañada disponible (persistida o en memoria de sesión).
     * @param {{ get: (k: string) => string | null }} storage
     * @param {{ CORRUPT_BACKUP: string }} keys
     * @param {string | null} [inMemoryFallback]
     * @returns {string | null}
     */
    const getCorruptBackup = (storage, keys, inMemoryFallback = null) => {
        const stored = storage.get(keys.CORRUPT_BACKUP);
        if (stored) return stored;
        return inMemoryFallback || null;
    };

    /**
     * Elimina la copia dañada tras su descarga o descarte explícito por el usuario.
     * @param {{ remove: (k: string) => void }} storage
     * @param {{ CORRUPT_BACKUP: string }} keys
     */
    const clearCorruptBackup = (storage, keys) => {
        storage.remove(keys.CORRUPT_BACKUP);
    };

    return {
        SCHEMA_VERSION,
        parseSavedState,
        loadOrRecoverState,
        getCorruptBackup,
        clearCorruptBackup
    };
});
