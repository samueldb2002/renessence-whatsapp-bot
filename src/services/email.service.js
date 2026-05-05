const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const TENANT_ID = process.env.MS_TENANT_ID;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const SENDER_EMAIL = process.env.MS_SENDER_EMAIL || 'bookings@renessence.com';

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }
  const res = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return accessToken;
}

async function sendMail({ to, subject, html, text, attachments }) {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    logger.warn('Microsoft Graph not configured. Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET in env.');
    return { sent: false };
  }

  const token = await getAccessToken();

  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: [{ emailAddress: { address: to } }],
  };

  if (attachments && attachments.length > 0) {
    message.attachments = attachments;
  }

  await axios.post(
    `https://graph.microsoft.com/v1.0/users/${SENDER_EMAIL}/sendMail`,
    { message, saveToSentItems: true },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Send escalation email to the team
 */
async function sendEscalationEmail({ customerName, customerPhone, message, conversationHistory }) {
  const toEmail = process.env.ESCALATION_EMAIL || 'welcome@renessence.com';

  const subject = `WhatsApp Escalation - ${customerName || customerPhone}`;
  const html = `
    <h2>Customer needs help</h2>
    <table style="border-collapse:collapse; font-family:Arial,sans-serif;">
      <tr><td style="padding:8px; font-weight:bold;">Name:</td><td style="padding:8px;">${customerName || 'Unknown'}</td></tr>
      <tr><td style="padding:8px; font-weight:bold;">Phone:</td><td style="padding:8px;"><a href="https://wa.me/${customerPhone}">+${customerPhone}</a></td></tr>
      <tr><td style="padding:8px; font-weight:bold;">Message:</td><td style="padding:8px;">${message || 'Requested human assistance'}</td></tr>
    </table>
    ${conversationHistory ? `<h3>Recent conversation</h3><pre style="background:#f5f5f5; padding:12px; border-radius:4px;">${conversationHistory}</pre>` : ''}
    <p style="color:#888; font-size:12px;">Sent by Renessence WhatsApp Bot</p>
  `;

  try {
    await sendMail({ to: toEmail, subject, html });
    logger.info('Escalation email sent to', toEmail);
    return { sent: true };
  } catch (err) {
    logger.error('Failed to send escalation email:', err.message, err.response?.data);
    logger.info('ESCALATION (email failed):', JSON.stringify({ customerName, customerPhone, message }));
    return { sent: false, error: err.message };
  }
}

/**
 * Send booking confirmation email to the customer
 */
async function sendBookingConfirmationEmail({ customerEmail, customerName, serviceName, date, time }) {
  if (!customerEmail) return { sent: false };

  const brandRed = '#C43E3E';
  const subject = `Renessence Appointment Is Booked for ${date} at ${time}`;

  // Inline logo as base64
  let logoAttachment = null;
  try {
    const logoPath = path.join(__dirname, '../../public/logo.png');
    const logoData = fs.readFileSync(logoPath).toString('base64');
    logoAttachment = {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'logo.png',
      contentType: 'image/png',
      contentBytes: logoData,
      contentId: 'renessence-logo',
      isInline: true,
    };
  } catch (e) {
    logger.warn('Could not load logo for email:', e.message);
  }

  const html = `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; max-width:600px; margin:0 auto; background:#ffffff;">
      <!-- Header -->
      <div style="padding:40px 30px; text-align:center; border-bottom:3px solid ${brandRed};">
        ${logoAttachment ? `<img src="cid:renessence-logo" alt="Renessence" style="height:60px; width:auto;" />` : '<strong style="font-size:22px;">Renessence</strong>'}
      </div>

      <!-- Body -->
      <div style="padding:40px 30px;">
        <p style="color:#555; font-size:15px; line-height:1.6;">Dear ${customerName || 'Guest'},</p>
        <p style="color:#555; font-size:15px; line-height:1.6;">We look forward to seeing you at Renessence!</p>
        <p style="color:#555; font-size:15px; line-height:1.6;">This confirms your journey at <strong>${time}</strong> on <strong>${date}</strong> for a <strong>${serviceName}</strong>.</p>

        <div style="margin:24px 0;"></div>

        <h3 style="color:#2c2c2c; font-weight:500; font-size:17px; margin-top:32px;">Arrival and preparation:</h3>
        <p style="color:#555; font-size:14px; line-height:1.6;">We kindly advise arriving 5 minutes early to settle in comfortably. Please note that your arrival time <strong>includes preparation time</strong>.</p>
        <p style="color:#555; font-size:14px; line-height:1.6;">At Renessence we will provide bathrobes and towels. You are welcome to bring your water bottle and slippers, or purchase them at reception.</p>

        <p style="color:#555; font-size:14px; line-height:1.6; margin-top:24px;">Cancellations are free of charge up to 24 hours before the scheduled start time. Cancellations made within 24 hours or no-shows will be charged 100% of the session fee.</p>

        <p style="color:#555; font-size:14px; line-height:1.6; margin-top:24px;">We look forward to welcoming you soon!</p>

        <p style="color:#555; font-size:14px; line-height:1.6; margin-top:24px;">Warmly,<br/>The Renessence Team</p>
        <p style="color:#555; font-size:14px; line-height:1.6;">
          Web: <a href="https://renessence.com" style="color:${brandRed}; text-decoration:none;">https://renessence.com</a><br/>
          Address: <a href="https://maps.google.com/?q=George+Gershwinlaan+520+Amsterdam" style="color:${brandRed}; text-decoration:none;">520 George Gershwinlaan 1082 MT Amsterdam NH</a>
        </p>
      </div>

      <!-- Footer -->
      <div style="background:#faf8f6; padding:24px 30px; text-align:center; border-top:1px solid #eee;">
        <p style="color:#bbb; margin:0; font-size:11px;">Renessence &middot; 520 George Gershwinlaan &middot; 1082 MT Amsterdam NH</p>
      </div>
    </div>
  `;

  try {
    await sendMail({
      to: customerEmail,
      subject,
      html,
      attachments: logoAttachment ? [logoAttachment] : undefined,
    });
    logger.info('Booking confirmation email sent to', customerEmail);
    return { sent: true };
  } catch (err) {
    logger.error('Failed to send booking confirmation email:', err.message, err.response?.data);
    return { sent: false, error: err.message };
  }
}

/**
 * Notify finance team of a refund needed after a paid booking is cancelled
 */
async function sendRefundNotificationEmail({ customerName, customerPhone, serviceName, dateTime, amountCents }) {
  const toEmail = 'finance@renessence.com';
  const amountFormatted = amountCents ? `€${(amountCents / 100).toFixed(2)}` : 'unknown';
  const subject = `Refund Request — ${customerName || customerPhone} — ${serviceName}`;
  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <h2 style="color:#C43E3E;">Refund Request</h2>
      <p>A paid booking has been cancelled via WhatsApp. Please process the refund.</p>
      <table style="border-collapse:collapse; width:100%;">
        <tr><td style="padding:8px; font-weight:bold; border-bottom:1px solid #eee;">Customer</td><td style="padding:8px; border-bottom:1px solid #eee;">${customerName || 'Unknown'}</td></tr>
        <tr><td style="padding:8px; font-weight:bold; border-bottom:1px solid #eee;">Phone (WhatsApp)</td><td style="padding:8px; border-bottom:1px solid #eee;"><a href="https://wa.me/${customerPhone}">+${customerPhone}</a></td></tr>
        <tr><td style="padding:8px; font-weight:bold; border-bottom:1px solid #eee;">Service</td><td style="padding:8px; border-bottom:1px solid #eee;">${serviceName}</td></tr>
        <tr><td style="padding:8px; font-weight:bold; border-bottom:1px solid #eee;">Date / Time</td><td style="padding:8px; border-bottom:1px solid #eee;">${dateTime}</td></tr>
        <tr><td style="padding:8px; font-weight:bold;">Amount paid</td><td style="padding:8px;">${amountFormatted}</td></tr>
      </table>
      <p style="color:#888; font-size:12px; margin-top:24px;">Sent automatically by Renessence WhatsApp Bot</p>
    </div>
  `;
  try {
    await sendMail({ to: toEmail, subject, html });
    logger.info('Refund notification sent to', toEmail);
    return { sent: true };
  } catch (err) {
    logger.error('Failed to send refund notification email:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendEscalationEmail, sendBookingConfirmationEmail, sendRefundNotificationEmail };
