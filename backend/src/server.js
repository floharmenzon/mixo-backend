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

// Home route
app.get("/", (req, res) => {
    res.send("✅ MIXO Backend is running!");
});

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
async function generateTicketPDF(uniqueTicketId, ticket, event, email) {
    return new Promise(async (resolve, reject) => {
        const filePath = `/tmp/ticket-${uniqueTicketId}.pdf`;
        const doc = new PDFDocument({
            size: "A4",
            margin: 0
        });

        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);

        // ---- BACKGROUND IMAGE ----
        try {
            const bgBuffer = await fetch(event.backgroundURL).then(r => r.arrayBuffer());
            doc.image(Buffer.from(bgBuffer), 0, 0, { width: doc.page.width, height: doc.page.height });
        } catch (err) {
            console.log("⚠ Could not load background image");
        }

        // ---- EVENT LOGO (centered & 1.5× bigger) ----
        try {
            const logoBuffer = await fetch(event.logoURL).then(res => res.arrayBuffer());
            const logoWidth = 180; // bigger
            doc.image(Buffer.from(logoBuffer),
                (doc.page.width - logoWidth) / 2,
                40,
                { width: logoWidth }
            );
        } catch (err) {
            console.log("⚠ Logo failed to load");
        }

        // ---- QR CODE (centered & 3× bigger) ----
        const qrData = await QRCode.toBuffer(uniqueTicketId, { width: 600 });
        const qrSize = 250; // bigger
        const qrX = (doc.page.width - qrSize) / 2;
        const qrY = 250;

        doc.image(qrData, qrX, qrY, { width: qrSize });

        // ---- TICKET INFO BOX (white container, bold) ----
        const infoY = qrY + qrSize + 40;

        const boxWidth = doc.page.width * 0.50;
        const boxX = (doc.page.width - boxWidth) / 2;
        const boxHeight = 160;

        // White background centered
        doc.fillColor("#FFFFFF");
        doc.rect(boxX, infoY, boxWidth, boxHeight).fill();

        // Reset text color & font
        doc.fillColor("#000000")
            .font("Helvetica-Bold")
            .fontSize(18);

        // Centered text inside container
        let lineY = infoY + 30;
        const textOptions = {
            align: "center",
            width: boxWidth
        };

        // Event name (uppercase)
        doc.text(event.name.toUpperCase(), boxX, lineY, textOptions);
        lineY += 35;

        // Event date
        const dateFormatted = new Date(event.date).toLocaleString("en-GB", {
            dateStyle: "medium",
            timeStyle: "short"
        });
        doc.text(`DATE: ${dateFormatted}`, boxX, lineY, textOptions);
        lineY += 35;

        // Email
        doc.text(email.toUpperCase(), boxX, lineY, textOptions);
        lineY += 35;

        // Unique ID
        doc.text(uniqueTicketId, boxX, lineY, textOptions);

        // ---- FOOTER (black bar bottom centered) ----
        const footerHeight = 50;
        const footerY = doc.page.height - footerHeight;

        doc.rect(0, footerY, doc.page.width, footerHeight).fill("#000000");

        doc.fillColor("#FFFFFF")
            .font("Helvetica-Bold")
            .fontSize(14)
            .text("For event info & updates:", 0, footerY + 20, { width: pageWidth, align: "center" })
            .moveDown(0.3)
            .text("www.intheflo.xyz", { align: "center" })
            .moveDown(0.3)
            .text("instagram.com/intheflo.xyz • facebook.com/intheflo.xyz", { align: "center" });

        doc.end();

        stream.on("finish", () => resolve(filePath));
        stream.on("error", reject);
    });
}

// -----------------
// Get tickets per event
// -----------------
app.get("/events/:id/tickets", async (req, res) => {
    const { id } = req.params;
    const tickets = await prisma.ticket.findMany({ where: { eventId: id } });

    const processed = tickets.map(t => {
        // Use the status stored in the database
        let status = t.status || "available";

        // Map status to a label
        let statusLabel;
        switch (status) {
            case "sold-out":
                statusLabel = "Sold Out";
                break;
            case "coming-soon":
                statusLabel = "Coming Soon";
                break;
            case "unavailable":
                statusLabel = "Unavailable";
                break;
            default:
                statusLabel = "Available";
        }

        return { ...t, status, statusLabel };
    });

    res.json(processed);
});


// -----------------
// Create payment
// -----------------
app.post("/create-payment", async (req, res) => {
    const { tickets: selectedTickets, email, eventId } = req.body;
    if (!selectedTickets || !email || !eventId)
        return res.status(400).json({ error: "Missing data" });

    try {
        const event = await prisma.event.findUnique({
            where: { id: eventId },
            include: { tickets: true }
        });
        if (!event) return res.status(404).json({ error: "Event not found" });

        let totalAmount = 0;

        for (const t of selectedTickets) {
            const ticket = await prisma.ticket.findUnique({ where: { id: t.id } });
            if (!ticket) return res.status(400).json({ error: "Ticket not found" });

            // Block tickets if status is not available
            if (ticket.status !== "available" || ticket.sold + t.quantity > ticket.max) {
                return res.status(400).json({
                    error: `Ticket "${ticket.name}" is not available for purchase`
                });
            }

            totalAmount += ticket.price * t.quantity * 1.09; // include BTW/fees
        }

        const response = await fetch("https://api.mollie.com/v2/payments", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
                "Content-Type": "application/json"
            },
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

    } catch (e) {
        res.status(500).json({ error: e.toString() });
    }
});

// -----------------
// Mollie Webhook
// -----------------
app.post("/mollie-webhook", async (req, res) => {
    res.sendStatus(200);

    try {
        const paymentId = req.body.id;
        if (!paymentId) return;

        const mollieRes = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` }
        });
        const paymentData = await mollieRes.json();
        if (paymentData.status !== "paid") return;

        const { eventId, selectedTickets, email } = paymentData.metadata;
        const event = await prisma.event.findUnique({ where: { id: eventId }, include: { tickets: true } });
        if (!event) return;

        const attachments = [];
        for (const t of event.tickets) {
            const quantity = selectedTickets.find(s => s.id === t.id)?.quantity || 0;
            if (quantity <= 0) continue;

            for (let i = 0; i < quantity; i++) {
                const ticketId = `${t.code}-${Date.now()}-${i}`;
                await prisma.issuedTicket.create({
                    data: { id: ticketId, ticketId: t.id, email, paymentId, used: false, ticketCode: t.code }
                });
                const filePath = await generateTicketPDF(ticketId, t, event, email);
                attachments.push({ filename: `${ticketId}.pdf`, path: filePath });
            }
        }

        if (attachments.length > 0) {
            await transporter.sendMail({
                from: `"MIXO Tickets" <${process.env.EMAIL_USER}>`,
                to: email,
                subject: `Your tickets for ${event.name}`,
                html: `<p>Hi,</p>
               <p>Thank you for your purchase! Attached are your tickets for <b>${event.name}</b>.</p>
               <p>Ticket IDs: ${attachments.map(a => a.filename.replace(".pdf", "")).join(", ")}</p>
               <p>Enjoy the event!</p>`,
                attachments
            });
        }
    } catch (err) {
        console.error("❌ Mollie webhook error:", err);
    }
});

// -----------------
// Validate ticket
// -----------------
app.get("/validate/:ticketId", async (req, res) => {
    const { ticketId } = req.params;
    const ticket = await prisma.issuedTicket.findUnique({
        where: { id: ticketId },
        include: { ticket: { include: { event: true } } }
    });
    if (!ticket) return res.status(404).send("Ticket not found");
    if (ticket.used) return res.status(410).send("Ticket already used");

    await prisma.issuedTicket.update({ where: { id: ticketId }, data: { used: true, usedAt: new Date() } });
    res.send("✅ Ticket validated successfully");
});

// Admin routes
app.use("/admin", adminRouter);

// Optional: simple check for GET /admin
app.get("/admin", (req, res) => {
    res.send("✅ Admin backend is running. Use API endpoints like /admin/tickets");
});

app.listen(PORT, () => console.log("✅ Backend running on port " + PORT));
