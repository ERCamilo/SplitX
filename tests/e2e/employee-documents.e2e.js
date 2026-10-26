const {describe,test}=require('node:test');
const assert=require('node:assert/strict');
const {openStudio}=require('./helpers.js');

const openDocuments=async page=>{
    await page.click('#ssBar [data-act="documents"]');
    await page.waitForSelector('#documentStudio:not([hidden]) #sxdocEditor');
};
const importedPayroll=page=>page.evaluate(()=>localStorage.getItem('Split_data'));
const replaceEditor=async(page,html)=>page.locator('#sxdocEditor').evaluate((el,value)=>{
    el.innerHTML=value;
    el.dispatchEvent(new Event('input',{bubbles:true}));
},html);

describe('employee document templates in SplitX',()=>{
    test('third Hojas tab opens documents and previews employee fields without editing SA payroll',async()=>{
        const {page,close,errors}=await openStudio(2);
        try{
            const before=await importedPayroll(page);
            await openDocuments(page);
            assert.equal(await page.locator('#documentStudio').isVisible(),true);
            assert.equal(await page.locator('#sheetStudio').isVisible(),false);
            assert.match(await page.locator('#sxdocPreview').textContent(),/Empleado 1 Prueba/);
            assert.match(await page.locator('#sxdocPreview').textContent(),/Constructora Ejemplo/);
            assert.equal(await page.locator('#sxdocMissing').isVisible(),true);
            await replaceEditor(page,'<h2>Carta para {{name}}</h2><p>Proyecto: {{project}}. Salario: {{monthlySalary}}.</p>');
            await page.fill('#sxdocPerson_monthlySalary','30000');
            assert.match(await page.locator('#sxdocPreview').textContent(),/30[,.]000/);
            assert.match(await page.locator('#sxdocPreview').textContent(),/Obra Centro/);
            await page.selectOption('#sxdocEmployee','1');
            assert.match(await page.locator('#sxdocPreview').textContent(),/Empleado 2 Prueba/);
            assert.equal(await page.locator('#sxdocMissing').isVisible(),true);
            await page.fill('#sxdocPerson_monthlySalary','32000');
            assert.match(await page.locator('#sxdocPreview').textContent(),/32[,.]000/);
            assert.equal(await importedPayroll(page),before);
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });

    test('templates are reusable and remain editable across refresh',async()=>{
        const {page,close,errors}=await openStudio(1);
        try{
            await openDocuments(page);
            await page.click('[data-act="new"]');
            await page.fill('#sxdocName','Carta de contratación');
            await replaceEditor(page,'<h2>BIENVENIDA</h2><p>Estimado <b>{{name}}</b>, fecha {{today}}.</p>');
            await page.click('#documentStudio [data-act="save"]');
            const snap=await page.evaluate(()=>JSON.parse(localStorage.getItem('Split_documents_v1')));
            const letter=snap.templates.find(x=>x.name==='Carta de contratación');
            assert.ok(letter);
            assert.match(letter.html,/<b>\{\{name\}\}<\/b>/);
            assert.match(await page.locator('#sxdocPreview').textContent(),/Empleado 1 Prueba/);
            await page.reload({waitUntil:'load'});
            await page.evaluate(()=>window.app.openDocumentStudio());
            await page.waitForSelector('#sxdocEditor');
            assert.equal(await page.inputValue('#sxdocName'),'Carta de contratación');
            assert.match(await page.locator('#sxdocEditor').textContent(),/BIENVENIDA/);
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });

    test('DOCX import strips executable content and preserves basic rich text',async()=>{
        const {page,close,errors}=await openStudio(1);
        try{
            await openDocuments(page);
            await page.evaluate(()=>{
                window.__injected=0;
                window.mammoth={
                    convertToHtml:async()=>({
                        value:'<h2>INGRESO</h2><p onclick="window.__injected=1">Empleado {{name}} <strong>Bienvenido</strong></p>'+
                        '<script>window.__injected=5</script><img src="x" onerror="window.__injected=2">'+
                        '<iframe src="https://example.org"></iframe>',
                        messages:[]
                    })
                };
            });
            await page.locator('#sxdocFile').setInputFiles({
                name:'modelo.docx',
                mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                buffer:Buffer.from('fake-docx-fixture')
            });
            await page.waitForFunction(()=>document.querySelector('#sxdocEditor')?.textContent.includes('INGRESO'));
            assert.equal(await page.locator('#sxdocEditor h2').count(),1);
            assert.equal(await page.locator('#sxdocEditor strong').count(),1);
            assert.equal(await page.locator('#sxdocEditor script, #sxdocEditor img, #sxdocEditor iframe').count(),0);
            assert.equal(await page.locator('#sxdocEditor [onclick]').count(),0);
            assert.equal(await page.evaluate(()=>window.__injected),0);
            assert.match(await page.locator('#sxdocPreview').textContent(),/Empleado 1 Prueba/);
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });

    test('text file imports as paragraphs, and print rejects missing values instead of inventing salary',async()=>{
        const {page,close,errors}=await openStudio(2);
        try{
            await openDocuments(page);
            const before=await importedPayroll(page);
            await page.locator('#sxdocFile').setInputFiles({
                name:'carta.txt',mimeType:'text/plain',
                buffer:Buffer.from('Estimado {{name}}\nSalario contractual {{monthlySalary}}')
            });
            await page.waitForFunction(()=>document.querySelector('#sxdocEditor')?.textContent.includes('Estimado'));
            assert.equal(await page.locator('#sxdocEditor p').count(),2);
            await page.evaluate(()=>{window.__opened=0;window.open=()=>{window.__opened++;return null;};});
            await page.click('#documentStudio [data-act="print-all"]');
            assert.equal(await page.evaluate(()=>window.__opened),0);
            assert.match(await page.locator('#sxdocStatus').textContent(),/faltan datos/i);
            await page.fill('#sxdocPerson_monthlySalary','30000');
            await page.selectOption('#sxdocEmployee','1');
            await page.fill('#sxdocPerson_monthlySalary','32000');
            await page.evaluate(()=>{
                window.__pages='';
                window.open=()=>{
                    window.__opened++;
                    return {
                        document:{open(){},write(s){window.__pages=s;},close(){}},
                        focus(){},addEventListener(){},opener:window
                    };
                };
            });
            await page.click('#documentStudio [data-act="print-all"]');
            const docs=await page.evaluate(()=>window.__pages);
            assert.equal(await page.evaluate(()=>window.__opened),1);
            assert.equal((docs.match(/<section>/g)||[]).length,2);
            assert.match(docs,/Empleado 1 Prueba/);
            assert.match(docs,/Empleado 2 Prueba/);
            assert.match(docs,/30[,.]000/);
            assert.match(docs,/32[,.]000/);
            assert.equal(await importedPayroll(page),before);
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });
    test('mobile document editor stays usable and opens from the main toolbar',async()=>{
        const {page,close,errors}=await openStudio(2);
        try {
            await page.setViewportSize({width:390,height:844});
            await page.locator('#ssBar [data-act="close"]').click();
            await page.locator('nav button[aria-label="Documentos personalizados"]').click();
            await page.waitForSelector('#documentStudio:not([hidden]) #sxdocEditor');
            assert.equal(await page.locator('#sxdocEditor').isVisible(),true);
            assert.equal(await page.locator('#sxdocPreview').isVisible(),true);
            const dimensions=await page.evaluate(()=>{
                const view=document.getElementById('documentStudio');
                return {width:view.clientWidth,scrollWidth:view.scrollWidth,windowWidth:innerWidth};
            });
            assert.ok(dimensions.scrollWidth<=dimensions.windowWidth+2,
                'editor should not require horizontal page scrolling on mobile');
            await page.locator('#sxdocEmployee').selectOption('1');
            assert.match(await page.locator('#sxdocPreview').textContent(),/Empleado 2 Prueba/);
            assert.deepEqual(errors,[]);
        }finally{await close();}
    });

});
