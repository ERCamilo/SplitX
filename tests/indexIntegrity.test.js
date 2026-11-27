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

    test('index.html has zero inline <script> blocks and js/SplitXApp.js parses cleanly (strict CSP)', () => {
        const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
        assert.equal(inlineScripts.length, 0, 'index.html must not contain inline <script> blocks');

        for (const rel of ['js/SplitXEarlyBoot.js', 'js/SplitXActionDelegation.js', 'js/SplitXApp.js']) {
            const full = path.join(ROOT, rel);
            assert.ok(fs.existsSync(full), `missing extracted script: ${rel}`);
            const code = fs.readFileSync(full, 'utf8');
            assert.doesNotThrow(() => new Function(code), `${rel} must parse without SyntaxError`);
        }
    });

    test('extracted catalogs, dialogs, cards and exporters are not duplicated in js/SplitXApp.js', () => {
        const body = fs.readFileSync(path.join(ROOT, 'js', 'SplitXApp.js'), 'utf8');
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
        const appJs = fs.readFileSync(path.join(ROOT, 'js', 'SplitXApp.js'), 'utf8');
        assert.equal(/onclick="app\.(loadHistoryEntry|deleteHistoryEntry)\(/.test(appJs), false, 'must not interpolate entry.id into inline onclick');
        assert.match(appJs, /data-history-action="load"/);
        assert.match(appJs, /data-history-action="delete"/);
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
        const appCss = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8');
        assert.match(appCss, /scrollbar-color:\s*var\(--scrollbar-thumb\)\s+var\(--scrollbar-track\)/);
        assert.match(appCss, /scrollbar-width:\s*thin/);
        assert.match(appCss, /@supports\s+not\s+\(scrollbar-color:\s*auto\)/);
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
        const appJs = fs.readFileSync(path.join(ROOT, 'js', 'SplitXApp.js'), 'utf8');
        assert.match(appJs, /SplitXState\.loadOrRecoverState\(/);
        assert.match(html, /id="opCorruptBackupCard"/);
        assert.match(html, /data-sx-click="downloadCorruptBackup"/);
        assert.match(html, /data-sx-click="discardCorruptBackup"/);
    });

    test('app CSS, ConfigUI and EditModal are extracted out of index.html (#28)', () => {
        const head = html.slice(0, html.indexOf('</head>'));
        assert.match(head, /<link\s+rel="stylesheet"\s+href="css\/app\.css">/);
        assert.ok(
            head.indexOf('css/app.css') < head.indexOf('css/tailwind.css'),
            'css/app.css must load before css/tailwind.css so Tailwind utilities like .hidden override component classes'
        );
        assert.ok(fs.existsSync(path.join(ROOT, 'css', 'app.css')), 'css/app.css must exist');
        assert.equal(/<style>[\s\S]{100,}<\/style>/.test(head), false, 'large inline <style> block must be extracted to css/app.css');

        const body = fs.readFileSync(path.join(ROOT, 'js', 'SplitXApp.js'), 'utf8');
        assert.equal((body.match(/\bconst\s+renderConfigModal\s*=/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+renderCustomBillsConfig\s*=/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+openEditModal\s*=/g) || []).length, 0);
        assert.equal((body.match(/\bconst\s+saveEmployeeModal\s*=/g) || []).length, 0);

        const jsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'jsconfig.json'), 'utf8'));
        assert.ok(jsconfig.include.includes('js/SplitXConfigUI.js'));
        assert.ok(jsconfig.include.includes('js/SplitXEditModal.js'));
        assert.ok(jsconfig.include.includes('js/SplitXActionDelegation.js'));
        assert.ok(jsconfig.include.includes('js/SplitXEarlyBoot.js'));
        assert.ok(jsconfig.include.includes('js/SheetStudioModel.js'));
        assert.ok(jsconfig.include.includes('js/SplitXVariables.js'));
        assert.ok(jsconfig.include.includes('js/SplitXFormulaBuilder.js'));
        assert.ok(jsconfig.include.includes('js/DocumentStudio.js'));
    });

    test('SheetStudioModel and css/sheet-studio.css are wired in index.html before SheetStudio.js', () => {
        const head = html.slice(0, html.indexOf('</head>'));
        assert.match(head, /<link\s+rel="stylesheet"\s+href="css\/sheet-studio\.css">/);
        assert.match(head, /<script\s+src="js\/SheetStudioModel\.js"><\/script>/);
        assert.ok(
            head.indexOf('js/SheetStudioModel.js') < head.indexOf('js/SheetStudio.js'),
            'js/SheetStudioModel.js must load before js/SheetStudio.js'
        );
    });

    test('zero inline on* HTML event handlers remain in index.html, SplitXApp.js, or SplitXConfigUI.js (strict CSP)', () => {
        const offenders = [];
        for (const rel of ['index.html', 'js/SplitXApp.js', 'js/SplitXConfigUI.js']) {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            for (const m of src.matchAll(/\bon[a-z]+\s*=\s*"[^"]*"/gi)) {
                offenders.push(`${rel}: ${m[0].slice(0, 100)}`);
            }
        }
        assert.deepEqual(offenders, [], `inline event handlers must be migrated to data-sx-* delegation:\n${offenders.join('\n')}`);
    });

    test('every icon-only button in index.html, SplitXEmployeeCard and SplitXConfigUI declares an aria-label', () => {
        const missing = [];
        for (const rel of ['index.html', 'js/SplitXEmployeeCard.js', 'js/SplitXConfigUI.js']) {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
                const attrs = m[1];
                const inner = m[2];
                if (!/fa-/.test(inner)) continue;
                const visibleText = inner
                    .replace(/<i\b[^>]*>[\s\S]*?<\/i>/gi, '')
                    .replace(/<[^>]+>/g, '')
                    .trim();
                if (!visibleText && !/\baria-label\s*=/.test(attrs)) {
                    missing.push(`${rel}: ${m[0].replace(/\s+/g, ' ').slice(0, 120)}`);
                }
            }
        }
        assert.deepEqual(missing, [], `icon-only buttons missing aria-label:\n${missing.join('\n')}`);
    });

    test('all 8 modals declare role="dialog" aria-modal="true" and Edit Modal exposes dynamic currency symbols (Sprint D)', () => {
        const modalIds = [
            'configModal', 'operationsModal', 'exportModal', 'importModal',
            'historyModal', 'postImportModal', 'customDialogModal', 'editEmployeeModal'
        ];
        for (const id of modalIds) {
            const m = html.match(new RegExp(`<div\\b[^>]*id="${id}"[^>]*>`, 'i'));
            assert.ok(m, `missing modal container #${id}`);
            assert.match(m[0], /\brole="dialog"/, `#${id} must declare role="dialog"`);
            assert.match(m[0], /\baria-modal="true"/, `#${id} must declare aria-modal="true"`);
        }
        for (const symId of ['editGrossSymbol', 'editLoansSymbol', 'editNetSymbol']) {
            assert.match(html, new RegExp(`id="${symId}"`), `Edit Modal must declare #${symId} for dynamic currency`);
        }
        const appJs = fs.readFileSync(path.join(ROOT, 'js', 'SplitXApp.js'), 'utf8');
        assert.match(appJs, /e\.key\s*[!=]==\s*'Escape'/, 'SplitXApp.js must support Escape key to close active modals');
        assert.equal(/state\.billColors\s*=\s*\{\s*\.\.\.preset\.colors,\s*\.\.\.state\.billColors\s*\}/.test(appJs), false,
            'setCurrencyPreset must not keep stale colors from previous currencies overriding new preset');
        assert.match(appJs, /lastImportAction/, 'closePostImportModal must preserve inventory on append imports');
    });

    test('index.html exposes 3-state Ledger UI: Cuadre tab, compact progress card, number toggle and status palette config', () => {
        for (const id of ['tab-cuadre', 'view-cuadre', 'cuadreTableBody', 'ledgerProgressCard', 'cardNumToggleBtn', 'statusScheme-traffic', 'statusScheme-classic']) {
            assert.match(html, new RegExp(`id="${id}"`), `missing 3-state Ledger element #${id}`);
        }
        const appJs = fs.readFileSync(path.join(ROOT, 'js', 'SplitXApp.js'), 'utf8');
        const histBlock = appJs.slice(appJs.indexOf('const loadHistoryEntry ='), appJs.indexOf('const deleteHistoryEntry ='));
        assert.match(histBlock, /lastImportAction\s*=\s*choice/, 'loadHistoryEntry must sync lastImportAction before opening postImportModal');
    });

    test('index.html exposes Sprint F payday workflow: employee search, status filters, and Cuadre net variance banner', () => {
        for (const id of ['empSearchInput', 'empFilterAll', 'empFilterPending', 'empFilterPacked', 'empFilterPaid', 'cuadreVarianceBanner']) {
            assert.match(html, new RegExp(`id="${id}"`), `missing Sprint F element #${id}`);
        }
        const appCss = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8');
        assert.match(appCss, /scroll-padding-top:\s*4\.5rem/, 'html must set scroll-padding-top for sticky header focus visibility');
        assert.match(appCss, /#panel-caja\s*\{[\s\S]*position:\s*sticky;[\s\S]*align-self:\s*flex-start;[\s\S]*100dvh/, '#panel-caja must stick on desktop with dvh max-height');
        for (const id of ['undoBtn', 'redoBtn', 'toastRegion']) {
            assert.match(html, new RegExp(`id="${id}"`), `missing Undo/Redo or toast region element #${id}`);
        }
    });
});
