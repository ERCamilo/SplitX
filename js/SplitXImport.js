/**
 * SplitXImport.js
 * Normalización de empleados importados (JSON / bridge) al formato interno de SplitX.
 */
(function (root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXImport = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // sheetFields: SplitXSheetFields (opcional). parseNumber: parser de números estilo Excel ("1,300.00").
    const createImporter = ({ sheetFields = null, parseNumber }) => {
        const parseExcelNumber = parseNumber;
        const parseImportNumber = (value, fallback = 0) => {
            if (value === undefined || value === null || value === '') return fallback;
            const parsed = typeof value === 'number' ? value : parseExcelNumber(String(value));
            return isNaN(parsed) ? fallback : parsed;
        };

        // Una lista de conceptos vacía no cuenta como dato de nómina.
        const hasValue = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');
        const hasPayrollFields = (item) => ['bruto', 'gross', 'bonificaciones', 'bonuses', 'descuentos', 'discounts', 'prestamos', 'loans', 'bonusDetails', 'deductionDetails', 'loanBreakdown'].some(key => hasValue(item[key]));

        const normalizeImportedEmployee = (item, idx) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Elemento #${idx + 1}: debe ser un objeto con los datos del colaborador.`);
            const name = item.nombre || item.name;
            if (!name) throw new Error(`Elemento #${idx + 1}: Falta nombre.`);

            const importedAmount = item.monto ?? item.amount;
            const hasDetails = hasPayrollFields(item);
            const gross = parseImportNumber(item.bruto ?? item.gross, null);
            const bonuses = parseImportNumber(item.bonificaciones ?? item.bonuses ?? sheetFields?.sumDetailAmounts(item.bonusDetails), 0);
            const discounts = parseImportNumber(item.descuentos ?? item.discounts ?? sheetFields?.sumDetailAmounts(item.deductionDetails), 0);
            const loans = parseImportNumber(item.prestamos ?? item.loans ?? sheetFields?.sumLoanAmounts(item.loanBreakdown), 0);
            // Capital, interés y saldo se derivan del desglose por préstamo cuando no vienen explícitos.
            const loanFromBreakdown = sheetFields ? sheetFields.summarizeLoans(item) : null;
            const prestamoCapital = parseImportNumber(item.prestamoCapital ?? item.loanPrincipal ?? item.loanDetails?.principal ?? loanFromBreakdown?.principal, null);
            const prestamoInteres = parseImportNumber(item.prestamoInteres ?? item.loanInterest ?? item.loanInterestAmount ?? item.loanDetails?.interestAmount ?? loanFromBreakdown?.interest, null);
            const saldoPendiente = parseImportNumber(item.saldoPendiente ?? item.balancePendiente ?? item.remainingBalance ?? item.loanDetails?.remainingBalance ?? loanFromBreakdown?.balanceAfter, null);
            const tasaInteres = parseImportNumber(item.tasaInteres ?? item.interestRate ?? item.loanDetails?.interestRate, null);

            let loanDetails = null;
            if (loans > 0 || prestamoCapital !== null || prestamoInteres !== null || saldoPendiente !== null) {
                const interestAmount = prestamoInteres ?? 0;
                const principal = prestamoCapital !== null ? prestamoCapital : Math.max(0, loans - interestAmount);
                loanDetails = {
                    principal,
                    interestRate: tasaInteres ?? (loans > 0 && interestAmount > 0 && principal > 0 ? Number(((interestAmount / principal) * 100).toFixed(2)) : 0),
                    interestAmount,
                    remainingBalance: saldoPendiente ?? 0
                };
            }

            const afterDiscounts = gross !== null ? gross + bonuses - discounts : null;
            const calculatedNet = afterDiscounts !== null ? afterDiscounts - loans : null;
            const amount = parseImportNumber(importedAmount, calculatedNet);

            if (amount === null || amount === undefined || isNaN(amount) || amount < 0) throw new Error(`Elemento #${idx + 1}: Monto inválido.`);

            const employee = {
                id: Date.now() + idx,
                name,
                amount,
                paid: item.paid || false,
                isManual: false,
                isEdited: false
            };

            if (hasDetails) {
                const difference = calculatedNet === null ? null : amount - calculatedNet;
                employee.payroll = {
                    gross: gross ?? amount,
                    bonusType: item.bonusType || 'fixed',
                    bonusValue: item.bonusValue !== undefined ? item.bonusValue : bonuses,
                    bonuses,
                    discountType: item.discountType || 'fixed',
                    discountValue: item.discountValue !== undefined ? item.discountValue : discounts,
                    discounts,
                    afterDiscounts: afterDiscounts ?? amount + loans,
                    loans,
                    loanDetails,
                    net: amount,
                    calculatedNet,
                    difference,
                    reconciled: difference === null ? null : Math.abs(difference) <= 0.01
                };
            }

            if (sheetFields) Object.assign(employee, sheetFields.pickImportExtras(item));

            employee.originalData = JSON.parse(JSON.stringify({
                name: employee.name,
                amount: employee.amount,
                payroll: employee.payroll ? { ...employee.payroll } : null
            }));

            return employee;
        };

        return { parseImportNumber, hasPayrollFields, normalizeImportedEmployee };
    };

    return { createImporter };
});
