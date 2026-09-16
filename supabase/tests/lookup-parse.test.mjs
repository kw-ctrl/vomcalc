// Parser tests — the fragile part, so it gets real assertions.
//   node supabase/tests/lookup-parse.test.mjs
import { parseListingUrl, normalizeQuery, addressKey } from '../../api/_shared/str-data.js';

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      expected: ${expected}\n      actual:   ${actual}`); }
}
function checkTruthy(label, actual) {
  if (actual) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}`); }
}
function checkNull(label, actual) {
  if (actual === null) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} — expected null, got ${JSON.stringify(actual)}`); }
}

console.log('\nRedfin URLs (structured path — city/state/zip all recoverable)');
check('standard listing',
  parseListingUrl('https://www.redfin.com/WA/Kirkland/12000-NE-80th-St-98033/home/285135').address,
  '12000 NE 80th St, Kirkland, WA 98033');
check('multi-word city',
  parseListingUrl('https://www.redfin.com/WA/Federal-Way/1234-S-312th-St-98003/home/999').address,
  '1234 S 312th St, Federal Way, WA 98003');
check('condo with unit segment',
  parseListingUrl('https://www.redfin.com/WA/Seattle/1234-Main-St-98101/unit-2/home/1234567').address,
  '1234 Main St, Seattle, WA 98101');
check('trailing query string ignored',
  parseListingUrl('https://www.redfin.com/CA/San-Diego/5678-Ocean-Blvd-92109/home/777?utm_source=share').address,
  '5678 Ocean Blvd, San Diego, CA 92109');
check('state field', parseListingUrl('https://www.redfin.com/TX/Austin/100-Congress-Ave-78701/home/1').state, 'TX');
check('zip field', parseListingUrl('https://www.redfin.com/TX/Austin/100-Congress-Ave-78701/home/1').zip, '78701');

console.log('\nZillow URLs (one dash-joined slug — state+zip clean, street left to the geocoder)');
const z = parseListingUrl('https://www.zillow.com/homedetails/16508-104th-Ave-NE-Bothell-WA-98011/12345678_zpid/');
checkTruthy('resolves', z);
check('state', z.state, 'WA');
check('zip', z.zip, '98011');
checkTruthy('street present in address', /104th Ave NE/.test(z.address));
check('no trailing dash junk', /^[^,]+,\s*WA\s*98011$/.test(z.address), true);
const z2 = parseListingUrl('https://www.zillow.com/homedetails/1234-N-Main-St-San-Francisco-CA-94110/999_zpid/?fbclid=abc');
check('multi-word city slug', z2.zip, '94110');
check('multi-word city slug state', z2.state, 'CA');

console.log('\nTyped addresses and edge cases');
check('plain address passes through', normalizeQuery('16508 104th Ave NE, Bothell, WA 98011').address, '16508 104th Ave NE, Bothell, WA 98011');
check('source tagged', normalizeQuery('16508 104th Ave NE, Bothell, WA 98011').source, 'typed-address');
checkNull('nonsense rejected', normalizeQuery('hello there'));
checkNull('too short rejected', normalizeQuery('12'));
checkNull('empty rejected', normalizeQuery(''));
check('www. prefixed URL still parsed',
  normalizeQuery('www.redfin.com/WA/Kirkland/12000-NE-80th-St-98033/home/285135').address,
  '12000 NE 80th St, Kirkland, WA 98033');

console.log('\nUnparseable link asks for the address instead of guessing');
const short = normalizeQuery('https://redf.in/abc123');
check('flagged for address prompt', short.source, 'url-unparsed');
checkNull('no address invented', short.address);

console.log('\nCache keys are stable across trivial formatting differences');
check('same address, different punctuation -> one key',
  addressKey('12000 NE 80th Street, Kirkland, WA 98033'),
  addressKey('12000 ne 80th st  kirkland wa 98033'));
check('different address -> different key',
  addressKey('12000 NE 80th St, Kirkland, WA 98033') === addressKey('12001 NE 80th St, Kirkland, WA 98033'),
  false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
