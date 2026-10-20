// @ts-check
/**
 * SplitXSheetFields.js
 * Adaptador entre los empleados de SplitX y el motor SheetBuilder:
 * - conserva al importar los datos extra del formato "sa-splitx-payroll/v1"
 *   (número de empleado, días trabajados, puestos, líderes, conceptos, contexto)
 * - expone los campos (variables) disponibles para las plantillas imprimibles,
 *   incluidos los conceptos dinámicos de bonos y deducciones ('bonus:<id>', 'deduction:<id>').
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        root.SplitXSheetFields = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * @typedef {{ id: string, concept: string, type: string, value: number, amount: number }} ConceptDetail
     * @typedef {{ unit?: string, regular?: number, overtime?: number, holiday?: number, restDay?: number, total?: number }} WorkDays
     * @typedef {{ start?: string, end?: string }} Period
     * @typedef {{ schema?: string, period?: Period, currency?: string, projectId?: string, projectName?: string, companyName?: string, payrollName?: string }} ExportContext
     *
     * @typedef {Object} ImportExtras
     * @property {string} [employeeNumber]
     * @property {string} [employeeName]
     * @property {string} [sourceEmployeeId]
     * @property {WorkDays} [workDays]
     * @property {{ id: string, name: string }[]} [positions]
     * @property {{ id: string, name: string, number?: string }[]} [leaders]
     * @property {ConceptDetail[]} [bonusDetails]
     * @property {ConceptDetail[]} [deductionDetails]
     * @property {ExportContext} [exportContext]
     *
     * @typedef {{ key: string, label: string, type: 'text' | 'number', decimals?: number | 'auto', noTotal?: boolean, get: (record: any, ctx: { index: number }) => unknown }} FieldDef
     */

    const MAX_ITEMS = 100;
    const MAX_TEXT = 200;
    const CONCEPT_GROUPS = /** @type {const} */ ([['bonus', 'bonusDetails'], ['deduction', 'deductionDetails']]);

    /** @param {unknown} v */
    const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

    /** @param {unknown} v @returns {string | undefined} */
    const str = (v) => {
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
        if (typeof v !== 'string') return undefined;
        const s = v.trim().slice(0, MAX_TEXT);
        return s || undefined;
    };

    /** @param {unknown} v @returns {number | undefined} */
    const num = (v) => {
        if (v === null || v === undefined || v === '') return undefined;
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        return Number.isFinite(n) ? n : undefined;
    };

    /** "Pérdida de Equipo" → "perdida_de_equipo" */
    const slugify = (/** @type {string} */ text) => text
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

    /** @param {unknown} v @returns {WorkDays | undefined} */
    const pickWorkDays = (v) => {
        if (!isObj(v)) return undefined;
        const w = /** @type {any} */ (v);
        /** @type {WorkDays} */
        const out = {};
        const unit = str(w.unit);
        if (unit) out.unit = unit;
        for (const k of /** @type {const} */ (['regular', 'overtime', 'holiday', 'restDay', 'total'])) {
            const n = num(w[k]);
            if (n !== undefined) out[k] = n;
        }
        return Object.keys(out).length ? out : undefined;
    };

    /** @param {unknown} list @returns {ConceptDetail[] | undefined} */
    const pickDetails = (list) => {
        if (!Array.isArray(list)) return undefined;
        /** @type {ConceptDetail[]} */
        const out = [];
        for (const raw of list.slice(0, MAX_ITEMS)) {
            if (!isObj(raw)) continue;
            const d = /** @type {any} */ (raw);
            const concept = str(d.concept) ?? str(d.concepto);
            const id = str(d.id) ?? (concept ? slugify(concept) : undefined);
            const amount = num(d.amount) ?? num(d.monto) ?? (num(d.signedAmount) !== undefined ? Math.abs(/** @type {number} */ (num(d.signedAmount))) : undefined);
            if (!id || amount === undefined) continue;
            out.push({ id, concept: concept ?? id, type: str(d.type) ?? 'fixed', value: num(d.value) ?? amount, amount });
        }
        return out;
    };

    /** @param {unknown} list @param {boolean} withNumber */
    const pickRefs = (list, withNumber) => {
        if (!Array.isArray(list)) return undefined;
        /** @type {{ id: string, name: string, number?: string }[]} */
        const out = [];
        for (const raw of list.slice(0, MAX_ITEMS)) {
            if (!isObj(raw)) continue;
            const r = /** @type {any} */ (raw);
            const name = str(r.name);
            if (!name) continue;
            /** @type {{ id: string, name: string, number?: string }} */
            const ref = { id: str(r.id) ?? slugify(name), name };
            const number = withNumber ? str(r.number) : undefined;
            if (number) ref.number = number;
            out.push(ref);
        }
        return out;
    };

    /** @param {unknown} v @returns {ExportContext | undefined} */
    const pickContext = (v) => {
        if (!isObj(v)) return undefined;
        const c = /** @type {any} */ (v);
        /** @type {ExportContext} */
        const out = {};
        for (const k of /** @type {const} */ (['schema', 'currency', 'projectId', 'projectName', 'companyName', 'payrollName'])) {
            const s = str(c[k]);
            if (s) out[k] = s;
        }
        if (isObj(c.period)) {
            const start = str(c.period.start);
            const end = str(c.period.end);
            if (start || end) out.period = { ...(start && { start }), ...(end && { end }) };
        }
        // Los totales del export no se guardan: quedarían desactualizados al editar en SplitX.
        return Object.keys(out).length ? out : undefined;
    };

    /**
     * Datos extra del import que SplitX conserva en el empleado. Solo incluye lo que viene.
     * @param {any} item
     * @returns {ImportExtras}
     */
    const pickImportExtras = (item) => {
        if (!isObj(item)) return {};
        /** @type {ImportExtras} */
        const out = {};
        const employeeNumber = str(item.employeeNumber);
        const employeeName = str(item.employeeName);
        const sourceEmployeeId = str(item.sourceEmployeeId);
        const workDays = pickWorkDays(item.workDays);
        const positions = pickRefs(item.positions, false);
        const leaders = pickRefs(item.leaders, true);
        const bonusDetails = pickDetails(item.bonusDetails);
        const deductionDetails = pickDetails(item.deductionDetails);
        const exportContext = pickContext(item.exportContext);
        if (employeeNumber) out.employeeNumber = employeeNumber;
        if (employeeName) out.employeeName = employeeName;
        if (sourceEmployeeId) out.sourceEmployeeId = sourceEmployeeId;
        if (workDays) out.workDays = workDays;
        if (positions) out.positions = positions;
        if (leaders) out.leaders = leaders;
        if (bonusDetails) out.bonusDetails = bonusDetails;
        if (deductionDetails) out.deductionDetails = deductionDetails;
        if (exportContext) out.exportContext = exportContext;
        return out;
    };

    /**
     * Suma de montos de una lista de conceptos (undefined si no es una lista).
     * @param {unknown} details
     */
    const sumDetailAmounts = (details) => {
        const list = pickDetails(details);
        return list ? list.reduce((sum, d) => sum + d.amount, 0) : undefined;
    };

    /** "2026-10-01" → "01/10/2026" */
    const formatDate = (/** @type {string | undefined} */ iso) => {
        if (!iso) return '';
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
        return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
    };

    /** @param {any} r */
    const displayName = (r) => r.employeeName || r.name || '';

    /**
     * @param {{ records?: any[], getNetAmount?: (record: any) => number }} [options]
     *   records: empleados actuales, para conocer el nombre de los conceptos importados.
     *   getNetAmount: monto neto efectivo según la app (por defecto, record.amount).
     */
    const createFieldSet = (options = {}) => {
        const getNet = options.getNetAmount || ((/** @type {any} */ r) => r.amount);
        /** @param {(r: any) => unknown} fn */
        const payroll = (fn) => (/** @type {any} */ r) => (r.payroll ? fn(r.payroll) : null);
        /** @param {string} k */
        const days = (k) => (/** @type {any} */ r) => r.workDays?.[k] ?? null;

        /** @type {FieldDef[]} */
        const fields = [
            { key: 'no', label: 'No.', type: 'text', get: (r, ctx) => r.employeeNumber || String(ctx.index + 1) },
            { key: 'name', label: 'Nombre', type: 'text', get: displayName },
            { key: 'firstName', label: 'Primer nombre', type: 'text', get: (r) => String(displayName(r)).trim().split(/\s+/)[0] },
            { key: 'net', label: 'Monto neto', type: 'number', get: getNet },
            { key: 'gross', label: 'Bruto', type: 'number', get: payroll((p) => p.gross) },
            { key: 'bonuses', label: 'Bonificaciones', type: 'number', get: payroll((p) => p.bonuses) },
            { key: 'discounts', label: 'Descuentos', type: 'number', get: payroll((p) => p.discounts) },
            { key: 'afterDiscounts', label: 'Después de descuentos', type: 'number', get: payroll((p) => p.afterDiscounts) },
            { key: 'loans', label: 'Préstamo/Adelanto', type: 'number', get: payroll((p) => p.loans) },
            { key: 'loanPrincipal', label: 'Capital del préstamo', type: 'number', get: payroll((p) => p.loanDetails?.principal) },
            { key: 'loanInterest', label: 'Interés del préstamo', type: 'number', get: payroll((p) => p.loanDetails?.interestAmount) },
            { key: 'loanBalance', label: 'Saldo pendiente', type: 'number', get: payroll((p) => p.loanDetails?.remainingBalance) },
            { key: 'days', label: 'Días trabajados', type: 'number', decimals: 'auto', noTotal: true, get: days('total') },
            { key: 'daysRegular', label: 'Días regulares', type: 'number', decimals: 'auto', noTotal: true, get: days('regular') },
            { key: 'daysOvertime', label: 'Días extra', type: 'number', decimals: 'auto', noTotal: true, get: days('overtime') },
            { key: 'daysHoliday', label: 'Días feriados', type: 'number', decimals: 'auto', noTotal: true, get: days('holiday') },
            { key: 'daysRest', label: 'Días de descanso', type: 'number', decimals: 'auto', noTotal: true, get: days('restDay') },
            {
                key: 'dailyRate', label: 'Sueldo por día', type: 'number', noTotal: true,
                get: (r) => {
                    const gross = r.payroll?.gross;
                    const total = r.workDays?.total;
                    return gross > 0 && total > 0 ? gross / total : null;
                }
            },
            { key: 'position', label: 'Puesto', type: 'text', get: (r) => (r.positions || []).map((/** @type {any} */ p) => p.name).join(', ') },
            { key: 'leader', label: 'Líder', type: 'text', get: (r) => (r.leaders || []).map((/** @type {any} */ l) => l.name).join(', ') },
            { key: 'company', label: 'Empresa', type: 'text', get: (r) => r.exportContext?.companyName ?? '' },
            { key: 'payrollName', label: 'Nómina', type: 'text', get: (r) => r.exportContext?.payrollName ?? '' },
            { key: 'project', label: 'Proyecto', type: 'text', get: (r) => r.exportContext?.projectName ?? '' },
            {
                key: 'period', label: 'Período', type: 'text',
                get: (r) => {
                    const p = r.exportContext?.period;
                    return p ? [formatDate(p.start), formatDate(p.end)].filter(Boolean).join(' - ') : '';
                }
            },
            { key: 'currency', label: 'Moneda', type: 'text', get: (r) => r.exportContext?.currency ?? '' }
        ];

        /** @type {Map<string, string>} Catálogo clave → nombre del concepto, en orden de aparición. */
        const catalog = new Map();
        for (const record of options.records || []) {
            for (const [prefix, prop] of CONCEPT_GROUPS) {
                for (const d of record?.[prop] || []) {
                    const key = `${prefix}:${d.id}`;
                    if (!catalog.has(key)) catalog.set(key, d.concept || d.id);
                }
            }
        }

        /**
         * Campos dinámicos 'bonus:<id>' y 'deduction:<id>': el monto del concepto del empleado
         * (sumado si se repite) o vacío si no lo tiene.
         * @param {string} key
         * @returns {FieldDef | undefined}
         */
        const resolveField = (key) => {
            const m = /^(bonus|deduction):(.+)$/.exec(key);
            if (!m) return undefined;
            const [, prefix, id] = m;
            const prop = prefix === 'bonus' ? 'bonusDetails' : 'deductionDetails';
            return {
                key,
                label: catalog.get(key) || id,
                type: 'number',
                get: (r) => {
                    const matches = (r?.[prop] || []).filter((/** @type {ConceptDetail} */ d) => d.id === id);
                    return matches.length ? matches.reduce((/** @type {number} */ s, /** @type {ConceptDetail} */ d) => s + d.amount, 0) : null;
                }
            };
        };

        const listConcepts = () => Array.from(catalog, ([key, label]) => ({ key, label, type: /** @type {'number'} */ ('number') }));

        return { fields, resolveField, listConcepts };
    };

    return { pickImportExtras, sumDetailAmounts, createFieldSet, slugify };
});
