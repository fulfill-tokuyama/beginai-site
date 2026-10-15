const nodemailer = require('nodemailer');

const MAX_BODY_BYTES = 12000;
const SERVICE_LABELS = {
  undecided: '相談して決めたい',
  'ai-advisor': 'AI顧問（自社で進めたい）',
  development: '開発代行（実装まで任せたい）'
};

function singleLineValue(value, maxLength) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return '';
  return value.trim().slice(0, maxLength);
}

function messageValue(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').trim().slice(0, maxLength)
    : '';
}

function isValidEmail(value) {
  return value.length <= 254
    && !/[\r\n]/.test(value)
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);
}

function loadSmtpConfig() {
  const host = singleLineValue(process.env.SMTP_HOST, 255);
  const port = Number(process.env.SMTP_PORT);
  const secureValue = process.env.SMTP_SECURE;
  const user = singleLineValue(process.env.SMTP_USER, 254);
  const pass = typeof process.env.SMTP_APP_PASSWORD === 'string'
    ? process.env.SMTP_APP_PASSWORD
    : '';
  const to = singleLineValue(process.env.CONTACT_TO_EMAIL, 254);

  if (
    !host
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || !['true', 'false'].includes(secureValue)
    || !isValidEmail(user)
    || !pass
    || /[\r\n]/.test(pass)
    || !isValidEmail(to)
  ) {
    return null;
  }

  return {
    host,
    port,
    secure: secureValue === 'true',
    user,
    pass,
    to
  };
}

module.exports = async function contactHandler(request, response) {
  response.setHeader('Cache-Control', 'no-store');

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'POSTメソッドのみ利用できます' });
  }

  const origin = request.headers.origin;
  const expectedOrigin = request.headers.host ? `https://${request.headers.host}` : '';
  if (origin && expectedOrigin && origin !== expectedOrigin) {
    return response.status(403).json({ error: '送信元を確認できませんでした' });
  }

  let body = request.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return response.status(400).json({ error: '入力内容を確認してください' });
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return response.status(400).json({ error: '入力内容を確認してください' });
  }

  let bodySize;
  try {
    bodySize = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return response.status(400).json({ error: '入力内容を確認してください' });
  }
  if (bodySize > MAX_BODY_BYTES) {
    return response.status(413).json({ error: '入力内容が長すぎます' });
  }

  if (singleLineValue(body.website, 200)) {
    return response.status(200).json({ success: true });
  }

  const company = singleLineValue(body.company, 100);
  const name = singleLineValue(body.name, 80);
  const email = singleLineValue(body.email, 254);
  const phone = singleLineValue(body.phone, 30);
  const industry = singleLineValue(body.industry, 80);
  const service = singleLineValue(body.service, 40);
  const message = messageValue(body.message, 2000);

  if (!company || !name || !email || !service || !message) {
    return response.status(400).json({ error: '必須項目を入力してください' });
  }
  if (!isValidEmail(email)) {
    return response.status(400).json({ error: 'メールアドレスを確認してください' });
  }
  if (!Object.prototype.hasOwnProperty.call(SERVICE_LABELS, service)) {
    return response.status(400).json({ error: 'ご希望の相談を選択してください' });
  }

  const smtp = loadSmtpConfig();
  if (!smtp) {
    console.error('Contact SMTP configuration is incomplete');
    return response.status(503).json({ error: '現在お問い合わせを送信できません' });
  }

  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass
    },
    tls: {
      minVersion: 'TLSv1.2'
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });

  const text = [
    'BeginAI 公式サイトからお問い合わせが届きました。',
    '',
    `会社名・屋号: ${company}`,
    `お名前: ${name}`,
    `メールアドレス: ${email}`,
    `電話番号: ${phone || '未入力'}`,
    `業種: ${industry || '未入力'}`,
    `ご希望の相談: ${SERVICE_LABELS[service]}`,
    '',
    'ご相談内容:',
    message
  ].join('\n');

  try {
    await transport.sendMail({
      from: {
        name: 'BeginAI お問い合わせ',
        address: smtp.user
      },
      to: smtp.to,
      replyTo: {
        name,
        address: email
      },
      subject: `[BeginAI HP] ${company} 様からのお問い合わせ`,
      text
    });

    return response.status(200).json({ success: true });
  } catch {
    console.error('Contact SMTP delivery failed');
    return response.status(502).json({ error: '送信できませんでした' });
  }
};
