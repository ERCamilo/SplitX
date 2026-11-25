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

    test('extracted catalogs, dialogs, cards and exporters are not duplicated inline in index.html', () => {
        const match = html.match(/<!-- JavaScript Logic -->\s*<script>([\s\S]*?)<\/script>/);
        const body = match ? match[1] : '';
        assert.equal((body.match(/\bconst\s+DEFAULT_BILL_IMAGES\b/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+CURRENCY_PRESETS\b/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+BILL_COLORS\b/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+exportToPDF\s*=/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+showCustomDialog\s*=/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+buildEmployeeCardElement\s*=/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+generateSmartAdvisorData\s*=/g) || []).length, 0);
    });

    test('index.html does not block initial <head> load with xlsx or jspdf CDNs', () => {
        const head = html.slice(0, html.indexOf('</head>'));
        assert.equal(/xlsx\.full\.min\.js/.test(head), false, 'xlsx must be lazy-loaded');
        assert.equal(/jspdf\.umd\.min\.js/.test(head), false, 'jspdf must be lazy-loaded');
    });

    test('history modal actions use delegated data-history-action instead of inline onclick interpolation', () => {
        assert.equal(/onclick="app\.(loadHistoryEntry|deleteHistoryEntry)\(/.test(html), false, 'must not interpolate entry.id into inline onclick');
        assert.match(html, /data-history-action="load"/);
        assert.match(html, /data-history-action="delete"/);
    });

    test('external pinned CDN resources enforce SRI (sha384), crossorigin=anonymous and referrerpolicy=no-referrer', () => {
        const head = html.slice(0, html.indexOf('</head>'));
        assert.match(head, /<meta\s+name="referrer"\s+content="strict-origin-when-cross-origin"/i);
        const faTag = head.match(/<link[^>]*font-awesome\/6\.4\.0\/css\/all\.min\.css[^>]*>/i);
        assert.ok(faTag, 'font-awesome stylesheet link must exist');
        assert.match(faTag[0], /integrity="sha384-[A-Za-z0-9+/=]+"/);
        assert.match(faTag[0], /crossorigin="anonymous"/);
        assert.match(faTag[0], /referrerpolicy="no-referrer"/);

        const exportJs = fs.readFileSync(path.join(ROOT, 'js', 'SplitXExport.js'), 'utf8');
        assert.equal((exportJs.match(/sha384-[A-Za-z0-9+/=]{60,}/g) || []).length, 3, 'xlsx, jspdf, and jspdf-autotable must all declare sha384 SRI');
        assert.match(exportJs, /script\.referrerPolicy\s*=\s*'no-referrer'/);

        const docStudioJs = fs.readFileSync(path.join(ROOT, 'js', 'DocumentStudio.js'), 'utf8');
        assert.match(docStudioJs, /sha384-[A-Za-z0-9+/=]{60,}/, 'mammoth script must declare sha384 SRI');
        assert.match(docStudioJs, /script\.crossOrigin\s*=\s*'anonymous'/);
        assert.match(docStudioJs, /script\.referrerPolicy\s*=\s*'no-referrer'/);
    });

    test('scrollbar CSS uses standard scrollbar-color/scrollbar-width with @supports fallback', () => {
        assert.match(html, /scrollbar-color:\s*var\(--scrollbar-thumb\)\s+var\(--scrollbar-track\)/);
        assert.match(html, /scrollbar-width:\s*thin/);
        assert.match(html, /@supports\s+not\s+\(scrollbar-color:\s*auto\)/);
    });

    test('CI test workflow declares explicit least-privilege permissions', () => {
        const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
        assert.match(workflow, /^permissions:\s*\r?\n\s+contents:\s*read/m);
    });

    test('index.html uses compiled local css/tailwind.css instead of runtime Tailwind Play CDN (#28)', () => {
        const head = html.slice(0, html.indexOf('</head>'));
        assert.equal(/cdn\.tailwindcss\.com/.test(head), false, 'Tailwind Play CDN must not be used in production');
        assert.equal(/\btailwind\.config\s*=/.test(head), false, 'runtime tailwind.config script should be removed');
        assert.match(head, /<link\s+rel="stylesheet"\s+href="css\/tailwind\.css">/);

        const cssPath = path.join(ROOT, 'css', 'tailwind.css');
        assert.ok(fs.existsSync(cssPath), 'compiled css/tailwind.css must exist');
        const css = fs.readFileSync(cssPath, 'utf8');
        assert.ok(css.length > 10000, 'compiled css/tailwind.css must contain compiled utilities');
        assert.match(css, /\.flex\b/);
        assert.match(css, /\.hidden\b/);
        assert.match(css, /\.font-mono\b/);
        assert.match(css, /\.dark\\:bg-slate-900:is\(\.dark \*\)/);

        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        assert.ok(typeof pkg.scripts?.['build:css'] === 'string' && pkg.scripts['build:css'].includes('tailwindcss'), 'package.json must expose build:css script');
    });

    test('index.html handles corrupt-backup persistence failure and exposes download/discard controls (#9)', () => {
        assert.match(html, /SplitXState\.loadOrRecoverState\(/);
        assert.match(html, /id="opCorruptBackupCard"/);
        assert.match(html, /app\.downloadCorruptBackup\(\)/);
        assert.match(html, /app\.discardCorruptBackup\(\)/);
    });
});
