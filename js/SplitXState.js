/**
 * SplitXState.js
 * Carga resiliente del estado persistido (Split_data).
 */
(function (root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXState = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Nunca lanza: un valor corrupto devuelve { ok: false, backup } para poder respaldarlo y arrancar limpio.
    const parseSavedState = (raw) => {
        if (raw === null || raw === undefined || raw === '') return { ok: true, data: null };
        try {
            const data = JSON.parse(raw);
            if (data && typeof data === 'object' && !Array.isArray(data)) return { ok: true, data };
        } catch (e) {}
        return { ok: false, data: null, backup: raw };
    };

    return { parseSavedState };
});
