// @ts-check
/**
 * SplitXExport.js
 * Exportación segura de nómina a CSV, Excel (.xlsx) y PDF:
 * - Protege CSV contra comillas sin escapar y CSV Formula Injection (prefijos =, +, -, arroba).
 * - Usa siempre el símbolo de moneda activo (cero '$' hardcodeados).
 * - Carga SheetJS y jsPDF bajo demanda (lazy) para no bloquear el arranque de la app.
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXExport = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const XLSX_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    const XLSX_SRI = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';
    const JSPDF_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    const JSPDF_SRI = 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk';
    const AUTOTABLE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.28/jspdf.plugin.autotable.min.js';
    const AUTOTABLE_SRI = 'sha384-vxxMdt1K6XlME6zkLsgFrrHIeC7XIdAo1GW/uhhObjJXnymxiIi/eoMXsKJA13ZJ';

    /** @param {Date} [date] */
    const isoDateTag = (date = new Date()) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    /**
     * Escapa una celda CSV (RFC 4180) y neutraliza fórmulas peligrosas (prefijos =, +, -, arroba, Tab, CR).
     * @param {unknown} value
     * @returns {string}
     */
    const csvCell = (value) => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
        let s = String(value);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        if (/[",\r\n]/.test(s) || s.startsWith("'")) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    };

    /** @param {unknown[]} row */
    const csvRow = (row) => row.map(csvCell).join(',');

    /** @param {number} n @param {number} [dec] */
    const formatNum = (n, dec = 2) => (Number(n) || 0).toLocaleString('en-US', {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec
    });

    /** Integer-cent arithmetic to prevent IEEE-754 float drift on USD/EUR coin sums. */
    /** @param {unknown} v */
    const toCents = (v) => Math.round((Number(v) || 0) * 100);
    /** @param {number} c */
    const fromCents = (c) => Math.round(c) / 100;

    /**
     * @param {string} src
     * @param {string} integrity
     * @param {string} attr
     * @param {() => boolean} isReady
     * @param {string} errorMsg
     * @returns {Promise<void>}
     */
    const loadScriptOnce = (src, integrity, attr, isReady, errorMsg) => new Promise((resolve, reject) => {
        if (isReady()) { resolve(); return; }
        if (typeof document === 'undefined') { reject(new Error(errorMsg)); return; }
        const existing = document.querySelector(`script[${attr}]`);
        if (existing) {
            existing.addEventListener('load', () => (isReady() ? resolve() : reject(new Error(errorMsg))), { once: true });
            existing.addEventListener('error', () => reject(new Error(errorMsg)), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.setAttribute(attr, '');
        script.src = src;
        script.integrity = integrity;
        script.crossOrigin = 'anonymous';
        script.referrerPolicy = 'no-referrer';
        script.onload = () => {
            if (isReady()) { resolve(); return; }
            script.remove();
            reject(new Error(errorMsg));
        };
        script.onerror = () => {
            script.remove();
            reject(new Error(errorMsg));
        };
        document.head.appendChild(script);
    });

    /**
     * Calcula anchos determinísticos para la tabla PDF de distribución por empleado (A4 horizontal)
     * garantizando que TODAS las denominaciones quepan dentro del ancho útil sin desbordarse.
     * @param {number[]} denoms
     * @param {number} [pageW]
     * @param {number} [marginX]
     */
    const computePdfEmpTableLayout = (denoms, pageW = 297, marginX = 14) => {
        const usableW = pageW - 2 * marginX;
        const count = Math.max(1, denoms.length);
        const numW = 9;
        const netW = count > 12 ? 26 : 30;
        const minNameW = count > 13 ? 38 : 48;
        const availForDenoms = Math.max(count * 8, usableW - numW - netW - minNameW);
        const denomColW = Math.min(18, Math.floor((availForDenoms / count) * 10) / 10);
        const nameW = Math.max(36, Math.round((usableW - numW - netW - denomColW * count) * 10) / 10);
        const fontSize = count > 13 ? 7 : count > 10 ? 7.5 : 8.5;
        const cellPadding = { top: 2.5, bottom: 2.5, left: 1.2, right: 1.2 };
        return {
            usableW,
            numW,
            nameW,
            netW,
            denomColW,
            fontSize,
            cellPadding,
            headers: denoms.map((d) => String(d))
        };
    };

    const ensureXLSX = () => loadScriptOnce(
        XLSX_CDN, XLSX_SRI, 'data-sx-xlsx',
        () => typeof (/** @type {any} */ (globalThis)).XLSX !== 'undefined',
        'No se pudo cargar la librería SheetJS (XLSX). Verifica tu conexión a internet.'
    );

    const ensureJsPDF = async () => {
        const g = /** @type {any} */ (globalThis);
        await loadScriptOnce(
            JSPDF_CDN, JSPDF_SRI, 'data-sx-jspdf',
            () => !!(g.jspdf && g.jspdf.jsPDF),
            'No se pudo cargar la librería jsPDF. Verifica tu conexión a internet.'
        );
        await loadScriptOnce(
            AUTOTABLE_CDN, AUTOTABLE_SRI, 'data-sx-jspdf-autotable',
            () => !!(g.jspdf?.jsPDF?.API?.autoTable),
            'No se pudo cargar el complemento jsPDF AutoTable. Verifica tu conexión a internet.'
        );
    };

    /**
     * Construye el dataset consolidado para CSV/Excel/PDF calculando la distribución una sola vez.
     * @param {{
     *   state: any,
     *   calculateDistribution: () => any,
     *   calculateBankNeeds: (coverage?: any) => any,
     *   getPayrollSummary: () => any,
     *   getEffectiveEmployeeAmount: (emp: any) => number,
     *   computeLedgerSummary?: (denoms: number[], inventory: Record<number, number>, results: any[], loanFundResult?: any) => any
     * }} deps
     */
    const buildExportData = ({ state, calculateDistribution, calculateBankNeeds, getPayrollSummary, getEffectiveEmployeeAmount, computeLedgerSummary }) => {
        const coverage = calculateDistribution();
        const { results, loanFundResult } = coverage;
        /** @type {number[]} */
        const denoms = state.denominations;
        const bankData = calculateBankNeeds(coverage);
        const payrollSummary = getPayrollSummary();

        /** @type {Record<number, number>} */
        const summary = {};
        denoms.forEach(d => { summary[d] = 0; });
        results.forEach((/** @type {any} */ emp) => {
            if (!emp.paid) {
                denoms.forEach(d => {
                    if (emp.distribution[d]) summary[d] += emp.distribution[d];
                });
            }
        });

        if (loanFundResult?.distribution) {
            denoms.forEach(d => {
                if (loanFundResult.distribution[d]) summary[d] += loanFundResult.distribution[d];
            });
        }

        const loanFundAmount = fromCents(toCents(loanFundResult?.amount || 0));
        const loanFundDistribution = loanFundResult?.distribution || {};
        const loanFundMissing = fromCents(toCents(loanFundResult?.missingAmount || 0));

        let totalToWithdrawCents = 0;
        /** @type {Record<number, number>} */
        const bankSummary = {};
        denoms.forEach(d => {
            const qty = bankData.breakdown[d]?.final || 0;
            bankSummary[d] = qty;
            totalToWithdrawCents += qty * toCents(d);
        });
        const totalToWithdraw = fromCents(totalToWithdrawCents);

        const empRows = results.map((/** @type {any} */ emp, /** @type {number} */ idx) => {
            const effAmount = fromCents(toCents(getEffectiveEmployeeAmount(emp)));
            const payoutStatus = (emp.payoutStatus === 'paid' || emp.payoutStatus === 'packed' || emp.payoutStatus === 'pending')
                ? emp.payoutStatus
                : (emp.paid ? 'paid' : 'pending');
            /** @type {Record<string | number, any>} */
            const row = {
                idx: idx + 1,
                name: emp.name,
                amount: effAmount,
                paid: payoutStatus === 'paid',
                payoutStatus,
                status: emp.status,
                missingAmount: fromCents(toCents(emp._missingAmount || 0)),
                payroll: emp.payroll
            };
            denoms.forEach(d => { row[d] = emp.distribution[d] || 0; });
            return row;
        });

        // Single source of truth for Ledger/Cuadre reconciliation: delegate to SplitXCore.computeLedgerSummary when available
        const g = /** @type {any} */ (typeof globalThis !== 'undefined' ? globalThis : null);
        const ledgerFn = typeof computeLedgerSummary === 'function'
            ? computeLedgerSummary
            : (g && g.SplitXCore && typeof g.SplitXCore.computeLedgerSummary === 'function' ? g.SplitXCore.computeLedgerSummary : null);

        let missingCents = toCents(loanFundMissing);
        results.forEach((/** @type {any} */ emp) => {
            const st = (emp.payoutStatus === 'paid' || emp.payoutStatus === 'packed' || emp.payoutStatus === 'pending')
                ? emp.payoutStatus
                : (emp.paid ? 'paid' : 'pending');
            if (st === 'pending') missingCents += toCents(emp._missingAmount || 0);
        });

        let ledgerSummary;
        if (ledgerFn) {
            const coreLedger = ledgerFn(denoms, state.inventory || {}, results, loanFundResult);
            ledgerSummary = {
                ...coreLedger,
                totalMissing: fromCents(missingCents)
            };
        } else {
            const inv = state.inventory || {};
            /** @type {Record<number, number>} */
            const packedBills = {};
            /** @type {Record<number, number>} */
            const paidBills = {};
            denoms.forEach(d => { packedBills[d] = 0; paidBills[d] = 0; });

            let totalBoxCents = 0;
            denoms.forEach(d => {
                totalBoxCents += Math.max(0, Number(inv[d]) || 0) * toCents(d);
            });

            let paidCents = 0;
            let paidFromBoxCents = 0;
            let paidExternalCents = 0;
            let packedCents = 0;
            let packedBillsCents = 0;
            let pendingCents = 0;
            let paidCount = 0;
            let paidFromBoxCount = 0;
            let paidExternalCount = 0;
            let packedCount = 0;
            let pendingCount = 0;

            results.forEach((/** @type {any} */ emp) => {
                const st = (emp.payoutStatus === 'paid' || emp.payoutStatus === 'packed' || emp.payoutStatus === 'pending')
                    ? emp.payoutStatus
                    : (emp.paid ? 'paid' : 'pending');
                const amtCents = toCents(getEffectiveEmployeeAmount(emp));
                const locked = emp.lockedDistribution && typeof emp.lockedDistribution === 'object' ? emp.lockedDistribution : null;
                const lockedEntries = locked ? Object.entries(locked).filter(([, q]) => Number(q) > 0) : [];
                if (st === 'paid') {
                    paidCount += 1;
                    paidCents += amtCents;
                    if (lockedEntries.length > 0) {
                        paidFromBoxCount += 1;
                        denoms.forEach(d => {
                            const q = Math.max(0, Number(locked[d]) || 0);
                            if (q > 0) {
                                paidBills[d] += q;
                                paidFromBoxCents += q * toCents(d);
                            }
                        });
                    } else {
                        paidExternalCount += 1;
                        paidExternalCents += amtCents;
                    }
                } else if (st === 'packed') {
                    packedCount += 1;
                    packedCents += amtCents;
                    if (lockedEntries.length > 0) {
                        denoms.forEach(d => {
                            const q = Math.max(0, Number(locked[d]) || 0);
                            if (q > 0) {
                                packedBills[d] += q;
                                packedBillsCents += q * toCents(d);
                            }
                        });
                    }
                } else {
                    pendingCount += 1;
                    pendingCents += amtCents;
                }
            });

            let looseCents = 0;
            let overcommitCents = 0;
            denoms.forEach(d => {
                const avail = Math.max(0, Number(inv[d]) || 0);
                const committed = (packedBills[d] || 0) + (paidBills[d] || 0);
                const diff = avail - committed;
                if (diff >= 0) looseCents += diff * toCents(d);
                else overcommitCents += (-diff) * toCents(d);
            });

            ledgerSummary = {
                totalBox: fromCents(totalBoxCents),
                paidTotal: fromCents(paidCents),
                paidFromBoxTotal: fromCents(paidFromBoxCents),
                paidFromBoxCount,
                paidExternalTotal: fromCents(paidExternalCents),
                paidExternalCount,
                packedTotal: fromCents(packedCents),
                packedBillsTotal: fromCents(packedBillsCents),
                pendingTotal: fromCents(pendingCents),
                loanFundAmount,
                looseTotal: fromCents(looseCents),
                overcommitTotal: fromCents(overcommitCents),
                orphanedLockedTotal: 0,
                totalMissing: fromCents(missingCents),
                paidCount,
                packedCount,
                pendingCount,
                paidBills,
                packedBills
            };
        }

        return {
            payrollMode: state.payrollMode || 'deductions',
            denoms,
            summary,
            empRows,
            payrollSummary,
            loanFundResult,
            loanFundAmount,
            loanFundMissing,
            loanFundDistribution,
            bankData,
            bankSummary,
            totalToWithdraw,
            ledgerSummary
        };
    };

    /**
     * Genera el contenido CSV seguro (puro, probado en Node).
     * @param {{ data: ReturnType<typeof buildExportData>, currencySymbol: string }} params
     */
    const buildCSVContent = ({ data, currencySymbol }) => {
        const { denoms, empRows, payrollSummary, loanFundResult, loanFundAmount, totalToWithdraw } = data;
        const isNormalMode = data.payrollMode === 'normal';
        const hasPayroll = payrollSummary.count > 0;
        const loansDeducted = isNormalMode ? 0 : payrollSummary.loans;
        /** @type {string[]} */
        const lines = [];

        lines.push(hasPayroll
            ? csvRow(['No.', 'Nombre', 'Bruto', 'Bonificaciones', 'Descuentos', 'Despues descuentos', 'Prestamos', 'Neto', 'Pagado', 'Detalle', 'Estado'])
            : csvRow(['No.', 'Nombre', 'Monto', 'Pagado', 'Detalle', 'Estado']));

        /** @param {any} row */
        const formatPayoutLabel = (row) => {
            const st = (row.payoutStatus === 'paid' || row.payoutStatus === 'packed' || row.payoutStatus === 'pending')
                ? row.payoutStatus
                : (row.paid ? 'paid' : 'pending');
            if (st === 'paid') return 'Pagado';
            if (st === 'packed') return 'En sobre';
            return 'Pendiente';
        };

        empRows.forEach((/** @type {any} */ row) => {
            /** @type {string[]} */
            const details = [];
            denoms.forEach(d => {
                if (row[d] > 0) details.push(`${row[d]}x${d}`);
            });
            const paidStatus = formatPayoutLabel(row);
            if (hasPayroll) {
                const p = row.payroll || {};
                lines.push(csvRow([
                    row.idx, row.name,
                    p.gross ?? '', p.bonuses ?? '', p.discounts ?? '',
                    p.afterDiscounts ?? '', isNormalMode ? 0 : (p.loans ?? ''),
                    row.amount, paidStatus, details.join(' + '), row.status
                ]));
            } else {
                lines.push(csvRow([row.idx, row.name, row.amount, paidStatus, details.join(' + '), row.status]));
            }
        });

        if (loanFundAmount > 0) {
            /** @type {string[]} */
            const fundDetails = [];
            denoms.forEach(d => {
                if (loanFundResult.distribution[d] > 0) fundDetails.push(`${loanFundResult.distribution[d]}x${d}`);
            });
            if (hasPayroll) {
                lines.push(csvRow(['★', 'FONDO PARA NUEVOS PRESTAMOS (RESERVA)', '', '', '', '', '', loanFundAmount, 'NO', fundDetails.join(' + '), loanFundResult.status]));
            } else {
                lines.push(csvRow(['★', 'FONDO PARA NUEVOS PRESTAMOS (RESERVA)', loanFundAmount, 'NO', fundDetails.join(' + '), loanFundResult.status]));
            }
        }

        lines.push('');
        lines.push(csvRow(['--- RESUMEN FINANCIERO Y SOLICITUD BANCARIA ---']));
        lines.push(csvRow(['Concepto', `Monto (${currencySymbol})`]));
        if (hasPayroll) {
            lines.push(csvRow(['Total Sueldo Bruto', fromCents(toCents(payrollSummary.gross))]));
            lines.push(csvRow(['Total Bonificaciones', fromCents(toCents(payrollSummary.bonuses))]));
            lines.push(csvRow(['Total Descuentos', fromCents(toCents(payrollSummary.discounts))]));
            lines.push(csvRow(['Total Préstamos Descontados en Nómina', fromCents(toCents(loansDeducted))]));
            lines.push(csvRow(['Fondo Reservado para Nuevos Préstamos', fromCents(toCents(loanFundAmount))]));
            lines.push(csvRow(['Recaudación Restante en Empresa', Math.max(0, fromCents(toCents(loansDeducted) - toCents(loanFundAmount)))]));
            lines.push(csvRow(['Total Neto Nómina a Pagar', fromCents(toCents(payrollSummary.net))]));
        } else {
            const totalNominaCents = empRows.reduce((/** @type {number} */ s, /** @type {any} */ e) => s + toCents(e.amount), 0);
            lines.push(csvRow(['Total Nómina', fromCents(totalNominaCents)]));
            if (loanFundAmount > 0) lines.push(csvRow(['Fondo Nuevos Préstamos', fromCents(toCents(loanFundAmount))]));
        }
        lines.push(csvRow(['TOTAL A RETIRAR DEL BANCO (NÓMINA + RESERVA)', fromCents(toCents(totalToWithdraw))]));

        const ls = data.ledgerSummary;
        if (ls && (ls.totalBox > 0 || ls.packedCount > 0 || ls.paidCount > 0 || ls.totalMissing > 0 || ls.overcommitTotal > 0)) {
            const paidFromBox = ls.paidFromBoxTotal !== undefined ? ls.paidFromBoxTotal : ls.paidTotal;
            const packedBillsAmt = ls.packedBillsTotal !== undefined ? ls.packedBillsTotal : ls.packedTotal;
            lines.push('');
            lines.push(csvRow(['--- CUADRE DE CAJA Y ESTADO DE ENTREGA ---']));
            lines.push(csvRow(['Concepto', `Monto (${currencySymbol})`]));
            lines.push(csvRow(['Caja inicial', ls.totalBox]));
            lines.push(csvRow(['Pagado de caja', paidFromBox]));
            if ((ls.paidExternalTotal || 0) > 0) lines.push(csvRow(['Pagado sin caja (externo)', ls.paidExternalTotal]));
            lines.push(csvRow(['En sobre', packedBillsAmt]));
            lines.push(csvRow(['Pendiente', ls.pendingTotal]));
            if ((ls.loanFundAmount || 0) > 0) lines.push(csvRow(['Reserva préstamos incluida en mesa', ls.loanFundAmount]));
            lines.push(csvRow(['Suelto en mesa', ls.looseTotal]));
            if (ls.overcommitTotal > 0) lines.push(csvRow(['SOBRECOMPROMISO EN CAJA', ls.overcommitTotal]));
            if ((ls.orphanedLockedTotal || 0) > 0) lines.push(csvRow(['DENOMINACIONES RETIRADAS EN SOBRES', ls.orphanedLockedTotal]));
            if (ls.totalMissing > 0) lines.push(csvRow(['FALTANTE EN CAJA', ls.totalMissing]));
        }
        return lines.join('\n') + '\n';
    };

    /**
     * @param {{
     *   getState: () => any,
     *   getCurrencySymbol: () => string,
     *   calculateDistribution: () => any,
     *   calculateBankNeeds: (coverage?: any) => any,
     *   getPayrollSummary: () => any,
     *   getEffectiveEmployeeAmount: (emp: any) => number,
     *   computeLedgerSummary?: (denoms: number[], inventory: Record<number, number>, results: any[], loanFundResult?: any) => any,
     *   showCustomAlert: (opts: any) => any
     * }} deps
     */
    const createExporter = (deps) => {
        const getData = () => buildExportData({
            state: deps.getState(),
            calculateDistribution: deps.calculateDistribution,
            calculateBankNeeds: deps.calculateBankNeeds,
            getPayrollSummary: deps.getPayrollSummary,
            getEffectiveEmployeeAmount: deps.getEffectiveEmployeeAmount,
            computeLedgerSummary: deps.computeLedgerSummary
        });

        const exportToCSV = () => {
            const data = getData();
            const sym = deps.getCurrencySymbol();
            const csv = '\uFEFF' + buildCSVContent({ data, currencySymbol: sym });
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.setAttribute('hidden', '');
            a.setAttribute('href', url);
            a.setAttribute('download', `nomina_SplitX_${isoDateTag()}.csv`);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        };

        const exportToExcel = async () => {
            try {
                await ensureXLSX();
            } catch (err) {
                deps.showCustomAlert({
                    title: 'Librería Excel no disponible',
                    message: err instanceof Error ? err.message : 'No se pudo cargar SheetJS (XLSX).',
                    icon: 'fa-circle-exclamation',
                    type: 'danger',
                    confirmText: 'Entendido'
                });
                return;
            }
            const XLSX = /** @type {any} */ (globalThis).XLSX;
            const { payrollMode, denoms, summary, empRows, payrollSummary, loanFundResult, loanFundAmount, totalToWithdraw, bankSummary, ledgerSummary } = getData();
            const isNormalMode = payrollMode === 'normal';
            const loansDeducted = isNormalMode ? 0 : payrollSummary.loans;
            const hasPayroll = payrollSummary.count > 0;
            const wb = XLSX.utils.book_new();
            const dateTag = isoDateTag();
            const today = new Date().toLocaleDateString('es-DO');
            const sym = deps.getCurrencySymbol();

            const allPaidComplete = !!(ledgerSummary && ledgerSummary.paidCount > 0 && ledgerSummary.pendingCount === 0 && ledgerSummary.packedCount === 0 && loanFundAmount === 0);
            const section1Title = allPaidComplete
                ? '1. RESUMEN DE BILLETES ENTREGADOS EN CAJA (NÓMINA COMPLETA)'
                : '1. RESUMEN DE BILLETES Y MONEDAS PARA PAGO EN CAJA';
            const section1Source = allPaidComplete && ledgerSummary.paidBills ? ledgerSummary.paidBills : summary;

            /** @type {any[][]} */
            const s1Data = [
                ['DISTRIBUCIÓN DE NÓMINA Y PEDIDO AL BANCO - SPLIT X'],
                [`Fecha: ${today}`],
                [],
                [section1Title],
                [`Denominación (${sym})`, 'Cantidad de Billetes', `Valor Total (${sym})`]
            ];
            let grandTotalCents = 0;
            denoms.forEach(d => {
                const qty = section1Source[d] || 0;
                const valCents = qty * toCents(d);
                grandTotalCents += valCents;
                s1Data.push([d, qty, fromCents(valCents)]);
            });
            s1Data.push([allPaidComplete ? 'TOTAL ENTREGADO EN CAJA' : 'TOTAL NÓMINA EN CAJA', '', fromCents(grandTotalCents)]);
            s1Data.push([]);

            s1Data.push(['2. SOLICITUD DE RETIRO AL BANCO (VENTANILLA)']);
            s1Data.push([`Denominación (${sym})`, 'Cantidad a Retirar', `Valor Total (${sym})`]);
            denoms.forEach(d => {
                const qty = bankSummary[d] || 0;
                s1Data.push([d, qty, fromCents(qty * toCents(d))]);
            });
            s1Data.push(['TOTAL A SOLICITAR AL BANCO', '', totalToWithdraw]);
            s1Data.push([]);

            if (hasPayroll || loanFundAmount > 0) {
                s1Data.push(['3. RESUMEN DE PRÉSTAMOS Y RESERVAS']);
                s1Data.push(['Concepto', '', `Monto (${sym})`]);
                s1Data.push(['Sueldo Bruto Total', '', fromCents(toCents(payrollSummary.gross))]);
                s1Data.push(['Bonificaciones Totales', '', fromCents(toCents(payrollSummary.bonuses))]);
                s1Data.push(['Descuentos Totales', '', fromCents(toCents(payrollSummary.discounts))]);
                s1Data.push([isNormalMode ? 'Préstamos Descontados (Modo Normal: Omitidos)' : 'Préstamos Descontados en Nómina', '', fromCents(toCents(loansDeducted))]);
                s1Data.push(['Fondo Reservado para Nuevos Préstamos', '', loanFundAmount]);
                s1Data.push(['Recaudación Restante en Empresa', '', Math.max(0, fromCents(toCents(loansDeducted) - toCents(loanFundAmount)))]);
                s1Data.push(['Total Neto a Pagar a Empleados', '', fromCents(toCents(payrollSummary.net))]);
                s1Data.push(['Total Efectivo a Retirar del Banco', '', totalToWithdraw]);
                s1Data.push([]);
            }

            if (ledgerSummary && (ledgerSummary.totalBox > 0 || ledgerSummary.packedCount > 0 || ledgerSummary.paidCount > 0 || ledgerSummary.totalMissing > 0 || ledgerSummary.overcommitTotal > 0)) {
                const paidFromBox = ledgerSummary.paidFromBoxTotal !== undefined ? ledgerSummary.paidFromBoxTotal : ledgerSummary.paidTotal;
                const packedBillsAmt = ledgerSummary.packedBillsTotal !== undefined ? ledgerSummary.packedBillsTotal : ledgerSummary.packedTotal;
                s1Data.push(['CUADRE DE CAJA Y ESTADO DE ENTREGA']);
                s1Data.push(['Concepto', '', `Monto (${sym})`]);
                s1Data.push(['Caja inicial', '', ledgerSummary.totalBox]);
                s1Data.push([`Pagado de caja (${ledgerSummary.paidFromBoxCount ?? ledgerSummary.paidCount})`, '', paidFromBox]);
                if ((ledgerSummary.paidExternalTotal || 0) > 0) s1Data.push([`Pagado sin caja (${ledgerSummary.paidExternalCount})`, '', ledgerSummary.paidExternalTotal]);
                s1Data.push([`En sobre (${ledgerSummary.packedCount})`, '', packedBillsAmt]);
                s1Data.push([`Pendiente (${ledgerSummary.pendingCount})`, '', ledgerSummary.pendingTotal]);
                if ((ledgerSummary.loanFundAmount || 0) > 0) s1Data.push(['Reserva préstamos incluida en mesa', '', ledgerSummary.loanFundAmount]);
                s1Data.push(['Suelto en mesa', '', ledgerSummary.looseTotal]);
                if (ledgerSummary.overcommitTotal > 0) s1Data.push(['SOBRECOMPROMISO EN CAJA', '', ledgerSummary.overcommitTotal]);
                if ((ledgerSummary.orphanedLockedTotal || 0) > 0) s1Data.push(['DENOMINACIONES RETIRADAS EN SOBRES', '', ledgerSummary.orphanedLockedTotal]);
                if (ledgerSummary.totalMissing > 0) s1Data.push(['FALTANTE EN CAJA', '', ledgerSummary.totalMissing]);
            }

            const ws1 = XLSX.utils.aoa_to_sheet(s1Data);
            ws1['!cols'] = [{ wch: 36 }, { wch: 22 }, { wch: 22 }];
            XLSX.utils.book_append_sheet(wb, ws1, 'Resumen y Banco');

            const payrollHeaders = hasPayroll ? ['Bruto', 'Bonif.', 'Desc.', 'Despues desc.', 'Prestamos', 'Neto'] : [`Monto (${sym})`];
            const headerRow = ['#', 'Nombre', ...payrollHeaders, ...denoms.map(d => `${sym}${d}`), 'Estado', 'Pagado'];
            /** @type {any[][]} */
            const s2Data = [
                ['DISTRIBUCIÓN DETALLADA POR EMPLEADO'],
                [`Fecha: ${today}`],
                [],
                headerRow
            ];

            empRows.forEach((/** @type {any} */ emp) => {
                const payrollValues = hasPayroll
                    ? [
                        emp.payroll?.gross ?? '',
                        emp.payroll?.bonuses ?? '',
                        emp.payroll?.discounts ?? '',
                        emp.payroll?.afterDiscounts ?? '',
                        isNormalMode ? 0 : (emp.payroll?.loans ?? ''),
                        emp.amount
                    ]
                    : [emp.amount];
                const pLabel = emp.payoutStatus === 'packed' ? 'En sobre' : (emp.paid ? 'Pagado' : 'Pendiente');
                s2Data.push([
                    emp.idx,
                    emp.name,
                    ...payrollValues,
                    ...denoms.map(d => emp[d] || 0),
                    emp.status === 'ok' ? 'OK' : 'Incompleto',
                    pLabel
                ]);
            });

            if (loanFundAmount > 0) {
                const fundValues = hasPayroll ? ['', '', '', '', '', loanFundAmount] : [loanFundAmount];
                s2Data.push([
                    '★',
                    'FONDO NUEVOS PRÉSTAMOS (RESERVA)',
                    ...fundValues,
                    ...denoms.map(d => loanFundResult.distribution[d] || 0),
                    loanFundResult.status === 'ok' ? 'OK' : 'Incompleto',
                    'No'
                ]);
            }

            const totalNominaAmount = fromCents(empRows.reduce((/** @type {number} */ s, /** @type {any} */ e) => s + toCents(e.amount), 0) + toCents(loanFundAmount));
            const totalRow = hasPayroll
                ? ['', 'TOTAL NÓMINA', payrollSummary.gross, payrollSummary.bonuses, payrollSummary.discounts, payrollSummary.afterDiscounts, loansDeducted, totalNominaAmount]
                : ['', 'TOTAL', totalNominaAmount];
            denoms.forEach(d => totalRow.push(empRows.reduce((/** @type {number} */ s, /** @type {any} */ e) => s + (e[d] || 0), 0) + (loanFundResult.distribution[d] || 0)));
            totalRow.push('', '');
            s2Data.push([]);
            s2Data.push(totalRow);

            const hasPaidRows = empRows.some((/** @type {any} */ e) => e.paid);
            if (hasPaidRows) {
                const pendingAmount = fromCents(empRows.reduce((/** @type {number} */ s, /** @type {any} */ e) => s + (!e.paid ? toCents(e.amount) : 0), 0) + toCents(loanFundAmount));
                const pendingRow = hasPayroll
                    ? ['', 'TOTAL PENDIENTE DE ENTREGA', '', '', '', '', '', pendingAmount]
                    : ['', 'TOTAL PENDIENTE DE ENTREGA', pendingAmount];
                denoms.forEach(d => pendingRow.push(summary[d] || 0));
                pendingRow.push('', '');
                s2Data.push(pendingRow);
            }

            const ws2 = XLSX.utils.aoa_to_sheet(s2Data);
            const col2widths = [{ wch: 5 }, { wch: 32 }];
            payrollHeaders.forEach(() => col2widths.push({ wch: 14 }));
            denoms.forEach(() => col2widths.push({ wch: 9 }));
            col2widths.push({ wch: 12 }, { wch: 8 });
            ws2['!cols'] = col2widths;
            XLSX.utils.book_append_sheet(wb, ws2, 'Distribución Empleados');

            /** @type {any[][]} */
            const s3Data = [
                ['SOLICITUD DE RETIRO DE EFECTIVO AL BANCO'],
                [`Fecha: ${today}`],
                ['Entidad / Empresa: Nómina Split X'],
                [],
                [`Denominación (${sym})`, 'Cantidad Solicitada', `Valor Total (${sym})`]
            ];
            denoms.forEach(d => {
                const qty = bankSummary[d] || 0;
                s3Data.push([d, qty, fromCents(qty * toCents(d))]);
            });
            s3Data.push([]);
            s3Data.push(['TOTAL GENERAL A RETIRAR', '', totalToWithdraw]);
            s3Data.push([]);
            s3Data.push(['Firma Autorizada:', '___________________________', '']);

            const ws3 = XLSX.utils.aoa_to_sheet(s3Data);
            ws3['!cols'] = [{ wch: 25 }, { wch: 25 }, { wch: 25 }];
            XLSX.utils.book_append_sheet(wb, ws3, 'Pedido al Banco');

            XLSX.writeFile(wb, `nomina_SplitX_${dateTag}.xlsx`);
        };

        const exportToPDF = async () => {
            try {
                await ensureJsPDF();
            } catch (err) {
                deps.showCustomAlert({
                    title: 'Librería PDF no disponible',
                    message: err instanceof Error ? err.message : 'No se pudo cargar jsPDF.',
                    icon: 'fa-circle-exclamation',
                    type: 'danger',
                    confirmText: 'Entendido'
                });
                return;
            }
            const { jsPDF } = /** @type {any} */ (globalThis).jspdf;
            const state = deps.getState();
            const sym = deps.getCurrencySymbol();
            const money = (/** @type {number} */ n, /** @type {number} */ dec = 2) => `${sym} ${formatNum(n, dec)}`;
            const { denoms, summary, empRows, payrollSummary, loanFundResult, loanFundAmount, ledgerSummary } = getData();
            const dateTag = isoDateTag();
            const today = new Date().toLocaleDateString('es-DO');

            const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
            const pageW = doc.internal.pageSize.getWidth();
            const pageH = doc.internal.pageSize.getHeight();

            // Página 1: Resumen de Billetes y Monedas en Caja
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(16);
            doc.setTextColor(30, 41, 59);
            doc.text('DISTRIBUCIÓN DE EFECTIVO — Split X', pageW / 2, 20, { align: 'center' });

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            doc.setTextColor(100, 116, 139);
            doc.text(`Fecha: ${today}`, pageW / 2, 26, { align: 'center' });

            const pdfAllPaid = !!(ledgerSummary && ledgerSummary.paidCount > 0 && ledgerSummary.pendingCount === 0 && ledgerSummary.packedCount === 0 && loanFundAmount === 0);
            const pdfPage1Source = pdfAllPaid && ledgerSummary.paidBills ? ledgerSummary.paidBills : summary;

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(11);
            doc.setTextColor(30, 41, 59);
            doc.text(
                pdfAllPaid
                    ? 'BILLETES ENTREGADOS EN CAJA (NÓMINA COMPLETA)'
                    : 'BILLETES Y MONEDAS EN CAJA (PAGOS + RESERVA DE PRÉSTAMOS)',
                pageW / 2, 36, { align: 'center' }
            );

            /** @type {any[]} */
            const summaryBody = [];
            let grandTotalCashCents = 0;
            denoms.forEach(d => {
                const qty = pdfPage1Source[d] || 0;
                const valCents = qty * toCents(d);
                grandTotalCashCents += valCents;
                if (qty > 0) {
                    const dec = Number.isInteger(d) ? 0 : 2;
                    summaryBody.push([money(d, dec), qty.toLocaleString('en-US'), money(fromCents(valCents))]);
                }
            });
            summaryBody.push([
                { content: 'TOTAL GENERAL', styles: { fontStyle: 'bold' } },
                { content: '', styles: { fontStyle: 'bold' } },
                { content: money(fromCents(grandTotalCashCents)), styles: { fontStyle: 'bold' } }
            ]);

            const table1Width = 190;
            doc.autoTable({
                head: [['Denominación', 'Cantidad', 'Total']],
                body: summaryBody,
                startY: 42,
                tableWidth: table1Width,
                margin: { left: (pageW - table1Width) / 2 },
                styles: { font: 'helvetica', fontSize: 9.5, cellPadding: 3.5 },
                headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold', halign: 'center' },
                columnStyles: { 0: { halign: 'left', cellWidth: 60 }, 1: { halign: 'center', cellWidth: 65 }, 2: { halign: 'right', cellWidth: 65 } },
                alternateRowStyles: { fillColor: [248, 250, 252] }
            });

            if (ledgerSummary && (ledgerSummary.totalBox > 0 || ledgerSummary.packedCount > 0 || ledgerSummary.paidCount > 0 || ledgerSummary.totalMissing > 0 || ledgerSummary.overcommitTotal > 0)) {
                const paidFromBox = ledgerSummary.paidFromBoxTotal !== undefined ? ledgerSummary.paidFromBoxTotal : ledgerSummary.paidTotal;
                const packedBillsAmt = ledgerSummary.packedBillsTotal !== undefined ? ledgerSummary.packedBillsTotal : ledgerSummary.packedTotal;
                /** @type {any[]} */
                const cuadreRows = [
                    ['Caja inicial', money(ledgerSummary.totalBox)],
                    [`Pagado de caja (${ledgerSummary.paidFromBoxCount ?? ledgerSummary.paidCount})`, money(paidFromBox)]
                ];
                if ((ledgerSummary.paidExternalTotal || 0) > 0) {
                    cuadreRows.push([`Pagado sin caja (${ledgerSummary.paidExternalCount})`, money(ledgerSummary.paidExternalTotal)]);
                }
                cuadreRows.push(
                    [`En sobre (${ledgerSummary.packedCount})`, money(packedBillsAmt)],
                    [`Pendiente (${ledgerSummary.pendingCount})`, money(ledgerSummary.pendingTotal)]
                );
                if ((ledgerSummary.loanFundAmount || 0) > 0) {
                    cuadreRows.push(['Reserva préstamos incluida en mesa', money(ledgerSummary.loanFundAmount)]);
                }
                cuadreRows.push([{ content: 'Suelto en mesa', styles: { fontStyle: 'bold' } }, { content: money(ledgerSummary.looseTotal), styles: { fontStyle: 'bold' } }]);
                if (ledgerSummary.overcommitTotal > 0) {
                    cuadreRows.push([
                        { content: 'SOBRECOMPROMISO EN CAJA', styles: { fontStyle: 'bold', textColor: [225, 29, 72] } },
                        { content: money(ledgerSummary.overcommitTotal), styles: { fontStyle: 'bold', textColor: [225, 29, 72] } }
                    ]);
                }
                if (ledgerSummary.totalMissing > 0) {
                    cuadreRows.push([
                        { content: 'FALTANTE EN CAJA', styles: { fontStyle: 'bold', textColor: [225, 29, 72] } },
                        { content: money(ledgerSummary.totalMissing), styles: { fontStyle: 'bold', textColor: [225, 29, 72] } }
                    ]);
                }
                doc.autoTable({
                    head: [['Cuadre de Caja y Estado de Entrega', 'Monto']],
                    body: cuadreRows,
                    startY: (doc.lastAutoTable?.finalY || 110) + 10,
                    tableWidth: table1Width,
                    margin: { left: (pageW - table1Width) / 2 },
                    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 2.5 },
                    headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: 'bold', halign: 'center' },
                    columnStyles: { 0: { halign: 'left', cellWidth: 125 }, 1: { halign: 'right', cellWidth: 65 } },
                    alternateRowStyles: { fillColor: [248, 250, 252] }
                });
            }

            // Página 2: Resumen de Pagos y Préstamos
            doc.addPage('a4', 'landscape');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(16);
            doc.setTextColor(30, 41, 59);
            doc.text('RESUMEN DE PAGOS Y PRÉSTAMOS — Split X', pageW / 2, 18, { align: 'center' });

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            doc.setTextColor(100, 116, 139);
            doc.text(`Fecha: ${today}`, pageW / 2, 24, { align: 'center' });

            const isNormalMode = state.payrollMode === 'normal';
            const netDisplay = payrollSummary.net || fromCents(empRows.reduce((/** @type {number} */ s, /** @type {any} */ e) => s + toCents(e.amount), 0));
            const cascadeBody = isNormalMode ? [
                ['1. Sueldo Bruto Total', money(payrollSummary.gross), money(payrollSummary.gross)],
                ['2. (+) Bonificaciones', `+${money(payrollSummary.bonuses)}`, money((payrollSummary.gross || 0) + (payrollSummary.bonuses || 0))],
                ['3. (-) Descuentos', `-${money(payrollSummary.discounts)}`, money(payrollSummary.afterDiscounts)],
                [
                    { content: '4. (=) Total Neto a Pagar (Modo Normal: Préstamos Omitidos)', styles: { fontStyle: 'bold' } },
                    { content: money(payrollSummary.afterDiscounts), styles: { fontStyle: 'bold' } },
                    { content: `${money(netDisplay)} (Neto a Pagar)`, styles: { fontStyle: 'bold', textColor: [37, 99, 235] } }
                ]
            ] : [
                ['1. Sueldo Bruto Total', money(payrollSummary.gross), money(payrollSummary.gross)],
                ['2. (+) Bonificaciones', `+${money(payrollSummary.bonuses)}`, money((payrollSummary.gross || 0) + (payrollSummary.bonuses || 0))],
                ['3. (-) Descuentos', `-${money(payrollSummary.discounts)}`, money(payrollSummary.afterDiscounts)],
                [
                    { content: '4. (-) Préstamos Cobrados', styles: { fontStyle: 'bold' } },
                    { content: `-${money(payrollSummary.loans)}`, styles: { fontStyle: 'bold' } },
                    { content: `${money(netDisplay)} (Neto a Pagar)`, styles: { fontStyle: 'bold', textColor: [37, 99, 235] } }
                ]
            ];

            doc.autoTable({
                head: [['Concepto', 'Monto', 'Total Acumulado']],
                body: cascadeBody,
                startY: 32,
                tableWidth: 268,
                margin: { left: 14, right: 14 },
                styles: { font: 'helvetica', fontSize: 9, cellPadding: 3.5 },
                headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold', halign: 'center' },
                columnStyles: { 0: { halign: 'left', cellWidth: 100 }, 1: { halign: 'right', cellWidth: 84 }, 2: { halign: 'right', cellWidth: 84 } },
                alternateRowStyles: { fillColor: [248, 250, 252] }
            });

            const table2StartY = Math.max(doc.lastAutoTable?.finalY || 80, 80) + 18;
            const loanAuditBody = isNormalMode ? [
                ['Estado del módulo de préstamos', 'Modo Normal activo (préstamos no deducidos en este pago)'],
                ['Total préstamos en cartera registrados', money(payrollSummary.loansScheduled || payrollSummary.loans)],
                ['Fondo reservado para nuevos préstamos', money(loanFundAmount)],
                [
                    { content: 'Deuda pendiente en cartera (Total saldo)', styles: { fontStyle: 'bold' } },
                    { content: money(payrollSummary.totalRemainingBalance), styles: { fontStyle: 'bold' } }
                ]
            ] : [
                ['Préstamos programados para este pago', money(payrollSummary.loansScheduled || payrollSummary.loans)],
                ['(-) Préstamos no cobrados (editados o cancelados)', `-${money(payrollSummary.loansUncollected)}`],
                [
                    { content: '(=) Préstamos cobrados en este pago', styles: { fontStyle: 'bold' } },
                    { content: money(payrollSummary.loans), styles: { fontStyle: 'bold' } }
                ],
                ['Interés ganado en los préstamos', money(payrollSummary.totalInterest)],
                ['Fondo reservado para nuevos préstamos', money(loanFundAmount)],
                [
                    { content: 'Deuda restante por cobrar (Total pendiente)', styles: { fontStyle: 'bold' } },
                    { content: money(payrollSummary.totalRemainingBalance), styles: { fontStyle: 'bold' } }
                ]
            ];

            doc.autoTable({
                head: [[isNormalMode ? 'Cartera de Préstamos' : 'Resumen de Préstamos', 'Monto Total']],
                body: loanAuditBody,
                startY: table2StartY,
                tableWidth: 268,
                margin: { left: 14, right: 14 },
                styles: { font: 'helvetica', fontSize: 9, cellPadding: 3.5 },
                headStyles: { fillColor: [15, 118, 110], textColor: 255, fontStyle: 'bold', halign: 'center' },
                columnStyles: { 0: { halign: 'left', cellWidth: 170 }, 1: { halign: 'right', cellWidth: 98 } },
                alternateRowStyles: { fillColor: [240, 253, 250] }
            });

            // Página 3: Distribución de Efectivo por Empleado
            doc.addPage('a4', 'landscape');
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(16);
            doc.setTextColor(30, 41, 59);
            doc.text('DISTRIBUCIÓN DE EFECTIVO POR EMPLEADO — Split X', pageW / 2, 18, { align: 'center' });

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            doc.setTextColor(100, 116, 139);
            doc.text(`Fecha: ${today}  •  Denominaciones en ${sym}`, pageW / 2, 24, { align: 'center' });

            const pdfLayout = computePdfEmpTableLayout(denoms, pageW, 14);
            const empHead = [['#', 'Nombre del Empleado', 'Sueldo Neto', ...pdfLayout.headers]];
            /** @type {any[]} */
            const empBody = empRows.map((/** @type {any} */ emp) => [
                emp.idx,
                emp.payoutStatus === 'packed' ? `${emp.name} [En sobre]` : (emp.paid ? `${emp.name} [Pagado]` : emp.name),
                money(emp.amount),
                ...denoms.map(d => emp[d] > 0 ? emp[d] : '—')
            ]);

            if (loanFundAmount > 0) {
                empBody.push([
                    '★',
                    'FONDO PARA NUEVOS PRÉSTAMOS',
                    money(loanFundAmount),
                    ...denoms.map(d => loanFundResult.distribution[d] > 0 ? loanFundResult.distribution[d] : '—')
                ]);
            }

            const totalRowIndex = empBody.length;
            const pdfTotalNomina = fromCents(empRows.reduce((/** @type {number} */ s, /** @type {any} */ e) => s + toCents(e.amount), 0) + toCents(loanFundAmount));
            empBody.push([
                { content: '', styles: { fontStyle: 'bold' } },
                { content: 'TOTALES', styles: { fontStyle: 'bold' } },
                { content: money(pdfTotalNomina), styles: { fontStyle: 'bold' } },
                ...denoms.map(d => ({
                    content: (empRows.reduce((/** @type {number} */ s, /** @type {any} */ e) => s + (e[d] || 0), 0) + (loanFundResult.distribution[d] || 0)) || '—',
                    styles: { fontStyle: 'bold' }
                }))
            ]);

            const hasPaidInPdf = empRows.some((/** @type {any} */ e) => e.paid);
            const pendingRowIndex = hasPaidInPdf ? empBody.length : -1;
            if (hasPaidInPdf) {
                const pendingAmt = fromCents(empRows.reduce((/** @type {number} */ s, /** @type {any} */ e) => s + (!e.paid ? toCents(e.amount) : 0), 0) + toCents(loanFundAmount));
                empBody.push([
                    { content: '', styles: { fontStyle: 'bold' } },
                    { content: 'TOTAL PENDIENTE DE ENTREGA', styles: { fontStyle: 'bold' } },
                    { content: money(pendingAmt), styles: { fontStyle: 'bold' } },
                    ...denoms.map(d => ({
                        content: summary[d] || '—',
                        styles: { fontStyle: 'bold' }
                    }))
                ]);
            }

            /** @type {Record<number, any>} */
            const colStyles = {
                0: { halign: 'center', cellWidth: pdfLayout.numW },
                1: { halign: 'left', cellWidth: pdfLayout.nameW },
                2: { halign: 'right', cellWidth: pdfLayout.netW }
            };
            denoms.forEach((_d, i) => { colStyles[3 + i] = { halign: 'center', cellWidth: pdfLayout.denomColW }; });

            doc.autoTable({
                head: empHead,
                body: empBody,
                startY: 30,
                tableWidth: pdfLayout.usableW,
                margin: { left: 14, right: 14 },
                styles: { font: 'helvetica', fontSize: pdfLayout.fontSize, cellPadding: pdfLayout.cellPadding, overflow: 'ellipsize' },
                headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold', halign: 'center', fontSize: pdfLayout.fontSize },
                columnStyles: colStyles,
                alternateRowStyles: { fillColor: [248, 250, 252] },
                didParseCell: (/** @type {any} */ data) => {
                    if (data.section === 'body') {
                        const emp = empRows[data.row.index];
                        if (emp && emp.paid) data.cell.styles.textColor = [148, 163, 184];
                    }
                    if (data.section === 'body' && data.row.index === totalRowIndex) {
                        data.cell.styles.fillColor = [30, 41, 59];
                        data.cell.styles.textColor = [255, 255, 255];
                    }
                    if (data.section === 'body' && data.row.index === pendingRowIndex) {
                        data.cell.styles.fillColor = [15, 118, 110];
                        data.cell.styles.textColor = [255, 255, 255];
                    }
                }
            });

            // Página 4: Detalle Individual de Préstamos (solo cuando el modo Con Préstamos tiene actividad real)
            const loanEmployees = empRows.filter((/** @type {any} */ e) => {
                const ld = e.payroll?.loanDetails || {};
                return (e.payroll?.loans || 0) > 0 || ld.principal > 0 || ld.remainingBalance > 0 || ld.interestAmount > 0;
            });
            if (!isNormalMode && (loanEmployees.length > 0 || loanFundAmount > 0)) {
                doc.addPage('a4', 'landscape');
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(16);
                doc.setTextColor(30, 41, 59);
                doc.text('DETALLE INDIVIDUAL DE PRÉSTAMOS — Split X', pageW / 2, 18, { align: 'center' });

                doc.setFont('helvetica', 'normal');
                doc.setFontSize(9);
                doc.setTextColor(100, 116, 139);
                doc.text(`Fecha: ${today}`, pageW / 2, 24, { align: 'center' });

                const displayRows = loanEmployees.length > 0 ? loanEmployees : empRows;
                const loanEmpHead = [['#', 'Nombre del Empleado', 'Cuota Cobrada', 'Capital Amortizado', 'Interés Cobrado', 'Deuda Restante (Saldo)']];
                /** @type {any[]} */
                const loanEmpBody = displayRows.map((/** @type {any} */ emp, /** @type {number} */ i) => {
                    const ld = emp.payroll?.loanDetails || {};
                    const loanVal = emp.payroll?.loans || 0;
                    const interest = ld.interestAmount || 0;
                    const principal = ld.principal !== undefined ? ld.principal : Math.max(0, loanVal - interest);
                    return [
                        i + 1,
                        emp.name,
                        loanVal > 0 ? money(loanVal) : money(0),
                        principal > 0 ? money(principal) : '—',
                        interest > 0 ? money(interest) : '—',
                        ld.remainingBalance ? money(ld.remainingBalance) : '—'
                    ];
                });

                const totalPrincipal = fromCents(displayRows.reduce((/** @type {number} */ s, /** @type {any} */ e) => {
                    const ld = e.payroll?.loanDetails || {};
                    const loanVal = e.payroll?.loans || 0;
                    const principal = ld.principal !== undefined ? ld.principal : Math.max(0, fromCents(toCents(loanVal) - toCents(ld.interestAmount || 0)));
                    return s + toCents(principal);
                }, 0));
                loanEmpBody.push([
                    { content: '', styles: { fontStyle: 'bold' } },
                    { content: 'TOTALES', styles: { fontStyle: 'bold' } },
                    { content: money(payrollSummary.loans), styles: { fontStyle: 'bold' } },
                    { content: totalPrincipal > 0 ? money(totalPrincipal) : '—', styles: { fontStyle: 'bold' } },
                    { content: money(payrollSummary.totalInterest), styles: { fontStyle: 'bold' } },
                    { content: money(payrollSummary.totalRemainingBalance), styles: { fontStyle: 'bold' } }
                ]);

                const loanTableW = 250;
                doc.autoTable({
                    head: loanEmpHead,
                    body: loanEmpBody,
                    startY: 32,
                    tableWidth: loanTableW,
                    margin: { left: (pageW - loanTableW) / 2 },
                    styles: { font: 'helvetica', fontSize: 9, cellPadding: 3.5 },
                    headStyles: { fillColor: [15, 118, 110], textColor: 255, fontStyle: 'bold', halign: 'center' },
                    columnStyles: {
                        0: { halign: 'center', cellWidth: 14 },
                        1: { halign: 'left', cellWidth: 78 },
                        2: { halign: 'right', cellWidth: 38 },
                        3: { halign: 'right', cellWidth: 38 },
                        4: { halign: 'right', cellWidth: 38 },
                        5: { halign: 'right', cellWidth: 44 }
                    },
                    alternateRowStyles: { fillColor: [240, 253, 250] },
                    didParseCell: (/** @type {any} */ data) => {
                        if (data.section === 'body' && data.row.index === loanEmpBody.length - 1) {
                            data.cell.styles.fillColor = [15, 118, 110];
                            data.cell.styles.textColor = [255, 255, 255];
                        }
                    }
                });

                const finYLoans = (doc.lastAutoTable?.finalY || 80) + 12;
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(8.5);
                doc.setTextColor(100, 116, 139);
                doc.text(`Colaboradores con descuento de préstamo: ${loanEmployees.length} de ${empRows.length}  •  Fondo para nuevos préstamos: ${money(loanFundAmount)}`, pageW / 2, finYLoans, { align: 'center' });
            }

            const pageCount = doc.internal.getNumberOfPages();
            for (let i = 1; i <= pageCount; i++) {
                doc.setPage(i);
                doc.setFontSize(8);
                doc.setTextColor(148, 163, 184);
                doc.text(`Página ${i} de ${pageCount}  •  Split X`, pageW / 2, pageH - 6, { align: 'center' });
            }

            doc.save(`distribucion_SplitX_${dateTag}.pdf`);
        };

        return { buildExportData: getData, exportToCSV, exportToExcel, exportToPDF };
    };

    return { isoDateTag, csvCell, computePdfEmpTableLayout, buildExportData, buildCSVContent, createExporter };
});
