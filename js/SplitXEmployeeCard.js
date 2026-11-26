// @ts-check
/**
 * SplitXEmployeeCard.js
 * Renderizado puro de tarjetas de empleado y cálculo del Asesor de Cambio (Smart Advisor).
 * Extraído de index.html para pruebas unitarias en Node y delegación de eventos (sin onclick inline).
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory(require('./SplitXCurrencies.js'));
    } else {
        root.SplitXEmployeeCard = factory(root.SplitXCurrencies);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, /** @param {any} SplitXCurrencies */ function (SplitXCurrencies) {
    'use strict';

    const SIZE_CONFIGS = {
        compact: {
            banknote: 'width:42px;height:22px;font-size:9px;',
            coin: 'width:24px;height:24px;font-size:9px;',
            badge: 'width:15px;height:15px;font-size:9px;top:-5px;right:-5px;',
            textMultiplier: 'text-xs font-bold'
        },
        normal: {
            banknote: 'width:54px;height:28px;font-size:11px;',
            coin: 'width:30px;height:30px;font-size:11px;',
            badge: 'width:18px;height:18px;font-size:11px;top:-6px;right:-6px;',
            textMultiplier: 'text-sm font-bold'
        },
        large: {
            banknote: 'width:68px;height:35px;font-size:13px;',
            coin: 'width:38px;height:38px;font-size:13px;',
            badge: 'width:22px;height:22px;font-size:12.5px;top:-7px;right:-7px;',
            textMultiplier: 'text-base font-extrabold'
        }
    };

    /**
     * Compara sobrantes de caja vs desglose ideal de montos faltantes para empleados pendientes.
     * @param {number[]} denominations
     * @param {Record<number, number>} leftoverInventory
     * @param {Array<any>} processedEmployees
     */
    const generateSmartAdvisorData = (denominations, leftoverInventory, processedEmployees) => {
        /** @type {Record<number, number>} */
        const idealMissingBreakdown = {};
        denominations.forEach(d => { idealMissingBreakdown[d] = 0; });

        processedEmployees.forEach(emp => {
            if (!emp.paid && emp._missingAmount > 0) {
                let remCents = Math.round((Number(emp._missingAmount) || 0) * 100);
                denominations.forEach(d => {
                    const dCents = Math.round((Number(d) || 0) * 100);
                    if (dCents <= 0 || remCents <= 0) return;
                    const count = Math.floor(remCents / dCents);
                    if (count > 0) {
                        idealMissingBreakdown[d] += count;
                        remCents -= count * dCents;
                    }
                });
            }
        });

        /** @type {Array<{ denom: number, count: number }>} */
        const surplus = [];
        /** @type {Array<{ denom: number, count: number }>} */
        const deficit = [];

        denominations.forEach(d => {
            if ((leftoverInventory[d] || 0) > 0) surplus.push({ denom: d, count: leftoverInventory[d] });
            if (idealMissingBreakdown[d] > 0) deficit.push({ denom: d, count: idealMissingBreakdown[d] });
        });

        return { surplus, deficit };
    };

    /**
     * Construye el HTML interno de una tarjeta de empleado usando atributos data-card-action
     * para delegación de eventos limpia y sin interpolación insegura en onclick.
     * @param {{
     *   emp: any,
     *   index: number,
     *   isPreview?: boolean,
     *   state: any,
     *   expandedEmpCards?: Set<any>,
     *   sheetFields?: any,
     *   getEffectiveEmployeeAmount: (emp: any) => number,
     *   fmt: (n: number) => string,
     *   fmtNum: (n: number) => string
     * }} opts
     */
    const buildEmployeeCardHTML = ({
        emp,
        index,
        isPreview = false,
        state,
        expandedEmpCards = new Set(),
        sheetFields = null,
        getEffectiveEmployeeAmount,
        fmt,
        fmtNum
    }) => {
        const escapeHTML = SplitXCurrencies.escapeHTML;
        const getCurrencySymbol = () => state.currencySymbol || 'RD$';
        const isCoin = (/** @type {number} */ denom) => {
            const d = Number(denom);
            if (Array.isArray(state.coinDenoms)) return state.coinDenoms.includes(d);
            return [25, 10, 5, 1].includes(d);
        };

        const sizeKey = /** @type {'compact' | 'normal' | 'large'} */ (state.breakdownSize in SIZE_CONFIGS ? state.breakdownSize : 'normal');
        const currentSize = SIZE_CONFIGS[sizeKey];
        const currentFormat = state.breakdownFormat || 'badge';
        const safeSym = escapeHTML(getCurrencySymbol());
        const safeEmpId = escapeHTML(String(emp.id ?? ''));

        /** @param {number} d @param {number} count */
        const renderSingleChip = (d, count) => {
            const billStyle = SplitXCurrencies.getBillStyle(state, d);
            const hasImg = !!SplitXCurrencies.getBillImage(state, d);
            const isCoinDenom = isCoin(d);
            const isRound = state.roundCoins !== false && isCoinDenom;
            const shapeClass = isRound ? 'chip-vector-coin' : 'chip-vector-banknote';
            const shapeStyle = isRound ? currentSize.coin : currentSize.banknote;
            const isZero = count === 0;
            const chipOpacity = isZero ? 'opacity:0.25;filter:grayscale(100%);' : '';
            const badgeStyle = `${currentSize.badge};${isZero ? 'background:#64748b;color:#f1f5f9;opacity:0.6;' : ''}`;
            const innerHTML = hasImg ? '' : (isRound ? `<div class="coin-inner"></div><span class="coin-text">${d}</span>` : `<div class="banknote-inner"></div><span class="banknote-text">${d}</span>`);
            const totalVal = count * Number(d);
            const tooltip = escapeHTML(count > 0 ? `${count} × ${getCurrencySymbol()} ${fmtNum(d)} = ${getCurrencySymbol()} ${fmtNum(totalVal)}` : `${getCurrencySymbol()} ${fmtNum(d)} (0 asignados)`);

            const chipHTML = `
                <div class="bill-chip ${shapeClass} chip-size-${sizeKey}" style="${billStyle};${shapeStyle}">
                    ${innerHTML}
                </div>
            `;

            if (currentFormat === 'qty_x_denom') {
                return `
                    <div class="inline-flex items-center gap-1.5 ${chipOpacity}" title="${tooltip}">
                        <span class="font-mono ${currentSize.textMultiplier} ${isZero ? 'text-slate-400 dark:text-slate-500' : 'text-slate-800 dark:text-slate-100'}">${count}<span class="text-slate-400 font-sans font-normal opacity-70 ml-0.5">×</span></span>
                        ${chipHTML}
                    </div>
                `;
            }
            if (currentFormat === 'denom_x_qty') {
                return `
                    <div class="inline-flex items-center gap-1.5 ${chipOpacity}" title="${tooltip}">
                        ${chipHTML}
                        <span class="font-mono ${currentSize.textMultiplier} ${isZero ? 'text-slate-400 dark:text-slate-500' : 'text-slate-800 dark:text-slate-100'}"><span class="text-slate-400 font-sans font-normal opacity-70 mr-0.5">×</span>${count}</span>
                    </div>
                `;
            }
            return `
                <div style="position:relative;display:inline-flex;align-items:center;justify-content:center;${chipOpacity}" title="${tooltip}">
                    ${chipHTML}
                    <span class="bill-badge" style="${badgeStyle}">${count}</span>
                </div>
            `;
        };

        const colCount = state.breakdownColumns || 5;
        const autoMin = currentFormat === 'badge'
            ? (sizeKey === 'compact' ? '42px' : sizeKey === 'large' ? '68px' : '54px')
            : (sizeKey === 'compact' ? '65px' : sizeKey === 'large' ? '95px' : '80px');
        const gridTemplate = colCount === 'auto' ? `repeat(auto-fill, minmax(${autoMin}, max-content))` : `repeat(${colCount}, max-content)`;
        const gridGap = currentFormat === 'badge' ? '6px 8px' : '8px 12px';
        const gridStyle = `display:grid;grid-template-columns:${gridTemplate};gap:${gridGap};align-items:center;justify-content:start;`;

        let breakdownHTML = '';
        const visibleDistribution = emp.distribution || {};
        const showZeros = state.breakdownShowZeros === true;
        const groupByType = state.breakdownGroupByType === true;

        if (groupByType) {
            const billDenoms = state.denominations.filter((/** @type {number} */ d) => !isCoin(d));
            const coinDenoms = state.denominations.filter((/** @type {number} */ d) => isCoin(d));

            let billsChips = '';
            billDenoms.forEach((/** @type {number} */ d) => {
                const count = visibleDistribution[d] || 0;
                if (count > 0 || showZeros) billsChips += renderSingleChip(d, count);
            });

            let coinsChips = '';
            coinDenoms.forEach((/** @type {number} */ d) => {
                const count = visibleDistribution[d] || 0;
                if (count > 0 || showZeros) coinsChips += renderSingleChip(d, count);
            });

            if (billsChips || coinsChips) {
                breakdownHTML = `
                    <div class="flex flex-col gap-1.5 w-full">
                        ${billsChips ? `<div style="${gridStyle}">${billsChips}</div>` : ''}
                        ${(billsChips && coinsChips) ? `<div class="h-px bg-slate-200/60 dark:bg-slate-800 my-0.5"></div>` : ''}
                        ${coinsChips ? `<div style="${gridStyle}">${coinsChips}</div>` : ''}
                    </div>
                `;
            }
        } else {
            let chipsHTML = '';
            state.denominations.forEach((/** @type {number} */ d) => {
                const count = visibleDistribution[d] || 0;
                if (count > 0 || showZeros) chipsHTML += renderSingleChip(d, count);
            });
            if (chipsHTML) breakdownHTML = `<div style="${gridStyle}">${chipsHTML}</div>`;
        }

        const isPaid = emp.paid || false;
        const effAmount = getEffectiveEmployeeAmount(emp);
        const hasCents = (effAmount % 1) !== 0;
        const isDeficit = emp.status !== 'ok' || (emp._missingAmount && emp._missingAmount > 0);
        const isCentsDeficit = isDeficit && (emp._missingAmount || 0) < 1;

        let statusClass = 'status-green';
        let statusTooltip = '100% Cubierto en caja · Listo para pagar';
        if (isPaid) {
            statusClass = 'status-paid';
            statusTooltip = 'Pagado';
        } else if (isDeficit && !isCentsDeficit) {
            statusClass = 'status-red';
            statusTooltip = `Faltan ${fmt(emp._missingAmount || 0)} en caja`;
        } else if (isCentsDeficit || hasCents) {
            statusClass = 'status-yellow';
            statusTooltip = isCentsDeficit ? `Faltan centavos: ${fmt(emp._missingAmount || 0)}` : 'Monto con centavos · Requiere redondeo';
        }

        let subTextHTML = '';
        const p = emp.payroll;
        const isNormalView = state.payrollMode !== 'deductions';
        const isExpanded = expandedEmpCards.has(emp.id);

        if (p && (p.gross > 0 || p.bonuses > 0 || p.discounts > 0 || p.loans > 0 || p.afterDiscounts > 0)) {
            const grossVal = (p.gross !== undefined && p.gross !== null && p.gross > 0)
                ? p.gross
                : (emp.originalData?.payroll?.gross || emp.originalData?.amount || emp.amount);
            const bonuses = Number(p.bonuses) || 0;
            const discounts = Number(p.discounts) || 0;
            const loans = Number(p.loans) || 0;
            const ld = p.loanDetails || {};
            const loanPrincipal = ld.principal !== undefined ? ld.principal : (loans - (ld.interestAmount || 0));
            const loanInterest = ld.interestAmount || 0;
            const netBeforeLoan = (p.afterDiscounts !== undefined && p.afterDiscounts !== null)
                ? p.afterDiscounts
                : (grossVal + bonuses - discounts);
            const concepts = sheetFields ? sheetFields.conceptLines(emp) : { bonuses: [], deductions: [], loans: [] };
            /** @param {any[]} lines @param {string} colorCls */
            const conceptRows = (lines, colorCls) => lines.map(l => `
                <span class="text-[10px] text-slate-500 dark:text-slate-400 pl-2 truncate" title="${escapeHTML(l.label)}">↳ ${escapeHTML(l.label)}</span>
                <span class="text-right text-[10px] ${colorCls} font-mono">${fmtNum(l.amount)}${l.balanceAfter !== undefined ? ` <span class="text-slate-400 dark:text-slate-500">(saldo ${fmtNum(l.balanceAfter)})</span>` : ''}</span>`).join('');
            const bonusConceptRows = conceptRows(concepts.bonuses, 'text-emerald-600 dark:text-emerald-400');
            const discountConceptRows = conceptRows(concepts.deductions, 'text-rose-600 dark:text-rose-400');
            const loanConceptRows = conceptRows(concepts.loans, 'text-amber-600 dark:text-amber-400');

            if (isNormalView) {
                const netAdj = bonuses - discounts;
                const adjColor = netAdj > 0 ? 'text-emerald-600 dark:text-emerald-400' : (netAdj < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-200');
                const adjSign = netAdj > 0 ? '+ ' : (netAdj < 0 ? '- ' : '');

                if (isExpanded) {
                    subTextHTML = `
                        <div class="emp-calc-stack font-mono text-xs mt-1">
                            <div class="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] leading-tight text-slate-500 dark:text-slate-400">
                                <span>Bruto:</span>
                                <span class="text-right text-slate-700 dark:text-slate-200 font-bold">${fmtNum(grossVal)}</span>
                                <span>Bonificación:</span>
                                <span class="text-right text-emerald-600 dark:text-emerald-400 font-semibold">+ ${fmtNum(bonuses)}</span>
                                ${bonusConceptRows}
                                <span>Descuento:</span>
                                <span class="text-right text-rose-600 dark:text-rose-400 font-semibold">- ${fmtNum(discounts)}</span>
                                ${discountConceptRows}
                            </div>
                            <div class="border-t border-slate-200 dark:border-slate-700 mt-1 pt-0.5"></div>
                            <div class="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] font-bold text-slate-700 dark:text-slate-200 leading-tight mt-0.5 items-baseline">
                                <span class="text-[10px] uppercase tracking-tight text-slate-500 dark:text-slate-400 flex items-center gap-1">
                                    Neto <i class="fa-solid fa-chevron-up text-[8px] text-slate-400"></i>
                                </span>
                                <span class="text-base font-extrabold font-mono text-slate-900 dark:text-slate-100 tracking-tight text-right">${safeSym} ${fmtNum(effAmount)}</span>
                            </div>
                        </div>
                    `;
                } else {
                    subTextHTML = `
                        <div class="emp-calc-stack font-mono text-xs mt-1">
                            <div class="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] leading-tight text-slate-500 dark:text-slate-400">
                                <span>Bruto:</span>
                                <span class="text-right text-slate-700 dark:text-slate-200 font-bold">${fmtNum(grossVal)}</span>
                                <span>Ajuste:</span>
                                <span class="text-right ${adjColor} font-semibold">${adjSign}${fmtNum(Math.abs(netAdj))}</span>
                            </div>
                            <div class="border-t border-slate-200 dark:border-slate-700 mt-1 pt-0.5"></div>
                            <div class="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] font-bold text-slate-700 dark:text-slate-200 leading-tight mt-0.5 items-baseline">
                                <span class="text-[10px] uppercase tracking-tight text-slate-500 dark:text-slate-400 flex items-center gap-1">
                                    Neto <i class="fa-solid fa-chevron-down text-[8px] text-slate-400 group-hover:text-blue-500"></i>
                                </span>
                                <span class="text-base font-extrabold font-mono text-slate-900 dark:text-slate-100 tracking-tight text-right">${safeSym} ${fmtNum(effAmount)}</span>
                            </div>
                        </div>
                    `;
                }
            } else if (isExpanded) {
                subTextHTML = `
                    <div class="emp-calc-stack font-mono text-xs mt-1">
                        <div class="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] leading-tight text-slate-500 dark:text-slate-400">
                            <span>Bruto:</span>
                            <span class="text-right text-slate-700 dark:text-slate-200 font-bold">${fmtNum(grossVal)}</span>
                            <span>Bonificación:</span>
                            <span class="text-right text-emerald-600 dark:text-emerald-400 font-semibold">+ ${fmtNum(bonuses)}</span>
                            ${bonusConceptRows}
                            <span>Descuento:</span>
                            <span class="text-right text-rose-600 dark:text-rose-400 font-semibold">- ${fmtNum(discounts)}</span>
                            ${discountConceptRows}
                        </div>
                        <div class="border-t border-slate-300 dark:border-slate-600 my-1"></div>
                        <div class="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] leading-tight text-slate-500 dark:text-slate-400">
                            <span>Neto:</span>
                            <span class="text-right text-slate-700 dark:text-slate-200 font-bold">${fmtNum(netBeforeLoan)}</span>
                            <span>Préstamo:</span>
                            <span class="text-right text-amber-600 dark:text-amber-400 font-semibold">- ${fmtNum(loans)}</span>
                            ${loanConceptRows}
                            ${(loans > 0 && (loanInterest > 0 || loanPrincipal > 0)) ? `
                                <span class="text-[10px] text-slate-500 dark:text-slate-400 pl-2">↳ Capital:</span>
                                <span class="text-right text-[10px] text-slate-600 dark:text-slate-300 font-mono">${fmtNum(loanPrincipal)}</span>
                                <span class="text-[10px] text-amber-600 dark:text-amber-400 pl-2 font-medium">↳ Interés:</span>
                                <span class="text-right text-[10px] text-amber-600 dark:text-amber-400 font-mono font-semibold">${fmtNum(loanInterest)}</span>
                            ` : ''}
                        </div>
                        <div class="border-t-2 border-slate-400 dark:border-slate-500 my-1"></div>
                        <div class="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] font-bold leading-tight items-baseline">
                            <span class="text-[10px] uppercase tracking-tight text-slate-500 dark:text-slate-400 flex items-center gap-1">
                                Restante <i class="fa-solid fa-chevron-up text-[8px] text-slate-400"></i>
                            </span>
                            <span class="text-base font-extrabold font-mono text-slate-900 dark:text-slate-100 tracking-tight text-right">${safeSym} ${fmtNum(emp.amount)}</span>
                        </div>
                    </div>
                `;
            } else {
                subTextHTML = `
                    <div class="emp-calc-stack font-mono text-xs mt-1">
                        <div class="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] leading-tight text-slate-500 dark:text-slate-400">
                            <span>Neto:</span>
                            <span class="text-right text-slate-700 dark:text-slate-200 font-bold">${fmtNum(netBeforeLoan)}</span>
                            <span>Préstamo:</span>
                            <span class="text-right text-amber-600 dark:text-amber-400 font-semibold">- ${fmtNum(loans)}</span>
                        </div>
                        <div class="border-t border-slate-200 dark:border-slate-700 mt-1 pt-0.5"></div>
                        <div class="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] font-bold text-slate-700 dark:text-slate-200 leading-tight mt-0.5 items-baseline">
                            <span class="text-[10px] uppercase tracking-tight text-slate-500 dark:text-slate-400 flex items-center gap-1">
                                Restante <i class="fa-solid fa-chevron-down text-[8px] text-slate-400 group-hover:text-blue-500"></i>
                            </span>
                            <span class="text-base font-extrabold font-mono text-slate-900 dark:text-slate-100 tracking-tight text-right">${safeSym} ${fmtNum(emp.amount)}</span>
                        </div>
                    </div>
                `;
            }
        } else if (emp.isEdited && emp.originalData && Math.abs(emp.originalData.amount - emp.amount) > 0.001) {
            subTextHTML = `
                <div class="emp-calc-stack font-mono text-xs mt-1">
                    <div class="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] leading-tight text-slate-500 dark:text-slate-400">
                        <span>Antes:</span>
                        <span class="text-right line-through text-slate-400 dark:text-slate-500">${fmtNum(emp.originalData.amount)}</span>
                    </div>
                    <div class="border-t border-slate-200 dark:border-slate-700 mt-1 pt-0.5"></div>
                    <div class="text-base font-extrabold font-mono text-slate-900 dark:text-slate-100 tracking-tight mt-0.5 text-right">
                        ${safeSym} ${fmtNum(effAmount)}
                    </div>
                </div>
            `;
        } else {
            subTextHTML = `
                <div class="emp-calc-stack font-mono text-xs mt-1">
                    <div class="text-[11px] text-slate-400 dark:text-slate-400 leading-tight">Neto a entregar</div>
                    <div class="text-base font-extrabold font-mono text-slate-900 dark:text-slate-100 tracking-tight mt-1 text-right">
                        ${safeSym} ${fmtNum(effAmount)}
                    </div>
                </div>
            `;
        }

        let badgeHTML = '';
        if (isPreview) {
            badgeHTML = `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 inline-flex items-center gap-1 shrink-0" title="Tarjeta de muestra"><i class="fa-solid fa-eye text-[8px]"></i>Muestra</span>`;
        } else if (emp.isManual) {
            badgeHTML = `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 inline-flex items-center gap-1 shrink-0" title="Agregado manualmente"><i class="fa-solid fa-user-plus text-[8px]"></i>Manual</span>`;
        } else if (emp.isEdited) {
            badgeHTML = `<span class="px-1.5 py-0.2 rounded text-[9px] font-bold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 inline-flex items-center gap-1 shrink-0" title="Modificado de importación original"><i class="fa-solid fa-pen text-[8px]"></i>Editado</span>`;
        }

        let errorNoteHTML = '';
        if (!isPaid && isDeficit && !isCentsDeficit && !isPreview) {
            errorNoteHTML = `<div class="text-[11px] text-rose-600 dark:text-rose-400 font-semibold mt-0.5"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Faltan ${escapeHTML(fmt(emp._missingAmount || 0))} en caja</div>`;
        } else if (!isPaid && isCentsDeficit && !isPreview) {
            errorNoteHTML = `<div class="text-[10px] text-amber-600 dark:text-amber-400 font-medium mt-0.5"><i class="fa-solid fa-coins mr-1"></i>Faltan centavos: ${escapeHTML(fmt(emp._missingAmount || 0))}</div>`;
        } else if (!isPaid && hasCents) {
            errorNoteHTML = `<div class="text-[10px] text-amber-600 dark:text-amber-400 font-medium mt-0.5"><i class="fa-solid fa-scissors mr-1"></i>Monto con centavos (${escapeHTML(fmt(emp.amount))})</div>`;
        }

        const cashBoxHTML = breakdownHTML || '<span class="text-[11px] text-slate-400 dark:text-slate-500 italic">Sin billetes asignados...</span>';
        const act = (/** @type {string} */ name) => (isPreview ? '' : `data-card-action="${name}" data-emp-id="${safeEmpId}"`);

        return `
            <div class="emp-status-pill ${statusClass}" title="${escapeHTML(statusTooltip)}" ${act('toggle-paid')}>
                <span class="text-base font-extrabold leading-none">${index + 1}</span>
                ${isPaid ? '<i class="fa-solid fa-check text-[11px] mt-1"></i>' : ''}
            </div>

            <div class="emp-card-content">
                <div class="emp-info-block cursor-pointer select-none group" ${act('toggle-details')} title="Clic para alternar desglose de cálculo">
                    <div class="flex items-center gap-1.5 min-w-0">
                        <h3 class="font-bold text-sm text-slate-800 dark:text-slate-100 truncate group-hover:text-blue-600 dark:group-hover:text-sky-400 transition-colors" title="${escapeHTML(emp.name)}">${escapeHTML(emp.name)}</h3>
                        ${badgeHTML}
                    </div>
                    ${subTextHTML}
                    ${errorNoteHTML}
                </div>

                <div class="emp-cash-box">
                    ${cashBoxHTML}
                </div>

                <div class="emp-actions-bar">
                    <button type="button" ${act('remove')}
                        class="w-6 h-6 rounded-md flex items-center justify-center text-slate-300 dark:text-slate-500 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-slate-800 transition-all -mr-1 -mt-1"
                        title="Eliminar empleado" aria-label="Eliminar empleado">
                        <i class="fa-solid fa-xmark text-xs"></i>
                    </button>
                    <div class="flex flex-col items-center gap-1.5 mt-auto">
                        <button type="button" ${act('edit')}
                            class="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-slate-750 transition-all border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-500 bg-white dark:bg-slate-800 shadow-2xs"
                            title="Editar datos y nómina" aria-label="Editar datos y nómina">
                            <i class="fa-solid fa-pen text-[11px]"></i>
                        </button>
                        <button type="button" ${act('toggle-paid')}
                            class="w-7 h-7 rounded-lg flex items-center justify-center transition-all shadow-2xs ${isPaid ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 border border-emerald-300 dark:border-emerald-700' : 'text-slate-300 dark:text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'}"
                            title="${isPaid ? 'Marcar como pendiente' : 'Marcar como pagado'}" aria-label="${isPaid ? 'Marcar como pendiente' : 'Marcar como pagado'}">
                            <i class="fa-solid fa-check text-xs"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    };

    /**
     * @param {Parameters<typeof buildEmployeeCardHTML>[0]} opts
     * @returns {HTMLElement}
     */
    const createEmployeeCardElement = (opts) => {
        const card = document.createElement('div');
        card.className = opts.emp?.paid ? 'emp-card paid' : 'emp-card';
        card.innerHTML = buildEmployeeCardHTML(opts);
        return card;
    };

    return { generateSmartAdvisorData, buildEmployeeCardHTML, createEmployeeCardElement };
});
