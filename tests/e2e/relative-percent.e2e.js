const {test,describe} = require('node:test');
const assert = require('node:assert/strict');
const {openStudio}=require('./helpers.js');

const actualPreview = page=>page.locator('#ssVarPreviewValue').textContent();
const localized = (page,value)=>page.evaluate(v=>Number(v).toLocaleString('es-DO',{maximumFractionDigits:2}),value);

describe('visual percent subtraction: screenshot regression',()=>{
  test('chips (daily rate - 3%) × 26 display and save a relative 3% adjustment',async()=>{
    const {page,store,errors,close}=await openStudio(2);
    try {
      const before=await page.evaluate(()=>localStorage.getItem('Split_data'));
      await page.click('#ssVarsBtn');
      await page.fill('#ssVarLabel','Diario menos tres por ciento');
      await page.selectOption('#ssVarKind','formula');
      const palette=page.locator('#ssVarBuilderPalette');
      await palette.locator('[data-chip-op="("]').click();
      await palette.locator('[data-chip-key="dailyRate"]').click();
      await palette.locator('[data-chip-op="-"]').click();
      await page.fill('#ssVarNumberValue','3');
      await page.check('#ssVarNumberPercent');
      await page.click('#ssVarInsertNumber');
      await palette.locator('[data-chip-op=")"]').click();
      await palette.locator('[data-chip-op="*"]').click();
      await page.uncheck('#ssVarNumberPercent');
      await page.fill('#ssVarNumberValue','26');
      await page.click('#ssVarInsertNumber');

      const pieces=await page.locator('#ssVarFormulaCanvas [data-formula-token]').allTextContents();
      assert.deepEqual(pieces,['(','Sueldo por día','−','3%',')','×','26']);
      assert.equal((await actualPreview(page)).trim(),await localized(page,25220));
      await page.click('[data-act="vars-save"]');
      const variable=(await store()).variables.find(v=>v.label==='Diario menos tres por ciento');
      assert.ok(variable);
      assert.match(variable.formula,/dailyRate\s*-\s*3%/);
      assert.equal(await page.evaluate(()=>localStorage.getItem('Split_data')),before);
      await page.reload({waitUntil:'load'});
      await page.evaluate(()=>window.app.openSheetStudio());
      await page.click('#ssVarsBtn');
      await page.click('[data-act="vars-edit"][data-v="diario_menos_tres_por_ciento"]');
      assert.equal(await page.locator('#ssVarFormulaCanvas [data-formula-token]').count(),7);
      assert.equal((await actualPreview(page)).trim(),await localized(page,25220));
      assert.deepEqual(errors,[]);
    }finally{await close();}
  });

  test('advanced text and visual chips agree on relative subtraction and multiplication',async()=>{
    const {page,errors,close}=await openStudio(1);
    try{
      await page.click('#ssVarsBtn');
      await page.fill('#ssVarLabel','Comparación de porcentaje');
      await page.selectOption('#ssVarKind','formula');
      await page.click('#ssVarModeText');
      await page.fill('#ssVarFormula','(dailyRate - 3%) * 26');
      assert.equal((await actualPreview(page)).trim(),await localized(page,25220));
      await page.click('#ssVarModeVisual');
      assert.equal(await page.locator('#ssVarFormulaCanvas [data-formula-token]').count(),7);
      assert.equal((await actualPreview(page)).trim(),await localized(page,25220));
      await page.click('#ssVarModeText');
      await page.fill('#ssVarFormula','dailyRate * 3%');
      assert.equal((await actualPreview(page)).trim(),await localized(page,30));
      assert.deepEqual(errors,[]);
    }finally{await close();}
  });
});
