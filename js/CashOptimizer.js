/**
 * Bounded denomination search for one cash assignment.
 *
 * Exact for the configured state/work budgets; otherwise returns the current
 * greedy allocation unchanged. This module neither spends cash nor mutates stock.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CashOptimizer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const minor = (n) => {
        const x = Number(n);
        const cents = Math.round(x * 100);
        if (!Number.isFinite(x) || !Number.isSafeInteger(cents) ||
            Math.abs(x * 100 - cents) > 1e-6) throw new Error('Amount must have at most two decimal places.');
        return cents;
    };
    const gcd = (a, b) => {
        while (b) { const t = a % b; a = b; b = t; }
        return a;
    };

    const solveCash = (amount, denominations, inventory, options = {}) => {
        const target = minor(amount);
        if (target < 0) throw new Error('Negative payment is invalid.');
        if (!Array.isArray(denominations) || !inventory || typeof inventory !== 'object')
            throw new Error('Invalid cash inventory.');
        const unique = [...new Set(denominations.map(Number))];
        const pairs = unique.map(denom => ({
            denom,
            cents: minor(denom),
            stock: Number(inventory[denom] ?? 0)
        })).sort((a, b) => b.cents - a.cents);
        if (pairs.some(p => p.cents <= 0 || !Number.isSafeInteger(p.stock) || p.stock < 0))
            throw new Error('Invalid denomination or stock count.');

        const greedy = () => {
            let left = target;
            const distribution = {};
            for (const p of pairs) {
                if (left <= 0) break;
                const count = Math.min(p.stock, Math.floor(left / p.cents));
                if (count > 0) {
                    distribution[p.denom] = count;
                    left -= count * p.cents;
                }
            }
            return { distribution, remainder: left / 100, exact: left === 0, optimized: false };
        };
        const original = greedy();
        if (original.exact || target === 0) return original;
        const active = pairs.filter(p => p.stock > 0 && p.cents <= target);
        if (!active.length) return original;

        const unit = active.reduce((value, p) => gcd(value, p.cents), active[0].cents);
        const limit = Math.floor(target / unit);
        const maxStates = options.maxStates ?? 20000;
        const maxWork = options.maxWork ?? 1600000;
        const maxUpdates = options.maxUpdates ?? 180000;
        if (limit > maxStates || !Number.isSafeInteger(limit)) return original;

        const chunks = [];
        for (const p of active) {
            let remaining = Math.min(p.stock, Math.floor(target / p.cents)), power = 1;
            while (remaining) {
                const count = Math.min(power, remaining);
                chunks.push({ key: p.denom, count, weight: count * (p.cents / unit) });
                remaining -= count;
                power *= 2;
            }
        }
        if ((limit + 1) * chunks.length > maxWork) return original;

        const notes = new Int32Array(limit + 1);
        notes.fill(-1);
        notes[0] = 0;
        // Paths are immutable snapshots: unlike overwritten DP predecessor arrays,
        // they cannot accidentally reuse the same finite-stock denomination.
        const paths = new Array(limit + 1);
        paths[0] = null;
        let updates = 0;
        for (const item of chunks) {
            for (let sum = limit; sum >= item.weight; sum--) {
                const prev = sum - item.weight;
                if (notes[prev] < 0) continue;
                const used = notes[prev] + item.count;
                if (notes[sum] < 0 || used < notes[sum]) {
                    if (++updates > maxUpdates) return original;
                    notes[sum] = used;
                    paths[sum] = { previous: paths[prev], key: item.key, count: item.count };
                }
            }
        }

        const baselineCovered = target - Math.round(original.remainder * 100);
        let best = limit;
        while (best > 0 && notes[best] < 0) best--;
        if (best * unit <= baselineCovered) return original;

        const distribution = {};
        for (let node = paths[best]; node; node = node.previous) {
            distribution[node.key] = (distribution[node.key] || 0) + node.count;
        }
        const covered = Object.entries(distribution).reduce((sum, [k, count]) => sum + minor(k) * count, 0);
        if (covered !== best * unit || active.some(p => (distribution[p.denom] || 0) > p.stock))
            return original;
        const remaining = target - covered;
        return { distribution, remainder: remaining / 100, exact: remaining === 0, optimized: true };
    };

    return { solveCash };
});
