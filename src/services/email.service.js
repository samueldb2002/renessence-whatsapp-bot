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
  const subject = `Your Renessence booking - ${serviceName}`;
  const html = `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif; max-width:600px; margin:0 auto; background:#ffffff;">
      <!-- Header -->
      <div style="padding:40px 30px; text-align:center; border-bottom:3px solid ${brandRed};">
        <img src="cid:renessence-logo" alt="Renessence" style="height:60px; width:auto;" />
      </div>

      <!-- Body -->
      <div style="padding:40px 30px;">
        <h2 style="color:#2c2c2c; margin-top:0; font-weight:400; font-size:24px;">Booking Confirmed</h2>
        <p style="color:#555; font-size:15px; line-height:1.6;">Dear ${customerName || 'Guest'},</p>
        <p style="color:#555; font-size:15px; line-height:1.6;">Your appointment has been confirmed. Here are the details:</p>

        <!-- Booking details card -->
        <div style="background:#faf8f6; border-left:4px solid ${brandRed}; padding:24px; margin:24px 0; border-radius:0 8px 8px 0;">
          <table style="border-collapse:collapse; width:100%;">
            <tr>
              <td style="padding:10px 8px 10px 0; font-weight:600; color:#888; width:110px; font-size:13px; text-transform:uppercase; letter-spacing:0.5px;">Treatment</td>
              <td style="padding:10px 8px; color:#2c2c2c; font-size:15px;">${serviceName}</td>
            </tr>
            <tr>
              <td style="padding:10px 8px 10px 0; font-weight:600; color:#888; font-size:13px; text-transform:uppercase; letter-spacing:0.5px;">Date</td>
              <td style="padding:10px 8px; color:#2c2c2c; font-size:15px;">${date}</td>
            </tr>
            <tr>
              <td style="padding:10px 8px 10px 0; font-weight:600; color:#888; font-size:13px; text-transform:uppercase; letter-spacing:0.5px;">Time</td>
              <td style="padding:10px 8px; color:#2c2c2c; font-size:15px;">${time}</td>
            </tr>
            <tr>
              <td style="padding:10px 8px 10px 0; font-weight:600; color:#888; font-size:13px; text-transform:uppercase; letter-spacing:0.5px;">Location</td>
              <td style="padding:10px 8px; color:#2c2c2c; font-size:15px;">${address || 'George Gershwinlaan 520, 1082 MT Amsterdam'}</td>
            </tr>
          </table>
        </div>

        <h3 style="color:#2c2c2c; font-weight:500; font-size:17px; margin-top:32px;">Before your visit</h3>
        <ul style="color:#555; line-height:2; font-size:14px; padding-left:20px;">
          <li>Please arrive 10 minutes before your appointment</li>
          <li>A robe and towel are provided; please bring your own slippers</li>
          <li>Cancellations within 24 hours will be charged at 100%</li>
        </ul>

        <h3 style="color:#2c2c2c; font-weight:500; font-size:17px; margin-top:32px;">How to find us</h3>
        <p style="color:#555; font-size:14px; line-height:1.6;">The entrance is located at the square between George Gershwinlaan and Gustav Mahlerlaan, directly in front of Rosso Pizza Bar.</p>
        <p style="margin-top:16px;">
          <a href="https://maps.google.com/?q=George+Gershwinlaan+520+Amsterdam" style="color:${brandRed}; font-size:14px; text-decoration:none; font-weight:500;">View on Google Maps &rarr;</a>
        </p>
      </div>

      <!-- Footer -->
      <div style="background:#faf8f6; padding:24px 30px; text-align:center; border-top:1px solid #eee;">
        <p style="color:#999; margin:0; font-size:13px;">Need to cancel or reschedule? Send us a WhatsApp message.</p>
        <p style="color:#bbb; margin:12px 0 0; font-size:11px;">Renessence &middot; George Gershwinlaan 520 &middot; 1082 MT Amsterdam</p>
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
