/**
 * End-to-end test of the member API handlers (no server needed): auth -> cookie -> gated content.
 *
 * Run:  node tests/api.members.test.mjs
 */
process.env.VOM_MEMBER_SECRET = 'test-secret-that-is-long-enough';
process.env.VOM_MEMBER_CODES = 'ESCAPE-VELOCITY';
process.env.VOM_MEMBER_EMAILS = 'kw@kassidywarren.com';

const assert = (await import('node:assert/strict')).default;
const auth = (await import('../api/members/auth.js')).default;
const content = (await import('../api/members/content.js')).default;
const resources = (await import('../api/members/resources.js')).default;

let pass = 0;
const failures = [];

function res() {
  const out = { status: 0, body: null, headers: {} };
  return {
    out,
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; return this; },
    end() { return this; },
  };
}

async function t(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const post = (body) => ({ method: 'POST', headers: {}, body });

await t('a wrong code is rejected with 401 and no cookie', async () => {
  const r = res();
  await auth(post({ code: 'WRONG' }), r);
  assert.equal(r.out.status, 401);
  assert.equal(r.out.headers['set-cookie'], undefined);
});

await t('an unknown email is rejected with 401', async () => {
  const r = res();
  await auth(post({ email: 'stranger@example.com' }), r);
  assert.equal(r.out.status, 401);
  assert.equal(r.out.headers['set-cookie'], undefined);
});

await t('the right code issues a member cookie', async () => {
  const r = res();
  await auth(post({ code: 'escape-velocity' }), r);
  assert.equal(r.out.status, 200);
  assert.match(r.out.headers['set-cookie'], /^vom_member=/);
});

await t('the member email issues a cookie', async () => {
  const r = res();
  await auth(post({ email: 'KW@kassidywarren.com' }), r);
  assert.equal(r.out.status, 200);
  assert.match(r.out.headers['set-cookie'], /^vom_member=/);
});

// grab a real cookie for the content tests
const login = res();
await auth(post({ code: 'ESCAPE-VELOCITY' }), login);
const cookie = String(login.out.headers['set-cookie']).split(';')[0];

await t('content is refused without a cookie', async () => {
  const r = res();
  await content({ method: 'GET', headers: {}, query: {} }, r);
  assert.equal(r.out.status, 401);
});

await t('content is refused with a forged cookie', async () => {
  const r = res();
  await content({ method: 'GET', headers: { cookie: 'vom_member=eyJ9.forged' }, query: {} }, r);
  assert.equal(r.out.status, 401);
});

await t('the catalogue lists both courses with real lesson counts', async () => {
  const r = res();
  await content({ method: 'GET', headers: { cookie }, query: {} }, r);
  assert.equal(r.out.status, 200);
  const ids = r.out.body.courses.map((c) => c.id).sort();
  assert.deepEqual(ids, ['airbnb', 'tax']);
  for (const c of r.out.body.courses) {
    assert.ok(c.lessonCount > 20, `${c.id} has only ${c.lessonCount} lessons`);
    assert.ok(c.moduleCount >= 6, `${c.id} has only ${c.moduleCount} modules`);
  }
});

await t('the tax course returns modules whose lessons carry sources', async () => {
  const r = res();
  await content({ method: 'GET', headers: { cookie }, query: { course: 'tax' } }, r);
  assert.equal(r.out.status, 200);
  const course = r.out.body.course;
  assert.equal(course.id, 'tax');
  assert.ok(course.modules.length >= 6);
  const lessons = course.modules.flatMap((m) => m.lessons);
  assert.ok(lessons.length > 20);
  for (const L of lessons.slice(0, 25)) {
    assert.ok(L.title, 'lesson without a title');
    assert.ok(L.source && L.source.label, `lesson "${L.title}" has no source call`);
  }
  const withWatch = lessons.filter((L) => L.source && L.source.watch).length;
  assert.ok(withWatch > 0, 'no lesson carries a video link');
  console.log(`       (${lessons.length} lessons, ${withWatch} with a video deep link)`);
});

await t('an unknown course id is a clean 404', async () => {
  const r = res();
  await content({ method: 'GET', headers: { cookie }, query: { course: 'nope' } }, r);
  assert.equal(r.out.status, 404);
});

await t('resources and partners are refused without a cookie', async () => {
  const r = res();
  await resources({ method: 'GET', headers: {}, query: {} }, r);
  assert.equal(r.out.status, 401);
});

await t('resources return real Drive links and the partner directory', async () => {
  const r = res();
  await resources({ method: 'GET', headers: { cookie }, query: {} }, r);
  assert.equal(r.out.status, 200);
  const groups = r.out.body.resources;
  assert.ok(groups.length >= 4);
  const items = groups.flatMap((g) => g.items);
  assert.ok(items.length >= 20, `only ${items.length} resources`);
  for (const it of items) {
    assert.match(it.url, /^https:\/\//, `bad url for ${it.title}`);
    assert.ok(!/example\.com|TODO|PLACEHOLDER/i.test(it.url), `placeholder url in ${it.title}`);
  }
  assert.ok(r.out.body.partners.length >= 15, 'partner directory looks empty');
  assert.ok(r.out.body.affiliatePrograms.length >= 3);
});

await t('sign-out clears the cookie', async () => {
  const r = res();
  await auth({ method: 'DELETE', headers: { cookie } }, r);
  assert.equal(r.out.status, 200);
  assert.match(r.out.headers['set-cookie'], /Max-Age=0/);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('failed: ' + failures.join(', '));
  process.exitCode = 1;
}
