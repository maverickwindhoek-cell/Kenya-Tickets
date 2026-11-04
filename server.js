const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

app.use(express.json());
app.use(cors({
    origin: process.env.FRONTEND_ORIGIN || "*"
}));

const PORT = process.env.PORT || 3000;

const PRICES = [500, 1000, 2000, 3500, 5000];

// Temporary booking storage.
// We will connect permanent database storage next.
const bookings = new Map();

function getTimestamp() {
    const d = new Date();
    return d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, "0") +
        String(d.getDate()).padStart(2, "0") +
        String(d.getHours()).padStart(2, "0") +
        String(d.getMinutes()).padStart(2, "0") +
        String(d.getSeconds()).padStart(2, "0");
}

async function getAccessToken() {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;

    if (!key || !secret) {
        throw new Error("M-Pesa credentials are not configured");
    }

    const auth = Buffer.from(`${key}:${secret}`).toString("base64");

    const base = process.env.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";

    const response = await fetch(
        `${base}/oauth/v1/generate?grant_type=client_credentials`,
        {
            headers: {
                Authorization: `Basic ${auth}`
            }
        }
    );

    const data = await response.json();

    if (!response.ok || !data.access_token) {
        throw new Error("Unable to obtain M-Pesa access token");
    }

    return data.access_token;
}

app.get("/", (req, res) => {
    res.send("KENYA TICKETS PAYMENT SERVER");
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "online",
        service: "KENYA TICKETS"
    });
});

app.post("/api/payments/stkpush", async (req, res) => {
    try {
        const { name, phone, ticketPrice, quantity } = req.body;

        const amount = Number(ticketPrice);
        const qty = Number(quantity);

        if (
            typeof name !== "string" ||
            name.trim().length < 2 ||
            name.length > 100
        ) {
            return res.status(400).json({
                error: "Enter a valid name"
            });
        }

        if (
            !Number.isInteger(amount) ||
            !PRICES.includes(amount) ||
            !Number.isInteger(qty) ||
            qty < 1 ||
            qty > 10
        ) {
            return res.status(400).json({
                error: "Invalid ticket selection"
            });
        }

        if (
            typeof phone !== "string" ||
            !/^254(7|1)\d{8}$/.test(phone)
        ) {
            return res.status(400).json({
                error: "Invalid Kenyan M-Pesa phone number"
            });
        }

        const shortcode = process.env.MPESA_SHORTCODE;
        const passkey = process.env.MPESA_PASSKEY;
        const callbackURL = process.env.MPESA_CALLBACK_URL;

        if (!shortcode || !passkey || !callbackURL) {
            return res.status(500).json({
                error: "Payment configuration incomplete"
            });
        }

        const token = await getAccessToken();
        const timestamp = getTimestamp();

        const password = Buffer.from(
            shortcode + passkey + timestamp
        ).toString("base64");

        const base = process.env.MPESA_ENV === "production"
            ? "https://api.safaricom.co.ke"
            : "https://sandbox.safaricom.co.ke";

        const reference =
            "KT" + crypto.randomBytes(5).toString("hex").toUpperCase();

        const total = amount * qty;

        const response = await fetch(
            `${base}/mpesa/stkpush/v1/processrequest`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    BusinessShortCode: shortcode,
                    Password: password,
                    Timestamp: timestamp,
                    TransactionType: "CustomerPayBillOnline",
                    Amount: total,
                    PartyA: phone,
                    PartyB: shortcode,
                    PhoneNumber: phone,
                    CallBackURL: callbackURL,
                    AccountReference: reference,
                    TransactionDesc: "Kenya Tickets"
                })
            }
        );

        const data = await response.json();

        if (!response.ok || data.ResponseCode !== "0") {
            return res.status(400).json({
                error: data.errorMessage ||
                    data.ResponseDescription ||
                    "STK Push request failed"
            });
        }

        bookings.set(data.CheckoutRequestID, {
            reference,
            name: name.trim(),
            phone,
            ticketPrice: amount,
            quantity: qty,
            total,
            status: "PENDING",
            receipt: null
        });

        res.json({
            success: true,
            message: "Payment request sent",
            reference,
            checkoutRequestId: data.CheckoutRequestID,
            total
        });

    } catch (error) {
        console.error("Payment error:", error.message);

        res.status(500).json({
            error: "Payment service temporarily unavailable"
        });
    }
});

app.post("/api/payments/callback", (req, res) => {
    try {
        const callback =
            req.body?.Body?.stkCallback;

        if (!callback) {
            return res.status(400).json({
                error: "Invalid callback"
            });
        }

        const booking = bookings.get(
            callback.CheckoutRequestID
        );

        if (booking) {
            if (callback.ResultCode === 0) {
                const items =
                    callback.CallbackMetadata?.Item || [];

                const receipt = items.find(
                    item => item.Name === "MpesaReceiptNumber"
                )?.Value;

                const paidAmount = items.find(
                    item => item.Name === "Amount"
                )?.Value;

                const paidPhone = items.find(
                    item => item.Name === "PhoneNumber"
                )?.Value;

                if (
                    receipt &&
                    Number(paidAmount) === booking.total &&
                    String(paidPhone) === booking.phone
                ) {
                    booking.status = "PAID";
                    booking.receipt = receipt;
                } else {
                    booking.status = "REVIEW";
                }
            } else {
                booking.status = "FAILED";
            }
        }

        res.json({
            ResultCode: 0,
            ResultDesc: "Accepted"
        });

    } catch (error) {
        console.error("Callback error:", error.message);

        res.status(500).json({
            ResultCode: 1,
            ResultDesc: "Callback processing failed"
        });
    }
});

app.get("/api/payments/status/:id", (req, res) => {
    const booking = bookings.get(req.params.id);

    if (!booking) {
        return res.status(404).json({
            error: "Booking not found"
        });
    }

    res.json({
        reference: booking.reference,
        status: booking.status,
        receipt: booking.receipt
    });
});

app.listen(PORT, () => {
    console.log(`KENYA TICKETS running on port ${PORT}`);
});
