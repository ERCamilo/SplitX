// @ts-check
/**
 * SplitXEditModal.js
 * Modal de edición detallada de colaborador (bruto, bonificaciones, descuentos, préstamos y neto) (Issue #28).
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXEditModal = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /** @param {number} n */
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    /** @param {number} n */
    const hasAtMostTwoDecimals = (n) => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) <= 1e-6;

    /**
     * Calcula bonificaciones, descuentos, neto calculado (limitado a 0.00 con excedente no cobrado)
     * y diferencia de conciliación.
     * @param {{
     *   gross: number,
     *   bonusType: string,
     *   bonusVal: number,
     *   discountType: string,
     *   discountVal: number,
     *   loans: number,
     *   net?: number
     * }} params
     */
    const computePayrollAdjustment = ({ gross, bonusType, bonusVal, discountType, discountVal, loans, net }) => {
        const g = round2(Number(gross) || 0);
        const bVal = round2(Number(bonusVal) || 0);
        const dVal = round2(Number(discountVal) || 0);
        const l = round2(Number(loans) || 0);

        const bonuses = bonusType === 'percent' ? round2((g * bVal) / 100) : bVal;
        const discounts = discountType === 'percent' ? round2((g * dVal) / 100) : dVal;
        const afterDiscounts = round2(g + bonuses - discounts);
        const rawCalculatedNet = round2(afterDiscounts - l);
        const uncollectedExcess = rawCalculatedNet < 0 ? round2(-rawCalculatedNet) : 0;
        const calculatedNet = Math.max(0, rawCalculatedNet);
        const finalNet = net !== undefined ? round2(Number(net) || 0) : calculatedNet;
        const difference = round2(finalNet - calculatedNet);
        return {
            gross: g,
            bonuses,
            discounts,
            afterDiscounts,
            loans: l,
            rawCalculatedNet,
            uncollectedExcess,
            calculatedNet,
            net: finalNet,
            difference,
            reconciled: Math.abs(difference) <= 0.01
        };
    };

    /**
     * Calcula interés y cuota total a partir de capital y tasa (o interés directo).
     * @param {{ principal: number, rate?: number, interestAmount?: number }} params
     */
    const computeLoanInstallment = ({ principal, rate, interestAmount }) => {
        const p = Number(principal) || 0;
        const interest = interestAmount !== undefined
            ? (Number(interestAmount) || 0)
            : ((Number(rate) || 0) > 0 ? round2((p * (Number(rate) || 0)) / 100) : 0);
        return {
            principal: p,
            interest,
            totalCuota: round2(p + interest)
        };
    };

    /**
     * Determina si un colaborador importado sufrió cambios reales frente a `originalData`.
     * @param {any} originalData
     * @param {{ name: string, net: number, gross: number, bonuses: number, discounts: number, loans: number }} updated
     */
    const hasPayrollChanged = (originalData, updated) => {
        if (!originalData) return false;
        const origPayroll = originalData.payroll || {};
        return (
            originalData.name !== updated.name ||
            Math.abs((originalData.amount || 0) - updated.net) > 0.001 ||
            Math.abs((origPayroll.gross || 0) - updated.gross) > 0.001 ||
            Math.abs((origPayroll.loans || 0) - updated.loans) > 0.001 ||
            Math.abs((origPayroll.bonuses || 0) - updated.bonuses) > 0.001 ||
            Math.abs((origPayroll.discounts || 0) - updated.discounts) > 0.001
        );
    };

    /**
     * @param {{
     *   getState: () => any,
     *   saveData: () => void,
     *   fmt: (n: number) => string,
     *   getCurrencySymbol: () => string,
     *   escapeHTML: (s: unknown) => string,
     *   isCoin: (d: number) => boolean,
     *   getBillStyle: (d: number) => string,
     *   getBillImage: (d: number) => string | null,
     *   onLedgerMutated?: () => void,
     *   getIdealBreakdown: (amount: number) => { distribution: Record<number, number> },
     *   showToast: (msg: string, type?: string) => void,
     *   showCustomConfirm: (opts: any) => Promise<boolean>
     * }} deps
     */
    const createEditModal = (deps) => {
        /** @type {string | number | null} */
        let currentEditEmpId = null;
        /** @type {{ bonus: string, discount: string }} */
        const currentAdjustmentTypes = { bonus: 'fixed', discount: 'fixed' };

        /** @param {string} id */
        const byId = (id) => /** @type {any} */ (document.getElementById(id));

        const updateModalCalculations = (manualNetEdit = false) => {
            const state = deps.getState();
            const gross = parseFloat(byId('editEmpGross').value) || 0;
            const bonusVal = parseFloat(byId('editEmpBonus').value) || 0;
            const discountVal = parseFloat(byId('editEmpDiscount').value) || 0;
            const loans = parseFloat(byId('editEmpLoans').value) || 0;

            const netInput = byId('editEmpNet');
            const previewCalc = computePayrollAdjustment({
                gross,
                bonusType: currentAdjustmentTypes.bonus,
                bonusVal,
                discountType: currentAdjustmentTypes.discount,
                discountVal,
                loans,
                net: manualNetEdit ? (parseFloat(netInput.value) || 0) : undefined
            });

            byId('bonusCalcDisplay').textContent = `+${deps.fmt(previewCalc.bonuses)}` + (currentAdjustmentTypes.bonus === 'percent' ? ` (${bonusVal}%)` : '');
            byId('discountCalcDisplay').textContent = `-${deps.fmt(previewCalc.discounts)}` + (currentAdjustmentTypes.discount === 'percent' ? ` (${discountVal}%)` : '');
            byId('calcFormulaNet').textContent = deps.fmt(previewCalc.calculatedNet);

            if (!manualNetEdit) {
                netInput.value = String(previewCalc.calculatedNet);
            }
            const currentNet = parseFloat(netInput.value) || 0;
            const diff = round2(currentNet - previewCalc.calculatedNet);
            const isReconciled = Math.abs(diff) <= 0.01;

            const statusEl = byId('editModalReconciledStatus');
            if (currentNet < 0) {
                statusEl.className = 'text-xs flex items-center gap-1.5 text-rose-700 dark:text-rose-400 font-semibold';
                statusEl.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> <span>El sueldo neto no puede ser negativo</span>';
            } else if (previewCalc.uncollectedExcess > 0) {
                statusEl.className = 'text-xs flex items-center gap-1.5 text-amber-700 dark:text-amber-300 font-semibold';
                statusEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <span>Deducciones exceden el salario en ${deps.escapeHTML(deps.fmt(previewCalc.uncollectedExcess))} (neto limitado a ${deps.escapeHTML(deps.fmt(0))})</span>`;
            } else if (isReconciled) {
                statusEl.className = 'text-xs flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-medium';
                statusEl.innerHTML = '<i class="fa-solid fa-circle-check"></i> <span>Nómina cuadrada perfectamente</span>';
            } else {
                statusEl.className = 'text-xs flex items-center gap-1.5 text-amber-700 dark:text-amber-300 font-semibold';
                statusEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <span>Monto manual difiere en ${diff > 0 ? '+' : ''}${deps.escapeHTML(deps.fmt(diff))} del cálculo</span>`;
            }

            byId('editModalBreakdownTotal').textContent = deps.fmt(Math.max(0, currentNet));
            const breakdown = deps.getIdealBreakdown(Math.max(0, currentNet)).distribution;
            const chipsContainer = byId('editModalBreakdownChips');
            let chipsHTML = '';
            state.denominations.forEach((/** @type {number} */ d) => {
                const count = breakdown[d];
                if (count > 0) {
                    const billStyle = deps.getBillStyle(d);
                    const hasImg = !!deps.getBillImage(d);
                    const isCoinDenom = deps.isCoin(d);
                    const isRound = state.roundCoins !== false && isCoinDenom;
                    const shapeStyle = isRound ? 'width:24px;height:24px;border-radius:50%;' : 'width:38px;height:22px;border-radius:6px;';
                    chipsHTML += `
                        <div style="position:relative;display:inline-block;margin:2px 4px 4px 0">
                            <div class="bill-chip" style="${billStyle};${shapeStyle};font-size:9px">
                                ${hasImg ? '' : d}
                            </div>
                            <span class="bill-badge">${count}</span>
                        </div>
                    `;
                }
            });
            chipsContainer.innerHTML = chipsHTML || `<span class="text-xs text-slate-400 italic">${deps.escapeHTML(deps.getCurrencySymbol())} 0.00 asignados</span>`;
        };

        /** @param {'bonus' | 'discount'} field @param {string} type @param {boolean} [recalculate] */
        const setModalAdjustmentType = (field, type, recalculate = true) => {
            currentAdjustmentTypes[field] = type;
            const isFixed = type === 'fixed';
            const btnFixed = byId(field === 'bonus' ? 'bonusTypeFixed' : 'discountTypeFixed');
            const btnPct = byId(field === 'bonus' ? 'bonusTypePercent' : 'discountTypePercent');
            const sym = byId(field === 'bonus' ? 'bonusSymbol' : 'discountSymbol');
            if (btnFixed && btnPct && sym) {
                if (isFixed) {
                    btnFixed.className = 'px-2 py-0.5 rounded-md transition-all bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-xs';
                    btnPct.className = 'px-2 py-0.5 rounded-md transition-all text-slate-500 dark:text-slate-400';
                    sym.textContent = deps.getCurrencySymbol();
                } else {
                    btnPct.className = 'px-2 py-0.5 rounded-md transition-all bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-xs';
                    btnFixed.className = 'px-2 py-0.5 rounded-md transition-all text-slate-500 dark:text-slate-400';
                    sym.textContent = '%';
                }
            }
            if (recalculate) updateModalCalculations();
        };

        /** @param {string | number} empId */
        const openEditModal = (empId) => {
            const state = deps.getState();
            const emp = state.employees.find((/** @type {any} */ e) => e.id === empId);
            if (!emp) return;
            currentEditEmpId = empId;

            byId('editEmpId').value = emp.id;
            byId('editEmpName').value = emp.name || '';
            byId('editModalTitle').textContent = `Editar a ${emp.name}`;
            byId('editModalSubtitle').textContent = `ID: #${emp.id}`;

            const badgeEl = byId('editModalBadge');
            if (emp.isManual) {
                badgeEl.className = 'px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-200 inline-flex items-center gap-1';
                badgeEl.innerHTML = '<i class="fa-solid fa-user-plus text-[8px]"></i> Manual';
                badgeEl.classList.remove('hidden');
            } else if (emp.isEdited) {
                badgeEl.className = 'px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-100 text-indigo-800 border border-indigo-200 inline-flex items-center gap-1';
                badgeEl.innerHTML = '<i class="fa-solid fa-pen text-[8px]"></i> Editado';
                badgeEl.classList.remove('hidden');
            } else {
                badgeEl.className = 'hidden';
            }

            const revertBtn = byId('revertEmpBtn');
            if (emp.originalData && emp.isEdited) revertBtn.classList.remove('hidden');
            else revertBtn.classList.add('hidden');

            const p = emp.payroll || {};
            currentAdjustmentTypes.bonus = p.bonusType || 'fixed';
            currentAdjustmentTypes.discount = p.discountType || 'fixed';

            byId('editEmpGross').value = p.gross !== undefined && p.gross !== null ? p.gross : emp.amount;
            byId('editEmpBonus').value = p.bonusValue !== undefined ? p.bonusValue : (p.bonuses || 0);
            byId('editEmpDiscount').value = p.discountValue !== undefined ? p.discountValue : (p.discounts || 0);
            byId('editEmpLoans').value = p.loans || 0;
            byId('editEmpNet').value = emp.amount;

            const ld = p.loanDetails || {};
            byId('editEmpLoanPrincipal').value = ld.principal !== undefined && ld.principal !== null ? ld.principal : '';
            byId('editEmpLoanInterestRate').value = ld.interestRate !== undefined && ld.interestRate !== null ? ld.interestRate : '';
            byId('editEmpLoanInterestAmount').value = ld.interestAmount !== undefined && ld.interestAmount !== null ? ld.interestAmount : '';
            byId('editEmpLoanRemainingBalance').value = ld.remainingBalance !== undefined && ld.remainingBalance !== null ? ld.remainingBalance : '';

            const hasLoanDetails = !!(ld.principal || ld.interestRate || ld.interestAmount || ld.remainingBalance);
            const loanExp = byId('loanDetailsExpanded');
            if (loanExp) {
                if (hasLoanDetails) {
                    loanExp.classList.remove('hidden');
                    byId('toggleLoanDetailsText').textContent = 'Ocultar detalles';
                } else {
                    loanExp.classList.add('hidden');
                    byId('toggleLoanDetailsText').textContent = 'Detalles (Interés/Saldo)';
                }
            }

            const activeSymbol = deps.getCurrencySymbol();
            ['editGrossSymbol', 'editLoansSymbol', 'editNetSymbol'].forEach((symId) => {
                const el = byId(symId);
                if (el) el.textContent = activeSymbol;
            });

            setModalAdjustmentType('bonus', currentAdjustmentTypes.bonus, false);
            setModalAdjustmentType('discount', currentAdjustmentTypes.discount, false);

            // Preserve existing emp.amount on open (do NOT overwrite unreconciled/manual net)
            updateModalCalculations(true);
            byId('editEmployeeModal').classList.remove('hidden');
            setTimeout(() => {
                if (typeof document !== 'undefined') byId('editEmpName')?.focus();
            }, 150);
        };

        const toggleLoanDetailsPanel = () => {
            const el = byId('loanDetailsExpanded');
            if (!el) return;
            const isHidden = el.classList.toggle('hidden');
            byId('toggleLoanDetailsText').textContent = isHidden ? 'Detalles (Interés/Saldo)' : 'Ocultar detalles';
        };

        const calcLoanFromDetails = () => {
            const principal = parseFloat(byId('editEmpLoanPrincipal').value) || 0;
            const rate = parseFloat(byId('editEmpLoanInterestRate').value) || 0;
            const { interest, totalCuota } = computeLoanInstallment({ principal, rate });
            if (interest > 0) byId('editEmpLoanInterestAmount').value = interest;
            if (totalCuota > 0) {
                byId('editEmpLoans').value = totalCuota;
                updateModalCalculations();
            }
        };

        const calcLoanFromInterestAmount = () => {
            const principal = parseFloat(byId('editEmpLoanPrincipal').value) || 0;
            const interest = parseFloat(byId('editEmpLoanInterestAmount').value) || 0;
            const { totalCuota } = computeLoanInstallment({ principal, interestAmount: interest });
            if (totalCuota > 0) {
                byId('editEmpLoans').value = totalCuota;
                updateModalCalculations();
            }
        };

        const closeEditModal = () => {
            byId('editEmployeeModal').classList.add('hidden');
            currentEditEmpId = null;
        };

        const syncNetFromCalculated = () => {
            updateModalCalculations(false);
        };

        const saveEmployeeModal = () => {
            const state = deps.getState();
            const id = currentEditEmpId;
            if (!id) return;
            const emp = state.employees.find((/** @type {any} */ e) => e.id === id);
            if (!emp) return;

            const name = byId('editEmpName').value.trim();
            if (!name) {
                deps.showToast('Indica un nombre para el empleado.', 'info');
                return;
            }

            /** @param {string} raw @param {string} label */
            const parseNonNegField = (raw, label) => {
                const txt = String(raw ?? '').trim();
                if (!txt) return { ok: true, value: 0 };
                const num = Number(txt);
                if (!Number.isFinite(num) || num < 0) {
                    return { ok: false, error: `${label} no puede ser negativo ni inválido.` };
                }
                if (!hasAtMostTwoDecimals(num)) {
                    return { ok: false, error: `${label} no puede tener más de 2 decimales.` };
                }
                return { ok: true, value: round2(num) };
            };

            const grossRes = parseNonNegField(byId('editEmpGross').value, 'El sueldo bruto');
            const bonusRes = parseNonNegField(byId('editEmpBonus').value, 'La bonificación');
            const discountRes = parseNonNegField(byId('editEmpDiscount').value, 'El descuento');
            const loansRes = parseNonNegField(byId('editEmpLoans').value, 'El préstamo');
            const netRes = parseNonNegField(byId('editEmpNet').value, 'El sueldo neto');
            const loanPrincipalRes = parseNonNegField(byId('editEmpLoanPrincipal').value, 'El capital de cuota');
            const loanRateRes = parseNonNegField(byId('editEmpLoanInterestRate').value, 'La tasa de interés');
            const loanInterestRes = parseNonNegField(byId('editEmpLoanInterestAmount').value, 'El interés de cuota');
            const loanRemRes = parseNonNegField(byId('editEmpLoanRemainingBalance').value, 'El saldo restante');

            for (const check of [grossRes, bonusRes, discountRes, loansRes, netRes, loanPrincipalRes, loanRateRes, loanInterestRes, loanRemRes]) {
                if (!check.ok) {
                    deps.showToast(/** @type {string} */ (check.error), 'info');
                    return;
                }
            }

            const gross = /** @type {number} */ (grossRes.value);
            const bonusVal = /** @type {number} */ (bonusRes.value);
            const discountVal = /** @type {number} */ (discountRes.value);
            const loans = /** @type {number} */ (loansRes.value);
            const net = /** @type {number} */ (netRes.value);

            const loanDetails = {
                principal: /** @type {number} */ (loanPrincipalRes.value),
                interestRate: /** @type {number} */ (loanRateRes.value),
                interestAmount: /** @type {number} */ (loanInterestRes.value),
                remainingBalance: /** @type {number} */ (loanRemRes.value)
            };

            const calc = computePayrollAdjustment({
                gross,
                bonusType: currentAdjustmentTypes.bonus,
                bonusVal,
                discountType: currentAdjustmentTypes.discount,
                discountVal,
                loans,
                net
            });

            const payroll = {
                gross: calc.gross,
                bonusType: currentAdjustmentTypes.bonus,
                bonusValue: bonusVal,
                bonuses: calc.bonuses,
                discountType: currentAdjustmentTypes.discount,
                discountValue: discountVal,
                discounts: calc.discounts,
                afterDiscounts: calc.afterDiscounts,
                loans: calc.loans,
                loanDetails,
                net: calc.net,
                calculatedNet: calc.calculatedNet,
                difference: calc.difference,
                reconciled: calc.reconciled
            };

            const isEdited = emp.originalData
                ? hasPayrollChanged(emp.originalData, { name, net: calc.net, gross: calc.gross, bonuses: calc.bonuses, discounts: calc.discounts, loans: calc.loans })
                : (emp.isEdited || false);

            const currentStatus = emp.payoutStatus || (emp.paid ? 'paid' : 'pending');
            const isNormalMode = state.payrollMode === 'normal';
            const oldEffective = (isNormalMode && emp.payroll && emp.payroll.afterDiscounts !== undefined && emp.payroll.afterDiscounts !== null)
                ? (Number(emp.payroll.afterDiscounts) || 0)
                : (Number(emp.amount) || 0);
            const newEffective = isNormalMode ? calc.afterDiscounts : calc.net;
            const amountChanged = Math.abs(oldEffective - newEffective) > 0.001 || Math.abs((Number(emp.amount) || 0) - calc.net) > 0.001;
            const nameChanged = (emp.name || '') !== name;

            const applySave = (/** @type {boolean} */ resetEnvelope, /** @type {string | null} */ customToast) => {
                state.employees = state.employees.map((/** @type {any} */ e) => {
                    if (e.id !== id) return e;
                    const ledgerPatch = resetEnvelope
                        ? { payoutStatus: 'pending', paid: false, lockedDistribution: null }
                        : {};
                    const nextEmp = {
                        ...e,
                        ...ledgerPatch,
                        name,
                        amount: calc.net,
                        payroll,
                        isEdited: !e.isManual ? isEdited : false
                    };
                    if (nameChanged && nextEmp.employeeName !== undefined) {
                        nextEmp.employeeName = name;
                    }
                    return nextEmp;
                });

                if ((resetEnvelope || amountChanged) && typeof deps.onLedgerMutated === 'function') {
                    deps.onLedgerMutated();
                }
                deps.saveData();
                closeEditModal();
                deps.showToast(customToast || `Empleado ${name} actualizado correctamente.`, customToast ? 'warning' : 'success');
            };

            if (currentStatus === 'paid' && amountChanged) {
                return deps.showCustomConfirm({
                    title: 'Colaborador ya marcado como Pagado',
                    message: `${emp.name} ya está marcado como Pagado. Cambiar su monto efectivo a ${deps.fmt(newEffective)} liberará el registro de efectivo fijado y lo devolverá a Pendiente para cuadrar la diferencia. ¿Deseas continuar?`,
                    icon: 'fa-triangle-exclamation',
                    type: 'warning',
                    confirmText: 'Sí, actualizar y pasar a Pendiente',
                    cancelText: 'Cancelar'
                }).then((ok) => {
                    if (!ok) return;
                    applySave(true, `Monto de ${name} actualizado. Volvió a Pendiente para reajustar el pago.`);
                });
            }

            if (currentStatus === 'packed' && amountChanged) {
                applySave(true, `El monto de ${name} cambió: el sobre volvió a Pendiente para rearmarlo con los nuevos billetes.`);
                return;
            }

            applySave(false, null);
        };

        /** @param {string | number} [empId] */
        const revertEmployeeToOriginal = async (empId) => {
            const state = deps.getState();
            const id = empId || currentEditEmpId;
            if (!id) return;
            const emp = state.employees.find((/** @type {any} */ e) => e.id === id);
            if (!emp || !emp.originalData) return;

            const currentStatus = emp.payoutStatus || (emp.paid ? 'paid' : 'pending');
            const extraWarn = currentStatus === 'paid'
                ? ' Como ya está Pagado, volverá a Pendiente y se liberará su efectivo fijado.'
                : (currentStatus === 'packed' ? ' Su sobre apartado volverá a Pendiente para rearmarlo.' : '');

            const ok = await deps.showCustomConfirm({
                title: '¿Restaurar valores originales?',
                message: `¿Deseas restaurar los valores originales de importación para ${emp.name}? Se perderán los cambios manuales aplicados.${extraWarn}`,
                icon: 'fa-rotate-left',
                type: 'warning',
                confirmText: 'Restaurar',
                cancelText: 'Cancelar'
            });
            if (!ok) return;

            const orig = JSON.parse(JSON.stringify(emp.originalData));
            const resetEnvelope = currentStatus === 'packed' || currentStatus === 'paid';
            state.employees = state.employees.map((/** @type {any} */ e) => {
                if (e.id !== id) return e;
                return {
                    ...e,
                    ...(resetEnvelope ? { payoutStatus: 'pending', paid: false, lockedDistribution: null } : {}),
                    name: orig.name,
                    ...(orig.employeeName !== undefined ? { employeeName: orig.employeeName } : {}),
                    amount: orig.amount,
                    payroll: orig.payroll ? JSON.parse(JSON.stringify(orig.payroll)) : undefined,
                    isEdited: false
                };
            });

            if (typeof deps.onLedgerMutated === 'function') deps.onLedgerMutated();
            deps.saveData();
            const modal = byId('editEmployeeModal');
            if (modal && !modal.classList.contains('hidden')) {
                openEditModal(id);
            }
            deps.showToast(`Valores originales restaurados para ${orig.name}.`);
        };

        return {
            openEditModal,
            toggleLoanDetailsPanel,
            calcLoanFromDetails,
            calcLoanFromInterestAmount,
            closeEditModal,
            setModalAdjustmentType,
            updateModalCalculations,
            syncNetFromCalculated,
            saveEmployeeModal,
            revertEmployeeToOriginal
        };
    };

    return {
        computePayrollAdjustment,
        computeLoanInstallment,
        hasPayrollChanged,
        createEditModal
    };
});
