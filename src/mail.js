const nodemailer = require('nodemailer');

// Build a reusable mail transporter from environment variables.
function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    // Fallback: a "console" transport used in development when SMTP is not configured.
    return {
      sendMail: async (options) => {
        // eslint-disable-next-line no-console
        console.log('[DEV MAIL]', {
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html
        });
      }
    };
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass
    }
  });
}

const defaultTransport = createTransport();

async function sendVerificationEmail({ to, token }) {
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const verifyUrl = `${baseUrl.replace(/\/+$/, '')}/auth/verify-email?token=${encodeURIComponent(
    token
  )}`;

  const from = process.env.MAIL_FROM || 'no-reply@example.com';
  const subject = 'Verify your email for WWW Chat';

  const text = [
    'Hi,',
    '',
    'Please click the link below to verify your email and start using the chat app:',
    verifyUrl,
    '',
    'If you did not sign up, you can safely ignore this email.'
  ].join('\n');

  const html = `
    <p>Hi,</p>
    <p>Please click the button below to verify your email and start using the chat app:</p>
    <p>
      <a href="${verifyUrl}" style="
        display:inline-block;
        padding:10px 18px;
        border-radius:999px;
        background:#2563eb;
        color:#ffffff;
        text-decoration:none;
        font-weight:600;
      ">Verify Email</a>
    </p>
    <p>Or open this link directly: <a href="${verifyUrl}">${verifyUrl}</a></p>
    <p>If you did not sign up, you can safely ignore this email.</p>
  `;

  await defaultTransport.sendMail({
    from,
    to,
    subject,
    text,
    html
  });
}

module.exports = {
  sendVerificationEmail
};

