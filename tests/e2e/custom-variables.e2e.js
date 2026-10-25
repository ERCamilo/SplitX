const {test,describe}=require('node:test');
const assert=require('node:assert/strict');
const {openStudio}=require('./helpers.js');

describe('print-only customizable variables in the actual editor',()=>{
    test('creates reusable variables, overrides an employee and persists them across reload',async()=>{
        const {page,errors,store,close}=await openStudio(3);
        try{
            await page.click('#ssVarsBtn');
            await page.fill('#ssVarId','transporte');
            await page.fill('#ssVarLabel','Transporte');
            await page.fill('#ssVarValue','250');
            await page.click('[data-act="vars-save"]');
            assert.equal((await store()).variables[0].value,250);
            await page.click('#ssVarsBtn');
            await page.click('[data-act="vars-edit"][data-v="transporte"]');
            await page.selectOption('#ssVarEmployee','001');
            await page.fill('#ssVarOverride','400');
            await page.click('[data-act="vars-save"]');
            assert.equal((await store()).variables[0].overrides['001'],400);

            await page.click('#ssVarsBtn');
            await page.fill('#ssVarId','pago_extra');
            await page.fill('#ssVarLabel','Pago extra');
            await page.selectOption('#ssVarKind','formula');
        await page.click('#ssVarModeText');
            await page.fill('#ssVarFormula','gross * 5% + transporte');
            await page.click('[data-act="vars-save"]');
            const state = await store();
            assert.equal(state.variables.length,2);
            assert.ok((await page.textContent('#ssPalette')).includes('Pago extra'));

            const values=await page.evaluate(()=>{
                const employees=JSON.parse(localStorage.getItem('Split_data')).employees;
                const defs=JSON.parse(localStorage.getItem('Split_sheets_v2')).variables;
                const base=window.SplitXSheetFields.createFieldSet({records:employees});
                const own=window.SplitXVariables.createFieldSet(defs,base,window.SheetBuilder);
                const engine=window.SheetBuilder.createEngine({fields:[...base.fields,...own.fields],resolveField:base.resolveField});
                return employees.slice(0,2).map((r,i)=>engine.evaluateCell({mode:'number',chips:[{kind:'field',key:'custom:pago_extra'}]},r,{index:i},null).value);
            });
            assert.deepEqual(values,[900,762.5]); // gross: 10000 and 10250, second uses default transport 250
            await page.reload({waitUntil:'load'});
            await page.evaluate(()=>window.app.openSheetStudio());
            assert.equal((await store()).variables.length,2);
            assert.ok((await page.textContent('#ssPalette')).includes('Pago extra'));
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });

    test('blocks invalid formula and prevents deleting a variable still used by a template',async()=>{
        const {page,errors,store,close}=await openStudio(2);
        try{
            await page.click('#ssVarsBtn');
            await page.fill('#ssVarId','ciclo');
            await page.fill('#ssVarLabel','Ciclo');
            await page.selectOption('#ssVarKind','formula');
        await page.click('#ssVarModeText');
            await page.fill('#ssVarFormula','ciclo + 1');
            await page.click('[data-act="vars-save"]');
            assert.match(await page.textContent('#ssVarsMsg'),/circular/i);
            assert.equal(((await store()).variables || []).length,0);
            await page.fill('#ssVarId','transporte');
            await page.fill('#ssVarLabel','Transporte');
            await page.selectOption('#ssVarKind','fixed');
            await page.fill('#ssVarValue','100');
            await page.click('[data-act="vars-save"]');
            await page.locator('#ssCardEdit [data-zone="A:1:1"]').click();
            await page.locator('#ssPalette [data-pi]',{hasText:'Transporte'}).first().click();
            await page.click('#ssVarsBtn');
            await page.click('[data-act="vars-delete"][data-v="transporte"]');
            await page.click('[data-act="vars-delete"][data-v="transporte"]');
            assert.match(await page.textContent('#ssVarsMsg'),/plantilla/i);
            assert.equal((await store()).variables.length,1);
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });
});
