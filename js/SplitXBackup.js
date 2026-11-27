// @ts-check
/**
 * SplitXBackup.js
 * Respaldo íntegro versionado, restauración atómica validada y purga de PII local (Issue #11).
 * No confunde un respaldo completo con la exportación de nómina (CSV/Excel/PDF).
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory(require('./SplitXStorage.js'), require('./SplitXCurrencies.js'));
    } else {
        root.SplitXBackup = factory(root.SplitXStorage, root.SplitXCurrencies);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, /** @param {any} SplitXStorage @param {any} SplitXCurrencies */ function (SplitXStorage, SplitXCurrencies) {
    'use strict';

    const SCHEMA = 'splitx-backup/v1';
    const VERSION = 1;
    const MAX_BACKUP_CHARS = 8 * 1024 * 1024; // 8 MB safety cap
    const SAFE_RASTER_LOGO = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;
    const SAFE_HISTORY_ID = /^[A-Za-z0-9:_-]{1,120}$/;

    /** @param {unknown} v */
    const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

    /**
     * Filtra un arreglo dejando solo números finitos positivos únicos, ordenados descendentemente.
     * @param {unknown} list
     * @returns {number[]}
     */
    const sanitizePositiveNumbers = (list) => {
        if (!Array.isArray(list)) return [];
        /** @type {Set<number>} */
        const seen = new Set();
        for (const item of list) {
            if (typeof item === 'number' && Number.isFinite(item) && item > 0) {
                seen.add(item);
            }
        }
        return Array.from(seen).sort((a, b) => b - a);
    };

    /** @param {string | null} raw */
    const safeJsonParse = (raw) => {
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
    };

    /**
     * @param {{ get: (k: string) => string | null }} storage
     * @param {Date} [now]
     */
    const buildBackup = (storage, now = new Date()) => {
        const KEYS = SplitXStorage.KEYS;
        const data = safeJsonParse(storage.get(KEYS.DATA));
        const history = safeJsonParse(storage.get(KEYS.HISTORY));
        const sheets = safeJsonParse(storage.get(KEYS.SHEETS));
        const documents = safeJsonParse(storage.get(KEYS.DOCUMENTS));

        const summary = {
            employees: Array.isArray(data?.employees) ? data.employees.length : 0,
            currency: typeof data?.currency === 'string' ? data.currency : 'DOP',
            historyCount: Array.isArray(history) ? history.length : 0,
            sheetsCount: Array.isArray(sheets?.templates) ? sheets.templates.length : 0,
            docTemplatesCount: Array.isArray(documents?.templates) ? documents.templates.length : 0,
            docPeopleCount: isPlainObj(documents?.people) ? Object.keys(documents.people).length : 0
        };

        return {
            schema: SCHEMA,
            version: VERSION,
            exportedAt: now.toISOString(),
            summary,
            payload: {
                data: isPlainObj(data) ? data : null,
                history: Array.isArray(history) ? history : null,
                sheets: isPlainObj(sheets) ? sheets : null,
                documents: isPlainObj(documents) ? documents : null
            }
        };
    };

    /**
     * @param {{ get: (k: string) => string | null }} storage
     * @param {Date} [now]
     */
    const serializeBackup = (storage, now = new Date()) => JSON.stringify(buildBackup(storage, now), null, 2);

    /**
     * Valida y sanea un respaldo antes de escribir una sola clave en almacenamiento.
     * @param {unknown} input
     */
    const validateBackup = (input) => {
        let parsed = input;
        if (typeof input === 'string') {
            if (input.length > MAX_BACKUP_CHARS) {
                throw new Error('El archivo de respaldo supera el tamaño máximo permitido (8 MB).');
            }
            try {
                parsed = JSON.parse(input);
            } catch (_) {
                throw new Error('El archivo de respaldo no es un JSON válido.');
            }
        }
        if (!isPlainObj(parsed)) throw new Error('El respaldo debe ser un objeto JSON.');
        const obj = /** @type {any} */ (parsed);
        if (obj.schema !== SCHEMA) throw new Error('Archivo no reconocido: no corresponde a un respaldo de SplitX.');
        if (obj.version !== VERSION) throw new Error(`Versión de respaldo no soportada (v${obj.version}).`);
        if (!isPlainObj(obj.payload)) throw new Error('El respaldo no contiene la sección payload.');

        const p = obj.payload;
        if (p.data !== null && p.data !== undefined && !isPlainObj(p.data)) {
            throw new Error('Datos principales de respaldo inválidos.');
        }
        if (p.data && p.data.employees !== undefined && !Array.isArray(p.data.employees)) {
            throw new Error('Lista de empleados inválida en el respaldo.');
        }
        if (p.data && p.data.inventory !== undefined && !isPlainObj(p.data.inventory)) {
            throw new Error('Inventario de caja inválido en el respaldo.');
        }
        if (p.data && p.data.bankLimits !== undefined && !isPlainObj(p.data.bankLimits)) {
            throw new Error('Límites bancarios inválidos en el respaldo.');
        }
        if (p.history !== null && p.history !== undefined && !Array.isArray(p.history)) {
            throw new Error('Historial de importaciones inválido en el respaldo.');
        }
        if (p.sheets !== null && p.sheets !== undefined && !isPlainObj(p.sheets)) {
            throw new Error('Plantillas de hojas inválidas en el respaldo.');
        }
        if (p.documents !== null && p.documents !== undefined && !isPlainObj(p.documents)) {
            throw new Error('Documentos personalizados inválidos en el respaldo.');
        }

        // Deep clone and sanitize untrusted fields (symbol, hex colors, raster-only images/logo)
        const cleanPayload = JSON.parse(JSON.stringify({
            data: p.data ?? null,
            history: p.history ?? null,
            sheets: p.sheets ?? null,
            documents: p.documents ?? null
        }));

        if (cleanPayload.data) {
            if (cleanPayload.data.denominations !== undefined) {
                const safeDenoms = sanitizePositiveNumbers(cleanPayload.data.denominations);
                if (safeDenoms.length > 0) cleanPayload.data.denominations = safeDenoms;
                else delete cleanPayload.data.denominations;
            }
            const activeDenomSet = Array.isArray(cleanPayload.data.denominations)
                ? new Set(cleanPayload.data.denominations.map(Number))
                : null;
            if (isPlainObj(cleanPayload.data.inventory)) {
                /** @type {Record<string, number>} */
                const safeInv = {};
                for (const [k, v] of Object.entries(cleanPayload.data.inventory)) {
                    const d = Number(k);
                    const q = Number.parseInt(String(v ?? ''), 10);
                    if (Number.isFinite(d) && d > 0) {
                        safeInv[String(d)] = Number.isFinite(q) && q > 0 ? q : 0;
                    }
                }
                cleanPayload.data.inventory = safeInv;
            }
            if (isPlainObj(cleanPayload.data.bankLimits)) {
                /** @type {Record<string, number>} */
                const safeLimits = {};
                for (const [k, v] of Object.entries(cleanPayload.data.bankLimits)) {
                    const d = Number(k);
                    if (!Number.isFinite(d) || d <= 0) continue;
                    if (v === null || v === undefined || String(v).trim() === '') continue;
                    const text = String(v).trim();
                    if (!/^-?\d+$/.test(text)) continue;
                    const q = Number.parseInt(text, 10);
                    if (Number.isFinite(q)) safeLimits[String(d)] = q < 0 ? 0 : q;
                }
                cleanPayload.data.bankLimits = safeLimits;
            }
            if (cleanPayload.data.breakdownColumns !== undefined) {
                const rawCols = cleanPayload.data.breakdownColumns;
                cleanPayload.data.breakdownColumns = (rawCols === 'auto' || rawCols === 3 || rawCols === 4 || rawCols === 5 || rawCols === 6) ? rawCols : 5;
            }
            if (cleanPayload.data.breakdownSize !== undefined) {
                const rawSz = cleanPayload.data.breakdownSize;
                cleanPayload.data.breakdownSize = (rawSz === 'compact' || rawSz === 'normal' || rawSz === 'large') ? rawSz : 'normal';
            }
            if (cleanPayload.data.breakdownFormat !== undefined) {
                const rawFmt = cleanPayload.data.breakdownFormat;
                cleanPayload.data.breakdownFormat = (rawFmt === 'badge' || rawFmt === 'qty_x_denom' || rawFmt === 'denom_x_qty') ? rawFmt : 'badge';
            }
            if (cleanPayload.data.chipTextColor !== undefined) {
                const rawTxt = cleanPayload.data.chipTextColor;
                cleanPayload.data.chipTextColor = (rawTxt === 'dark_tone' || rawTxt === 'black' || rawTxt === 'white') ? rawTxt : 'dark_tone';
            }
            if (cleanPayload.data.payrollLoanFund !== undefined) {
                const lf = Number(cleanPayload.data.payrollLoanFund);
                cleanPayload.data.payrollLoanFund = Number.isFinite(lf) && lf > 0 ? Math.round(lf * 100) / 100 : 0;
            }
            if (cleanPayload.data.payrollMode !== undefined) {
                cleanPayload.data.payrollMode = cleanPayload.data.payrollMode === 'deductions' ? 'deductions' : 'normal';
            }
            if (Array.isArray(cleanPayload.data.employees)) {
                cleanPayload.data.employees = cleanPayload.data.employees
                    .filter((/** @type {unknown} */ e) => isPlainObj(e))
                    .map((/** @type {any} */ e) => {
                        let cleanDist = null;
                        let droppedInvalidEntry = false;
                        if (e.lockedDistribution !== undefined) {
                            if (isPlainObj(e.lockedDistribution)) {
                                /** @type {Record<number, number>} */
                                const mapDist = {};
                                let countEntries = 0;
                                for (const [k, v] of Object.entries(e.lockedDistribution)) {
                                    const d = Number(k);
                                    const q = Number.parseInt(String(v ?? ''), 10);
                                    if (Number.isFinite(d) && d > 0 && Number.isFinite(q) && q > 0) {
                                        if (!activeDenomSet || activeDenomSet.has(d)) {
                                            mapDist[d] = q;
                                            countEntries += 1;
                                        } else {
                                            droppedInvalidEntry = true;
                                        }
                                    }
                                }
                                cleanDist = countEntries > 0 ? mapDist : null;
                            }
                            e.lockedDistribution = cleanDist;
                        }
                        if (e.payoutStatus !== undefined) {
                            let validStatus = (e.payoutStatus === 'pending' || e.payoutStatus === 'packed' || e.payoutStatus === 'paid')
                                ? e.payoutStatus
                                : (e.paid === true ? 'paid' : 'pending');
                            // Enforce cross-invariants: pending cannot hold locked bills; packed with amount > 0 requires valid complete locked bills
                            if (validStatus === 'pending') {
                                if (e.lockedDistribution !== undefined) e.lockedDistribution = null;
                            } else if (validStatus === 'packed' && ((Number(e.amount) || 0) > 0 && (!cleanDist || droppedInvalidEntry))) {
                                validStatus = 'pending';
                                e.lockedDistribution = null;
                            }
                            e.payoutStatus = validStatus;
                            e.paid = validStatus === 'paid';
                        }
                        return e;
                    });
            }
            if (cleanPayload.data.statusColorScheme !== undefined) {
                cleanPayload.data.statusColorScheme = cleanPayload.data.statusColorScheme === 'classic' ? 'classic' : 'traffic';
            }
            if (cleanPayload.data.cardNumberMode !== undefined) {
                cleanPayload.data.cardNumberMode = cleanPayload.data.cardNumberMode === 'order' ? 'order' : 'ref';
            }
            if (cleanPayload.data.currencySymbol !== undefined) {
                cleanPayload.data.currencySymbol = SplitXCurrencies.sanitizeCurrencySymbol(cleanPayload.data.currencySymbol);
            }
            if (cleanPayload.data.coinDenoms !== undefined) {
                const safeCoins = sanitizePositiveNumbers(cleanPayload.data.coinDenoms);
                if (safeCoins.length > 0) cleanPayload.data.coinDenoms = safeCoins;
                else delete cleanPayload.data.coinDenoms;
            }
            if (isPlainObj(cleanPayload.data.billColors)) {
                /** @type {Record<string, string>} */
                const safeColors = {};
                for (const [k, v] of Object.entries(cleanPayload.data.billColors)) {
                    const hex = SplitXCurrencies.sanitizeHexColor(v);
                    if (hex) safeColors[k] = hex;
                }
                cleanPayload.data.billColors = safeColors;
            }
            if (isPlainObj(cleanPayload.data.billImages)) {
                /** @type {Record<string, string>} */
                const safeImgs = {};
                for (const [k, v] of Object.entries(cleanPayload.data.billImages)) {
                    if (SplitXCurrencies.isSafeBillImage(v)) safeImgs[k] = String(v);
                }
                cleanPayload.data.billImages = safeImgs;
            }
        }

        if (Array.isArray(cleanPayload.history)) {
            const stamp = Date.now().toString(36);
            cleanPayload.history = cleanPayload.history
                .filter((/** @type {unknown} */ entry) => isPlainObj(entry))
                .map((/** @type {any} */ entry, /** @type {number} */ idx) => {
                    if (typeof entry.id !== 'string' || !SAFE_HISTORY_ID.test(entry.id)) {
                        entry.id = `h-${idx}-${stamp}`;
                    }
                    return entry;
                });
        }

        if (cleanPayload.sheets && cleanPayload.sheets.logo !== undefined && cleanPayload.sheets.logo !== null) {
            const logo = cleanPayload.sheets.logo;
            if (typeof logo !== 'string' || !SAFE_RASTER_LOGO.test(logo) || logo.length > 500000) {
                cleanPayload.sheets.logo = null;
            }
        }

        const summary = {
            employees: Array.isArray(cleanPayload.data?.employees) ? cleanPayload.data.employees.length : 0,
            currency: typeof cleanPayload.data?.currency === 'string' ? cleanPayload.data.currency : 'DOP',
            historyCount: Array.isArray(cleanPayload.history) ? cleanPayload.history.length : 0,
            sheetsCount: Array.isArray(cleanPayload.sheets?.templates) ? cleanPayload.sheets.templates.length : 0,
            docTemplatesCount: Array.isArray(cleanPayload.documents?.templates) ? cleanPayload.documents.templates.length : 0,
            docPeopleCount: isPlainObj(cleanPayload.documents?.people) ? Object.keys(cleanPayload.documents.people).length : 0
        };

        return {
            schema: SCHEMA,
            version: VERSION,
            exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : null,
            summary,
            payload: cleanPayload
        };
    };

    /**
     * Restaura un respaldo validado de forma atómica con rollback si alguna escritura falla por cuota o bloqueo.
     * @param {{ get?: (k: string) => string | null, set: (k: string, v: string) => any, remove: (k: string) => void }} storage
     * @param {unknown} input
     */
    const restoreBackup = (storage, input) => {
        const clean = validateBackup(input);
        const KEYS = SplitXStorage.KEYS;
        const ALL_KEYS = SplitXStorage.ALL_KEYS || Object.values(KEYS);

        // Snapshot prior raw values for atomic rollback
        /** @type {Array<[string, string | null]>} */
        const snapshot = ALL_KEYS.map((/** @type {string} */ k) => [k, typeof storage.get === 'function' ? storage.get(k) : null]);
        const prevDataObj = safeJsonParse(typeof storage.get === 'function' ? storage.get(KEYS.DATA) : null);
        if (clean.payload.data) {
            const prevRev = (isPlainObj(prevDataObj) && Number.isFinite(Number(prevDataObj._rev))) ? Number(prevDataObj._rev) : 0;
            const restoredRev = Number.isFinite(Number(clean.payload.data._rev)) ? Number(clean.payload.data._rev) : 0;
            clean.payload.data._rev = Math.max(prevRev, restoredRev) + 1;
            clean.payload.data._epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        }

        const rollback = () => {
            for (const [key, prev] of snapshot) {
                try {
                    if (prev === null || prev === undefined) storage.remove(key);
                    else storage.set(key, prev);
                } catch (_) { /* best-effort rollback */ }
            }
        };

        /** @type {Array<[string, unknown]>} */
        const entries = [
            [KEYS.DATA, clean.payload.data],
            [KEYS.HISTORY, clean.payload.history],
            [KEYS.SHEETS, clean.payload.sheets],
            [KEYS.DOCUMENTS, clean.payload.documents]
        ];
        try {
            for (const [key, val] of entries) {
                if (val === null) {
                    storage.remove(key);
                } else {
                    const res = storage.set(key, JSON.stringify(val));
                    if (res && res.ok === false) {
                        const why = res.reason === 'quota' ? 'almacenamiento lleno' : 'almacenamiento bloqueado';
                        throw new Error(`No se pudo restaurar el respaldo (${why}). Tus datos anteriores fueron conservados.`);
                    }
                }
            }
            // Clear legacy v1 sheets and stale corrupt backups so they cannot resurrect after reload
            storage.remove(KEYS.SHEETS_LEGACY);
            storage.remove(KEYS.CORRUPT_BACKUP);
        } catch (err) {
            rollback();
            throw err;
        }
        return { ok: true, summary: clean.summary };
    };

    /**
     * Elimina datos personales (cédula, dirección, salario contractual) guardados en Documentos,
     * conservando las plantillas editadas.
     * @param {{ get: (k: string) => string | null, set: (k: string, v: string) => any }} storage
     */
    const purgeDocumentPii = (storage) => {
        const key = SplitXStorage.KEYS.DOCUMENTS;
        const docs = safeJsonParse(storage.get(key));
        if (!isPlainObj(docs) || !isPlainObj(docs.people)) {
            return { purged: 0 };
        }
        const purged = Object.keys(docs.people).length;
        if (purged === 0) return { purged: 0 };
        docs.people = {};
        storage.set(key, JSON.stringify(docs));
        return { purged };
    };

    return {
        SCHEMA,
        VERSION,
        buildBackup,
        serializeBackup,
        validateBackup,
        restoreBackup,
        purgeDocumentPii
    };
});
