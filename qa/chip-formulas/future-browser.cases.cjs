/**
 * RED browser contract: intended behaviors of reusable visual-chip formulas.
 * The selectors and behavior are documented in CASES.md. These tests belong
 * only to the isolated QA branch, not the production npm test:e2e command.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openStudio } = require('../../tests/e2e/helpers.js');
const assertVisible = async (page, selector, goal) => {
    assert.ok(await page.locator(selector).isVisible(),
        'PENDIENTE [constructor de chips]: '+goal+' ('+selector+')');
};
const editFormula = async (page) => {
    await page.click('#ssVarsBtn');
    await page.selectOption('#ssVarKind','formula');
};
const payroll = page => page.evaluate(() => localStorage.getItem('Split_data'));
const variable = (store,id)=>store.variables?.find(x=>x.id===id);
const createTransport = async page => {
    await page.click('#ssVarsBtn');
    await page.fill('#ssVarId','transporte');
    await page.fill('#ssVarLabel','Transporte');
    await page.fill('#ssVarValue','250');
    await page.click('[data-act="vars-save"]');
};

test('C02: visual editor is the default, displaying human names rather than internal IDs',async()=>{
    const {page,close}=await openStudio(2);
    try{
        await editFormula(page);
        await assertVisible(page,'#ssVarModeVisual','selección de modo visual por defecto');
        await assertVisible(page,'#ssVarFormulaCanvas','lienzo de fórmula creado con los chips existentes');
        await assertVisible(page,'#ssVarBuilderPalette [data-chip-key="gross"]','chip de Sueldo bruto reutilizado en el modal');
        assert.match(await page.locator('#ssVarBuilderPalette [data-chip-key="gross"]').textContent(),/bruto/i);
        assert.equal(await page.locator('#ssVarFormula').isVisible(),false,'los identificadores se ocultan en modo visual');
    }finally{await close();}
});

test('C06: dragging imported field and operator builds an ordered visual expression',async()=>{
    const {page,close,store}=await openStudio(2);
    try{
        await editFormula(page);
        await assertVisible(page,'#ssVarFormulaCanvas','zona de soltar');
        const palette=page.locator('#ssVarBuilderPalette'),canvas=page.locator('#ssVarFormulaCanvas');
        await palette.locator('[data-chip-key="gross"]').dragTo(canvas);
        await palette.locator('[data-chip-op="*"]').dragTo(canvas);
        await page.fill('#ssVarNumberValue','5');
        await page.check('#ssVarNumberPercent');
        await page.click('#ssVarInsertNumber');
        await page.fill('#ssVarLabel','Bono de prueba'); // El ID debe generarse automáticamente.
        await page.click('[data-act="vars-save"]');
        const defs=(await store()).variables;
        const created=defs.find(d=>d.label==='Bono de prueba');
        assert.ok(created,'la variable se guarda por nombre, sin pedir un ID técnico');
        assert.match(created.formula,/gross\s*\*\s*5%/);
    }finally{await close();}
});

test('C06/C12: reorder or remove a chip via pointer and keyboard, not by rewriting text',async()=>{
    const {page,close}=await openStudio(2);
    try{
        await editFormula(page);
        await assertVisible(page,'#ssVarFormulaCanvas','zona visual');
        const palette=page.locator('#ssVarBuilderPalette'),canvas=page.locator('#ssVarFormulaCanvas');
        await palette.locator('[data-chip-key="gross"]').click();
        await palette.locator('[data-chip-op="+"]').click();
        await page.fill('#ssVarNumberValue','10');
        await page.click('#ssVarInsertNumber');
        assert.equal(await canvas.locator('[data-formula-token]').count(),3);
        await canvas.locator('[data-formula-token]').last().dragTo(canvas.locator('[data-formula-token]').first());
        assert.match((await canvas.textContent()),/10.*bruto/i);
        await canvas.locator('[data-formula-token]').first().focus();
        await page.keyboard.press('Delete');
        assert.equal(await canvas.locator('[data-formula-token]').count(),2);
    }finally{await close();}
});

test('C10: switching visual -> advanced text -> visual preserves the expression',async()=>{
    const {page,close,store}=await openStudio(2);
    try{
        await createTransport(page);
        await editFormula(page);
        await assertVisible(page,'#ssVarModeText','botón explícito de edición avanzada');
        await page.click('#ssVarModeText');
        await page.fill('#ssVarFormula','gross * 5% + transporte');
        await page.click('#ssVarModeVisual');
        await assertVisible(page,'#ssVarFormulaCanvas [data-formula-token]','texto convertido en chips');
        assert.equal(await page.locator('#ssVarFormulaCanvas [data-formula-token]').count(),5);
        await page.click('#ssVarModeText');
        assert.equal(await page.inputValue('#ssVarFormula'),'gross * 5% + transporte');
        await page.fill('#ssVarLabel','Pago extra');
        await page.click('[data-act="vars-save"]');
        assert.equal(variable(await store(),'pago_extra')?.formula,'gross * 5% + transporte');
    }finally{await close();}
});

test('C09: preview uses actual employee payroll and an override without changing SA data',async()=>{
    const {page,close,store}=await openStudio(2);
    try{
        await createTransport(page);
        await page.click('#ssVarsBtn');
        await page.click('[data-act="vars-edit"][data-v="transporte"]');
        await page.selectOption('#ssVarEmployee','001');
        await page.fill('#ssVarOverride','400');
        await page.click('[data-act="vars-save"]');
        const before=await payroll(page);
        await editFormula(page);
        await page.click('#ssVarModeText');
        await page.fill('#ssVarFormula','gross * 5% + transporte');
        await page.click('#ssVarModeVisual');
        await assertVisible(page,'#ssVarPreviewEmployee','lista de empleados de muestra');
        await page.selectOption('#ssVarPreviewEmployee','001');
        assert.match(await page.textContent('#ssVarPreviewValue'),/900([.,]00)?/);
        await page.selectOption('#ssVarPreviewEmployee','002');
        assert.match(await page.textContent('#ssVarPreviewValue'),/762([.,]50|\.5)/);
        assert.equal(await payroll(page),before,'ninguna vista previa escribe la nómina original');
        assert.ok((await store()).variables.length>=1);
    }finally{await close();}
});

test('C08/C16: save a formula already present in a card as a reusable chip',async()=>{
    const {page,close,store}=await openStudio(2);
    try{
        const before=await payroll(page);
        await page.locator('#ssCardEdit [data-zone="A:1:1"]').click();
        await assertVisible(page,'#ssSaveCellAsVariable','acción guardar cálculo de la celda');
        await page.click('#ssSaveCellAsVariable');
        await page.fill('#ssVarLabel','Monto para tarjeta');
        await page.click('[data-act="vars-save"]');
        const v=(await store()).variables.find(d=>d.label==='Monto para tarjeta');
        assert.ok(v?.kind==='formula','el cálculo de la celda se convierte a variable');
        assert.match(await page.textContent('#ssPalette'),/Monto para tarjeta/);
        assert.equal(before,await payroll(page));
    }finally{await close();}
});

test('C05/C17: wrong text keeps existing valid formula unchanged and shows precise errors',async()=>{
    const {page,close,store}=await openStudio(2);
    try{
        await page.click('#ssVarsBtn');
        await page.fill('#ssVarId','extra');
        await page.fill('#ssVarLabel','Extra');
        await page.selectOption('#ssVarKind','formula');
        await page.fill('#ssVarFormula','gross * 5%');
        await page.click('[data-act="vars-save"]');
        await page.click('#ssVarsBtn');
        await page.click('[data-act="vars-edit"][data-v="extra"]');
        await assertVisible(page,'#ssVarModeText','cambiar a edición avanzada');
        await page.click('#ssVarModeText');
        await page.fill('#ssVarFormula','gross + campo_desconocido');
        await page.click('[data-act="vars-save"]');
        assert.match(await page.textContent('#ssVarsMsg'),/campo|no encontrado/i);
        assert.equal(variable(await store(),'extra').formula,'gross * 5%');
        assert.equal(await page.inputValue('#ssVarFormula'),'gross + campo_desconocido',
            'no borrar el texto que debe corregirse');
    }finally{await close();}
});

test('C11: autocompletion displays Spanish labels and inserts the correct underlying field',async()=>{
    const {page,close}=await openStudio(2);
    try{
        await editFormula(page);
        await assertVisible(page,'#ssVarModeText','modo avanzado');
        await page.click('#ssVarModeText');
        await page.fill('#ssVarFormula','bru');
        await assertVisible(page,'#ssVarFormulaSuggestions','sugerencias disponibles');
        assert.match(await page.textContent('#ssVarFormulaSuggestions'),/Bruto/i);
        await page.locator('#ssVarFormulaSuggestions [data-chip-key="gross"]').click();
        assert.equal(await page.inputValue('#ssVarFormula'),'gross');
    }finally{await close();}
});

test('C07: on mobile, tapping chips builds a formula without drag-and-drop',async()=>{
    const original=await openStudio(2);
    const browser=original.page.context().browser();
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    try{
        const page=await context.newPage();
        const url=original.page.url(),origin=new URL(url).origin;
        const imported=await payroll(original.page);
        await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
        await page.goto(url,{waitUntil:'load'});
        await page.evaluate(data=>{
            localStorage.clear();
            localStorage.setItem('Split_data',data);
            localStorage.setItem('Split_sheets_v2',JSON.stringify({tourDone:true}));
        },imported);
        await page.reload({waitUntil:'load'});
        await page.evaluate(()=>window.app.openSheetStudio());
        await page.tap('#ssVarsBtn');
        await page.selectOption('#ssVarKind','formula');
        await assertVisible(page,'#ssVarFormulaCanvas','constructor táctil de fórmulas');
        await page.locator('#ssVarBuilderPalette [data-chip-key="gross"]').tap();
        await page.locator('#ssVarBuilderPalette [data-chip-op="+"]').tap();
        await page.fill('#ssVarNumberValue','100');
        await page.locator('#ssVarInsertNumber').tap();
        assert.equal(await page.locator('#ssVarFormulaCanvas [data-formula-token]').count(),3);
        assert.ok((await page.locator('#ssVarFormulaCanvas').boundingBox()).width<390);
    }finally{await context.close();await original.close();}
});

test('C13: saved legacy formula returns as visual chips after reload',async()=>{
    const {page,close}=await openStudio(2);
    try{
        await page.click('#ssVarsBtn');
        await page.fill('#ssVarId','extra');
        await page.fill('#ssVarLabel','Extra');
        await page.selectOption('#ssVarKind','formula');
        await page.fill('#ssVarFormula','gross * 5%');
        await page.click('[data-act="vars-save"]');
        await page.reload({waitUntil:'load'});
        await page.evaluate(()=>window.app.openSheetStudio());
        await page.click('#ssVarsBtn');
        await page.click('[data-act="vars-edit"][data-v="extra"]');
        await assertVisible(page,'#ssVarFormulaCanvas [data-formula-token]','fórmula antigua convertida visualmente');
        assert.equal(await page.locator('#ssVarFormulaCanvas [data-formula-token]').count(),3);
    }finally{await close();}
});
