// server.js — MIXO Backend with QR validation, email, admin panel, and scanner UI
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
// Safe file ops
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
// Ticket validation (QR)
// --------------------
app.get("/validate/:ticketId", (req, res) => {
    const ticketId = req.params.ticketId;
    const usedTickets = safeReadJSON(USED_TICKETS_FILE);

    if (!usedTickets[ticketId])
        return res.status(404).send("<h2 style='color:orange'>⚠️ Ticket not found</h2>");

    if (usedTickets[ticketId].used)
        return res
            .status(410)
            .send("<h2 style='color:red'>❌ Already used ticket</h2>");

    usedTickets[ticketId].used = true;
    usedTickets[ticketId].usedAt = new Date().toISOString();
    safeWriteJSON(USED_TICKETS_FILE, usedTickets);
    logAudit("ticket_validated", { ticketId });
    res.send("<h2 style='color:green'>✅ Ticket validated successfully</h2>");
});

// --------------------
// Admin auth helper
// --------------------
function isAdmin(req) {
    const pass = req.query.pass || req.body?.pass || req.headers["x-admin-pass"];
    return pass && pass === ADMIN_PASS;
}

// --------------------
// Admin scanner web page
// --------------------
app.get("/admin/scan", (req, res) => {
    if (!isAdmin(req)) return res.status(403).send("Unauthorized");

    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>MIXO Ticket Scanner</title>
<style>
  body { font-family: sans-serif; background:#111; color:#fff; text-align:center; padding:20px; }
  video { width:100%; max-width:400px; border:3px solid #444; border-radius:10px; }
  input { padding:10px; width:80%; margin:10px; font-size:16px; }
  button { padding:10px 20px; font-size:16px; }
  #result { margin-top:20px; font-size:18px; }
</style>
</head>
<body>
  <h2>🎟️ MIXO Ticket Scanner</h2>
  <video id="preview"></video>
  <p>or manually enter Ticket ID:</p>
  <input id="manualId" placeholder="Enter Ticket ID" />
  <button onclick="manualValidate()">Validate</button>
  <div id="result"></div>

  <script src="https://unpkg.com/html5-qrcode"></script>
  <script>
    const pass = new URLSearchParams(window.location.search).get('pass');
    const resultBox = document.getElementById('result');

    function showResult(msg, color) {
      resultBox.innerHTML = msg;
      resultBox.style.color = color;
    }

    async function validateTicket(ticketId) {
      if (!ticketId) return;
      const res = await fetch('/validate/' + encodeURIComponent(ticketId));
      const text = await res.text();
      if (res.status === 200) showResult('✅ VALID: ' + ticketId, 'lightgreen');
      else if (res.status === 410) showResult('❌ USED: ' + ticketId, 'red');
      else if (res.status === 404) showResult('⚠️ NOT FOUND: ' + ticketId, 'orange');
      else showResult('⚠️ Error validating', 'orange');
    }

    async function manualValidate() {
      const val = document.getElementById('manualId').value.trim();
      validateTicket(val);
    }

    // QR scanner
    const html5QrCode = new Html5Qrcode("preview");
    html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 250 },
      (decodedText) => {
        html5QrCode.stop();
        validateTicket(decodedText.split('/').pop());
        setTimeout(() => location.reload(), 3000);
      },
      (err) => {}
    );
  </script>
</body>
</html>
  `);
});

// --------------------
// Admin view used tickets
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
