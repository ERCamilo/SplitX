// @ts-check
/**
 * SplitXEarlyBoot.js
 * Instala la cola temprana de postMessage (SA -> SplitX) sin usar <script> inline (CSP estricto).
 */
(function () {
    'use strict';
    try {
        const g = /** @type {any} */ (globalThis);
        if (g.SplitXBridge && typeof g.SplitXBridge.installEarlyQueue === 'function') {
            g.SplitXBridge.installEarlyQueue(g);
        }
    } catch (e) {
        console.warn('SplitX: cola temprana no disponible', e);
    }
})();
