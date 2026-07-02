'use strict';

const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const useFileTransport = !process.env.SMTP_USER || !process.env.SMTP_PASS;
const outboxPath = path.join(__dirname, '../../data/dev_emails.json');

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

function writeToOutbox(message) {
  const dataDir = path.dirname(outboxPath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const outbox = fs.existsSync(outboxPath) ? JSON.parse(fs.readFileSync(outboxPath, 'utf8')) : [];
  outbox.push({ ...message, sentAt: new Date().toISOString() });
  fs.writeFileSync(outboxPath, JSON.stringify(outbox, null, 2));
  console.log(`[email] No SMTP credentials set — wrote "${message.subject}" for ${message.to} to ${outboxPath}`);
}

const FROM = `"${process.env.EMAIL_FROM_NAME || 'Fitanya'}" <${process.env.EMAIL_FROM || 'noreply@fitanya.com'}>`;

const baseTemplate = (content) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #0a0a0a; color: #fff; margin: 0; padding: 0; }
    .wrapper { max-width: 600px; margin: 0 auto; background: #111; border-radius: 16px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #ff6b35, #f7931e); padding: 32px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; font-weight: 900; letter-spacing: 2px; color: #fff; }
    .header p { margin: 4px 0 0; color: rgba(255,255,255,0.8); font-size: 13px; letter-spacing: 1px; }
    .body { padding: 32px; }
    .body p { color: #ccc; line-height: 1.7; }
    .btn { display: inline-block; background: linear-gradient(135deg, #ff6b35, #f7931e); color: #fff !important;
           padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; margin: 16px 0; }
    .otp { font-size: 40px; font-weight: 900; letter-spacing: 12px; color: #ff6b35; text-align: center;
           background: #1a1a1a; border-radius: 12px; padding: 24px; margin: 20px 0; }
    .detail-box { background: #1a1a1a; border-radius: 12px; padding: 20px; margin: 16px 0; }
    .detail-box p { margin: 6px 0; color: #aaa; }
    .detail-box strong { color: #fff; }
    .footer { text-align: center; padding: 24px; border-top: 1px solid #222; color: #555; font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>FITANYA</h1>
      <p>TRANSFORM · PERFORM · EXCEL</p>
    </div>
    <div class="body">${content}</div>
    <div class="footer">© ${new Date().getFullYear()} Fitanya. All rights reserved.</div>
  </div>
</body>
</html>`;

async function sendMail({ to, subject, html, text }) {
  if (useFileTransport) return writeToOutbox({ from: FROM, to, subject, html, text });
  const mailer = getTransporter();
  return mailer.sendMail({ from: FROM, to, subject, html, text });
}

async function sendOtp({ to, name, otp }) {
  return sendMail({
    to, subject: 'Your Fitanya OTP Verification Code',
    html: baseTemplate(`
      <p>Hi <strong>${name}</strong>,</p>
      <p>Your one-time password for Fitanya registration is:</p>
      <div class="otp">${otp}</div>
      <p style="text-align:center;color:#666;font-size:13px;">This OTP expires in <strong style="color:#ff6b35">10 minutes</strong>. Do not share it with anyone.</p>
    `),
  });
}

async function sendWelcome({ to, name }) {
  return sendMail({
    to, subject: 'Welcome to Fitanya! Your journey starts now 🔥',
    html: baseTemplate(`
      <p>Hi <strong>${name}</strong>,</p>
      <p>Welcome to <strong>Fitanya</strong>! Your account is ready and your fitness transformation journey begins today.</p>
      <p>Login to your dashboard to book your first session, track your progress, and connect with your coach.</p>
      <a href="${process.env.APP_URL}/login" class="btn">Go to My Dashboard</a>
    `),
  });
}

async function sendBookingConfirmation({ to, name, booking, meetLink }) {
  return sendMail({
    to, subject: `Session Confirmed — ${booking.date} at ${booking.start_time}`,
    html: baseTemplate(`
      <p>Hi <strong>${name}</strong>,</p>
      <p>Your training session has been confirmed! Here are your details:</p>
      <div class="detail-box">
        <p>📅 <strong>Date:</strong> ${booking.date}</p>
        <p>⏰ <strong>Time:</strong> ${booking.start_time} – ${booking.end_time}</p>
        <p>👤 <strong>Coach:</strong> ${booking.coach_name}</p>
        <p>⏱ <strong>Duration:</strong> 1 Hour</p>
      </div>
      <p>Join your session using this Google Meet link:</p>
      <a href="${meetLink}" class="btn">Join Google Meet</a>
      <p style="color:#666;font-size:13px;">Please join 5 minutes early. If you need to reschedule, do so at least 24 hours before the session.</p>
    `),
  });
}

async function sendSessionReminder({ to, name, booking, meetLink }) {
  return sendMail({
    to, subject: `Reminder: Your session is tomorrow at ${booking.start_time}`,
    html: baseTemplate(`
      <p>Hi <strong>${name}</strong>,</p>
      <p>Just a reminder that you have a training session tomorrow!</p>
      <div class="detail-box">
        <p>📅 <strong>Date:</strong> ${booking.date}</p>
        <p>⏰ <strong>Time:</strong> ${booking.start_time}</p>
        <p>👤 <strong>Coach:</strong> ${booking.coach_name}</p>
      </div>
      <a href="${meetLink}" class="btn">Join Google Meet</a>
    `),
  });
}

async function sendPaymentConfirmation({ to, name, payment, packageName }) {
  return sendMail({
    to, subject: `Payment Confirmed — ₹${payment.final_amount} for ${packageName}`,
    html: baseTemplate(`
      <p>Hi <strong>${name}</strong>,</p>
      <p>Your payment has been received successfully!</p>
      <div class="detail-box">
        <p>📦 <strong>Package:</strong> ${packageName}</p>
        <p>💰 <strong>Amount Paid:</strong> ₹${payment.final_amount}</p>
        <p>🧾 <strong>Transaction ID:</strong> ${payment.transaction_id || 'N/A'}</p>
        <p>📅 <strong>Date:</strong> ${new Date().toLocaleDateString('en-IN')}</p>
      </div>
      <p>Your membership is now active. Please complete your registration to get started.</p>
      <a href="${process.env.APP_URL}/register" class="btn">Complete Registration</a>
    `),
  });
}

async function sendRegistrationRequest({ to, name, packageName }) {
  return sendMail({
    to, subject: 'Complete your Fitanya Registration',
    html: baseTemplate(`
      <p>Hi <strong>${name}</strong>,</p>
      <p>Thank you for choosing the <strong>${packageName}</strong> plan!</p>
      <p>Please complete your registration to activate your account and start booking sessions with your coach.</p>
      <a href="${process.env.APP_URL}/register?email=${encodeURIComponent(to)}" class="btn">Complete Registration</a>
      <p style="color:#666;font-size:13px;">Use the same email address you used during signup.</p>
    `),
  });
}

async function sendReferralReward({ to, name, rewardValue }) {
  return sendMail({
    to, subject: `🎉 You earned ₹${rewardValue} referral reward!`,
    html: baseTemplate(`
      <p>Hi <strong>${name}</strong>,</p>
      <p>Great news! Someone you referred has joined Fitanya and completed their first payment.</p>
      <div class="detail-box">
        <p>🎁 <strong>Reward Credited:</strong> ₹${rewardValue}</p>
        <p>💡 Use this credit on your next membership renewal!</p>
      </div>
      <a href="${process.env.APP_URL}/dashboard/membership" class="btn">View My Credits</a>
    `),
  });
}

module.exports = {
  sendMail, sendOtp, sendWelcome, sendBookingConfirmation,
  sendSessionReminder, sendPaymentConfirmation, sendRegistrationRequest,
  sendReferralReward,
};
