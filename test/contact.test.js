const assert = require('node:assert/strict');
const Module = require('node:module');
const { afterEach, beforeEach, test } = require('node:test');

const ORIGINAL_ENV = { ...process.env };
const mailCalls = [];
const transportCalls = [];
let sendMailFailure = null;

const originalLoad = Module._load;
Module._load = function mockNodemailer(request, parent, isMain) {
  if (request === 'nodemailer') {
    return {
      createTransport(options) {
        transportCalls.push(options);
        return {
          async sendMail(message) {
            mailCalls.push(message);
            if (sendMailFailure) throw sendMailFailure;
            return { accepted: [options.auth.user] };
          }
        };
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const handler = require('../api/contact');
Module._load = originalLoad;

function setTestEnvironment() {
  process.env.SMTP_HOST = 'smtp.gmail.com';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_SECURE = 'true';
  process.env.SMTP_USER = 't.tokuyama@beginai.jp';
  process.env.SMTP_APP_PASSWORD = 'test-only-placeholder';
  process.env.CONTACT_TO_EMAIL = 't.tokuyama@beginai.jp';
}

function validBody(overrides = {}) {
  return {
    company: 'テスト株式会社',
    name: 'テスト 太郎',
    email: 'visitor@example.com',
    phone: '03-1234-5678',
    industry: '製造業',
    service: 'ai-advisor',
    message: '業務整理について相談したいです。',
    website: '',
    ...overrides
  };
}

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

async function invoke({ method = 'POST', body = validBody(), headers = {} } = {}) {
  const response = mockResponse();
  await handler({
    method,
    body,
    headers: {
      host: 'beginai.vercel.app',
      origin: 'https://beginai.vercel.app',
      ...headers
    }
  }, response);
  return response;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  setTestEnvironment();
  mailCalls.length = 0;
  transportCalls.length = 0;
  sendMailFailure = null;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test('uses Google Workspace SMTP without making a real network connection', async () => {
  const response = await invoke();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { success: true });
  assert.equal(transportCalls.length, 1);
  assert.deepEqual(transportCalls[0], {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    requireTLS: false,
    auth: {
      user: 't.tokuyama@beginai.jp',
      pass: 'test-only-placeholder'
    },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
  assert.equal(mailCalls.length, 1);
  assert.deepEqual(mailCalls[0].from, {
    name: 'BeginAI お問い合わせ',
    address: 't.tokuyama@beginai.jp'
  });
  assert.equal(mailCalls[0].to, 't.tokuyama@beginai.jp');
  assert.deepEqual(mailCalls[0].replyTo, {
    name: 'テスト 太郎',
    address: 'visitor@example.com'
  });
  assert.match(mailCalls[0].text, /AI顧問/);
});

test('fails closed when an SMTP environment variable is missing', async () => {
  delete process.env.SMTP_APP_PASSWORD;
  const response = await invoke();

  assert.equal(response.statusCode, 503);
  assert.equal(mailCalls.length, 0);
  assert.equal(transportCalls.length, 0);
});

test('rejects cross-origin requests', async () => {
  const response = await invoke({ headers: { origin: 'https://example.com' } });

  assert.equal(response.statusCode, 403);
  assert.equal(mailCalls.length, 0);
});

test('rejects invalid methods and input', async () => {
  assert.equal((await invoke({ method: 'GET' })).statusCode, 405);
  assert.equal((await invoke({ body: validBody({ email: 'invalid' }) })).statusCode, 400);
  assert.equal((await invoke({ body: validBody({ service: 'unknown' }) })).statusCode, 400);
  assert.equal((await invoke({ body: validBody({ message: '' }) })).statusCode, 400);
  assert.equal(mailCalls.length, 0);
});

test('rejects header injection attempts', async () => {
  const emailResponse = await invoke({
    body: validBody({ email: 'visitor@example.com\r\nBcc: attacker@example.com' })
  });
  const companyResponse = await invoke({
    body: validBody({ company: '会社名\nBcc: attacker@example.com' })
  });

  assert.equal(emailResponse.statusCode, 400);
  assert.equal(companyResponse.statusCode, 400);
  assert.equal(mailCalls.length, 0);
});

test('accepts the honeypot silently without sending mail', async () => {
  const response = await invoke({ body: validBody({ website: 'https://spam.example' }) });

  assert.equal(response.statusCode, 200);
  assert.equal(mailCalls.length, 0);
});

test('returns a generic error when SMTP delivery fails', async () => {
  sendMailFailure = Object.assign(new Error('must not be logged'), {
    code: 'EAUTH',
    responseCode: 535,
    command: 'AUTH PLAIN',
    response: 'must not be logged either'
  });
  const logCalls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logCalls.push(args);

  let response;
  try {
    response = await invoke();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.payload, { error: '送信できませんでした' });
  assert.equal(mailCalls.length, 1);
  assert.deepEqual(logCalls, [[
    'Contact SMTP delivery failed',
    { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }
  ]]);
  assert.doesNotMatch(JSON.stringify(logCalls), /must not be logged/);
});
