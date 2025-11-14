import express from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const router = express.Router();

// Middleware
router.use(express.json());

// Admin auth
function checkAdmin(req, res) {
    const pass = req.query.pass || req.body.pass;
    if (!pass || pass !== process.env.ADMIN_PASS) return res.status(403).json({ error: "Unauthorized" });
}

// Get events
router.get("/events", async (req, res) => {
    checkAdmin(req, res);
    const events = await prisma.event.findMany();
    res.json(events);
});

// Get tickets for a given event
router.get("/tickets", async (req, res) => {
    checkAdmin(req, res);
    const { eventId } = req.query;
    if (!eventId) return res.status(400).json({ error: "Missing eventId" });

    const tickets = await prisma.issuedTicket.findMany({
        where: { ticket: { eventId } },
        include: { ticket: true }
    });

    const formatted = tickets.map(t => ({
        ticketName: t.ticket.name,
        price: t.ticket.price,
        sold: t.ticket.sold,
        max: t.ticket.max,
        email: t.email,
        issuedAt: t.issuedAt,
        used: t.used
    }));

    res.json(formatted);
});

export default router;
