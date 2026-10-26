/**
 * Real DOCX browser roundtrip, not a mocked Mammoth converter.
 * Builds an in-memory OOXML ZIP without external binary fixtures, intercepts
 * the same pinned Mammoth 1.13.0 browser script using its installed npm copy.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { openStudio } = require('./helpers.js');

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function zipStored(parts) {
    const local = [], directory = [];
    let offset = 0;
    for (const [name, content] of Object.entries(parts)) {
        const nameBuffer = Buffer.from(name, 'utf8');
        const bytes = Buffer.from(content, 'utf8');
        const check = crc32(bytes);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt32LE(check, 14);
        header.writeUInt32LE(bytes.length, 18);
        header.writeUInt32LE(bytes.length, 22);
        header.writeUInt16LE(nameBuffer.length, 26);
        local.push(header, nameBuffer, bytes);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(check, 16);
        central.writeUInt32LE(bytes.length, 20);
        central.writeUInt32LE(bytes.length, 24);
        central.writeUInt16LE(nameBuffer.length, 28);
        central.writeUInt32LE(offset, 42);
        directory.push(central, nameBuffer);
        offset += header.length + nameBuffer.length + bytes.length;
    }
    const cdir = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(parts).length, 8);
    end.writeUInt16LE(Object.keys(parts).length, 10);
    end.writeUInt32LE(cdir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, cdir, end]);
}
function realDocx() {
    const document = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>CARTA DE INGRESO</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Empleado {{name}},</w:t></w:r>',
        '<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> bienvenida.</w:t></w:r></w:p>',
        '<w:sectPr/></w:body></w:document>'
    ].join('');
    const contents = '<?xml version="1.0" encoding="UTF-8"?>'+
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
        '<Default Extension="xml" ContentType="application/xml"/>'+
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'+
        '</Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8"?>'+
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'+
        '</Relationships>';
    return zipStored({
        '[Content_Types].xml': contents,
        '_rels/.rels': rels,
        'word/document.xml': document
    });
}
test('real DOCX import via pinned Mammoth browser bundle, formatting and personal field substitution', async () => {
    const bundle=path.join(path.dirname(require.resolve('mammoth/package.json')),'mammoth.browser.min.js');
    assert.ok(fs.existsSync(bundle),'Install mammoth@1.13.0 as a test-only dependency');
    const {page,errors,close}=await openStudio(2);
    try {
        await page.route('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.13.0/mammoth.browser.min.js',
            route=>route.fulfill({path:bundle,contentType:'application/javascript'}));
        await page.locator('#ssBar [data-act="documents"]').click();
        await page.waitForSelector('#sxdocFile');
        await page.locator('#sxdocFile').setInputFiles({
            name:'ingreso-real.docx',
            mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            buffer:realDocx()
        });
        await page.waitForFunction(() => document.querySelector('#sxdocEditor')?.textContent?.includes('CARTA DE INGRESO'));
        const editor=page.locator('#sxdocEditor');
        assert.equal(await editor.locator('strong').count(),1,'Word bold should be retained');
        assert.equal(await editor.locator('em').count(),1,'Word italics should be retained');
        assert.match(await page.locator('#sxdocPreview').textContent(),/Empleado 1 Prueba/);
        assert.equal(await editor.locator('script,img,iframe,[onerror],[onclick]').count(),0);
        assert.match(await page.locator('#sxdocStatus').textContent(),/Importado/);
        assert.deepEqual(errors,[]);
    }finally{await close();}
});
