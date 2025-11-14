import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
    const event1 = await prisma.event.create({
        data: {
            name: "MIXO: Reloaded",
            description: "The main MIXO party",
            logoURL: "https://intheflo.xyz/files/1382195/mixo-reloaded-icon.png",
            backgroundURL: "https://intheflo.xyz/files/1382404/mixo-reloaded-background.png",
            date: new Date("2026-01-10T17:00:00Z"),
            tickets: {
                create: [
                    { name: "Early Bird", price: 5, max: 50, code: "EARLY" },
                    { name: "Standard", price: 7.5, max: 600, code: "STANDARD" },
                    { name: "Latecomer", price: 10, max: 100, code: "LATE" }
                ]
            }
        }
    });

    const event2 = await prisma.event.create({
        data: {
            name: "MIXO: Heartbeat",
            description: "Second event",
            logoURL: "https://intheflo.xyz/files/1382195/mixo-reloaded-icon.png",
            backgroundURL: "https://intheflo.xyz/files/1382404/mixo-reloaded-background.png",
            date: new Date("2026-02-14T17:00:00Z"),
            tickets: {
                create: [
                    { name: "Early Bird", price: 6, max: 50, code: "EARLY" },
                    { name: "Standard", price: 8.18, max: 600, code: "STANDARD" },
                    { name: "Latecomer", price: 12, max: 100, code: "LATE" }
                ]
            }
        }
    });

    console.log({ event1, event2 });
}

main()
    .catch(e => console.error(e))
    .finally(async () => { await prisma.$disconnect(); });
