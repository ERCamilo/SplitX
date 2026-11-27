// @ts-check
/**
 * SplitXImportHistory.js
 * Historial de las últimas nóminas importadas (Sistema de Asistencia, JSON o Excel).
 * Funciones puras + lectura/escritura tolerante en localStorage.
 */
(function (root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        /** @type {any} */ (root).SplitXImportHistory = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STORAGE_KEY = 'Split_import_history';
    const MAX_ENTRIES = 10;
    /** ~1.5M caracteres: deja espacio a Split_data y a las plantillas dentro de la cuota (~5MB). */
    const MAX_CHARS = 1500000;

    /**
     * @typedef {{ start?: string, end?: string }} Period
     * @typedef {{ id: string, importedAt: string, source: string, title: string, subtitle: string,
     *   period: Period|null, currency: string, count: number, total: number, signature: string,
     *   context: Record<string, any>|null, employees: Array<Record<string, any>> }} HistoryEntry
     */

    /** @param {any} v */
    const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    /** @param {any} v */
    const clone = (v) => JSON.parse(JSON.stringify(v));
    /** @param {any} v */
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    /** @param {number} n */
    const round2 = (n) => Math.round(n * 100) / 100;

    /** Hash corto y estable (FNV-1a 32 bits) en base 36. @param {string} str */
    const hash = (str) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(36);
    };

    /**
     * Identifica una nómina por nombres y montos (no por ids ni estado de pago).
     * @param {Array<Record<string, any>>} employees
     */
    const entrySignature = (employees) => {
        const list = Array.isArray(employees) ? employees : [];
        return list.length + ':' + hash(list.map((e) => String(e?.name ?? '').trim().toLowerCase() + '|' + round2(num(e?.amount)).toFixed(2)).join('\n'));
    };

    const SOURCE_LABELS = /** @type {Record<string, string>} */ ({ sa: 'Sistema de Asistencia', json: 'JSON', excel: 'Excel' });

    /**
     * @param {{ employees: Array<Record<string, any>>, source: string, context?: Record<string, any>|null,
     *   period?: Period|null, currency?: string|null, now?: Date }} input
     * @returns {HistoryEntry}
     */
    const createEntry = ({ employees, source, context = null, period = null, currency = null, now = new Date() }) => {
        const list = Array.isArray(employees) ? employees : [];
        const ctx = isObj(context) ? /** @type {Record<string, any>} */ (context) : null;
        const ctxJson = ctx ? JSON.stringify(ctx) : null;
        // El contexto compartido se guarda una sola vez; solo se conserva el de cada empleado si es distinto.
        const packed = list.map((e) => {
            const copy = clone(e || {});
            if (ctxJson && isObj(copy.exportContext) && JSON.stringify(copy.exportContext) === ctxJson) delete copy.exportContext;
            return copy;
        });
        const p = (isObj(period) && period) || (ctx && isObj(ctx.period) ? ctx.period : null);
        const subtitle = ctx ? [ctx.companyName, ctx.projectName].map((s) => String(s || '').trim()).filter(Boolean).join(' · ') : '';
        const signature = entrySignature(list);
        const importedAt = now.toISOString();
        return {
            id: signature + '-' + now.getTime().toString(36),
            importedAt,
            source: String(source || 'json'),
            title: (ctx && String(ctx.payrollName || '').trim()) || 'Importación ' + (SOURCE_LABELS[source] || 'manual'),
            subtitle,
            period: p ? { start: String(p.start || ''), end: String(p.end || '') } : null,
            currency: String(currency || (ctx && ctx.currency) || ''),
            count: list.length,
            total: round2(list.reduce((s, e) => s + num(e?.amount), 0)),
            signature,
            context: ctx ? clone(ctx) : null,
            employees: packed
        };
    };

    /**
     * Empleados listos para cargar: copias, con su contexto y sin marcas de pago.
     * @param {HistoryEntry} entry
     */
    const restoreEmployees = (entry) => (entry.employees || []).map((e) => {
        const copy = clone(e);
        if (entry.context && !isObj(copy.exportContext)) copy.exportContext = clone(entry.context);
        copy.paid = false;
        copy.payoutStatus = 'pending';
        copy.lockedDistribution = null;
        return copy;
    });

    /** @param {HistoryEntry} entry @param {Array<Record<string, any>>} employees */
    const isCurrent = (entry, employees) => Array.isArray(employees) && employees.length > 0 && entry.signature === entrySignature(employees);

    /** @param {Period | null | undefined} a @param {Period | null | undefined} b */
    const samePeriod = (a, b) => (!a && !b) || (!!a && !!b && (a.start || '') === (b.start || '') && (a.end || '') === (b.end || ''));

    /**
     * Agrega al inicio; si la misma nómina del mismo período ya estaba, se mueve arriba (sin duplicar).
     * Períodos distintos con salarios fijos idénticos se conservan ambos.
     * @param {HistoryEntry[]} list @param {HistoryEntry} entry @param {number} [max]
     */
    const addEntry = (list, entry, max = MAX_ENTRIES) => [
        entry,
        ...(list || []).filter((e) => !(e.signature === entry.signature && samePeriod(e.period, entry.period)))
    ].slice(0, max);

    /** @param {HistoryEntry[]} list @param {string} id */
    const removeEntry = (list, id) => (list || []).filter((e) => e.id !== id);

    /** Quita las más antiguas hasta que el JSON quepa. @param {HistoryEntry[]} list @param {number} maxChars */
    const trimToChars = (list, maxChars) => {
        let out = (list || []).slice();
        while (out.length && JSON.stringify(out).length > maxChars) out = out.slice(0, -1);
        return out;
    };

    /** @param {any} e @returns {e is HistoryEntry} */
    const isEntry = (e) => isObj(e) && typeof e.id === 'string' && typeof e.importedAt === 'string' && Array.isArray(e.employees) && typeof e.signature === 'string';

    /** @param {string|null|undefined} raw @returns {HistoryEntry[]} */
    const parseHistory = (raw) => {
        if (!raw) return [];
        try {
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data.filter(isEntry) : [];
        } catch (e) {
            return [];
        }
    };

    /** @param {{ getItem: (k: string) => string|null }} storage */
    const load = (storage) => {
        try { return parseHistory(storage.getItem(STORAGE_KEY)); } catch (e) { return []; }
    };

    /**
     * Guarda lo que quepa: recorta por tamaño y, ante un error de cuota (lanzado o retornado), sigue quitando la más antigua.
     * Nunca lanza: el historial es secundario, la nómina actual ya se guardó aparte.
     * @param {{ setItem: (k: string, v: string) => any }} storage @param {HistoryEntry[]} list
     * @returns {HistoryEntry[]} lo que quedó guardado
     */
    const save = (storage, list) => {
        let out = trimToChars(list, MAX_CHARS);
        while (true) {
            try {
                const res = storage.setItem(STORAGE_KEY, JSON.stringify(out));
                if (res && res.ok === false) {
                    if (res.reason === 'quota' && out.length > 0) {
                        out = out.slice(0, -1);
                        continue;
                    }
                    return res.reason === 'quota' ? out : list;
                }
                return out;
            } catch (e) {
                const quota = /quota/i.test(String(/** @type {any} */ (e)?.name) + String(/** @type {any} */ (e)?.message));
                if (!quota || out.length === 0) return quota ? out : list;
                out = out.slice(0, -1);
            }
        }
    };

    const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    /** @param {number} n */
    const pad = (n) => String(n).padStart(2, '0');
    /** @param {string} iso */
    const parseDay = (iso) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
    };

    /** @param {Period|null} period */
    const periodLabel = (period) => {
        const a = parseDay(period?.start || ''), b = parseDay(period?.end || '');
        if (!a || !b) return '';
        const left = pad(a.d) + ' ' + MONTHS[a.m] + (a.y !== b.y ? ' ' + a.y : '');
        return left + ' – ' + pad(b.d) + ' ' + MONTHS[b.m] + ' ' + b.y;
    };

    /** @param {Date} a @param {Date} b */
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

    /** @param {HistoryEntry} entry @param {Date} [now] */
    const describeEntry = (entry, now = new Date()) => {
        const at = new Date(entry.importedAt);
        const time = pad(at.getHours()) + ':' + pad(at.getMinutes());
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const whenLabel = sameDay(at, now) ? 'Hoy ' + time
            : sameDay(at, yesterday) ? 'Ayer ' + time
                : pad(at.getDate()) + ' ' + MONTHS[at.getMonth()] + ' ' + at.getFullYear() + ' ' + time;
        return {
            periodLabel: periodLabel(entry.period),
            whenLabel,
            sourceLabel: SOURCE_LABELS[entry.source] || entry.source,
            countLabel: entry.count + (entry.count === 1 ? ' empleado' : ' empleados')
        };
    };

    return {
        STORAGE_KEY, MAX_ENTRIES, MAX_CHARS,
        entrySignature, createEntry, restoreEmployees, isCurrent,
        addEntry, removeEntry, trimToChars, parseHistory, load, save,
        periodLabel, describeEntry
    };
});
