import { startWorker, registerHandler } from "./worker/worker";
import jobRoutes from "./routes/jobs";
import express from "express";
import cors from "cors";

registerHandler("send-email", async (payload) => {
  console.log("Sending email to", payload.to);
  // real nodemailer code here
});

registerHandler("resize-image", async (payload) => {
  console.log("Resizing image", payload.url);
});

registerHandler("charge-payment", async (payload) => {
  console.log("Charging", payload.amount);
});

const Port = process.env.PORT || 3000;
const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:5173"];

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
startWorker();

// app.get('/healthStatus', (req, res) => {
//     res.json({status: "OK"});
// });
app.use("/", jobRoutes);

app.listen(Port, () => {
  console.log(`Server running on port: ${Port}`);
});
