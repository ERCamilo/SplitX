const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');

describe('index.html structural & script integrity', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');

    test('every local <script src="js/..."> referenced in index.html exists on disk', () => {
        const matches = [...html.matchAll(/<script\s+[^>]*src="(js\/[^"]+)"/g)];
        assert.ok(matches.length >= 10, 'expected local JS modules in index.html');
        for (const m of matches) {
            const full = path.join(ROOT, m[1]);
            assert.ok(fs.existsSync(full), `missing script referenced in index.html: ${m[1]}`);
        }
    });

    test('inline JavaScript Logic block parses cleanly with zero syntax or duplicate-const errors', () => {
        const match = html.match(/<!-- JavaScript Logic -->\s*<script>([\s\S]*?)<\/script>/);
        assert.ok(match, 'inline JavaScript Logic script block must exist');
        assert.doesNotThrow(() => new Function(match[1]), 'inline script must parse without SyntaxError');
    });

    test('extracted catalogs and exporters are not duplicated inline in index.html', () => {
        const match = html.match(/<!-- JavaScript Logic -->\s*<script>([\s\S]*?)<\/script>/);
        const body = match ? match[1] : '';
        assert.equal((body.match(/\bconst\s+DEFAULT_BILL_IMAGES\b/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+CURRENCY_PRESETS\b/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+BILL_COLORS\b/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+exportToPDF\s*=/g) || []).length, 0);
    });

    test('index.html does not block initial <head> load with xlsx or jspdf CDNs', () => {
        const head = html.slice(0, html.indexOf('</head>'));
        assert.equal(/xlsx\.full\.min\.js/.test(head), false, 'xlsx must be lazy-loaded');
        assert.equal(/jspdf\.umd\.min\.js/.test(head), false, 'jspdf must be lazy-loaded');
    });
});
