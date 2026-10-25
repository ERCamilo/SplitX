/**
 * GREEN browser characterization: these interactions exist in current main.
 * Future builder work must not break them.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openStudio } = require('../../tests/e2e/helpers.js');

test('C01/C13: legacy textual formula saves, appears as chip and survives reload',async()=>{
    const {page,store,errors,close}=await openStudio(2);
    try{
        await page.click('#ssVarsBtn');
        await page.fill('#ssVarId','transporte');
        await page.fill('#ssVarLabel','Transporte');
        await page.fill('#ssVarValue','250');
        await page.click('[data-act="vars-save"]');
        await page.click('#ssVarsBtn');
        await page.fill('#ssVarId','pago_extra');
        await page.fill('#ssVarLabel','Pago extra');
        await page.selectOption('#ssVarKind','formula');
        await page.fill('#ssVarFormula','gross * 5% + transporte');
        await page.click('[data-act="vars-save"]');
        let cfg=await store();
        assert.equal(cfg.variables.find(v=>v.id==='pago_extra').formula,'gross * 5% + transporte');
        assert.match(await page.textContent('#ssPalette'),/Pago extra/);
        await page.reload({waitUntil:'load'});
        await page.evaluate(()=>window.app.openSheetStudio());
        cfg=await store();
        assert.equal(cfg.variables.find(v=>v.id==='pago_extra').formula,'gross * 5% + transporte');
        assert.deepEqual(errors,[]);
    }finally{await close();}
});

test('C06 baseline: the current palette already inserts chips into a selected card cell',async()=>{
    const {page,store,close}=await openStudio(2);
    try{
        await page.locator('#ssCardEdit [data-zone="A:1:1"]').click();
        const chip = page.locator('#ssPalette [data-pi]',{hasText:'Días trabajados'}).first();
        // Playwright.has scopes locators relative to each details element.
        const group = page.locator('#ssPalette details').filter({has:page.locator('[data-pi]',{hasText:'Días trabajados'})});
        if (!(await group.evaluate(el => el.open))) await group.locator('summary').click();
        await chip.click();
        const config=await store();
        const tpl=config.templates.find(t=>t.id===config.active.A).template;
        assert.ok(tpl.rows[1].cells[1].chips.some(ch=>ch.kind==='field'&&ch.key==='days'));
    }finally{await close();}
});
