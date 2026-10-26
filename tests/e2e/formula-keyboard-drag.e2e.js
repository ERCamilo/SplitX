const {test, describe}=require('node:test');
const assert=require('node:assert/strict');
const {openStudio}=require('./helpers.js');

const openFormula=async page=>{
    await page.click('#ssVarsBtn');
    await page.fill('#ssVarLabel','Prueba de teclado');
    await page.selectOption('#ssVarKind','formula');
    assert.equal(await page.locator('#ssVarFormulaCanvas').isVisible(),true);
};
const tokens=page=>page.locator('#ssVarFormulaCanvas [data-formula-token]').evaluateAll(items=>items.map(el=>Array.from(el.childNodes).filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('')));
const clean=t=>t.map(v=>v.trim());
const payroll=page=>page.evaluate(()=>localStorage.getItem('Split_data'));

describe('direct typing, selection and guided drag in formula chips',()=>{
    test('typing numeric digits, operators and % creates chips without the separate Add button',async()=>{
        const {page,close,store,errors}=await openStudio(2);
        try{
            const original=await payroll(page);
            await openFormula(page);
            const palette=page.locator('#ssVarBuilderPalette');
            await palette.locator('[data-chip-op="("]').click();
            await palette.locator('[data-chip-key="dailyRate"]').click();
            const input=page.locator('#ssVarInlineInput');
            await input.focus();
            await page.keyboard.type('-');
            await page.keyboard.type('3');
            assert.deepEqual(clean(await tokens(page)),['(','Sueldo por día','−','3']);
            await page.keyboard.type('%');
            await page.keyboard.type(')');
            await page.keyboard.type('*');
            await page.keyboard.type('#');
            assert.deepEqual(clean(await tokens(page)),['(','Sueldo por día','−','3%',')','×','0']);
            await page.keyboard.type('26');
            assert.deepEqual(clean(await tokens(page)),['(','Sueldo por día','−','3%',')','×','26']);
            // The test's sample payroll gives 1000 gross/day? daily rate 1000;
            // 970 × 26 = 25,220. The preview must match.
            assert.equal((await page.locator('#ssVarPreviewValue').textContent()).trim(),'25,220');
            await page.click('[data-act="vars-save"]');
            const def=(await store()).variables.find(v=>v.label==='Prueba de teclado');
            assert.ok(def?.kind==='formula');
            assert.match(def.formula,/dailyRate\s*-\s*3%/);
            assert.match(def.formula,/\*\s*26/);
            assert.equal(await payroll(page),original);
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });

    test('digits including decimals stay in a single numeric chip; keyboard operators start new chips',async()=>{
        const {page,close,errors}=await openStudio(1);
        try{
            await openFormula(page);
            await page.locator('#ssVarInlineInput').focus();
            await page.keyboard.type('12.50');
            assert.deepEqual(clean(await tokens(page)),['12.5']);
            await page.keyboard.type('+');
            await page.keyboard.type('7,25');
            assert.deepEqual(clean(await tokens(page)),['12.5','+','7.25']);
            assert.equal((await page.locator('#ssVarPreviewValue').textContent()).trim(),'19.75');
            await page.keyboard.type('/');
            await page.keyboard.type('5');
            assert.deepEqual(clean(await tokens(page)),['12.5','+','7.25','÷','5']);
            assert.equal((await page.locator('#ssVarPreviewValue').textContent()).trim(),'13.95');
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });

    test('clicking a token reveals only its own circular X and removes just that chip',async()=>{
        const {page,close,errors}=await openStudio(2);
        try{
            await openFormula(page);
            const palette=page.locator('#ssVarBuilderPalette');
            await palette.locator('[data-chip-key="gross"]').click();
            await palette.locator('[data-chip-op="+"]').click();
            await palette.locator('[data-chip-key="dailyRate"]').click();
            await page.locator('[data-formula-token="1"]').click();
            const x=page.locator('#ssVarFormulaCanvas [data-remove-token="1"]');
            assert.equal(await x.isVisible(),true);
            assert.equal(await page.locator('#ssVarFormulaCanvas [data-remove-token]').count(),1);
            assert.ok((await x.boundingBox()).width<=23,'delete button must be a small circle');
            await x.click();
            assert.deepEqual(clean(await tokens(page)),['Bruto','Sueldo por día']);
            assert.equal(await page.locator('#ssVarFormulaCanvas [data-remove-token]').count(),0);
            await page.locator('[data-formula-token="1"]').focus();
            await page.keyboard.press('Delete');
            assert.deepEqual(clean(await tokens(page)),['Bruto']);
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });

    test('reordering chips shows a blue insertion line before dropping, and honors target position',async()=>{
        const {page,close,errors}=await openStudio(1);
        try{
            await openFormula(page);
            const palette=page.locator('#ssVarBuilderPalette');
            await palette.locator('[data-chip-key="gross"]').click();
            await palette.locator('[data-chip-op="+"]').click();
            await palette.locator('[data-chip-key="dailyRate"]').click();
            const tail=page.locator('#ssVarFormulaCanvas [data-formula-token="2"]');
            const head=page.locator('#ssVarFormulaCanvas [data-formula-token="0"]');
            const tailBox=await tail.boundingBox(),headBox=await head.boundingBox();
            await page.mouse.move(tailBox.x+tailBox.width/2,tailBox.y+tailBox.height/2);
            await page.mouse.down();
            await page.mouse.move(headBox.x+2,headBox.y+headBox.height/2,{steps:9});
            const marker=page.locator('#ssVarDropMarker');
            assert.equal(await marker.isVisible(),true,'visible insertion caret must appear while dragging');
            assert.equal(await marker.getAttribute('data-slot'),'0');
            await page.mouse.up();
            assert.deepEqual(clean(await tokens(page)),['Sueldo por día','Bruto','+']);
            assert.equal(await marker.count(),0,'caret disappears on drop');
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });

    test('dragging a new palette field between existing chips inserts at the shown caret',async()=>{
        const {page,close,errors}=await openStudio(1);
        try{
            await openFormula(page);
            const palette=page.locator('#ssVarBuilderPalette');
            await palette.locator('[data-chip-key="gross"]').click();
            await palette.locator('[data-chip-op="+"]').click();
            const source=palette.locator('[data-chip-key="dailyRate"]');
            const target=page.locator('#ssVarFormulaCanvas [data-formula-token="1"]');
            const a=await source.boundingBox(),b=await target.boundingBox();
            await source.dragTo(target,{sourcePosition:{x:a.width/2,y:a.height/2},targetPosition:{x:2,y:b.height/2}});
            assert.deepEqual(clean(await tokens(page)),['Bruto','Sueldo por día','+']);
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });
});