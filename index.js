require("dotenv").config();
const express = require("express");
const cors = require("cors");
const twilio = require("twilio");
const apiRoutes = require("./api");
const { handleMessage, handleConfirmation, findMember } = require("./bot");

const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));

// Serve the organizer web panel (public/index.html) at the root URL
app.use(express.static("public"));

app.use("/api", apiRoutes);

// ── Verify the request genuinely came from Twilio ──
function validateTwilioRequest(req) {
  if (process.env.SKIP_TWILIO_VALIDATION === "true") return true;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers["x-twilio-signature"];
  if (!authToken || !signature) return false;
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  return twilio.validateRequest(authToken, signature, url, req.body || {});
}

app.post("/webhook", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    console.log("⚠️  Rejected webhook with invalid Twilio signature");
    return res.status(403).send("Invalid signature");
  }

  const incomingMessage = req.body.Body;
  const senderNumber = req.body.From;

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end("<Response></Response>");

  if (!incomingMessage || !senderNumber) return;

  try {
    const message = incomingMessage.trim().toLowerCase();

    if (["yes", "no", "confirm", "cancel", "1", "2"].includes(message)) {
      const member = await findMember(senderNumber);
      if (member) {
        const handled = await handleConfirmation(senderNumber, member, message);
        if (handled) return;
      }
    }

    await handleMessage(incomingMessage, senderNumber);
  } catch (error) {
    console.log("Webhook error:", error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("KaryaSetu server running on port " + PORT);
  console.log("Waiting for WhatsApp messages...");
});
