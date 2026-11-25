// @ts-check
/**
 * SplitXCurrencies.js
 * Catálogo de monedas, estilos seguros de billetes/monedas, sanitización HTML/CSS
 * y compresión de imágenes personalizadas para no agotar la cuota de localStorage.
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXCurrencies = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /** @type {Record<string, Record<number, string>>} */
    const DEFAULT_BILL_IMAGES = {
        DOP: {
            2000: 'imagenes/DOP/billetes/2000pesos.jpg',
            1000: 'imagenes/DOP/billetes/1000pesos.jpg',
            500:  'imagenes/DOP/billetes/500pesos.jpg',
            200:  'imagenes/DOP/billetes/200pesos.jpg',
            100:  'imagenes/DOP/billetes/100pesos.jpg',
            50:   'imagenes/DOP/billetes/50pesos.jpg',
            25:   'imagenes/DOP/monedas/25pesos.jpg',
            10:   'imagenes/DOP/monedas/10pesos.jpg',
            5:    'imagenes/DOP/monedas/5pesos.jpg',
            1:    'imagenes/DOP/monedas/1peso.jpg'
        }
    };

    /**
     * @typedef {{
     *   code: string, flag: string, name: string, currencyName: string, symbol: string,
     *   denominations: number[], coinDenoms: number[],
     *   images?: Record<number, string>,
     *   colors?: Record<number, string>
     * }} CurrencyPreset
     */

    /** @type {Record<string, CurrencyPreset>} */
    const CURRENCY_PRESETS = {
        DOP: {
            code: 'DOP', flag: '🇩🇴', name: 'Rep. Dominicana', currencyName: 'Peso Dominicano', symbol: 'RD$',
            denominations: [2000, 1000, 500, 200, 100, 50, 25, 10, 5, 1],
            coinDenoms: [25, 10, 5, 1],
            images: { ...DEFAULT_BILL_IMAGES.DOP },
            colors: { 2000: '#4A90E2', 1000: '#E05A6D', 500: '#26A69A', 200: '#D81B60', 100: '#F57C00', 50: '#8E44AD', 25: '#b8952a', 10: '#607d8b', 5: '#8d6e63', 1: '#a0784c' }
        },
        USD: {
            code: 'USD', flag: '🇺🇸', name: 'EE.UU. / Dólar Global', currencyName: 'Dólar Estadounidense', symbol: '$',
            denominations: [100, 50, 20, 10, 5, 2, 1, 0.25, 0.10, 0.05, 0.01],
            coinDenoms: [1, 0.25, 0.10, 0.05, 0.01],
            colors: { 100: '#14532d', 50: '#166534', 20: '#15803d', 10: '#16a34a', 5: '#22c55e', 2: '#4ade80', 1: '#86efac', 0.25: '#94a3b8', 0.10: '#cbd5e1', 0.05: '#cbd5e1', 0.01: '#b45309' }
        },
        EUR: {
            code: 'EUR', flag: '🇪🇺', name: 'Zona Euro', currencyName: 'Euro', symbol: '€',
            denominations: [200, 100, 50, 20, 10, 5, 2, 1, 0.50, 0.20, 0.10, 0.05],
            coinDenoms: [2, 1, 0.50, 0.20, 0.10, 0.05],
            colors: { 200: '#ca8a04', 100: '#15803d', 50: '#ea580c', 20: '#1d4ed8', 10: '#dc2626', 5: '#64748b', 2: '#b45309', 1: '#d97706', 0.50: '#eab308', 0.20: '#eab308', 0.10: '#eab308', 0.05: '#b45309' }
        },
        MXN: {
            code: 'MXN', flag: '🇲🇽', name: 'México', currencyName: 'Peso Mexicano', symbol: '$',
            denominations: [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.50],
            coinDenoms: [10, 5, 2, 1, 0.50],
            colors: { 1000: '#0369a1', 500: '#15803d', 200: '#4d7c0f', 100: '#b91c1c', 50: '#c026d3', 20: '#0284c7', 10: '#d97706', 5: '#ca8a04', 2: '#ca8a04', 1: '#ca8a04', 0.50: '#94a3b8' }
        },
        COP: {
            code: 'COP', flag: '🇨🇴', name: 'Colombia', currencyName: 'Peso Colombiano', symbol: '$',
            denominations: [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50],
            coinDenoms: [1000, 500, 200, 100, 50],
            colors: { 100000: '#1e3a8a', 50000: '#6b21a8', 20000: '#ea580c', 10000: '#be123c', 5000: '#047857', 2000: '#0284c7', 1000: '#b45309', 500: '#b45309', 200: '#64748b', 100: '#64748b', 50: '#94a3b8' }
        },
        BRL: {
            code: 'BRL', flag: '🇧🇷', name: 'Brasil', currencyName: 'Real Brasileño', symbol: 'R$',
            denominations: [200, 100, 50, 20, 10, 5, 2, 1, 0.50, 0.25, 0.10, 0.05],
            coinDenoms: [1, 0.50, 0.25, 0.10, 0.05],
            colors: { 200: '#78716c', 100: '#0284c7', 50: '#ea580c', 20: '#ca8a04', 10: '#dc2626', 5: '#7c3aed', 2: '#0d9488', 1: '#d97706', 0.50: '#94a3b8', 0.25: '#b45309', 0.10: '#b45309', 0.05: '#b45309' }
        },
        CLP: {
            code: 'CLP', flag: '🇨🇱', name: 'Chile', currencyName: 'Peso Chileno', symbol: '$',
            denominations: [20000, 10000, 5000, 2000, 1000, 500, 100, 50, 10],
            coinDenoms: [500, 100, 50, 10],
            colors: { 20000: '#ea580c', 10000: '#0284c7', 5000: '#be123c', 2000: '#7c3aed', 1000: '#15803d', 500: '#b45309', 100: '#ca8a04', 50: '#ca8a04', 10: '#94a3b8' }
        },
        PEN: {
            code: 'PEN', flag: '🇵🇪', name: 'Perú', currencyName: 'Sol Peruano', symbol: 'S/',
            denominations: [200, 100, 50, 20, 10, 5, 2, 1, 0.50, 0.20, 0.10],
            coinDenoms: [5, 2, 1, 0.50, 0.20, 0.10],
            colors: { 200: '#7e22ce', 100: '#0284c7', 50: '#991b1b', 20: '#ea580c', 10: '#15803d', 5: '#b45309', 2: '#ca8a04', 1: '#ca8a04', 0.50: '#94a3b8', 0.20: '#94a3b8', 0.10: '#94a3b8' }
        },
        ARS: {
            code: 'ARS', flag: '🇦🇷', name: 'Argentina', currencyName: 'Peso Argentino', symbol: '$',
            denominations: [20000, 10000, 2000, 1000, 500, 200, 100],
            coinDenoms: [100],
            colors: { 20000: '#1e3a8a', 10000: '#0369a1', 2000: '#0f766e', 1000: '#ea580c', 500: '#15803d', 200: '#0284c7', 100: '#7c3aed' }
        },
        RUB: {
            code: 'RUB', flag: '🇷🇺', name: 'Rusia', currencyName: 'Rublo Ruso', symbol: '₽',
            denominations: [5000, 2000, 1000, 500, 200, 100, 50, 10, 5, 2, 1],
            coinDenoms: [10, 5, 2, 1],
            colors: { 5000: '#b91c1c', 2000: '#1d4ed8', 1000: '#047857', 500: '#7c3aed', 200: '#16a34a', 100: '#ea580c', 50: '#0284c7', 10: '#b45309', 5: '#ca8a04', 2: '#94a3b8', 1: '#94a3b8' }
        },
        JPY: {
            code: 'JPY', flag: '🇯🇵', name: 'Japón', currencyName: 'Yen Japonés', symbol: '¥',
            denominations: [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1],
            coinDenoms: [500, 100, 50, 10, 5, 1],
            colors: { 10000: '#78716c', 5000: '#7c3aed', 2000: '#15803d', 1000: '#0284c7', 500: '#ca8a04', 100: '#94a3b8', 50: '#94a3b8', 10: '#b45309', 5: '#ca8a04', 1: '#cbd5e1' }
        },
        GBP: {
            code: 'GBP', flag: '🇬🇧', name: 'Reino Unido', currencyName: 'Libra Esterlina', symbol: '£',
            denominations: [50, 20, 10, 5, 2, 1, 0.50, 0.20, 0.10, 0.05, 0.02, 0.01],
            coinDenoms: [2, 1, 0.50, 0.20, 0.10, 0.05, 0.02, 0.01],
            colors: { 50: '#b91c1c', 20: '#6b21a8', 10: '#ea580c', 5: '#0284c7', 2: '#b45309', 1: '#ca8a04', 0.50: '#94a3b8', 0.20: '#94a3b8', 0.10: '#94a3b8', 0.05: '#94a3b8', 0.02: '#b45309', 0.01: '#b45309' }
        },
        CHF: {
            code: 'CHF', flag: '🇨🇭', name: 'Suiza', currencyName: 'Franco Suizo', symbol: 'CHF',
            denominations: [1000, 200, 100, 50, 20, 10, 5, 2, 1, 0.50, 0.20, 0.10, 0.05],
            coinDenoms: [5, 2, 1, 0.50, 0.20, 0.10, 0.05],
            colors: { 1000: '#7c3aed', 200: '#78716c', 100: '#0284c7', 50: '#16a34a', 20: '#dc2626', 10: '#ca8a04', 5: '#94a3b8', 2: '#94a3b8', 1: '#94a3b8', 0.50: '#94a3b8', 0.20: '#ca8a04', 0.10: '#ca8a04', 0.05: '#ca8a04' }
        },
        INR: {
            code: 'INR', flag: '🇮🇳', name: 'India', currencyName: 'Rupia India', symbol: '₹',
            denominations: [500, 200, 100, 50, 20, 10, 5, 2, 1],
            coinDenoms: [20, 10, 5, 2, 1],
            colors: { 500: '#78716c', 200: '#ea580c', 100: '#6366f1', 50: '#06b6d4', 20: '#ca8a04', 10: '#78350f', 5: '#ca8a04', 2: '#94a3b8', 1: '#94a3b8' }
        },
        PHP: {
            code: 'PHP', flag: '🇵🇭', name: 'Filipinas', currencyName: 'Peso Filipino', symbol: '₱',
            denominations: [1000, 500, 200, 100, 50, 20, 10, 5, 1],
            coinDenoms: [20, 10, 5, 1],
            colors: { 1000: '#0284c7', 500: '#ca8a04', 200: '#15803d', 100: '#7c3aed', 50: '#dc2626', 20: '#ea580c', 10: '#94a3b8', 5: '#94a3b8', 1: '#94a3b8' }
        }
    };

    /** @type {Record<number, { bg: string, darkText: string, text: string, border: string }>} */
    const BILL_COLORS = {
        2000: { bg: '#4A90E2', darkText: '#0d3880', text: '#ffffff', border: '#2563eb' },
        1000: { bg: '#E05A6D', darkText: '#7f1d1d', text: '#ffffff', border: '#e11d48' },
        500:  { bg: '#26A69A', darkText: '#064e3b', text: '#ffffff', border: '#0d9488' },
        200:  { bg: '#D81B60', darkText: '#701a75', text: '#ffffff', border: '#c026d3' },
        100:  { bg: '#F57C00', darkText: '#7c2d12', text: '#ffffff', border: '#ea580c' },
        50:   { bg: '#8E44AD', darkText: '#581c87', text: '#ffffff', border: '#9333ea' },
        20:   { bg: '#7a5c38', darkText: '#451a03', text: '#ffffff', border: '#78350f' },
        25:   { bg: '#b8952a', darkText: '#5c4709', text: '#ffffff', border: '#8f7020' },
        10:   { bg: '#607d8b', darkText: '#1e293b', text: '#ffffff', border: '#455a64' },
        5:    { bg: '#8d6e63', darkText: '#3e2723', text: '#ffffff', border: '#6d4c41' },
        1:    { bg: '#a0784c', darkText: '#4e342e', text: '#ffffff', border: '#7d5c38' }
    };

    const SAFE_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    const SAFE_RASTER_DATA_URI = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;
    const SAFE_LOCAL_IMG_PATH = /^imagenes\/[A-Za-z0-9_/-]+\.(?:jpg|jpeg|png|webp|gif)$/i;
    const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

    /** @param {unknown} value */
    const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => (/** @type {Record<string, string>} */ ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }))[ch]);

    /** @param {unknown} sym */
    const sanitizeCurrencySymbol = (sym) => {
        const cleaned = String(sym ?? '').replace(/[\u0000-\u001f\u007f<>'"`]/g, '').trim().slice(0, 10);
        return cleaned || '$';
    };

    /** @param {unknown} color @param {string} [fallback] */
    const sanitizeHexColor = (color, fallback = '') => {
        if (typeof color !== 'string') return fallback;
        const trimmed = color.trim();
        return SAFE_HEX.test(trimmed) ? trimmed : fallback;
    };

    /** @param {unknown} src */
    const isSafeBillImage = (src) => {
        if (typeof src !== 'string' || src.length > 200000) return false;
        return SAFE_LOCAL_IMG_PATH.test(src) || SAFE_RASTER_DATA_URI.test(src);
    };

    /** @param {string} hex @param {number} [factor] */
    const darkenHex = (hex, factor = 0.42) => {
        const safe = sanitizeHexColor(hex);
        if (!safe) return '#0f172a';
        let c = safe.slice(1);
        if (c.length === 3) c = c.split('').map(x => x + x).join('');
        const num = parseInt(c, 16);
        const r = Math.max(0, Math.floor(((num >> 16) & 255) * factor));
        const g = Math.max(0, Math.floor(((num >> 8) & 255) * factor));
        const b = Math.max(0, Math.floor((num & 255) * factor));
        return `rgb(${r}, ${g}, ${b})`;
    };

    /** @param {any} state @param {number} denom @param {string} baseBgColor */
    const getChipTextColor = (state, denom, baseBgColor) => {
        const mode = state?.chipTextColor || 'dark_tone';
        if (mode === 'black') return '#0f172a';
        if (mode === 'white') return '#ffffff';
        if (BILL_COLORS[denom]?.darkText) return BILL_COLORS[denom].darkText;
        return darkenHex(baseBgColor || '#475569', 0.42);
    };

    /** @param {any} state @param {number} denom @returns {string | null} */
    const getBillImage = (state, denom) => {
        const custom = state?.billImages?.[denom];
        if (custom && isSafeBillImage(custom)) return custom;
        if (state?.useDefaultImages !== false) {
            const curr = state?.currency || 'DOP';
            const preset = CURRENCY_PRESETS[curr];
            const presetImg = preset?.images?.[denom] || DEFAULT_BILL_IMAGES[curr]?.[denom];
            if (presetImg && isSafeBillImage(presetImg)) return presetImg;
        }
        return null;
    };

    /** @param {any} state @param {number} denom */
    const getBillStyle = (state, denom) => {
        const img = getBillImage(state, denom);
        const customColor = sanitizeHexColor(state?.billColors?.[denom]);
        if (img) {
            const border = customColor || BILL_COLORS[denom]?.border || '#555';
            return `background-image:url('${img}');background-size:cover;background-position:center;color:#fff;border-color:${border};text-shadow:0 1px 3px rgba(0,0,0,0.75);`;
        }
        if (customColor) {
            const textColor = getChipTextColor(state, denom, customColor);
            return `background-color:${customColor};color:${textColor};border-color:${customColor};border-width:1.5px;`;
        }
        const curr = state?.currency || 'DOP';
        const presetHex = sanitizeHexColor(CURRENCY_PRESETS[curr]?.colors?.[denom]);
        const baseBg = presetHex || BILL_COLORS[denom]?.bg || '#e2e8f0';
        const border = BILL_COLORS[denom]?.border || presetHex || '#cbd5e1';
        const textColor = getChipTextColor(state, denom, baseBg);
        return `background-color:${baseBg};color:${textColor};border-color:${border};border-width:1.5px;`;
    };

    /**
     * Valida y redimensiona una imagen subida para evitar agotar localStorage.
     * @param {File} file
     * @param {{ maxFileBytes?: number, maxWidth?: number, maxHeight?: number, quality?: number }} [opts]
     * @returns {Promise<string>}
     */
    const compressBillImageFile = (file, opts = {}) => new Promise((resolve, reject) => {
        const maxFileBytes = opts.maxFileBytes ?? 5 * 1024 * 1024;
        const maxWidth = opts.maxWidth ?? 200;
        const maxHeight = opts.maxHeight ?? 120;
        const quality = opts.quality ?? 0.78;

        if (!file || !ALLOWED_IMAGE_MIMES.has(file.type)) {
            reject(new Error('Formato no admitido. Usa PNG, JPG o WebP (no SVG).'));
            return;
        }
        if (file.size > maxFileBytes) {
            reject(new Error('La imagen supera el límite de 5 MB.'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
        reader.onload = () => {
            const rawDataUrl = String(reader.result || '');
            const img = new Image();
            img.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
            img.onload = () => {
                const scale = Math.min(1, maxWidth / (img.width || maxWidth), maxHeight / (img.height || maxHeight));
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) { reject(new Error('No se pudo procesar la imagen.')); return; }
                ctx.drawImage(img, 0, 0, w, h);
                const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                let out = canvas.toDataURL(mime, quality);
                if (out.length > 90000) out = canvas.toDataURL('image/jpeg', 0.65);
                if (!isSafeBillImage(out)) {
                    reject(new Error('La imagen comprimida excede el tamaño seguro permitido.'));
                    return;
                }
                resolve(out);
            };
            img.src = rawDataUrl;
        };
        reader.readAsDataURL(file);
    });

    return {
        DEFAULT_BILL_IMAGES,
        CURRENCY_PRESETS,
        BILL_COLORS,
        escapeHTML,
        sanitizeCurrencySymbol,
        sanitizeHexColor,
        isSafeBillImage,
        darkenHex,
        getChipTextColor,
        getBillImage,
        getBillStyle,
        compressBillImageFile
    };
});
