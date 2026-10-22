const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
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

console.log('PASS: phone-format and HTML-escape regression cases');
