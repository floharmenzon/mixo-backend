// server.js — MIXO Backend with QR validation, email, Mollie payments, admin panel
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --------------------
// Environment variables
// --------------------
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY;
const RENDER_URL = process.env.RENDER_URL;
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const THANKYOU_MESSAGE =
    process.env.THANKYOU_MESSAGE ||
    "Thank you, {email}, for purchasing {quantity} ticket(s)! Enjoy MIXO.";

// --------------------
// File paths
// --------------------
const TICKETS_FILE = "./ticketsData.json";
const USED_TICKETS_FILE = "./usedTickets.json";
const ISSUED_TICKETS_FILE = "./issuedTickets.json";
const PENDING_ORDERS_FILE = "./pendingOrders.json";
const AUDIT_LOG_FILE = "./audit.log";
const TICKETS_FOLDER = "./tickets";

// --------------------
// Safe file operations
// --------------------
function safeReadJSON(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify({}, null, 2));
            return {};
        }
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return {};
    }
}
function safeWriteJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
if (!fs.existsSync(TICKETS_FOLDER)) fs.mkdirSync(TICKETS_FOLDER, { recursive: true });

// --------------------
// Audit log
// --------------------
function logAudit(action, details = {}) {
    const entry = { ts: new Date().toISOString(), action, ...details };
    fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + "\n");
}

// --------------------
// Email
// --------------------
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

// --------------------
// PDF ticket creation
// --------------------
async function generateTicketPDF(ticketId, ticketName, email) {
    return new Promise(async (resolve, reject) => {
        try {
            const filePath = path.join(TICKETS_FOLDER, `${ticketId}.pdf`);
            const doc = new PDFDocument({ size: "A6", margin: 20 });
            const stream = fs.createWriteStream(filePath);
            doc.pipe(stream);

            doc.rect(0, 0, doc.page.width, doc.page.height).fill("#0a0a0a");
            doc.fillColor("#FF0000").fontSize(20).text("MIXO Ticket", { align: "center" });

            const qrData = `${RENDER_URL}/validate/${encodeURIComponent(ticketId)}`;
            const qrImg = await QRCode.toDataURL(qrData);
            doc.image(qrImg, doc.page.width / 2 - 75, 80, { width: 150 });

            doc.fillColor("white").fontSize(12)
                .text(`Ticket ID: ${ticketId}`, 20, 250)
                .text(`Type: ${ticketName}`, 20, 265)
                .text(`Email: ${email}`, 20, 280);

            doc.end();
            stream.on("finish", () => resolve(filePath));
        } catch (e) {
            reject(e);
        }
    });
}

// --------------------
// Email sender
// --------------------
async function sendTicketsEmail(email, filePaths, totalTickets) {
    const message = THANKYOU_MESSAGE
        .replace("{quantity}", totalTickets)
        .replace("{email}", email);

    await transporter.sendMail({
        from: `"MIXO Tickets" <${EMAIL_USER}>`,
        to: email,
        subject: `Your MIXO Tickets (${totalTickets})`,
        text: message,
        attachments: filePaths.map(f => ({ filename: path.basename(f), path: f })),
    });
    logAudit("email_sent", { to: email, totalTickets });
}

// --------------------
// Root
// --------------------
app.get("/", (req, res) => res.send("MIXO Backend Running"));

// --------------------
// Admin auth helper
// --------------------
function isAdmin(req) {
    const pass = req.query.pass || req.body?.pass || req.headers["x-admin-pass"];
    return pass && pass === ADMIN_PASS;
}

// --------------------
// Create Payment
// --------------------
app.post("/create-payment", async (req, res) => {
    const { tickets, email } = req.body;
    if (!tickets || !email) return res.status(400).json({ error: "Quantity and email required" });

    try {
        // Load sold tickets
        const ticketsData = safeReadJSON(TICKETS_FILE);

        // Check availability & total
        let totalAmount = 0;
        for (const t of tickets) {
            const sold = ticketsData[t.name]?.sold ?? 0;
            if (sold + t.quantity > (ticketsData[t.name]?.max ?? Infinity)) {
                return res.status(400).json({ error: `Not enough ${t.name} tickets available` });
            }
            totalAmount += t.price * t.quantity;
        }
        totalAmount = totalAmount.toFixed(2);

        // Create Mollie payment
        const response = await fetch("https://api.mollie.com/v2/payments", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${MOLLIE_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                amount: { currency: "EUR", value: totalAmount.toFixed(2) }, // convert here only
                description: `MIXO Tickets x${tickets.reduce((a, b) => a + b.quantity, 0)}`,
                redirectUrl: "https://www.intheflo.xyz/thank-you",
                webhookUrl: `${RENDER_URL}/mollie-webhook`,
                metadata: { email }
            })
        });

        const data = await response.json();
        // ✅ Add these logs right here
        console.log("Mollie response status:", response.status);
        console.log("Mollie response body:", JSON.stringify(data, null, 2));

        if (!data.checkoutUrl) return res.status(500).json({ error: "Failed to create Mollie payment", data });

        // Save pending order
        const pendingOrders = safeReadJSON(PENDING_ORDERS_FILE);
        pendingOrders[data.id] = { tickets, email };
        safeWriteJSON(PENDING_ORDERS_FILE, pendingOrders);

        res.json({ checkoutUrl: data.checkoutUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.toString() });
    }
});

// --------------------
// Mollie webhook
// --------------------
app.post("/mollie-webhook", async (req, res) => {
    const paymentId = req.body.id;
    if (!paymentId) return res.sendStatus(400);

    try {
        const mollieRes = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${MOLLIE_API_KEY}` }
        });
        const paymentData = await mollieRes.json();
        if (paymentData.status !== "paid") return res.sendStatus(200);

        // Load pending orders
        const pendingOrders = safeReadJSON(PENDING_ORDERS_FILE);
        const order = pendingOrders[paymentId];
        if (!order) return res.sendStatus(404);

        const ticketsData = safeReadJSON(TICKETS_FILE);
        const issuedTickets = safeReadJSON(ISSUED_TICKETS_FILE);
        const usedTickets = safeReadJSON(USED_TICKETS_FILE);

        const pdfPaths = [];
        let totalTickets = 0;

        for (const t of order.tickets) {
            ticketsData[t.name].sold = ticketsData[t.name].sold ?? 0;

            for (let i = 0; i < t.quantity; i++) {
                const ticketNumber = ticketsData[t.name].sold + 1;
                const ticketId = `${t.name}-${ticketNumber}-${Date.now()}`;
                ticketsData[t.name].sold++;

                issuedTickets[ticketId] = { name: t.name, email: order.email, issuedAt: new Date().toISOString(), paymentId };
                usedTickets[ticketId] = { used: false };

                const pdfPath = await generateTicketPDF(ticketId, t.name, order.email);
                pdfPaths.push(pdfPath);
                totalTickets++;
            }
        }

        safeWriteJSON(TICKETS_FILE, ticketsData);
        safeWriteJSON(ISSUED_TICKETS_FILE, issuedTickets);
        safeWriteJSON(USED_TICKETS_FILE, usedTickets);
        delete pendingOrders[paymentId];
        safeWriteJSON(PENDING_ORDERS_FILE, pendingOrders);

        await sendTicketsEmail(order.email, pdfPaths, totalTickets);

        res.sendStatus(200);
    } catch (e) {
        console.error(e);
        res.sendStatus(500);
    }
});

// --------------------
// Ticket validation
// --------------------
app.get("/validate/:ticketId", (req, res) => {
    const ticketId = req.params.ticketId;
    const usedTickets = safeReadJSON(USED_TICKETS_FILE);

    if (!usedTickets[ticketId])
        return res.status(404).send("<h2 style='color:orange'>⚠️ Ticket not found</h2>");
    if (usedTickets[ticketId].used)
        return res.status(410).send("<h2 style='color:red'>❌ Already used ticket</h2>");

    usedTickets[ticketId].used = true;
    usedTickets[ticketId].usedAt = new Date().toISOString();
    safeWriteJSON(USED_TICKETS_FILE, usedTickets);
    logAudit("ticket_validated", { ticketId });
    res.send("<h2 style='color:green'>✅ Ticket validated successfully</h2>");
});

// --------------------
// Admin endpoints
// --------------------
app.get("/admin/used-tickets", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "Unauthorized" });
    res.json(safeReadJSON(USED_TICKETS_FILE));
});

// --------------------
// Start server
// --------------------
app.listen(PORT, () => {
    console.log("✅ MIXO backend running on port " + PORT);
});
