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
async function generateTicketPDF(ticketId, ticket, event, email) {
    return new Promise(async (resolve, reject) => {
        try {
            const filePath = path.join(TICKETS_FOLDER, `${ticketId}.pdf`);
            const doc = new PDFDocument({ size: "A4", margin: 0 }); // no margins for full background
            const stream = fs.createWriteStream(filePath);
            doc.pipe(stream);

            const pageWidth = doc.page.width;
            const pageHeight = doc.page.height;

            // -----------------------------
            // BACKGROUND IMAGE
            // -----------------------------
            if (event.backgroundURL) {
                const resp = await fetch(event.backgroundURL);
                const buffer = Buffer.from(await resp.arrayBuffer());
                doc.image(buffer, 0, 0, {
                    width: pageWidth,
                    height: pageHeight
                });
            }

            // -----------------------------
            // LOGO (center top, 1.5x bigger)
            // -----------------------------
            if (event.logoURL) {
                const resp = await fetch(event.logoURL);
                const buffer = Buffer.from(await resp.arrayBuffer());

                const logoWidth = 150; // was 100 → now 1.5x bigger
                doc.image(buffer, (pageWidth - logoWidth) / 2, 40, {
                    width: logoWidth
                });
            }

            // -----------------------------
            // QR CODE (centered, 3x larger)
            // -----------------------------
            const qrData = `${process.env.RENDER_URL}/validate.html?ticketId=${encodeURIComponent(ticketId)}`;
            const qrImg = await QRCode.toDataURL(qrData);

            const qrSize = 300; // was 150 → now 3x larger
            doc.image(qrImg, (pageWidth - qrSize) / 2, 200, {
                width: qrSize
            });

            // -----------------------------
            // TICKET INFO BOX (centered, white background)
            // -----------------------------
            const infoBoxWidth = pageWidth * 0.8;
            const infoBoxX = (pageWidth - infoBoxWidth) / 2;
            const infoBoxY = 700;
            const infoBoxHeight = 200;

            // White rectangle
            doc.rect(infoBoxX, infoBoxY, infoBoxWidth, infoBoxHeight)
                .fillOpacity(0.95)
                .fill("white")
                .fillOpacity(1);

            doc.fillColor("black")
                .fontSize(22)
                .text(`Ticket ID: ${ticketId}`, infoBoxX + 20, infoBoxY + 20, { width: infoBoxWidth - 40, align: "center" })
                .moveDown(0.5)
                .text(`Type: ${ticket.name}`, { align: "center" })
                .moveDown(0.5)
                .text(`Email: ${email}`, { align: "center" })
                .moveDown(0.5)
                .text(`Event: ${event.name}`, { align: "center" })
                .moveDown(0.5)
                .text(`Date: ${event.date.toDateString()} ${event.date.toLocaleTimeString()}`, { align: "center" });

            // -----------------------------
            // FOOTER BLACK BOX
            // -----------------------------
            const footerHeight = 120;
            const footerY = pageHeight - footerHeight;

            // Black rectangle
            doc.rect(0, footerY, pageWidth, footerHeight)
                .fillOpacity(1)
                .fill("black");

            doc.fillColor("white")
                .fontSize(20)
                .text("For event info & updates:", 0, footerY + 20, { width: pageWidth, align: "center" })
                .moveDown(0.3)
                .text("www.intheflo.xyz", { align: "center" })
                .moveDown(0.3)
                .text("instagram.com/intheflo.xyz • facebook.com/intheflo.xyz", { align: "center" });

            doc.end();

            stream.on("finish", () => resolve(filePath));
            stream.on("error", (err) => reject(err));

        } catch (err) {
            reject(err);
        }
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
