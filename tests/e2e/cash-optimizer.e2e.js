/**
 * Browser smoke coverage of the real UMD cash modules loaded by index.html.
 * Keeps tests independent of SA, employees are fabricated locally.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./server.js');
const { loadPlaywright } = require('./helpers.js');

describe('cash optimizer within browser SplitXCore', () => {
    test('uses three tens instead of 25 and leaves stock unchanged', async () => {
        const server = await startServer();
        const browser = await loadPlaywright().chromium.launch();
        try {
            const page = await browser.newPage();
            const errors = [];
            page.on('pageerror', e => { if (!/tailwind/i.test(e.message)) errors.push(e.message); });
            await page.route('**/*', route => route.request().url().startsWith(server.url) ? route.continue() : route.abort());
            await page.goto(server.url + '/index.html');
            const data = await page.evaluate(() => {
                const state = {
                    denominations:[25,10], inventory:{25:1,10:3}, payrollMode:'normal',
                    payrollLoanFund:0, bankLimits:{},
                    employees:[{id:1,name:'Ana',amount:30,paid:false}]
                };
                const core = window.SplitXCore.createCore({getState:()=>state});
                const before = JSON.stringify(state);
                const result = core.calculateDistribution();
                const bank = core.calculateBankNeeds();
                return {
                    loaded: typeof window.CashOptimizer.solveCash === 'function',
                    result, bank, stable: JSON.stringify(state) === before
                };
            });
            assert.equal(data.loaded, true);
            assert.equal(data.result.results[0]._missingAmount,0);
            assert.deepEqual(data.result.results[0].distribution, {10:3});
            assert.equal(data.result.leftoverInventory[25],1);
            assert.equal(data.stable,true);
            assert.ok(Object.values(data.bank.breakdown).every(x=>x.final===0));
            assert.deepEqual(errors, []);
        } finally { await browser.close(); await server.close(); }
    });
});
