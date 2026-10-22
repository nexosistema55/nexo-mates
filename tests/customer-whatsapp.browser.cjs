const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..') + path.sep;
const { normalize } = require(root + 'customer-whatsapp.js');
const target = '5493564621982';
const valid = new Map([
  ['3564621982', target], ['03564 621982', target], ['03564 15 621982', target],
  ['+54 9 3564 621982', target], ['5493564621982', target], ['0054 9 3564 621982', target],
  ['54 (3564) 621982', target], ['+54 (03564) 15-621982', target],
  ['9 3564 621982', target], ['3564.621982', target],
  ['011 15 2345-6789', '5491123456789'], ['0341 15 5123456', '5493415123456'],
  ['3564151982', '5493564151982'], ['3514151234', '5493514151234'],
  ['+34 612 345 678', '34612345678'], ['0034 612 345 678', '34612345678'],
  ['+1 (202) 555-0123', '12025550123'], ['+598 99 123 456', '59899123456'],
  ['+39 06 6982 0000', '390669820000'], ['+44 20 7946 0958', '442079460958'],
  [3564621982, target],
]);
for (const [input, expected] of valid) assert.equal(normalize(input), expected, String(input));
for (const input of ['', null, undefined, {}, [], NaN, Infinity, 1.2, '621982', '15 621982', '356462198', '35646219822', '0000000000', '1111111111', '9999621982', '3564000000', '+54', '+54 9 621982', '+1 2025550', '59899123456', '+999 123456789', '++5493564621982', '3564/621982', '3564621982 int 15', '3564621982#9', '03564 15 15 621982', '(3564 621982', '3564)621982', '<img src=x onerror=alert(1)>', 'https://wa.me/5493564621982']) {
  assert.equal(normalize(input), '', String(input));
}
const app = fs.readFileSync(root + 'app.js', 'utf8');
const extract = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const escapeCode = extract('function htmlAttr(', 'function showActionToast(');
// Extract the single helper, not unrelated app functions.
const htmlAttr = escapeCode.slice(0, escapeCode.indexOf('\n}') + 2);
const phoneMarkup = extract('function customerPhoneMarkup(', 'function customerDisplayLabel(');
const render = extract('function renderCustomers()', 'function openCustomerInfoModal(');
const maliciousName = 'Ana " onclick="alert(1)" <script>bad()</script>';
const customers = [
  { id: 'fake-1', name: maliciousName, phone: '03564 15 621982', dni: '30123456', province: 'Córdoba', notes: 'Nota <b>literal</b>' },
  { id: 'fake-2', name: 'Sin teléfono', phone: '', dni: '20222333', province: 'Santa Fe', notes: 'Conservar nota' },
  { id: 'fake-3', name: 'Teléfono incompleto', phone: '621982', province: 'Córdoba' },
  { id: 'fake-4', name: 'Texto peligroso', phone: '<img src=x onerror=alert(2)>', province: 'Buenos Aires' },
  { id: 'fake-5', name: 'Cliente exterior', phone: '+34 612 345 678', province: 'Otra' },
];
const ctx = { window: { NexoCustomerPhones: { normalize } } };
vm.createContext(ctx);
vm.runInContext(htmlAttr + phoneMarkup, ctx);
assert.ok(ctx.customerPhoneMarkup(customers[0]).includes('href="https://wa.me/' + target + '"'));
assert.ok(!ctx.customerPhoneMarkup(customers[0]).includes('<script>'));
assert.ok(!ctx.customerPhoneMarkup(customers[3]).includes('<img'));
assert.ok(ctx.customerPhoneMarkup(customers[3]).includes('&lt;img'));
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const requests = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        requests.push({ url: url.href, method: route.request().method() });
        if (url.hostname === 'wa.me') return route.fulfill({ contentType: 'text/html', body: '<p>Chat ficticio interceptado</p>' });
        if (url.hostname !== 'customers.test') return route.abort();
        const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
        if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        let body = fs.readFileSync(file);
        if (url.pathname === '/' || url.pathname === '/index.html') body = body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        return route.fulfill({ body, contentType: ({ '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/javascript' });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('https://customers.test/index.html');
      await page.addScriptTag({ content: fs.readFileSync(root + 'customer-whatsapp.js', 'utf8') });
      await page.evaluate(rows => {
        document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'customers'));
        window.CLOUD_DATA_ENABLED = true;
        window.CUSTOMER_PAGE_SIZE = 40;
        window.state = { customers: rows, customerFilters: { query: '', sort: 'alpha' }, customerPage: 1 };
        window.fixtureRows = rows;
        window.readCalls = [];
        window.writes = [];
        Storage.prototype.setItem = function () { writes.push('storage'); throw Error('unexpected storage write'); };
        window.supabaseClient = { rpc() { writes.push('rpc'); throw Error('unexpected rpc'); }, from() { writes.push('from'); throw Error('unexpected from'); } };
        window.saveState = () => { writes.push('saveState'); throw Error('unexpected save'); };
        window.requestCloudCustomersPage = (filters, page) => readCalls.push({ filters, page });
        window.cachedCloudCustomersPage = () => ({ rows: state.customerPage === 1 ? fixtureRows : fixtureRows.slice(4), page: state.customerPage, totalCount: 81, activeCount: 10, totalAmount: 1000, debtAmount: 0 });
        window.filteredCustomers = () => state.customers;
        window.customerProvinceOptions = () => '<option value="">Provincia</option>';
        window.customerStats = () => ({ salesCount: 2, total: 100, debt: 0, ticket: 50 });
        window.customerDuplicateLabel = () => '';
        window.formatCustomerDni = dni => dni;
        window.money = value => '$ ' + value;
        window.cloudEnabledWithSession = () => true;
        window.sizedPaginationControls = (kind, current, pages, total, size) => {
          window.paginationArgs = { kind, current, pages, total, size };
          return '<button type="button">Siguiente</button>';
        };
      }, customers);
      await page.addScriptTag({ content: htmlAttr + phoneMarkup + render + '\nrenderCustomers();' });
      const rows = page.locator('#customersTable tr');
      assert.equal(await rows.count(), 5);
      assert.equal(await rows.first().locator('td').count(), 6);
      assert.equal(await page.locator('.customer-whatsapp-link').count(), 2);
      const link = rows.first().locator('.customer-whatsapp-link');
      assert.equal(await link.getAttribute('href'), 'https://wa.me/' + target);
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
      assert.ok((await link.getAttribute('aria-label')).includes(maliciousName));
      assert.equal(await rows.first().locator('td strong').first().textContent(), maliciousName);
      assert.equal(await rows.nth(1).locator('.customer-phone-text').textContent(), 'Sin Teléfono');
      assert.equal(await rows.nth(2).locator('.customer-phone-text').textContent(), '621982');
      assert.equal(await rows.nth(3).locator('.customer-phone-text').textContent(), customers[3].phone);
      assert.equal(await rows.first().locator('td').first().locator('img').count(), 1);
      assert.equal(await rows.first().locator('td script, [onclick], [onerror]').count(), 0);
      assert.equal(await rows.first().locator('.customer-note-line').textContent(), customers[0].notes);
      assert.equal(await rows.first().locator('.row-actions button').count(), 3);
      await link.scrollIntoViewIfNeeded();
      await link.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const geometry = await link.evaluate(el => {
        const box = el.getBoundingClientRect(), cell = el.closest('td').getBoundingClientRect(), row = el.closest('tr').getBoundingClientRect(), image = el.querySelector('img');
        return { width: box.width, height: box.height, within: box.left >= cell.left && box.right <= cell.right && box.bottom <= row.bottom, loaded: image.complete && image.naturalWidth > 0, outline: getComputedStyle(el).outlineStyle, color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(geometry.within);
      assert.ok(geometry.loaded);
      assert.equal(geometry.overflow, false);
      assert.equal(geometry.background, 'rgba(0, 0, 0, 0)');
      assert.equal(geometry.outline, 'solid');
      if (width < 760) assert.ok(geometry.height >= 44);
      await page.screenshot({ path: path.join(process.env.TEST_OUTPUT_DIR || require('node:os').tmpdir(), 'customer-whatsapp-' + width + '.png') });
      const popupPromise = context.waitForEvent('page');
      await link.click();
      const popup = await popupPromise;
      await popup.waitForURL('https://wa.me/' + target);
      assert.equal(popup.url(), 'https://wa.me/' + target);
      assert.equal(await popup.evaluate(() => window.opener), null);
      await popup.close();
      await page.evaluate(() => { state.customerPage = 2; renderCustomers(); });
      assert.equal(await rows.count(), 1);
      assert.deepEqual(await page.evaluate(() => paginationArgs), { kind: 'customers', current: 2, pages: 3, total: 81, size: 40 });
      assert.equal((await page.evaluate(() => readCalls)).length, 2);
      assert.deepEqual(await page.evaluate(() => writes), []);
      assert.deepEqual(await page.evaluate(() => state.customers.map(customer => customer.phone)), customers.map(customer => customer.phone));
      assert.equal(requests.some(request => request.method !== 'GET'), false);
      assert.equal(errors.length, 0, errors.join('\n'));
      await context.close();
    }
    console.log('PASS: phone formats and invalid data; escaped HTML; no writes; existing paginated rows/actions; single phone link; logo, tooltip, focus and mobile target; chat intercepted');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
