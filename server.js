// ===============================
// MIXO Backend - server.js
// ===============================

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import 'dotenv/config'; // load .env file locally

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===============================
// Environment Variables
// ===============================
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY;
const RENDER_URL = process.env.RENDER_URL;
const ADMIN_PASS = process.env.ADMIN_PASS;

// ===============================
// Test endpoint
// ===============================
app.get('/', (req, res) => {
  res.send('MIXO Backend Running');
});

// ===============================
// Nodemailer Setup
// ===============================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// ===============================
// Generate PDF Ticket with QR Code
// ===============================
async function generateTicketPDF(ticketNumber, email) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A6', margin: 20 });
      const folder = path.join('tickets');
      if (!fs.existsSync(folder)) fs.mkdirSync(folder);
      const filePath = path.join(folder, `${ticketNumber}.pdf`);
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Background
      doc.rect(0, 0, doc.page.width, doc.page.height).fill('#0a0a0a');

      // Title
      doc.fillColor('#FF0000')
        .fontSize(20)
        .text('MIXO Ticket', { align: 'center', valign: 'center' });

      // QR Code
      const qrData = `${RENDER_URL}/validate/${ticketNumber}`;
      const qrImg = await QRCode.toDataURL(qrData);
      doc.image(qrImg, doc.page.width / 2 - 75, 80, { width: 150 });

      // Ticket info
      doc.fillColor('white').fontSize(12)
        .text(`Ticket #: ${ticketNumber}`, 20, 250)
        .text(`Email: ${email}`, 20, 270);

      doc.end();
      stream.on('finish', () => resolve(filePath));
    } catch (e) {
      reject(e);
    }
  });
}

// ===============================
// Send Ticket via Email
// ===============================
async function sendTicket(email, filePath) {
  await transporter.sendMail({
    from: `"MIXO Tickets" <${EMAIL_USER}>`,
    to: email,
    subject: 'Your MIXO Ticket',
    text: 'Please find your ticket attached.',
    attachments: [{ filename: path.basename(filePath), path: filePath }]
  });
}

// ===============================
// Create Mollie Payment
// ===============================
app.post('/create-payment', async (req, res) => {
  const { quantity, email } = req.body;
  if (!quantity || !email) return res.status(400).json({ error: 'Quantity and email required' });

  const totalPrice = (quantity * 8.18).toFixed(2); // €7.50 + 9% BTW

  try {
    // Call Mollie API
    const response = await fetch('https://api.mollie.com/v2/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MOLLIE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: { currency: 'EUR', value: totalPrice.toString() },
        description: `MIXO Ticket x${quantity}`,
        redirectUrl: `https://intheflo.xyz/thank-you`,
        webhookUrl: `${RENDER_URL}/mollie-webhook`
      })
    });

    const data = await response.json();
    if (!data.checkoutUrl) return res.status(500).json({ error: 'Failed to create Mollie payment', data });

    // Optionally, generate tickets and email after payment completed via webhook

    res.json({ checkoutUrl: data.checkoutUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.toString() });
  }
});

// ===============================
// Webhook for Mollie Payment Completed
// ===============================
app.post('/mollie-webhook', async (req, res) => {
  // Here you validate the payment via Mollie API, then generate tickets
  // Example: fetch payment status from Mollie, if paid, generate PDF and send email
  res.sendStatus(200);
});

// ===============================
// Start server
// ===============================
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
