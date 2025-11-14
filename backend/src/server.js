import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

import adminRouter from "./admin.js";

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const TICKETS_FOLDER = "./backend/tickets";
if (!fs.existsSync(TICKETS_FOLDER)) fs.mkdirSync(TICKETS_FOLDER, { recursive: true });

// Email transporter
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// -----------------
// Generate Ticket PDF
// -----------------
async function generateTicketPDF(ticketId, ticket, event, email) {
    return new Promise(async (resolve, reject) => {
        try {
            const filePath = path.join(TICKETS_FOLDER, `${ticketId}.pdf`);
            const doc = new PDFDocument({ size: "A4", margin: 40 });
            const stream = fs.createWriteStream(filePath);
            doc.pipe(stream);

            // Background
            if (event.backgroundURL) doc.image(event.backgroundURL, 0, 0, { width: doc.page.width, height: doc.page.height });

            // Logo
            if (event.logoURL) doc.image(event.logoURL, doc.page.width / 2 - 50, 40, { width: 100 });

            // Ticket info
            doc.moveDown(10).fillColor("black").fontSize(16)
                .text(`Ticket ID: ${ticketId}`, { align: "left" })
                .text(`Type: ${ticket.name}`, { align: "left" })
                .text(`Email: ${email}`, { align: "left" })
                .text(`Event: ${event.name}`, { align: "left" })
                .text(`Date: ${event.date.toDateString()} ${event.date.toLocaleTimeString()}`, { align: "left" })
                .text(`Ticket Code: ${ticket.code}`, { align: "left" });

            // QR Code
            const qrData = `${process.env.RENDER_URL}/validate.html?ticketId=${encodeURIComponent(ticketId)}`;
            const qrImg = await QRCode.toDataURL(qrData);
            doc.image(qrImg, doc.page.width - 180, 200, { width: 150 });

            // Footer
            doc.moveDown(15).fontSize(12).fillColor("gray")
                .text("For more information or questions, please check out:", { align: "center" })
                .text("Website: www.intheflo.xyz", { align: "center" })
                .text("Instagram: www.instagram.com/intheflo.xyz", { align: "center" })
                .text("Facebook: www.facebook.com/intheflo.xyz", { align: "center" });

            doc.end();
            stream.on("finish", () => resolve(filePath));
        } catch (e) { reject(e); }
    });
}

// -----------------
// Get tickets per event
// -----------------
app.get("/events/:id/tickets", async (req, res) => {
    const { id } = req.params;

    const tickets = await prisma.ticket.findMany({
        where: { eventId: id }
    });

    const processed = tickets.map(t => {
        let status = "available";
        let statusLabel = "Available";

        if (t.sold >= t.max) {
            status = "unavailable";
            statusLabel = "Sold Out";
        }

        return {
            ...t,
            status,
            statusLabel
        };
    });

    res.json(processed);
});

// -----------------
// Create payment
// -----------------
app.post("/create-payment", async (req, res) => {
    const { tickets: selectedTickets, email, eventId } = req.body;
    if (!selectedTickets || !email || !eventId) return res.status(400).json({ error: "Missing data" });

    try {
        const event = await prisma.event.findUnique({ where: { id: eventId }, include: { tickets: true } });
        if (!event) return res.status(404).json({ error: "Event not found" });

        let totalAmount = 0;
        for (const t of selectedTickets) {
            const ticket = await prisma.ticket.findUnique({ where: { id: t.id } });
            if (!ticket) return res.status(400).json({ error: "Ticket not found" });
            if (ticket.sold + t.quantity > ticket.max) return res.status(400).json({ error: `Not enough ${ticket.name} tickets` });
            totalAmount += ticket.price * t.quantity * 1.09;
        }

        const response = await fetch("https://api.mollie.com/v2/payments", {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                amount: { currency: "EUR", value: totalAmount.toFixed(2) },
                description: `Tickets for ${event.name}`,
                redirectUrl: `https://www.intheflo.xyz/thank-you`,
                webhookUrl: `${process.env.RENDER_URL}/mollie-webhook`,
                metadata: { email, eventId, selectedTickets }
            })
        });

        const data = await response.json();
        res.json({ checkoutUrl: data._links.checkout.href });
    } catch (e) { res.status(500).json({ error: e.toString() }); }
});

// -----------------
// Mollie webhook
// -----------------
app.post("/mollie-webhook", async (req, res) => {
    res.sendStatus(200);

    const paymentId = req.body.id;
    if (!paymentId) return;

    const mollieRes = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` }
    });
    const paymentData = await mollieRes.json();
    if (paymentData.status !== "paid") return;

    const { eventId, selectedTickets, email } = paymentData.metadata;
    const event = await prisma.event.findUnique({ where: { id: eventId }, include: { tickets: true } });

    for (const t of event.tickets) {
        const quantity = selectedTickets.find(s => s.id === t.id)?.quantity || 0;
        if (quantity <= 0) continue;

        for (let i = 0; i < quantity; i++) {
            const ticketId = `${t.code}-${Date.now()}-${i}`;
            await prisma.issuedTicket.create({
                data: {
                    id: ticketId,
                    ticketId: t.id,
                    ticketCode: t.code,   // <-- add this
                    email,
                    paymentId,
                    used: false
                }
            });

            await generateTicketPDF(ticketId, t, event, email);
        }
    }

    // Optionally send email here
});

// -----------------
// Validate ticket
// -----------------
app.get("/validate/:ticketId", async (req, res) => {
    const { ticketId } = req.params;
    const ticket = await prisma.issuedTicket.findUnique({ where: { id: ticketId }, include: { ticket: true, ticket: { include: { event: true } } } });
    if (!ticket) return res.status(404).send("Ticket not found");
    if (ticket.used) return res.status(410).send("Ticket already used");

    await prisma.issuedTicket.update({ where: { id: ticketId }, data: { used: true, usedAt: new Date() } });
    res.send("✅ Ticket validated successfully");
});

// -----------------
// Admin routes
// -----------------
app.use("/admin", adminRouter);

app.listen(PORT, () => console.log("✅ Backend running on port " + PORT));
