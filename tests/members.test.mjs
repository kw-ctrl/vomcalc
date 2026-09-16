/**
 * The member gate is the only thing standing between the public and the internal
 * EV area, so it gets tested rather than assumed.
 *
 * Run:  node tests/members.test.mjs
 *
 * Covers: cookie signing/verification, tamper + expiry rejection, the fail-closed
 * path when the secret is missing, code matching, and the email allowlist.
 */
process.env.VOM_MEMBER_SECRET = 'test-secret-that-is-long-enough';
process.env.VOM_MEMBER_CODES = 'ESCAPE-VELOCITY,SECOND-CODE';
process.env.VOM_MEMBER_EMAILS = 'member@example.com,@partner.com';

const { default: assert } = await import('node:assert/strict');
const m = await import('../api/_shared/members.js');

let pass = 0;
const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}
async function run() {
  for (const [name, fn] of checks) {
    try {
      await fn();
      pass += 1;
      console.log(`  ok   ${name}`);
    } catch (err) {
      console.log(`  FAIL ${name}\n       ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${pass}/${checks.length} assertions passed`);
}

const fakeRes = () => {
  const out = { status: 0, body: null, headers: {} };
  return {
    out,
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; },
    setHeader(k, v) { out.headers[k] = v; },
    end() { return this; },
  };
};

check('a signed token verifies and keeps its payload', () => {
  const t = m.sign({ email: 'a@b.com', via: 'code', exp: Date.now() + 10000 });
  const p = m.verify(t);
  assert.equal(p.email, 'a@b.com');
});

check('a tampered payload is rejected', () => {
  const t = m.sign({ via: 'code', exp: Date.now() + 10000 });
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ via: 'code', exp: Date.now() + 10 ** 9 })).toString('base64url');
  assert.equal(m.verify(`${forged}.${sig}`), null);
});

check('a forged signature is rejected', () => {
  const t = m.sign({ via: 'code', exp: Date.now() + 10000 });
  const [body] = t.split('.');
  assert.equal(m.verify(`${body}.deadbeef`), null);
});

check('an expired token is rejected', () => {
  const t = m.sign({ via: 'code', exp: Date.now() - 1000 });
  assert.equal(m.verify(t), null);
});

check('garbage tokens are rejected without throwing', () => {
  for (const bad of ['', null, undefined, 'x', 'a.b', '....', 'eyJ9.sig']) {
    assert.equal(m.verify(bad), null);
  }
});

check('the issued cookie is HttpOnly, Secure and SameSite', () => {
  const h = m.cookieHeader(m.sign({ via: 'code', exp: Date.now() + 1000 }));
  assert.match(h, /^vom_member=/);
  assert.match(h, /HttpOnly/);
  assert.match(h, /Secure/);
  assert.match(h, /SameSite=Lax/);
});

check('no member cookie -> requireMember answers 401', () => {
  const res = fakeRes();
  const member = m.requireMember({ headers: {} }, res);
  assert.equal(member, null);
  assert.equal(res.out.status, 401);
});

check('a valid cookie -> requireMember returns the member', () => {
  const token = m.sign({ email: 'member@example.com', via: 'email', exp: Date.now() + 100000 });
  const res = fakeRes();
  const member = m.requireMember({ headers: { cookie: `other=1; ${m.COOKIE_NAME}=${token}` } }, res);
  assert.equal(member.email, 'member@example.com');
  assert.equal(res.out.status, 0);
});

check('a valid cookie is rejected when the secret changes (rotated secret)', () => {
  const token = m.sign({ via: 'code', exp: Date.now() + 100000 });
  const original = process.env.VOM_MEMBER_SECRET;
  process.env.VOM_MEMBER_SECRET = 'a-completely-different-secret-here';
  assert.equal(m.verify(token), null);
  process.env.VOM_MEMBER_SECRET = original;
});

check('the gate fails CLOSED when the secret is missing', () => {
  const original = process.env.VOM_MEMBER_SECRET;
  delete process.env.VOM_MEMBER_SECRET;
  assert.equal(m.configured(), false);
  const res = fakeRes();
  const member = m.requireMember({ headers: {} }, res);
  assert.equal(member, null);
  assert.equal(res.out.status, 503);
  process.env.VOM_MEMBER_SECRET = original;
});

check('codes match case-insensitively and reject wrong ones', () => {
  assert.equal(m.checkCode('escape-velocity'), true);
  assert.equal(m.checkCode('  SECOND-CODE  '), true);
  assert.equal(m.checkCode('nope'), false);
  assert.equal(m.checkCode(''), false);
});

check('the email allowlist matches exact addresses and whole domains', async () => {
  assert.equal(await m.checkEmail('member@example.com'), true);
  assert.equal(await m.checkEmail('MEMBER@example.com'), true);
  assert.equal(await m.checkEmail('anyone@partner.com'), true);
  assert.equal(await m.checkEmail('stranger@example.com'), false);
  assert.equal(await m.checkEmail('not-an-email'), false);
});

await run();
