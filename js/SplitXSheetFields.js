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
     * @typedef {{ id: string, conceptId: string, concept: string, amount: number, status?: string, principal?: number, interest?: number, balanceBefore?: number, balanceAfter?: number }} LoanItem
     * @typedef {{ balanceBefore?: number, amount?: number, balanceAfter?: number, totalOutstanding?: number, totalOutstandingAfter?: number }} LoanSummary
     * @typedef {{ unit?: string, regular?: number, overtime?: number, holiday?: number, restDay?: number, total?: number }} WorkDays
     * @typedef {{ start?: string, end?: string }} Period
     * @typedef {{ schema?: string, period?: Period, currency?: string, projectId?: string, projectName?: string, companyName?: string, payrollName?: string }} ExportContext
     *
     * @typedef {Object} ImportExtras
     * @property {string} [employeeNumber]
     * @property {string} [employeeName]
     * @property {string} [sourceEmployeeId]
     * @property {WorkDays} [workDays]
     * @property {{ id: string, name: string, days?: number, dailyRate?: number }[]} [positions]
     * @property {{ id: string, name: string, number?: string }[]} [leaders]
     * @property {ConceptDetail[]} [bonusDetails]
     * @property {ConceptDetail[]} [deductionDetails]
     * @property {LoanItem[]} [loanItems] Cada préstamo/adelanto descontado en este pago.
     * @property {LoanSummary} [loanSummary]
     * @property {ExportContext} [exportContext]
     *
     * @typedef {{ key: string, label: string, type: 'text' | 'number', decimals?: number | 'auto', noTotal?: boolean, get: (record: any, ctx: { index: number }) => unknown }} FieldDef
     */

    const MAX_ITEMS = 100;
    const MAX_TEXT = 200;
    const CONCEPT_GROUPS = /** @type {const} */ ([['bonus', 'bonusDetails'], ['deduction', 'deductionDetails'], ['loan', 'loanItems']]);

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

    /** @param {unknown} list */
    const pickPositions = (list) => {
        if (!Array.isArray(list)) return undefined;
        /** @type {{ id: string, name: string, days?: number, dailyRate?: number }[]} */
        const out = [];
        for (const raw of list.slice(0, MAX_ITEMS)) {
            if (!isObj(raw)) continue;
            const r = /** @type {any} */ (raw);
            const name = str(r.name);
            if (!name) continue;
            /** @type {{ id: string, name: string, days?: number, dailyRate?: number }} */
            const pos = { id: str(r.id) ?? slugify(name), name };
            const days = num(r.workDays?.total);
            const dailyRate = num(r.dailyRate);
            if (days !== undefined) pos.days = days;
            if (dailyRate !== undefined) pos.dailyRate = dailyRate;
            out.push(pos);
        }
        return out;
    };

    /** @param {unknown} list @returns {LoanItem[] | undefined} */
    const pickLoanItems = (list) => {
        if (!Array.isArray(list)) return undefined;
        /** @type {LoanItem[]} */
        const out = [];
        for (const raw of list.slice(0, MAX_ITEMS)) {
            if (!isObj(raw)) continue;
            const l = /** @type {any} */ (raw);
            const concept = str(l.concept) ?? str(l.concepto);
            const id = str(l.loanId) ?? str(l.id) ?? (concept ? slugify(concept) : undefined);
            const amount = num(l.deductionAmount) ?? num(l.amount);
            if (!id || amount === undefined) continue;
            /** @type {LoanItem} */
            // conceptId agrupa préstamos del mismo tipo: un chip "Adelanto de salario" sirve para todos.
            const item = { id, conceptId: slugify(concept ?? id), concept: concept ?? id, amount };
            const status = str(l.status);
            if (status) item.status = status;
            /** @type {[keyof LoanItem, unknown][]} */
            const optional = [['principal', l.principalAmount], ['interest', l.interestAmount], ['balanceBefore', l.balanceBefore], ['balanceAfter', l.projectedBalanceAfter]];
            for (const [k, v] of optional) {
                const n = num(v);
                if (n !== undefined) /** @type {any} */ (item)[k] = n;
            }
            out.push(item);
        }
        return out;
    };

    /** @param {unknown} v @returns {LoanSummary | undefined} */
    const pickLoanSummary = (v) => {
        if (!isObj(v)) return undefined;
        const s = /** @type {any} */ (v);
        /** @type {LoanSummary} */
        const out = {};
        /** @type {[keyof LoanSummary, unknown][]} */
        const map = [['balanceBefore', s.balanceBefore], ['amount', s.deductionAmount], ['balanceAfter', s.projectedBalanceAfter],
            ['totalOutstanding', s.totalOutstandingBalance], ['totalOutstandingAfter', s.projectedTotalOutstandingBalance]];
        for (const [k, raw] of map) {
            const n = num(raw);
            if (n !== undefined) out[k] = n;
        }
        return Object.keys(out).length ? out : undefined;
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
        const positions = pickPositions(item.positions);
        const leaders = pickRefs(item.leaders, true);
        const bonusDetails = pickDetails(item.bonusDetails);
        const deductionDetails = pickDetails(item.deductionDetails);
        const exportContext = pickContext(item.exportContext);
        const loanItems = pickLoanItems(item.loanBreakdown);
        const loanSummary = pickLoanSummary(item.loanSummary);
        if (employeeNumber) out.employeeNumber = employeeNumber;
        if (employeeName) out.employeeName = employeeName;
        if (sourceEmployeeId) out.sourceEmployeeId = sourceEmployeeId;
        if (workDays) out.workDays = workDays;
        if (positions) out.positions = positions;
        if (leaders) out.leaders = leaders;
        if (bonusDetails) out.bonusDetails = bonusDetails;
        if (deductionDetails) out.deductionDetails = deductionDetails;
        if (loanItems) out.loanItems = loanItems;
        if (loanSummary) out.loanSummary = loanSummary;
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

    /**
     * Suma de lo descontado por préstamos en este pago (undefined si no es una lista).
     * @param {unknown} breakdown
     */
    const sumLoanAmounts = (breakdown) => {
        const list = pickLoanItems(breakdown);
        return list ? list.reduce((sum, l) => sum + l.amount, 0) : undefined;
    };

    /**
     * Capital, interés y saldo restante de los préstamos descontados en este pago, a partir de
     * loanBreakdown / loanSummary (undefined si el empleado no trae desglose de préstamos).
     * @param {any} item
     * @returns {{ principal?: number, interest?: number, balanceAfter?: number } | undefined}
     */
    const summarizeLoans = (item) => {
        if (!isObj(item)) return undefined;
        const loans = pickLoanItems(item.loanBreakdown) || [];
        const summary = pickLoanSummary(item.loanSummary);
        if (!loans.length && !summary) return undefined;
        /** @type {{ principal?: number, interest?: number, balanceAfter?: number }} */
        const out = {};
        const sumOf = (/** @type {'principal' | 'interest' | 'balanceAfter'} */ k) => {
            const withValue = loans.filter((l) => typeof l[k] === 'number');
            return withValue.length ? withValue.reduce((s, l) => s + /** @type {number} */ (l[k]), 0) : undefined;
        };
        const principal = sumOf('principal');
        const interest = sumOf('interest');
        const balanceAfter = summary?.balanceAfter ?? sumOf('balanceAfter');
        if (principal !== undefined) out.principal = principal;
        if (interest !== undefined) out.interest = interest;
        if (balanceAfter !== undefined) out.balanceAfter = balanceAfter;
        return out;
    };

    /**
     * Sueldo por día: el del puesto si el export lo trae (ponderado por días si hay varios puestos);
     * si no, bruto ÷ días trabajados.
     * @param {any} r
     */
    const dailyRateOf = (r) => {
        const rated = (r.positions || []).filter((/** @type {any} */ p) => typeof p.dailyRate === 'number');
        if (rated.length) {
            const weight = (/** @type {any} */ p) => (typeof p.days === 'number' && p.days > 0 ? p.days : 1);
            const totalW = rated.reduce((/** @type {number} */ s, /** @type {any} */ p) => s + weight(p), 0);
            return rated.reduce((/** @type {number} */ s, /** @type {any} */ p) => s + p.dailyRate * weight(p), 0) / totalW;
        }
        const gross = r.payroll?.gross;
        const total = r.workDays?.total;
        return gross > 0 && total > 0 ? gross / total : null;
    };

    /**
     * Acepta una lista de empleados [...] o un objeto { exportContext, employees: [...] }.
     * El contexto general se copia a los empleados que no traen el suyo.
     * @param {unknown} parsed
     * @returns {{ items: any[], context: ExportContext | null }}
     */
    const unwrapImportPayload = (parsed) => {
        /** @type {any[]} */
        let items;
        /** @type {any} */
        let rawContext = null;
        if (Array.isArray(parsed)) {
            items = parsed;
        } else if (isObj(parsed) && Array.isArray(/** @type {any} */ (parsed).employees ?? /** @type {any} */ (parsed).empleados)) {
            const obj = /** @type {any} */ (parsed);
            items = obj.employees ?? obj.empleados;
            rawContext = isObj(obj.exportContext) ? obj.exportContext : null;
        } else {
            throw new Error('El JSON debe ser una lista [...] de empleados o un objeto con "employees": [...].');
        }
        if (items.length === 0) throw new Error('La lista de empleados está vacía.');
        if (rawContext) {
            items = items.map((it) => (isObj(it) && !isObj(it.exportContext) ? { ...it, exportContext: rawContext } : it));
        }
        const first = items.find((it) => isObj(it) && isObj(it.exportContext));
        return { items, context: pickContext(rawContext ?? (first ? first.exportContext : null)) ?? null };
    };

    /**
     * Detalle por concepto para mostrar en la tarjeta del empleado. Un grupo sale vacío
     * si su detalle ya no cuadra con el total (p. ej. el total se editó a mano).
     * @param {any} emp
     */
    const conceptLines = (emp) => {
        const p = emp?.payroll || {};
        /** @param {{ concept: string, amount: number }[] | undefined} list @param {unknown} total */
        const lines = (list, total) => {
            if (!Array.isArray(list) || !list.length) return [];
            const sum = list.reduce((s, d) => s + (Number(d.amount) || 0), 0);
            return Math.abs(sum - (Number(total) || 0)) <= 0.01 ? list : null;
        };
        const bonuses = lines(emp?.bonusDetails, p.bonuses);
        const deductions = lines(emp?.deductionDetails, p.discounts);
        const loans = lines(emp?.loanItems, p.loans);
        return {
            bonuses: (bonuses || []).map((d) => ({ label: d.concept, amount: d.amount })),
            deductions: (deductions || []).map((d) => ({ label: d.concept, amount: d.amount })),
            loans: (loans || []).map((/** @type {any} */ d) => {
                /** @type {{ label: string, amount: number, balanceAfter?: number }} */
                const line = { label: d.concept, amount: d.amount };
                if (typeof d.balanceAfter === 'number') line.balanceAfter = d.balanceAfter;
                return line;
            })
        };
    };

    /** "2026-10-01" → "01/10/2026" */
    const formatDate = (/** @type {string | undefined} */ iso) => {
        if (!iso) return '';
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
        return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
    };

    /** @param {any} r */
    // El nombre limpio del export, salvo que el usuario haya corregido el nombre en SplitX.
    const displayName = (r) => {
        const edited = r.originalData && r.originalData.name !== undefined && r.name !== r.originalData.name;
        return (edited ? r.name : r.employeeName || r.name) || '';
    };

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
            { key: 'loanBalance', label: 'Saldo pendiente', type: 'number', noTotal: true, get: payroll((p) => p.loanDetails?.remainingBalance) },
            { key: 'loanBalanceBefore', label: 'Saldo antes del pago', type: 'number', noTotal: true, get: (r) => r.loanSummary?.balanceBefore ?? null },
            { key: 'loanBalanceAfter', label: 'Saldo después del pago', type: 'number', noTotal: true, get: (r) => r.loanSummary?.balanceAfter ?? null },
            { key: 'days', label: 'Días trabajados', type: 'number', decimals: 'auto', noTotal: true, get: days('total') },
            { key: 'daysRegular', label: 'Días regulares', type: 'number', decimals: 'auto', noTotal: true, get: days('regular') },
            { key: 'daysOvertime', label: 'Días extra', type: 'number', decimals: 'auto', noTotal: true, get: days('overtime') },
            { key: 'daysHoliday', label: 'Días feriados', type: 'number', decimals: 'auto', noTotal: true, get: days('holiday') },
            { key: 'daysRest', label: 'Días de descanso', type: 'number', decimals: 'auto', noTotal: true, get: days('restDay') },
            {
                key: 'dailyRate', label: 'Sueldo por día', type: 'number', noTotal: true, get: dailyRateOf
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
                    const key = `${prefix}:${prefix === 'loan' ? d.conceptId : d.id}`;
                    if (!catalog.has(key)) catalog.set(key, d.concept || d.id);
                }
            }
        }

        /**
         * Campos dinámicos 'bonus:<id>', 'deduction:<id>' y 'loan:<id>': el monto del concepto del empleado
         * (sumado si se repite) o vacío si no lo tiene.
         * @param {string} key
         * @returns {FieldDef | undefined}
         */
        const resolveField = (key) => {
            const m = /^(bonus|deduction|loan):(.+)$/.exec(key);
            if (!m) return undefined;
            const [, prefix, id] = m;
            const prop = /** @type {'bonusDetails' | 'deductionDetails' | 'loanItems'} */ ({ bonus: 'bonusDetails', deduction: 'deductionDetails', loan: 'loanItems' }[prefix]);
            return {
                key,
                label: catalog.get(key) || id,
                type: 'number',
                get: (r) => {
                    const matches = (r?.[prop] || []).filter((/** @type {any} */ d) => (prefix === 'loan' ? d.conceptId : d.id) === id);
                    return matches.length ? matches.reduce((/** @type {number} */ s, /** @type {{ amount: number }} */ d) => s + d.amount, 0) : null;
                }
            };
        };

        const listConcepts = () => Array.from(catalog, ([key, label]) => ({ key, label, type: /** @type {'number'} */ ('number') }));

        return { fields, resolveField, listConcepts };
    };

    return { pickImportExtras, sumDetailAmounts, sumLoanAmounts, summarizeLoans, unwrapImportPayload, conceptLines, createFieldSet, slugify };
});
