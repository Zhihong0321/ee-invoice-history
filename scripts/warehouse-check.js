'use strict';
const { loadWarehouse } = require('../src/repo/warehouse');
(async () => {
  const d = await loadWarehouse({ month: '2026-07' });
  console.log('month', d.month, d.monthLabel, 'months:', d.months.slice(0,5).map(m=>m.month+':'+m.invoices).join(' '));
  console.log('totals', d.totals, 'unlinkedPackages', d.unlinkedPackages);
  for (const g of d.groups) {
    console.log(`\n--- ${g.key} n=${g.invoiceCount} panelQty=${g.panelQty} invQty=${g.inverterQty}`);
    console.log('panels:', JSON.stringify(g.panels));
    console.log('inverters:', JSON.stringify(g.inverters));
    console.log('sample invoice:', JSON.stringify(g.invoices[0], null, 1).slice(0, 900));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
