// @ts-check
/**
 * SplitXCore.js
 * Lógica pura de distribución de efectivo, resumen de nómina y planificador de banco.
 * Sin DOM: recibe getState() y fmt() para poder probarse en Node.
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory(require('./CashOptimizer.js'));
    } else {
        root.SplitXCore = factory(root.CashOptimizer);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, /** @param {any} CashOptimizer */ function (CashOptimizer) {
    'use strict';

    /** @param {unknown} n @returns {number} */
    const toCents = (n) => Math.round((Number(n) || 0) * 100);
    /** @param {number} cents @returns {number} */
    const fromCents = (cents) => Math.round(cents) / 100;

    /**
     * Normaliza el estado de pago de un colaborador manteniendo compatibilidad con registros legados (`paid: boolean`).
     * @param {any} emp
     * @returns {'pending' | 'packed' | 'paid'}
     */
    const getEmployeePayoutStatus = (emp) => {
        if (!emp || typeof emp !== 'object') return 'pending';
        if (emp.payoutStatus === 'paid' || emp.payoutStatus === 'packed' || emp.payoutStatus === 'pending') {
            return emp.payoutStatus;
        }
        return emp.paid === true ? 'paid' : 'pending';
    };

    /**
     * Sanitiza un mapa de billetes fijados (`lockedDistribution`) a enteros positivos por denominación positiva.
     * @param {unknown} raw
     * @returns {Record<number, number> | null}
     */
    const sanitizeLockedDistribution = (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        /** @type {Record<number, number>} */
        const clean = {};
        let hasEntries = false;
        for (const [k, v] of Object.entries(raw)) {
            const denom = Number(k);
            const qty = Number.parseInt(String(v ?? ''), 10);
            if (Number.isFinite(denom) && denom > 0 && Number.isFinite(qty) && qty > 0) {
                clean[denom] = qty;
                hasEntries = true;
            }
        }
        return hasEntries ? clean : null;
    };

    /**
     * Calcula el resumen contable del libro mayor (Cuadre de Mesa en vivo) en centavos enteros.
     * @param {number[]} denominations
     * @param {Record<number | string, number>} initialInventory
     * @param {Array<any>} coverageResults
     */
    const computeLedgerSummary = (denominations, initialInventory, coverageResults) => {
        const denoms = Array.isArray(denominations) ? denominations : [];
        const inv = initialInventory && typeof initialInventory === 'object' ? initialInventory : {};
        const list = Array.isArray(coverageResults) ? coverageResults : [];

        /** @type {Record<number, number>} */
        const packedBills = {};
        /** @type {Record<number, number>} */
        const paidBills = {};
        /** @type {Record<number, number>} */
        const committedBills = {};
        /** @type {Record<number, number>} */
        const physicalLooseOnTable = {};
        /** @type {Record<number, number>} */
        const overcommittedDenoms = {};

        for (const d of denoms) {
            packedBills[d] = 0;
            paidBills[d] = 0;
            committedBills[d] = 0;
            physicalLooseOnTable[d] = Math.max(0, Number(inv[d]) || 0);
        }

        let paidCents = 0;
        let packedCents = 0;
        let pendingCents = 0;
        let paidCount = 0;
        let packedCount = 0;
        let pendingCount = 0;
        let shortageCount = 0;

        for (const emp of list) {
            const st = getEmployeePayoutStatus(emp);
            const effCents = Math.max(0, toCents(emp.effectiveAmount !== undefined ? emp.effectiveAmount : emp.amount));
            const locked = sanitizeLockedDistribution(emp.lockedDistribution);

            if (st === 'paid') {
                paidCount += 1;
                paidCents += effCents;
                if (locked) {
                    for (const d of denoms) {
                        const q = locked[d] || 0;
                        if (q > 0) {
                            paidBills[d] += q;
                            committedBills[d] += q;
                        }
                    }
                }
            } else if (st === 'packed') {
                packedCount += 1;
                packedCents += effCents;
                const src = locked || sanitizeLockedDistribution(emp.distribution) || {};
                for (const d of denoms) {
                    const q = src[d] || 0;
                    if (q > 0) {
                        packedBills[d] += q;
                        committedBills[d] += q;
                    }
                }
            } else {
                pendingCount += 1;
                pendingCents += effCents;
                if (emp.status === 'error' || (emp._missingAmount || 0) > 0) {
                    shortageCount += 1;
                }
            }
        }

        let totalBoxCents = 0;
        let looseCents = 0;
        for (const d of denoms) {
            const dCents = toCents(d);
            const initialQty = Math.max(0, Number(inv[d]) || 0);
            const committedQty = committedBills[d] || 0;
            totalBoxCents += initialQty * dCents;
            if (committedQty > initialQty) {
                overcommittedDenoms[d] = committedQty - initialQty;
                physicalLooseOnTable[d] = 0;
            } else {
                physicalLooseOnTable[d] = initialQty - committedQty;
                looseCents += physicalLooseOnTable[d] * dCents;
            }
        }

        const totalPayrollCents = paidCents + packedCents + pendingCents;
        return {
            packedBills,
            paidBills,
            committedBills,
            physicalLooseOnTable,
            overcommittedDenoms,
            totalBox: fromCents(totalBoxCents),
            totalPayroll: fromCents(totalPayrollCents),
            paidTotal: fromCents(paidCents),
            packedTotal: fromCents(packedCents),
            pendingTotal: fromCents(pendingCents),
            looseTotal: fromCents(looseCents),
            paidCount,
            packedCount,
            pendingCount,
            shortageCount
        };
    };

    /**
     * Sanitiza un límite bancario: vacío/inválido -> null (sin límite), negativo -> 0, entero >= 0 -> entero.
     * @param {unknown} val
     * @returns {number | null}
     */
    const sanitizeBankLimit = (val) => {
        if (val === undefined || val === null) return null;
        const text = String(val).trim();
        if (text === '') return null;
        const n = Number.parseInt(text, 10);
        if (!Number.isFinite(n)) return null;
        return n < 0 ? 0 : n;
    };

    /** @param {{ getState: () => any, fmt?: (n: number) => string }} deps */
    const createCore = ({ getState, fmt = (n) => String(n) }) => {
        /** @param {any} emp @returns {number} */
        const getEffectiveEmployeeAmount = (emp) => {
            const state = getState();
            // When in 'normal' mode and employee has payroll breakdown, ignore loan deductions:
            if (state.payrollMode === 'normal' && emp.payroll && emp.payroll.afterDiscounts !== undefined && emp.payroll.afterDiscounts !== null) {
                return emp.payroll.afterDiscounts;
            }
            return emp.amount;
        };

        const getPayrollSummary = () => {
            const state = getState();
            const isNormal = state.payrollMode === 'normal';
            return state.employees.reduce((/** @type {any} */ summary, /** @type {any} */ emp) => {
                if (!emp.payroll) {
                    summary.net = fromCents(toCents(summary.net) + toCents(emp.amount));
                    return summary;
                }
                summary.count += 1;
                if ((emp.payroll.loans || 0) > 0) {
                    summary.loansCount += 1;
                }
                const gross = emp.payroll.gross || 0;
                const bonuses = emp.payroll.bonuses || 0;
                const discounts = emp.payroll.discounts || 0;
                const afterDiscounts = (emp.payroll.afterDiscounts !== undefined && emp.payroll.afterDiscounts !== null)
                    ? emp.payroll.afterDiscounts
                    : fromCents(toCents(gross) + toCents(bonuses) - toCents(discounts));
                const loans = emp.payroll.loans || 0;
                const netWithLoans = emp.amount !== undefined ? emp.amount : fromCents(toCents(afterDiscounts) - toCents(loans));

                summary.gross = fromCents(toCents(summary.gross) + toCents(gross));
                summary.bonuses = fromCents(toCents(summary.bonuses) + toCents(bonuses));
                summary.discounts = fromCents(toCents(summary.discounts) + toCents(discounts));
                summary.afterDiscounts = fromCents(toCents(summary.afterDiscounts) + toCents(afterDiscounts));
                summary.loans = fromCents(toCents(summary.loans) + toCents(loans));
                summary.net = fromCents(toCents(summary.net) + toCents(isNormal ? afterDiscounts : netWithLoans));

                // Scheduled loans from original imported data vs actual:
                const origLoans = emp.originalData?.payroll?.loans !== undefined
                    ? (emp.originalData.payroll.loans || 0)
                    : (emp.payroll.loans || 0);
                summary.loansScheduled = fromCents(toCents(summary.loansScheduled) + toCents(origLoans));
                const diffLoans = Math.max(0, fromCents(toCents(origLoans) - toCents(loans)));
                summary.loansUncollected = fromCents(toCents(summary.loansUncollected) + toCents(diffLoans));

                // Loan details: principal, interest & debt portfolio
                const ld = emp.payroll.loanDetails || {};
                const interest = ld.interestAmount || 0;
                const principal = ld.principal !== undefined ? ld.principal : Math.max(0, fromCents(toCents(loans) - toCents(interest)));

                summary.totalPrincipal = fromCents(toCents(summary.totalPrincipal) + toCents(principal));
                summary.totalInterest = fromCents(toCents(summary.totalInterest) + toCents(interest));
                summary.totalRemainingBalance = fromCents(toCents(summary.totalRemainingBalance) + toCents(ld.remainingBalance || 0));

                return summary;
            }, {
                count: 0,
                loansCount: 0,
                gross: 0,
                bonuses: 0,
                discounts: 0,
                afterDiscounts: 0,
                loans: 0,
                net: 0,
                loansScheduled: 0,
                loansUncollected: 0,
                totalPrincipal: 0,
                totalInterest: 0,
                totalRemainingBalance: 0
            });
        };

        /** @param {number} amount */
        const getIdealBreakdown = (amount) => {
            const state = getState();
            /** @type {Record<number, number>} */
            const distribution = {};
            let remCents = Math.max(0, toCents(amount));
            state.denominations.forEach((/** @type {number} */ denom) => {
                const denomCents = toCents(denom);
                if (denomCents <= 0 || remCents <= 0) return;
                const count = Math.floor(remCents / denomCents);
                if (count > 0) {
                    distribution[denom] = count;
                    remCents -= count * denomCents;
                }
            });
            return { distribution, remainder: fromCents(remCents) };
        };

        // Allocate without mutating employees; keep the original greedy policy as
        // the safe fallback whenever exact search exceeds its bounded resource budget.
        /** @param {number} amount @param {number[]} denominations @param {Record<number | string, number>} inventory @param {boolean} [optimize] */
        const allocateAvailable = (amount, denominations, inventory, optimize = false) => {
            const safeAmount = Math.max(0, fromCents(toCents(amount)));
            if (optimize && CashOptimizer && typeof CashOptimizer.solveCash === 'function') {
                try {
                    const plan = CashOptimizer.solveCash(safeAmount, denominations, inventory);
                    Object.entries(plan.distribution).forEach(([denom, count]) => {
                        inventory[denom] = (inventory[denom] || 0) - Number(count);
                    });
                    return { distribution: /** @type {Record<number, number>} */ (plan.distribution), remainder: /** @type {number} */ (plan.remainder) };
                } catch (_) { /* preserved/legacy data can still use the old greedy fallback */ }
            }
            /** @type {Record<number, number>} */
            const distribution = {};
            let remCents = toCents(safeAmount);
            denominations.forEach(denom => {
                const denomCents = toCents(denom);
                if (remCents <= 0 || denomCents <= 0) return;
                const avail = Math.max(0, Number(inventory[denom]) || 0);
                const take = Math.min(Math.floor(remCents / denomCents), avail);
                if (take > 0) {
                    distribution[denom] = take;
                    inventory[denom] = avail - take;
                    remCents -= take * denomCents;
                }
            });
            return { distribution, remainder: fromCents(remCents) };
        };

        // 1. Calculate Distribution and Return LEFTOVER Inventory (Practical Ledger Approach)
        /** @param {boolean} [optimize] @param {number[] | null} [orderIndices] */
        const calculateDistributionPass = (optimize = false, orderIndices = null) => {
            const state = getState();
            // Deep copy initial inventory and first deduct bills already committed in locked envelopes
            /** @type {Record<number | string, number>} */
            let currentInventory = { ...state.inventory };
            const isNormal = state.payrollMode === 'normal';
            const totalEmps = state.employees.length;

            // Ledger commit pass: deduct lockedDistribution of packed and ledger-paid employees BEFORE allocating pending
            for (let i = 0; i < totalEmps; i++) {
                const emp = state.employees[i];
                const payoutStatus = getEmployeePayoutStatus(emp);
                const locked = sanitizeLockedDistribution(emp.lockedDistribution);
                if ((payoutStatus === 'packed' || payoutStatus === 'paid') && locked) {
                    for (const [denomKey, qty] of Object.entries(locked)) {
                        const avail = Math.max(0, Number(currentInventory[denomKey]) || 0);
                        currentInventory[denomKey] = Math.max(0, avail - qty);
                    }
                }
            }

            /** @type {any[]} */
            const results = new Array(totalEmps);
            const indices = Array.isArray(orderIndices) && orderIndices.length === totalEmps
                ? orderIndices
                : Array.from({ length: totalEmps }, (_, idx) => idx);

            for (const idx of indices) {
                const emp = state.employees[idx];
                const payoutStatus = getEmployeePayoutStatus(emp);
                const locked = sanitizeLockedDistribution(emp.lockedDistribution);
                /** @type {Record<number, number>} */
                let distribution = {};
                let status = 'ok';
                /** @type {number | undefined} */
                let missingAmount; // solo se define para empleados no pagados
                /** @type {string[]} */
                let notes = [];
                const targetAmount = Math.max(0, fromCents(toCents(getEffectiveEmployeeAmount(emp))));

                if (payoutStatus === 'paid') {
                    // Ledger-paid preserves its locked bills (already deducted above); legacy/checklist paid shows ideal without deducting
                    distribution = locked ? { ...locked } : getIdealBreakdown(targetAmount).distribution;
                } else if (payoutStatus === 'packed') {
                    // Envelope already assembled and bills reserved in commit pass above
                    distribution = locked ? { ...locked } : getIdealBreakdown(targetAmount).distribution;
                    missingAmount = 0;
                } else {
                    // Pending employee: allocate from remaining uncommitted cash
                    const allocation = allocateAvailable(targetAmount, state.denominations, currentInventory, optimize);
                    distribution = allocation.distribution;
                    const remaining = allocation.remainder;
                    if (remaining > 0) {
                        status = 'error';
                        missingAmount = remaining;
                        notes.push(`Faltan ${fmt(remaining)}`);
                    } else {
                        missingAmount = 0;
                    }
                }

                results[idx] = {
                    ...emp,
                    _originalIndex: idx,
                    payoutStatus,
                    paid: payoutStatus === 'paid',
                    _missingAmount: missingAmount,
                    effectiveAmount: targetAmount,
                    distribution,
                    status,
                    notes
                };
            }

            // Treat the new-loan reserve as one more pending cash assignment (only in deductions / Nómina mode).
            const payrollSummary = getPayrollSummary();
            const loanFundAmount = isNormal ? 0 : Math.min(Math.max(0, Number(state.payrollLoanFund) || 0), Math.max(0, payrollSummary.loans));
            const loanFundResult = { amount: loanFundAmount, distribution: /** @type {Record<number, number>} */ ({}), status: 'ok', missingAmount: 0 };
            const fundAllocation = allocateAvailable(loanFundAmount, state.denominations, currentInventory, optimize);
            loanFundResult.distribution = fundAllocation.distribution;
            const fundRemaining = fundAllocation.remainder;
            if (fundRemaining > 0) {
                loanFundResult.status = 'error';
                loanFundResult.missingAmount = fundRemaining;
            }

            // Return both the mapped employees AND what's left in the inventory
            return { results, leftoverInventory: currentInventory, loanFundResult };
        };

        // Never turn an employee or loan reserve that was fully covered by the
        // existing method into an underfunded one. Also reject plans with more
        // missing money across the entire operation.
        const calculateDistribution = () => {
            const baseline = calculateDistributionPass(false);
            if (!CashOptimizer || typeof CashOptimizer.solveCash !== 'function') return baseline;

            /** @param {any} pass */
            const calcMissing = (pass) => pass.results.reduce((/** @type {number} */ n, /** @type {any} */ e) => n + (!e.paid ? (e._missingAmount || 0) : 0), 0)
                + pass.loanFundResult.missingAmount;
            /** @param {any} pass */
            const countShort = (pass) => pass.results.reduce((/** @type {number} */ n, /** @type {any} */ e) => n + (!e.paid && (e._missingAmount || 0) > 0 ? 1 : 0), 0)
                + (pass.loanFundResult.missingAmount > 0 ? 1 : 0);

            const baselineMissing = calcMissing(baseline);
            if (baselineMissing <= 0) return baseline;

            let best = baseline;
            let bestMissing = baselineMissing;
            let bestShort = countShort(baseline);

            /** @param {any} candidate */
            const considerCandidate = (candidate) => {
                const newlyShort = candidate.results.some((/** @type {any} */ e, /** @type {number} */ i) => !e.paid &&
                    (baseline.results[i]._missingAmount || 0) === 0 && (e._missingAmount || 0) > 0);
                if (newlyShort || (baseline.loanFundResult.missingAmount === 0 && candidate.loanFundResult.missingAmount > 0)) {
                    return;
                }
                const candMissing = calcMissing(candidate);
                const candShort = countShort(candidate);
                if (candMissing < bestMissing - 0.001 || (Math.abs(candMissing - bestMissing) <= 0.001 && candShort < bestShort)) {
                    best = candidate;
                    bestMissing = candMissing;
                    bestShort = candShort;
                }
            };

            considerCandidate(calculateDistributionPass(true));
            if (bestMissing <= 0) return best;

            // Multi-order bounded search: resolves false shortages caused solely by list order
            // (e.g. Emp1=1000 taking both 500s before Emp2=700 & Emp3=700). UI order is preserved.
            const state = getState();
            const unpaid = [];
            const committed = [];
            for (let i = 0; i < state.employees.length; i++) {
                const emp = state.employees[i];
                const st = getEmployeePayoutStatus(emp);
                if (st === 'paid' || st === 'packed') committed.push(i);
                else unpaid.push({ idx: i, cents: Math.max(0, toCents(getEffectiveEmployeeAmount(emp))) });
            }
            if (unpaid.length < 2) return best;

            let maxAvailDenomCents = 0;
            for (const d of state.denominations) {
                if ((Number(state.inventory?.[d]) || 0) > 0) {
                    const dc = toCents(d);
                    if (dc > maxAvailDenomCents) maxAvailDenomCents = dc;
                }
            }
            if (maxAvailDenomCents <= 0 && state.denominations.length > 0) {
                maxAvailDenomCents = toCents(state.denominations[0]);
            }

            /** @type {number[][]} */
            const candidateOrders = [
                // 1. Constrained / non-divisible amounts first (protects exact-change bills like 500 for 700)
                [...unpaid].sort((a, b) => {
                    const aDiv = maxAvailDenomCents > 0 && a.cents % maxAvailDenomCents === 0 ? 1 : 0;
                    const bDiv = maxAvailDenomCents > 0 && b.cents % maxAvailDenomCents === 0 ? 1 : 0;
                    if (aDiv !== bDiv) return aDiv - bDiv;
                    if (a.cents !== b.cents) return a.cents - b.cents;
                    return a.idx - b.idx;
                }).map(x => x.idx).concat(committed),
                // 2. Smallest unpaid first
                [...unpaid].sort((a, b) => (a.cents - b.cents) || (a.idx - b.idx)).map(x => x.idx).concat(committed),
                // 3. Largest unpaid first
                [...unpaid].sort((a, b) => (b.cents - a.cents) || (a.idx - b.idx)).map(x => x.idx).concat(committed)
            ];

            const seenOrders = new Set([unpaid.map(x => x.idx).concat(committed).join(',')]);
            for (const order of candidateOrders) {
                const key = order.join(',');
                if (seenOrders.has(key)) continue;
                seenOrders.add(key);
                considerCandidate(calculateDistributionPass(true, order));
                if (bestMissing <= 0) break;
            }

            return best;
        };

        // 2. Bank Planner (Calculates needs ONLY for Unpaid employees)
        /** @param {any} [precomputedCoverage] */
        const calculateBankNeeds = (precomputedCoverage = null) => {
            const state = getState();
            /** @type {Record<number, number>} */
            let tempTotalBreakdown = {};
            state.denominations.forEach((/** @type {number} */ d) => tempTotalBreakdown[d] = 0);

            // Plan only the portions that could not be covered with cash in the box.
            const coverage = precomputedCoverage || calculateDistribution();
            const pendingEmployees = coverage.results.filter((/** @type {any} */ e) => !e.paid && e._missingAmount > 0);

            pendingEmployees.forEach((/** @type {any} */ emp) => {
                let remCents = toCents(emp._missingAmount);
                state.denominations.forEach((/** @type {number} */ denom) => {
                    const denomCents = toCents(denom);
                    if (denomCents <= 0 || remCents <= 0) return;
                    const count = Math.floor(remCents / denomCents);
                    if (count > 0) {
                        tempTotalBreakdown[denom] += count;
                        remCents -= count * denomCents;
                    }
                });
            });

            // Cash reserve withdrawn to make new employee loans.
            const { loanFundResult } = coverage;
            const loanFundBreakdown = getIdealBreakdown(loanFundResult.missingAmount).distribution;
            state.denominations.forEach((/** @type {number} */ denom) => {
                tempTotalBreakdown[denom] += loanFundBreakdown[denom] || 0;
            });

            // Apply Limits & Cascade in integer cents
            /** @type {Record<number, { ideal: number, neededAfterCarry: number, final: number }>} */
            let finalOrder = {};
            let carryOverCents = 0;

            state.denominations.forEach((/** @type {number} */ denom) => {
                const denomCents = toCents(denom);
                let needed = tempTotalBreakdown[denom];
                if (carryOverCents > 0 && denomCents > 0) {
                    const extraNeeded = Math.floor(carryOverCents / denomCents);
                    needed += extraNeeded;
                    carryOverCents -= extraNeeded * denomCents;
                }
                const sanitized = sanitizeBankLimit(state.bankLimits?.[denom]);
                const actualLimit = sanitized === null ? Infinity : sanitized;

                const take = Math.min(needed, actualLimit);
                finalOrder[denom] = {
                    ideal: tempTotalBreakdown[denom],
                    neededAfterCarry: needed,
                    final: take
                };

                const diffCount = needed - take;
                if (diffCount > 0 && denomCents > 0) carryOverCents += diffCount * denomCents;
            });

            return { breakdown: finalOrder, remainder: fromCents(carryOverCents) };
        };

        return { getEffectiveEmployeeAmount, getPayrollSummary, getIdealBreakdown, calculateDistribution, calculateBankNeeds };
    };

    // Pure domain helpers extracted from index.html for testability and safety.
    let _lastGeneratedId = 0;
    const nextEmployeeId = () => {
        const now = Date.now();
        _lastGeneratedId = now > _lastGeneratedId ? now : _lastGeneratedId + 1;
        return _lastGeneratedId;
    };

    /** @param {unknown} val */
    const sanitizeInventoryQty = (val) => {
        const n = Number.parseInt(String(val ?? ''), 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };

    /** @param {unknown} valStr @param {((s: string) => number) | null} [parseMoneyFn] */
    const parseManualAmount = (valStr, parseMoneyFn = null) => {
        const raw = String(valStr ?? '').trim();
        if (!raw) return { ok: false, error: 'Ingresa un monto válido.' };
        try {
            let amount;
            if (typeof parseMoneyFn === 'function') {
                amount = parseMoneyFn(raw);
            } else {
                const n = Number(raw);
                if (!Number.isFinite(n) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
                    throw new Error('Monto inválido o con más de dos decimales.');
                }
                amount = Math.round(n * 100) / 100;
            }
            if (!Number.isFinite(amount) || amount < 0) {
                return { ok: false, error: 'El monto no puede ser negativo.' };
            }
            return { ok: true, amount };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : 'Monto inválido.' };
        }
    };

    /** @param {unknown} rawValue @param {number} collectedLoans @param {((s: string) => number) | null} [parseMoneyFn] */
    const clampLoanFund = (rawValue, collectedLoans, parseMoneyFn = null) => {
        const maxLoans = Math.max(0, Number(collectedLoans) || 0);
        const text = String(rawValue ?? '').trim();
        if (!text) return { ok: true, value: 0 };
        const parsed = parseManualAmount(text, parseMoneyFn);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        return { ok: true, value: Math.min(/** @type {number} */(parsed.amount), maxLoans) };
    };

    /** @param {any[]} employees @param {string} [payrollMode] */
    const roundEmployeeAmounts = (employees, payrollMode = 'normal') => {
        const list = Array.isArray(employees) ? employees : [];
        let count = 0;
        const next = list.map(emp => {
            const hasPayroll = !!(emp && emp.payroll);
            const curAmount = fromCents(toCents(emp?.amount));
            const curAfter = hasPayroll && emp.payroll.afterDiscounts !== undefined && emp.payroll.afterDiscounts !== null
                ? fromCents(toCents(emp.payroll.afterDiscounts))
                : null;
            const effective = (payrollMode === 'normal' && curAfter !== null) ? curAfter : curAmount;
            const amountHasCents = curAmount !== Math.floor(curAmount);
            const afterHasCents = curAfter !== null && curAfter !== Math.floor(curAfter);
            if (effective === Math.floor(effective) && !amountHasCents && !afterHasCents) {
                return emp;
            }
            count += 1;
            const newAmount = Math.floor(curAmount);
            const resetEnvelope = getEmployeePayoutStatus(emp) === 'packed'
                ? { payoutStatus: 'pending', paid: false, lockedDistribution: null }
                : {};
            if (!hasPayroll) return { ...emp, ...resetEnvelope, amount: newAmount };
            const newAfter = curAfter !== null ? Math.floor(curAfter) : emp.payroll.afterDiscounts;
            const calcNet = emp.payroll.calculatedNet;
            const diff = (calcNet !== undefined && calcNet !== null)
                ? fromCents(toCents(newAmount) - toCents(calcNet))
                : emp.payroll.difference;
            return {
                ...emp,
                ...resetEnvelope,
                amount: newAmount,
                payroll: {
                    ...emp.payroll,
                    afterDiscounts: newAfter,
                    net: newAmount,
                    difference: diff,
                    reconciled: diff === null || diff === undefined ? emp.payroll.reconciled : Math.abs(diff) <= 0.01
                }
            };
        });
        return { employees: next, count };
    };

    /**
     * Parsea entrada rápida como "Juan 4,500.00", "Ana-María 500" o "1. Juan Pérez 4500"
     * sin truncar separadores de miles.
     * @param {unknown} raw
     * @returns {{ name: string, amountText: string } | null}
     */
    const parseQuickAddLine = (raw) => {
        const text = String(raw ?? '').trim();
        if (!text) return null;
        const match = text.match(/^[\d.\-)\s]*([a-zA-Z\u00C0-\u024F][a-zA-Z\u00C0-\u024F\s'’.-]*?)[,\s]+(-?\d[\d.,]*)$/);
        if (!match) return null;
        const name = match[1].trim();
        const amountText = match[2].trim();
        if (!name || !amountText) return null;
        return { name, amountText };
    };

    return {
        createCore,
        toCents,
        fromCents,
        getEmployeePayoutStatus,
        sanitizeLockedDistribution,
        computeLedgerSummary,
        nextEmployeeId,
        sanitizeInventoryQty,
        sanitizeBankLimit,
        parseManualAmount,
        parseQuickAddLine,
        clampLoanFund,
        roundEmployeeAmounts
    };
});
