import express from "express";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const router = express.Router();

router.use(express.json());

function checkAdmin(req, res) {
	const pass = req.query.pass || req.body.pass || req.headers["x-admin-pass"];
	if (!pass || pass !== process.env.ADMIN_PASS) return res.status(403).json({ error: "Unauthorized" });
}

// Get all events with ticket sales
router.get("/events", async (req, res) => {
	checkAdmin(req, res);
	const events = await prisma.event.findMany({ include: { tickets: { include: { issuedTickets: true } } } });
	res.json(events);
});

export default router;
