import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "gestor_ia_verify";
const ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body;

    console.log("Mensagem recebida:", text);

    await sendMessage(from, `Recebi sua mensagem: "${text}". Em breve vou analisar e confirmar antes de registrar.`);

  } catch (error) {
    console.error(error);
  }

  res.sendStatus(200);
});

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/164100763459601/messages`,
    {
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

app.listen(3000, () => {
  console.log("Servidor rodando na porta 3000");
});
