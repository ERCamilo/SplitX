/**
 * SplitXCore.js
 * Lógica pura de distribución de efectivo, resumen de nómina y planificador de banco.
 * Sin DOM: recibe getState() y fmt() para poder probarse en Node.
 */
(function (root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory(require('./CashOptimizer.js'));
    } else {
        root.SplitXCore = factory(root.CashOptimizer);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CashOptimizer) {
    'use strict';

    const createCore = ({ getState, fmt = (n) => String(n) }) => {
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
            return state.employees.reduce((summary, emp) => {
                if (!emp.payroll) {
                    summary.net += emp.amount || 0;
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
                    : (gross + bonuses - discounts);
                const loans = emp.payroll.loans || 0;
                const netWithLoans = emp.amount !== undefined ? emp.amount : (afterDiscounts - loans);

                summary.gross += gross;
                summary.bonuses += bonuses;
                summary.discounts += discounts;
                summary.afterDiscounts += afterDiscounts;
                summary.loans += loans;
                summary.net += isNormal ? afterDiscounts : netWithLoans;

                // Scheduled loans from original imported data vs actual:
                const origLoans = emp.originalData?.payroll?.loans !== undefined
                    ? (emp.originalData.payroll.loans || 0)
                    : (emp.payroll.loans || 0);
                summary.loansScheduled += origLoans;
                const diffLoans = Math.max(0, origLoans - loans);
                summary.loansUncollected += diffLoans;

                // Loan details: principal, interest & debt portfolio
                const ld = emp.payroll.loanDetails || {};
                const interest = ld.interestAmount || 0;
                const principal = ld.principal !== undefined ? ld.principal : Math.max(0, loans - interest);

                summary.totalPrincipal += principal;
                summary.totalInterest += interest;
                summary.totalRemainingBalance += ld.remainingBalance || 0;

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

        const getIdealBreakdown = (amount) => {
            const state = getState();
            const distribution = {};
            let remaining = Math.max(0, Number(amount) || 0);
            state.denominations.forEach(denom => {
                const count = Math.floor(remaining / denom);
                if (count > 0) {
                    distribution[denom] = count;
                    remaining = parseFloat((remaining - count * denom).toFixed(2));
                }
            });
            return { distribution, remainder: remaining };
        };


        // Allocate without mutating employees; keep the original greedy policy as
        // the safe fallback whenever exact search exceeds its bounded resource budget.
        const allocateAvailable = (amount, denominations, inventory, optimize = false) => {
            if (optimize && CashOptimizer && typeof CashOptimizer.solveCash === 'function') {
                try {
                    const plan = CashOptimizer.solveCash(amount, denominations, inventory);
                    Object.entries(plan.distribution).forEach(([denom, count]) => {
                        inventory[denom] = (inventory[denom] || 0) - count;
                    });
                    return { distribution: plan.distribution, remainder: plan.remainder };
                } catch (_) { /* preserved/legacy data can still use the old greedy fallback */ }
            }
            const distribution = {};
            let remainder = amount;
            denominations.forEach(denom => {
                if (remainder <= 0) return;
                const take = Math.min(Math.floor(remainder / denom), inventory[denom] || 0);
                if (take > 0) {
                    distribution[denom] = take;
                    inventory[denom] -= take;
                    remainder = parseFloat((remainder - take * denom).toFixed(2));
                }
            });
            return { distribution, remainder };
        };

        // 1. Calculate Distribution and Return LEFTOVER Inventory (Practical Approach)
        const calculateDistributionPass = (optimize = false) => {
            const state = getState();
            // We create a deep copy of inventory to simulate payments
            let currentInventory = { ...state.inventory };
            const isNormal = state.payrollMode === 'normal';
        
            const results = state.employees.map(emp => {
                let distribution = {};
                let status = 'ok';
                    let missingAmount; // solo se define para empleados no pagados
                let notes = [];
                const targetAmount = getEffectiveEmployeeAmount(emp);

                if (emp.paid) {
                    // For PAID employees, we just calculate ideal for display
                    // We DO NOT deduct from currentInventory because payment is done.
                    let remaining = targetAmount;
                    for (let denom of state.denominations) {
                         let count = Math.floor(remaining / denom);
                         if (count > 0) {
                             distribution[denom] = count;
                             remaining = parseFloat((remaining - (count * denom)).toFixed(2));
                         }
                    }
                } else {
                    // The improved strategy is evaluated against the old plan
                    // before it can affect other employees or the bank order.
                    const allocation = allocateAvailable(targetAmount, state.denominations, currentInventory, optimize);
                    distribution = allocation.distribution;
                    const remaining = allocation.remainder;
                    if (remaining > 0) {
                        status = 'error';
                        // We attach the remaining amount to the employee object for the advisor
                        missingAmount = remaining;
                        notes.push(`Faltan ${fmt(remaining)}`);
                    } else {
                        missingAmount = 0;
                    }
                }

                return { ...emp, _missingAmount: missingAmount, effectiveAmount: targetAmount, distribution, status, notes };
            });

            // Treat the new-loan reserve as one more pending cash assignment (only in deductions / Nómina mode).
            const payrollSummary = getPayrollSummary();
            const loanFundAmount = isNormal ? 0 : Math.min(Math.max(0, Number(state.payrollLoanFund) || 0), payrollSummary.loans);
            const loanFundResult = { amount: loanFundAmount, distribution: {}, status: 'ok', missingAmount: 0 };
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
            const baselineMissing = baseline.results.reduce((n, e) => n + (!e.paid ? (e._missingAmount || 0) : 0), 0)
                + baseline.loanFundResult.missingAmount;
            if (baselineMissing <= 0) return baseline;
            const candidate = calculateDistributionPass(true);
            const newlyShort = candidate.results.some((e, i) => !e.paid &&
                (baseline.results[i]._missingAmount || 0) === 0 && (e._missingAmount || 0) > 0);
            if (newlyShort || (baseline.loanFundResult.missingAmount === 0 && candidate.loanFundResult.missingAmount > 0))
                return baseline;
            const candidateMissing = candidate.results.reduce((n, e) => n + (!e.paid ? (e._missingAmount || 0) : 0), 0)
                + candidate.loanFundResult.missingAmount;
            return candidateMissing < baselineMissing - 0.001 ? candidate : baseline;
        };

        // 2. Bank Planner (Calculates needs ONLY for Unpaid employees)
        const calculateBankNeeds = () => {
            const state = getState();
            let tempTotalBreakdown = {};
            state.denominations.forEach(d => tempTotalBreakdown[d] = 0);

            // Plan only the portions that could not be covered with cash in the box.
            const coverage = calculateDistribution();
            const pendingEmployees = coverage.results.filter(e => !e.paid && e._missingAmount > 0);

            pendingEmployees.forEach(emp => {
                let rem = emp._missingAmount;
                state.denominations.forEach(denom => {
                    let count = Math.floor(rem / denom);
                    if (count > 0) {
                        tempTotalBreakdown[denom] += count;
                        rem = parseFloat((rem - (count * denom)).toFixed(2));
                    }
                });
            });

            // Cash reserve withdrawn to make new employee loans.
            const { loanFundResult } = coverage;
            const loanFundBreakdown = getIdealBreakdown(loanFundResult.missingAmount).distribution;
            state.denominations.forEach(denom => {
                tempTotalBreakdown[denom] += loanFundBreakdown[denom] || 0;
            });

            // Apply Limits & Cascade
            let finalOrder = {};
            let carryOverAmount = 0;

            state.denominations.forEach(denom => {
                let needed = tempTotalBreakdown[denom];
                if (carryOverAmount > 0) {
                    let extraNeeded = Math.floor(carryOverAmount / denom);
                    needed += extraNeeded;
                    carryOverAmount = parseFloat((carryOverAmount - (extraNeeded * denom)).toFixed(2));
                }
                let limit = state.bankLimits[denom];
                let actualLimit = (limit === undefined || limit === null || limit === "") ? Infinity : parseInt(limit);

                let take = Math.min(needed, actualLimit);
                finalOrder[denom] = {
                    ideal: tempTotalBreakdown[denom], 
                    neededAfterCarry: needed, 
                    final: take
                };

                let diffCount = needed - take;
                if (diffCount > 0) carryOverAmount += (diffCount * denom);
            });
        
            return { breakdown: finalOrder, remainder: carryOverAmount };
        };


        return { getEffectiveEmployeeAmount, getPayrollSummary, getIdealBreakdown, calculateDistribution, calculateBankNeeds };
    };

    return { createCore };
});
