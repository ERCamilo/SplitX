// @ts-check
/**
 * SplitXCuadre.js
 * Motor puro de conciliación física de mesa (conteo Real, variación neta en centavos e intercambio de billetes).
 * - Nunca fabrica denominaciones no contadas como exactas en conteos parciales.
 * - Impide conciliación verde o aplicación de intercambios mientras exista sobrecompromiso en caja.
 * - Aplica intercambios de varianza 0 conservando totalBox al centavo exacto y sin tocar sobres comprometidos.
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXCuadre = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /** @param {unknown} v */
    const toCents = (v) => Math.round((Number(v) || 0) * 100);
    /** @param {number} c */
    const fromCents = (c) => Math.round(c) / 100;

    /**
     * Normaliza la entrada del campo numérico `Real` en Cuadre (entero >= 0 o vacío).
     * @param {unknown} raw
     * @returns {{ empty: boolean, qty: number | null, normalizedText: string }}
     */
    const sanitizeActualCountInput = (raw) => {
        const text = String(raw ?? '').trim();
        if (text === '') return { empty: true, qty: null, normalizedText: '' };
        const qty = Math.max(0, Math.floor(Number(text) || 0));
        return { empty: false, qty, normalizedText: String(qty) };
    };

    /**
     * @param {Map<number, number> | Record<string | number, number>} actualCounts
     * @param {number} denom
     */
    const hasCount = (actualCounts, denom) => {
        if (actualCounts instanceof Map) return actualCounts.has(denom);
        return Object.prototype.hasOwnProperty.call(actualCounts, denom);
    };

    /**
     * @param {Map<number, number> | Record<string | number, number>} actualCounts
     * @param {number} denom
     */
    const getCount = (actualCounts, denom) => {
        const v = actualCounts instanceof Map ? actualCounts.get(denom) : actualCounts[denom];
        return Math.max(0, Math.floor(Number(v) || 0));
    };

    /**
     * @param {Map<number, number> | Record<string | number, number>} actualCounts
     */
    const countSize = (actualCounts) => (actualCounts instanceof Map ? actualCounts.size : Object.keys(actualCounts || {}).length);

    /**
     * Calcula la variación física estrictamente sobre las denominaciones ingresadas en `actualCounts`.
     * @param {{
     *   denominations: number[],
     *   ledger: { physicalLooseOnTable: Record<number, number>, committedBills?: Record<number, number>, overcommitTotal?: number } | null,
     *   actualCounts: Map<number, number> | Record<string | number, number>
     * }} params
     */
    const computeVariance = ({ denominations, ledger, actualCounts }) => {
        if (!ledger || !actualCounts || countSize(actualCounts) === 0) return null;

        let enteredCount = 0;
        let expectedEnteredCents = 0;
        let actualEnteredCents = 0;
        let hasSwapDiff = false;
        /** @type {Array<{ denom: number, diff: number, expQty: number, actQty: number }>} */
        const deltas = [];

        denominations.forEach((denom) => {
            if (!hasCount(actualCounts, denom)) return;
            enteredCount += 1;
            const dCents = toCents(denom);
            const expQty = Math.max(0, Number(ledger.physicalLooseOnTable?.[denom]) || 0);
            const actQty = getCount(actualCounts, denom);
            expectedEnteredCents += expQty * dCents;
            actualEnteredCents += actQty * dCents;
            if (actQty !== expQty) {
                hasSwapDiff = true;
                deltas.push({ denom, diff: actQty - expQty, expQty, actQty });
            }
        });

        if (enteredCount === 0) return null;

        const totalDenoms = denominations.length;
        const isComplete = enteredCount >= totalDenoms;
        const deltaCents = actualEnteredCents - expectedEnteredCents;
        const hasOvercommit = (Number(ledger.overcommitTotal) || 0) > 0;
        const deltaSummary = deltas.map((x) => `${x.diff > 0 ? '+' : '−'}${Math.abs(x.diff)}×${x.denom}`).join(', ');

        /** @type {'overcommit' | 'swap_balanced' | 'exact_complete' | 'exact_partial' | 'shortage' | 'surplus'} */
        let status;
        if (hasOvercommit) status = 'overcommit';
        else if (deltaCents === 0 && hasSwapDiff) status = 'swap_balanced';
        else if (deltaCents === 0 && isComplete) status = 'exact_complete';
        else if (deltaCents === 0) status = 'exact_partial';
        else if (deltaCents < 0) status = 'shortage';
        else status = 'surplus';

        return {
            enteredCount,
            totalDenoms,
            isComplete,
            expectedCents: expectedEnteredCents,
            actualCents: actualEnteredCents,
            deltaCents,
            hasSwapDiff,
            deltas,
            deltaSummary,
            status
        };
    };

    /**
     * Construye un nuevo inventario aplicando un intercambio de billetes de varianza neta 0
     * sin alterar sobres comprometidos (`committedBills`) ni el total monetario en caja.
     * @param {{
     *   inventory: Record<number, number>,
     *   denominations: number[],
     *   ledger: { physicalLooseOnTable: Record<number, number>, committedBills: Record<number, number>, overcommitTotal?: number } | null,
     *   actualCounts: Map<number, number> | Record<string | number, number>
     * }} params
     */
    const buildSwappedInventory = ({ inventory, denominations, ledger, actualCounts }) => {
        const stats = computeVariance({ denominations, ledger, actualCounts });
        if (!stats || !ledger || stats.status !== 'swap_balanced') {
            return { ok: false, reason: stats ? stats.status : 'empty' };
        }
        /** @type {Record<number, number>} */
        const nextInventory = { ...inventory };
        stats.deltas.forEach(({ denom, actQty }) => {
            const committed = Math.max(0, Number(ledger.committedBills?.[denom]) || 0);
            nextInventory[denom] = committed + actQty;
        });
        return {
            ok: true,
            nextInventory,
            summaryText: stats.deltaSummary,
            deltas: stats.deltas
        };
    };

    return {
        toCents,
        fromCents,
        sanitizeActualCountInput,
        computeVariance,
        buildSwappedInventory
    };
});
