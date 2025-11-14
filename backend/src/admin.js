import express from "express";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const router = express.Router();

// Middleware
router.use(express.json());

// Admin password check
function checkAdmin(req, res) {
    const pass = req.query.pass || req.body.pass;
    if (!pass || pass !== process.env.ADMIN_PASS) return res.status(403).json({ error: "Unauthorized" });
}

// -------------------- Get events --------------------
router.get("/events", async (req, res) => {
    checkAdmin(req, res);
    const events = await prisma.event.findMany({ include: { tickets: true } });
    res.json(events);
});

// -------------------- Update ticket --------------------
router.post("/update-ticket", async (req, res) => {
    checkAdmin(req, res);
    const { ticketId, price, max, status } = req.body;
    if (!ticketId) return res.status(400).json({ error: "Missing ticketId" });

    try {
        const updated = await prisma.ticket.update({
            where: { id: ticketId },
            data: { price, max, status }
        });
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// -------------------- Get tickets per event --------------------
router.get("/tickets", async (req, res) => {
    checkAdmin(req, res);
    const { eventId } = req.query;
    if (!eventId) return res.status(400).json({ error: "Missing eventId" });

    const tickets = await prisma.ticket.findMany({ where: { eventId } });
    res.json(tickets);
});

export default router;
