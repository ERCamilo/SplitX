const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { openStudio } = require('./helpers.js');

const payroll = page => page.evaluate(() => localStorage.getItem('Split_data'));
const goSignatures = page => page.click('[data-act="sheet"][data-v="B"]');

describe('signature table offers the same visual reusable formula tools as envelope cards', () => {
    test('numeric signature column can save its existing chip formula without changing the payroll', async () => {
        const {page,store,errors,close} = await openStudio(3);
        try {
            const before = await payroll(page);
            await goSignatures(page);
            assert.equal(await page.locator('#ssVarsBarBtn').isVisible(),true);
            await page.locator('#ssCanvas [data-zone="B:col:5"]').first().click();
            assert.equal(await page.locator('#ssSaveCellAsVariable').isVisible(),true,
                'numeric signature columns must offer the same action as envelope cells');
            await page.click('#ssSaveCellAsVariable');
            assert.equal(await page.locator('#ssVarFormulaCanvas').isVisible(),true);
            assert.equal(await page.locator('#ssVarFormulaCanvas [data-formula-token]').count(),3);
            await page.fill('#ssVarLabel','Bruto más bonos');
            await page.click('[data-act="vars-save"]');
            const saved = await store();
            const variable = saved.variables.find(v=>v.label==='Bruto más bonos');
            assert.ok(variable?.kind==='formula');
            assert.equal(variable.formula.replace(/\s+/g,' ').trim(),'gross + bonuses');
            assert.ok(saved.templates.find(t=>t.id===saved.active.B).template.columns[5].cell.chips.some(
                c=>c.kind==='field' && c.key==='gross'),
                'saving a formula must not replace the original column');
            assert.match(await page.locator('#ssPalette').textContent(),/Bruto más bonos/);
            assert.equal(await payroll(page),before);
            assert.deepEqual(errors,[]);
        } finally { await close(); }
    });

    test('manager is directly accessible in signatures and creates visual formulas for signature columns', async () => {
        const {page,store,errors,close} = await openStudio(2);
        try {
            await goSignatures(page);
            const original = await payroll(page);
            await page.click('#ssVarsBarBtn');
            await page.fill('#ssVarLabel','Cinco por ciento bruto');
            await page.selectOption('#ssVarKind','formula');
            assert.equal(await page.locator('#ssVarFormulaCanvas').isVisible(),true);
            await page.locator('#ssVarBuilderPalette [data-chip-key="gross"]').click();
            await page.locator('#ssVarBuilderPalette [data-chip-op="*"]').click();
            await page.fill('#ssVarNumberValue','5');
            await page.check('#ssVarNumberPercent');
            await page.click('#ssVarInsertNumber');
            await page.click('[data-act="vars-save"]');
            const vars=(await store()).variables;
            const created=vars.find(v=>v.label==='Cinco por ciento bruto');
            assert.ok(created,'the custom formula is stored while the signature tab is open');
            assert.equal(created.formula.replace(/\s+/g,''),'gross*5%');
            assert.match(await page.locator('#ssPalette').textContent(),/Cinco por ciento bruto/);
            const values=await page.evaluate(id=>{
                const employees=JSON.parse(localStorage.getItem('Split_data')).employees;
                const defs=JSON.parse(localStorage.getItem('Split_sheets_v2')).variables;
                const source=window.SplitXSheetFields.createFieldSet({records:employees});
                const custom=window.SplitXVariables.createFieldSet(defs,source,window.SheetBuilder);
                const engine=window.SheetBuilder.createEngine({fields:[...source.fields,...custom.fields],resolveField:source.resolveField});
                return employees.slice(0,2).map((r,i)=>engine.evaluateCell({
                    mode:'number',chips:[{kind:'field',key:'custom:'+id}]
                },r,{index:i},null).value);
            },created.id);
            assert.deepEqual(values,[500,512.5]);
            assert.equal(await payroll(page),original);
            await page.reload({waitUntil:'load'});
            await page.evaluate(()=>window.app.openSheetStudio());
            await goSignatures(page);
            assert.equal(await page.locator('#ssVarsBarBtn').isVisible(),true);
            assert.ok((await store()).variables.some(v=>v.id===created.id));
            assert.deepEqual(errors,[]);
        } finally {await close();}
    });

    test('signature-only text column does not pretend it has a numeric formula to save', async () => {
        const {page,errors,close}=await openStudio(2);
        try {
            await goSignatures(page);
            await page.locator('#ssCanvas [data-zone="B:col:7"]').first().click();
            assert.equal(await page.locator('#ssSaveCellAsVariable').count(),0);
            assert.equal(await page.locator('#ssVarsBarBtn').isVisible(),true,
                'signature column with no numeric formula can still open variable editor');
            await page.click('#ssVarsBarBtn');
            assert.equal(await page.locator('#ssVarKind').isVisible(),true);
            assert.deepEqual(errors,[]);
        } finally {await close();}
    });
});