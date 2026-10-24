'use strict';
/**
 * Find a denomination combination from finite stock for a single payment.
 *
 * Exact bounded subset-sum in minor currency units, with a conservative state
 * limit. On unsupported/very large inputs return the original greedy result.
 * This is a candidate engine for review: it is NOT wired into production.
 */
const solveCash = (amount, denominations, inventory, options = {}) => {
    const scale = 100;
    const toMinor = n => Math.round(Number(n) * scale);
    const target = toMinor(amount);
    const maxStates = options.maxStates ?? 200000;
    if (!Number.isFinite(target) || target < 0 || Math.abs(target / scale - Number(amount)) > 1e-7) {
        throw new Error('Invalid target amount');
    }
    const pairs = [...new Set(denominations.map(Number))].filter(d => Number.isFinite(d) && d > 0)
        .sort((a, b) => b - a)
        .map(d => ({ denom: d, value: toMinor(d), stock: Number(inventory[d] || 0) }));
    if (pairs.some(p => !Number.isSafeInteger(p.value) || p.value <= 0 ||
        !Number.isSafeInteger(p.stock) || p.stock < 0)) throw new Error('Invalid denominations or inventory');
    const greedy = () => {
        let left = target, distribution = {};
        for (const p of pairs) {
            const n = Math.min(p.stock, Math.floor(left / p.value));
            if (n) { distribution[p.denom] = n; left -= n * p.value; }
        }
        return { distribution, remainder: left / scale, exact: left === 0, optimized: false };
    };
    const baseline = greedy();
    if (baseline.exact || target === 0) return baseline;
    if (!Number.isSafeInteger(target) || target > maxStates || pairs.length > 24) return baseline;

    // Bounded knapsack with binary decomposition. Favor fewer notes for equal sums.
    // All decisions use integer minor units: no floating point remainder drift.
    const dp = new Int32Array(target + 1);
    dp.fill(-1);
    dp[0] = 0;
    const previous = new Int32Array(target + 1);
    const chosen = new Int32Array(target + 1);
    const chunks = [];
    for (const p of pairs) {
        let available = Math.min(p.stock, Math.floor(target / p.value)), size = 1;
        while (available > 0) {
            const count = Math.min(size, available);
            chunks.push({ denom: p.denom, count, sum: count * p.value });
            available -= count;
            size *= 2;
        }
    }
    for (let k = 0; k < chunks.length; k++) {
        const item = chunks[k];
        for (let sum = target; sum >= item.sum; sum--) {
            const before = sum - item.sum;
            if (dp[before] < 0) continue;
            const noteCount = dp[before] + item.count;
            if (dp[sum] < 0 || noteCount < dp[sum]) {
                dp[sum] = noteCount;
                previous[sum] = before;
                chosen[sum] = k + 1;
            }
        }
    }
    let best = target;
    while (best > 0 && dp[best] < 0) best--;
    if (best <= target - Math.round(baseline.remainder * scale)) return baseline;
    const distribution = {};
    let cursor = best;
    // Caution: descending 0/1 DP predecessor arrays can be overwritten in a later
    // iteration. Verify the reconstructed combination before returning it.
    let steps = 0;
    while (cursor > 0 && steps++ <= chunks.length) {
        const idx = chosen[cursor] - 1;
        if (idx < 0) return baseline;
        const item = chunks[idx];
        distribution[item.denom] = (distribution[item.denom] || 0) + item.count;
        if (previous[cursor] >= cursor) return baseline;
        cursor = previous[cursor];
    }
    if (cursor !== 0 ||
        pairs.some(p => (distribution[p.denom] || 0) > p.stock) ||
        Math.round(Object.entries(distribution).reduce((s, [d, n]) => s + Number(d) * n, 0) * scale) !== best) {
        return baseline;
    }
    return { distribution, remainder: (target - best) / scale, exact: best === target, optimized: true };
};
module.exports = { solveCash };
