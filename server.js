import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── Configurações ───────────────────────────────────────────
const VERIFY_TOKEN = "gestor_ia_verify";
const ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = "1032130426649107";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── Sessões em memória (confirmações pendentes) ─────────────
const pendingSessions = new Map();

// ─── Webhook GET — verificação Meta ─────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Webhook POST — recebe mensagens ────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responder imediatamente ao WhatsApp

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== "text") return;

    const from = message.from;
    const text = message.text?.body?.trim();

    console.log(`📨 Mensagem de ${from}: "${text}"`);

    // ── Verificar se é resposta de confirmação ──
    const session = pendingSessions.get(from);
    if (session) {
      const lower = text.toLowerCase();
      const confirmWords = ["sim", "s", "yes", "ok", "confirmar", "confirma", "pode", "certo"];
      const denyWords = ["não", "nao", "n", "no", "cancelar", "cancela", "errado"];

      if (confirmWords.includes(lower)) {
        pendingSessions.delete(from);
        await sendMessage(from,
          `✅ *Registrado com sucesso!*\n\n` +
          `📋 ${session.description}\n` +
          `💵 R$ ${Number(session.amount).toFixed(2).replace(".", ",")}\n` +
          `🏥 ${session.entity}\n` +
          `📝 Tipo: ${session.typeLabel}\n\n` +
          `_Quando o banco estiver conectado, isso será salvo automaticamente._`
        );
        return;
      }

      if (denyWords.some(w => lower === w || lower.startsWith(w + " "))) {
        pendingSessions.delete(from);
        await sendMessage(from, "❌ *Registro cancelado.*\n\nEnvie uma nova mensagem quando quiser registrar.");
        return;
      }

      // Se não é sim/não, cancela sessão anterior e processa nova mensagem
      pendingSessions.delete(from);
    }

    // ── Comandos especiais ──
    const lower = text.toLowerCase();
    if (lower === "ajuda" || lower === "help" || lower === "?") {
      await sendHelpMessage(from);
      return;
    }

    // ── Interpretar com IA ──
    await sendMessage(from, "🤔 _Analisando sua mensagem..._");

    const parsed = await interpretWithAI(text);

    if (!parsed.understood) {
      await sendMessage(from, parsed.confirmationMessage);
      return;
    }

    // ── Salvar sessão pendente e pedir confirmação ──
    pendingSessions.set(from, {
      ...parsed,
      timestamp: Date.now(),
    });

    // Expirar sessão em 5 minutos
    setTimeout(() => {
      if (pendingSessions.has(from)) {
        pendingSessions.delete(from);
      }
    }, 5 * 60 * 1000);

    await sendMessage(from, parsed.confirmationMessage);

  } catch (error) {
    console.error("❌ Erro ao processar mensagem:", error.message);
  }
});

// ─── Interpretação com Claude AI ────────────────────────────
async function interpretWithAI(text) {
  const systemPrompt = `Você é um assistente financeiro para clínicas médicas brasileiras.
Interprete mensagens em linguagem natural e extraia dados financeiros.

ENTIDADES DISPONÍVEIS:
- Clínica João Pessoa (slug: clinica_jp) — use quando mencionar "JP", "joão pessoa", "clínica JP"
- Clínica Patos (slug: clinica_patos) — use quando mencionar "patos", "clínica patos"
- Paulo (slug: paulo)
- Milena (slug: milena)
- Família (slug: familia)

TIPOS:
- EXPENSE (Despesa): boleto, conta, pagar, compra, gasto
- INCOME (Receita): recebi, entrada, paciente, recebimento
- TRANSFER (Transferência): transferência, transferiu

REGRAS:
- "dia 20" ou "vence 20" = próximo dia 20
- "12x 800" = 12 parcelas de R$800 (total = R$9600)
- Se entidade não mencionada, deixar null

Responda APENAS em JSON válido, sem markdown:
{
  "understood": true,
  "type": "EXPENSE",
  "typeLabel": "Despesa",
  "amount": 380.00,
  "description": "Energia Elétrica",
  "supplier": "Energia Elétrica",
  "entity": "Clínica João Pessoa",
  "entitySlug": "clinica_jp",
  "dueDate": "20",
  "installments": null,
  "installmentValue": null,
  "confirmationMessage": "💸 *Despesa*\\n\\n📋 Energia Elétrica\\n💵 R$ 380,00\\n🏥 Clínica JP\\n📅 Vencimento: dia 20\\n\\nConfirmar? Responda *sim* ou *não*"
}

Se não entender:
{
  "understood": false,
  "confirmationMessage": "❓ Não entendi. Tente:\\n• \\"Boleto energia 380 dia 20\\"\\n• \\"Recebi paciente 450 clínica patos\\"\\n• \\"Transferência Paulo 1000\\""
}`;

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: "user", content: `Data: ${new Date().toLocaleDateString("pt-BR")}\nMensagem: "${text}"` }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const raw = response.data.content[0].text.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(raw);

  } catch (error) {
    console.error("Erro na IA:", error.message);
    return {
      understood: false,
      confirmationMessage: "❌ Erro ao interpretar mensagem. Tente novamente em instantes.",
    };
  }
}

// ─── Enviar mensagem WhatsApp ────────────────────────────────
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error.response?.data || error.message);
  }
}

// ─── Mensagem de ajuda ───────────────────────────────────────
async function sendHelpMessage(from) {
  const msg =
    `👋 *Gestor IA — Como usar:*\n\n` +
    `💸 *Despesas:*\n` +
    `• "Boleto energia 380 dia 20"\n` +
    `• "Conta água clínica patos 150"\n\n` +
    `💰 *Receitas:*\n` +
    `• "Recebi paciente 450 clínica patos"\n` +
    `• "Entrada clínica JP 2500"\n\n` +
    `🔄 *Transferências:*\n` +
    `• "Transferência Paulo 1000"\n\n` +
    `📦 *Parcelamentos:*\n` +
    `• "Equipamento academia 12x 800"\n\n` +
    `_Após cada mensagem, confirme com *sim* ou *não*_`;

  await sendMessage(from, msg);
}

// ─── Health check ────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Start ───────────────────────────────────────────────────
app.listen(3000, () => {
  console.log("🚀 Gestor IA WhatsApp rodando na porta 3000");
  console.log(`🤖 IA: ${ANTHROPIC_API_KEY ? "configurada ✅" : "NÃO configurada ❌"}`);
  console.log(`📱 WhatsApp Token: ${ACCESS_TOKEN ? "configurado ✅" : "NÃO configurado ❌"}`);
});
