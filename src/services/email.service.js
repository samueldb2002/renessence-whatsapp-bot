const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../utils/logger');

// Create transporter from env config
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT || 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    logger.warn('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(smtpPort),
    secure: parseInt(smtpPort) === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  return transporter;
}

/**
 * Send escalation email to the team
 */
async function sendEscalationEmail({ customerName, customerPhone, message, conversationHistory }) {
  const t = getTransporter();

  const toEmail = process.env.ESCALATION_EMAIL || 'welcome@renessence.com';
  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'bot@renessence.com';

  const subject = `🔔 WhatsApp Escalation - ${customerName || customerPhone}`;
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

  const text = `Customer needs help\nName: ${customerName || 'Unknown'}\nPhone: +${customerPhone}\nMessage: ${message || 'Requested human assistance'}`;

  if (!t) {
    // SMTP not configured — log the escalation so it's not lost
    logger.warn('SMTP not configured. Escalation logged:');
    logger.info('ESCALATION:', JSON.stringify({ customerName, customerPhone, message, toEmail }));
    return { logged: true, sent: false };
  }

  try {
    const info = await t.sendMail({
      from: `"Renessence Bot" <${fromEmail}>`,
      to: toEmail,
      subject,
      text,
      html,
    });
    logger.info('Escalation email sent:', info.messageId);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    logger.error('Failed to send escalation email:', err.message);
    // Still log it so the escalation isn't lost
    logger.info('ESCALATION (email failed):', JSON.stringify({ customerName, customerPhone, message }));
    return { sent: false, error: err.message };
  }
}

/**
 * Send booking confirmation email to the customer
 */
async function sendBookingConfirmationEmail({ customerEmail, customerName, serviceName, date, time, address }) {
  const t = getTransporter();
  if (!t || !customerEmail) return { sent: false };

  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'bot@renessence.com';

  const logoUrl = 'https://cdn.prod.website-files.com/6944f6c696a89e0710a0c48f/694545b808ffa18badf9126f_renessence_logo.png';
  const brandRed = '#C43E3E';
  const subject = `Renessence Appointment Is Booked for ${date} at ${time}`;
  const html = `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; max-width:600px; margin:0 auto; background:#ffffff;">
      <!-- Header -->
      <div style="padding:40px 30px; text-align:center; border-bottom:3px solid ${brandRed};">
        <img src="cid:renessence-logo" alt="Renessence" style="height:60px; width:auto;" />
      </div>

      <!-- Body -->
      <div style="padding:40px 30px;">
        <p style="color:#555; font-size:15px; line-height:1.6;">Dear ${customerName || 'Guest'},</p>
        <p style="color:#555; font-size:15px; line-height:1.6;">We look forward to seeing you at Renessence!</p>
        <p style="color:#555; font-size:15px; line-height:1.6;">This confirms your journey at <strong>${time}</strong> on <strong>${date}</strong> for a <strong>${serviceName}</strong>.</p>

        <!-- Spacer -->
        <div style="margin:24px 0;"></div>

        <h3 style="color:#2c2c2c; font-weight:500; font-size:17px; margin-top:32px;">Arrival and preparation:</h3>
        <p style="color:#555; font-size:14px; line-height:1.6;">We kindly advise arriving 5 minutes early to settle in comfortably. Please note, that your arrival time <strong>includes preparation time</strong>.</p>
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

  const logoPath = require('path').join(__dirname, '../../public/logo.png');

  try {
    const info = await t.sendMail({
      from: `"Renessence" <${fromEmail}>`,
      to: customerEmail,
      subject,
      html,
      attachments: [{
        filename: 'logo.png',
        path: logoPath,
        cid: 'renessence-logo',
      }],
    });
    logger.info('Booking confirmation email sent to', customerEmail, ':', info.messageId);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    logger.error('Failed to send booking confirmation email:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendEscalationEmail, sendBookingConfirmationEmail };
