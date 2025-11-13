import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ENV Variables
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY;
const RENDER_URL = process.env.RENDER_URL;
const THANKYOU_MESSAGE = process.env.THANKYOU_MESSAGE || "Thank you for purchasing {quantity} tickets!";

// Nodemailer setup
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// Load tickets sold data
const ticketsFile = './ticketsData.json';
function loadTicketsData() { return JSON.parse(fs.readFileSync(ticketsFile)); }
function saveTicketsData(data) { fs.writeFileSync(ticketsFile, JSON.stringify(data, null, 2)); }

// Test endpoint
app.get('/', (req, res) => res.send('MIXO Backend Running'));

// Generate a PDF ticket
async function generateTicketPDF(ticketName, ticketNumber, email) {
    return new Promise(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A6', margin: 20 });
            const folder = path.join('tickets');
            if (!fs.existsSync(folder)) fs.mkdirSync(folder);
            const filePath = path.join(folder, `${ticketName}-${ticketNumber}.pdf`);
            const stream = fs.createWriteStream(filePath);
            doc.pipe(stream);

            // Background
            doc.rect(0, 0, doc.page.width, doc.page.height).fill('#0a0a0a');

            // Title
            doc.fillColor('#FF0000').fontSize(20).text('MIXO Ticket', { align: 'center', valign: 'center' });

            // QR code linking to validate endpoint
            const qrData = `${RENDER_URL}/validate/${ticketName}-${ticketNumber}`;
            const qrImg = await QRCode.toDataURL(qrData);
            doc.image(qrImg, doc.page.width / 2 - 75, 80, { width: 150 });

            // Ticket info
            doc.fillColor('white').fontSize(12)
                .text(`Ticket #: ${ticketNumber}`, 20, 250)
                .text(`Type: ${ticketName}`, 20, 265)
                .text(`Email: ${email}`, 20, 280);

            doc.end();
            stream.on('finish', () => resolve(filePath));
        } catch (e) { reject(e); }
    });
}

// Send email with PDF tickets
async function sendTicketsEmail(email, filePaths, totalTickets) {
    const message = THANKYOU_MESSAGE.replace("{quantity}", totalTickets);
    await transporter.sendMail({
        from: `"MIXO Tickets" <${EMAIL_USER}>`,
        to: email,
        subject: 'Your MIXO Tickets',
        text: message,
        attachments: filePaths.map(f => ({ filename: path.basename(f), path: f }))
    });
}

// Create Mollie Payment
app.post('/create-payment', async (req, res) => {
    const { tickets: selectedTickets, email } = req.body;
    if (!selectedTickets || !email) return res.status(400).json({ error: "Quantity and email required" });

    const ticketsData = loadTicketsData();
    let totalAmount = 0;

    // Check availability & calculate total
    for (const t of selectedTickets) {
        const sold = ticketsData[t.name]?.sold ?? 0;
        if (t.quantity + sold > ticketsData[t.name]?.max) {
            return res.status(400).json({ error: `Not enough ${t.name} tickets available` });
        }
        totalAmount += t.quantity * t.price;
    }

    totalAmount = totalAmount.toFixed(2);

    try {
        // Mollie API request
        const response = await fetch('https://api.mollie.com/v2/payments', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MOLLIE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                amount: { currency: 'EUR', value: totalAmount.toString() },
                description: `MIXO Tickets x${selectedTickets.reduce((a, b) => a + b.quantity, 0)}`,
                redirectUrl: "https://www.intheflo.xyz/thank-you",
                webhookUrl: `${RENDER_URL}/mollie-webhook`
            })
        });

        const data = await response.json();
        if (!data.checkoutUrl) return res.status(500).json({ error: "Failed to create Mollie payment", data });

        // Temporarily store order in memory or DB here if needed for webhook validation
        // You could store selectedTickets and email keyed by payment ID

        res.json({ checkoutUrl: data.checkoutUrl });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.toString() });
    }
});

// Mollie webhook
app.post('/mollie-webhook', async (req, res) => {
    // Example: you would fetch payment details from Mollie using payment ID
    // Then confirm the payment was successful
    // For each ticket type, generate PDFs and update ticketsData.json

    // Simulated: Assume we received order details (in real: use Mollie payment ID)
    // Example payload:
    /*
    const order = {
      email: "customer@example.com",
      tickets: [
        { name:"Standard", price:7.50, quantity:2 }
      ]
    };
    */

    // For demo, you would replace this with real webhook handling
    // After confirmation:
    /*
    const pdfPaths = [];
    let totalTickets = 0;
    for(const t of order.tickets){
      for(let i=1;i<=t.quantity;i++){
        const ticketNumber = ticketsData[t.name].sold + 1;
        ticketsData[t.name].sold++;
        saveTicketsData(ticketsData);
        const pdfPath = await generateTicketPDF(t.name, ticketNumber, order.email);
        pdfPaths.push(pdfPath);
        totalTickets++;
      }
    }
    await sendTicketsEmail(order.email, pdfPaths, totalTickets);
    */

    res.sendStatus(200);
});

// Validate QR ticket (optional)
app.get('/validate/:ticketId', (req, res) => {
    const ticketId = req.params.ticketId;
    // Here you can implement: check if ticketId was used already
    // Mark as used and return success/fail
    res.send(`Ticket ${ticketId} scanned (demo).`);
});

app.listen(PORT, () => console.log(`MIXO Backend running on port ${PORT}`));
