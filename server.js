import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ─── Configurações ────────────────────────────────────────────
const VERIFY_TOKEN = "gestor_ia_verify";
const ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = "1032130426649107";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_NAME = "Financeiro";

// ─── Supabase REST API ────────────────────────────────────────
// Extrair dados da DATABASE_URL para usar via REST
const SUPABASE_URL = `https://grfgavzbhgkiijisuayi.supabase.co`;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";

async function dbQuery(table, method = "GET", body = null, filters = "") {
  try {
    const url = `${SUPABASE_URL}/rest/v1/${table}${filters}`;
    const headers = {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=representation" : "",
    };
    const response = await axios({ method, url, headers, data: body, timeout: 10000 });
    return response.data;
  } catch (err) {
    console.error(`DB Error [${table}]:`, err.response?.data || err.message);
    return null;
  }
}

async function dbInsert(table, data) {
  return await dbQuery(table, "POST", data);
}

async function dbUpdate(table, filters, data) {
  return await dbQuery(table, "PATCH", data, filters);
}

async function dbSelect(table, filters = "") {
  return await dbQuery(table, "GET", null, filters);
}

// ─── Usuários ─────────────────────────────────────────────────
const USUARIOS = {
  "5583996299904": { nome: "Paulo",    role: "GESTOR",      pf: true  },
  "5583999165348": { nome: "Milena",   role: "GESTOR",      pf: true  },
  "5583996515709": { nome: "Michelle", role: "COLABORADOR", pf: false },
  "5583996189405": { nome: "Letticia", role: "COLABORADOR", pf: false },
  "5548991683756": { nome: "Meuri",    role: "COLABORADOR", pf: false },
};

const GESTORES = Object.entries(USUARIOS)
  .filter(([, u]) => u.role === "GESTOR")
  .map(([phone]) => phone);

// ─── Sessões em memória ───────────────────────────────────────
const pendingSessions = new Map();

// ─── Utilitários ──────────────────────────────────────────────
const fmt = (v) => `R$ ${Number(v).toFixed(2).replace(".", ",")}`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("pt-BR") : "–";
const hoje = () => new Date().toLocaleDateString("pt-BR");
const agora = () => new Date();

function gerarId() {
  return `GIA-${Date.now().toString(36).toUpperCase()}`;
}

function isDiaUtil(d = new Date()) { return d.getDay() !== 0 && d.getDay() !== 6; }
function isSexta(d = new Date()) { return d.getDay() === 5; }
function isSegunda(d = new Date()) { return d.getDay() === 1; }

function diasAteVencimento(vencimento) {
  const h = new Date(); h.setHours(0,0,0,0);
  const v = new Date(vencimento); v.setHours(0,0,0,0);
  return Math.round((v - h) / 86400000);
}

function calcularSemanasMes(inicioMes, hoje) {
  const semanas = [];
  let inicio = new Date(inicioMes);
  while (inicio <= hoje) {
    const fim = new Date(inicio);
    fim.setDate(fim.getDate() + 6);
    if (fim > hoje) fim.setTime(hoje.getTime());
    semanas.push({ inicio: new Date(inicio), fim: new Date(fim) });
    inicio.setDate(inicio.getDate() + 7);
  }
  return semanas;
}

// ─── AGENDAMENTOS ─────────────────────────────────────────────
setInterval(async () => {
  const now = agora();
  const hora = now.getHours();
  const min = now.getMinutes();

  if (hora === 18 && min === 0 && isDiaUtil(now)) await enviarRelatorioDiario();
  if (hora === 9  && min === 0 && isDiaUtil(now)) await verificarVencimentos();
  if (hora === 9  && min === 0 && isSegunda(now)) await enviarBalancoPF();
}, 60000);

// ─── Relatório diário 18h ─────────────────────────────────────
async function enviarRelatorioDiario() {
  const now = agora();
  const inicioDia = new Date(now); inicioDia.setHours(0,0,0,0);

  const txs = await dbSelect("transacoes", `?created_at=gte.${inicioDia.toISOString()}&status=eq.CONFIRMADO`);
  const lista = txs || [];

  const receitas = lista.filter(t => t.tipo === "RECEITA");
  const despesas = lista.filter(t => t.tipo === "DESPESA");
  const totR = receitas.reduce((s, t) => s + Number(t.valor), 0);
  const totD = despesas.reduce((s, t) => s + Number(t.valor), 0);

  const diaSemana = now.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
  let msg = `🤖 *Aqui é o ${BOT_NAME}*\n\n📊 *Relatório do Dia — ${diaSemana}*\n\n`;

  if (lista.length === 0) {
    msg += `📭 Nenhuma movimentação registrada hoje.`;
  } else {
    if (receitas.length > 0) {
      msg += `💰 *Entradas (${receitas.length}):*\n`;
      receitas.forEach(t => msg += `  • ${t.descricao} — ${fmt(t.valor)} (${t.entidade})\n`);
      msg += `  *Total: ${fmt(totR)}*\n\n`;
    } else {
      msg += `💰 *Entradas:* Zero entradas hoje.\n\n`;
    }
    if (despesas.length > 0) {
      msg += `💸 *Despesas (${despesas.length}):*\n`;
      despesas.forEach(t => msg += `  • ${t.descricao} — ${fmt(t.valor)} (${t.entidade})\n`);
      msg += `  *Total: ${fmt(totD)}*\n\n`;
    }
    msg += `📈 *Saldo do dia: ${fmt(totR - totD)}*`;
  }

  for (const phone of GESTORES) await sendMessage(phone, msg);
}

// ─── Lembretes de vencimento ──────────────────────────────────
async function verificarVencimentos() {
  const boletos = await dbSelect("boletos_pendentes", "?status=eq.PENDENTE") || [];
  const ehSexta = isSexta();

  for (const bill of boletos) {
    if (!bill.vencimento_date) continue;
    const dias = diasAteVencimento(bill.vencimento_date);
    const avisar3 = ehSexta ? (dias <= 3 && dias >= 1) : dias === 3;
    const avisarHoje = dias === 0;

    if (avisar3 || avisarHoje) {
      const tipo = avisarHoje ? "vence *HOJE*" : `vence em *${dias} dia${dias > 1 ? "s" : ""}*`;
      let msg = `🤖 *Aqui é o ${BOT_NAME}*\n\n⏰ *Lembrete de Vencimento*\n\n`;
      msg += `📋 ${bill.descricao}\n💵 ${fmt(bill.valor)}\n🏥 ${bill.entidade}\n`;
      msg += `📅 ${fmtDate(bill.vencimento_date)} — ${tipo}\n🆔 \`${bill.id}\`\n\n`;
      msg += `_Envie o comprovante para dar baixa._`;
      for (const phone of GESTORES) await sendMessage(phone, msg);
    }
  }

  if (ehSexta) await enviarRelatorioVencimentosSemana(boletos);
}

async function enviarRelatorioVencimentosSemana(boletos) {
  const proximos = (boletos || [])
    .filter(b => { const d = diasAteVencimento(b.vencimento_date); return d >= 0 && d <= 7; })
    .sort((a, b) => new Date(a.vencimento_date) - new Date(b.vencimento_date));

  if (!proximos.length) return;

  let msg = `🤖 *Aqui é o ${BOT_NAME}*\n\n📋 *Boletos — próximos 7 dias:*\n\n`;
  proximos.forEach(b => {
    const d = diasAteVencimento(b.vencimento_date);
    const u = d === 0 ? "🔴" : d <= 3 ? "🟡" : "🟢";
    msg += `${u} ${b.descricao}\n   💵 ${fmt(b.valor)} | 📅 ${fmtDate(b.vencimento_date)} | ${b.entidade}\n\n`;
  });
  msg += `💰 *Total: ${fmt(proximos.reduce((s, b) => s + Number(b.valor), 0))}*`;
  for (const phone of GESTORES) await sendMessage(phone, msg);
}

// ─── Balanço PF semanal ───────────────────────────────────────
async function enviarBalancoPF() {
  const now = agora();
  const inicioMes = new Date(now.getFullYear(), now.getMonth(), 1);
  const semanas = calcularSemanasMes(inicioMes, now);

  for (const [phone, usuario] of Object.entries(USUARIOS)) {
    if (!usuario.pf) continue;

    const gastos = await dbSelect("transacoes",
      `?status=eq.CONFIRMADO&tipo=eq.DESPESA&is_pf=eq.true&created_at=gte.${inicioMes.toISOString()}`
    ) || [];

    const meus = gastos.filter(t => t.entidade === "Família" || t.entidade === usuario.nome);
    const totalMes = meus.reduce((s, t) => s + Number(t.valor), 0);

    const mes = now.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    let msg = `🤖 *Aqui é o ${BOT_NAME}*\n\n💳 *Balanço Pessoal — ${usuario.nome}*\n📅 ${mes.charAt(0).toUpperCase() + mes.slice(1)}\n\n`;

    semanas.forEach((s, i) => {
      const semGastos = meus.filter(t => {
        const d = new Date(t.created_at);
        return d >= s.inicio && d <= s.fim;
      });
      const tot = semGastos.reduce((acc, t) => acc + Number(t.valor), 0);
      const ini = s.inicio.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      const fim = s.fim.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

      msg += `📆 *Semana ${i + 1}* (${ini} a ${fim}):\n`;
      if (semGastos.length === 0) {
        msg += `  Sem gastos\n`;
      } else {
        const cats = {};
        semGastos.forEach(t => { cats[t.categoria || t.descricao] = (cats[t.categoria || t.descricao] || 0) + Number(t.valor); });
        Object.entries(cats).sort(([,a],[,b]) => b - a).forEach(([c, v]) => msg += `  • ${c}: ${fmt(v)}\n`);
        msg += `  *Subtotal: ${fmt(tot)}*\n`;
      }
      msg += "\n";
    });

    msg += `━━━━━━━━━━━━━\n💰 *Total acumulado: ${fmt(totalMes)}*`;

    if (totalMes > 0) {
      const cats = {};
      meus.forEach(t => { cats[t.categoria || t.descricao] = (cats[t.categoria || t.descricao] || 0) + Number(t.valor); });
      const top3 = Object.entries(cats).sort(([,a],[,b]) => b - a).slice(0, 3);
      msg += `\n\n🔝 *Maiores gastos:*\n`;
      top3.forEach(([c, v]) => msg += `  • ${c}: ${fmt(v)} (${((v/totalMes)*100).toFixed(0)}%)\n`);
    }

    await sendMessage(phone, msg);
  }
}

// ─── Webhook GET ──────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    res.status(200).send(challenge);
  } else res.sendStatus(403);
});

// ─── Webhook POST ─────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return;

    const message = value.messages[0];
    const from = message.from;
    const tipo = message.type;

    const usuario = USUARIOS[from];
    if (!usuario) {
      await sendMessage(from, `🤖 *Aqui é o ${BOT_NAME}.*\n\n⚠️ Número não autorizado.`);
      return;
    }

    console.log(`📨 ${usuario.nome} (${tipo}): ${message.text?.body || "[mídia]"}`);

    // Sessão pendente
    const session = pendingSessions.get(from);
    if (session && tipo === "text") {
      await tratarRespostaUsuario(from, usuario, session, message.text.body.trim());
      return;
    }

    if (tipo === "text") {
      await processarTexto(from, usuario, message.text.body.trim());
    } else if (tipo === "image" || tipo === "document") {
      await processarMidia(from, usuario, message, tipo);
    } else {
      await sendMessage(from, `🤖 *${BOT_NAME}:* Formato não suportado. Envie texto, foto ou PDF.`);
    }
  } catch (err) {
    console.error("❌ Erro:", err.message);
  }
});

// ─── Tratar respostas em sessão ───────────────────────────────
async function tratarRespostaUsuario(from, usuario, session, text) {
  const lower = text.toLowerCase().trim();
  const sim = ["sim","s","ok","confirmar","pode","certo","1"];
  const nao = ["não","nao","n","cancelar","errado","2"];

  if (session.etapa === "CONFIRMAR") {
    if (sim.includes(lower)) { await executarLancamento(from, usuario, session); return; }
    if (nao.some(w => lower === w)) {
      pendingSessions.delete(from);
      await sendMessage(from, `🤖 *${BOT_NAME}:* ❌ Cancelado.`);
      return;
    }
  }

  if (session.etapa === "ENTIDADE") {
    const entidade = resolverEntidade(lower, usuario);
    if (!entidade) {
      await sendMessage(from, `⚠️ Não reconheci. Responda:\n1 - Clínica João Pessoa\n2 - Clínica Patos\n3 - Conjunta${usuario.pf ? "\n4 - Paulo\n5 - Milena\n6 - Família" : ""}`);
      return;
    }
    session.dados.entidade = entidade;
    session.etapa = "CONFIRMAR";
    pendingSessions.set(from, session);
    await sendMessage(from, montarConfirmacao(session.dados, session.duplicata));
    return;
  }

  if (session.etapa === "ESCOLHER_BAIXA") {
    if (lower === "novo") {
      session.dados.tipo = "DESPESA";
      session.etapa = "CONFIRMAR";
      pendingSessions.set(from, session);
      await sendMessage(from, montarConfirmacao(session.dados, null));
      return;
    }
    const idx = parseInt(lower) - 1;
    const opcoes = session.opcoesBaixa;
    if (isNaN(idx) || idx < 0 || idx >= opcoes.length) {
      await sendMessage(from, `⚠️ Responda com o número (1 a ${opcoes.length}) ou *novo*.`);
      return;
    }
    const bill = opcoes[idx];
    await dbUpdate("boletos_pendentes", `?id=eq.${bill.id}`, {
      status: "PAGO", paid_at: new Date().toISOString(), paid_by: usuario.nome
    });
    await dbUpdate("transacoes", `?id=eq.${bill.transacao_id || bill.id}`, { status: "PAGO" });
    pendingSessions.delete(from);
    await sendMessage(from, `🤖 *${BOT_NAME}:*\n\n✅ *Baixa realizada!*\n\n📋 ${bill.descricao}\n💵 ${fmt(bill.valor)}\n🏥 ${bill.entidade}\n📅 Pago em: ${hoje()}\n👤 Por: ${usuario.nome}`);
    await notificarGestores(usuario, bill, bill.id);
    return;
  }

  if (session.etapa === "CATEGORIA_PF") {
    session.dados.categoria = text;
    session.dados.entidade = /marketing|publicidade|uniforme|clínica|insumo/.test(lower) ? "Conjunta" : "Família";
    session.dados.is_pf = true;
    session.etapa = "CONFIRMAR";
    pendingSessions.set(from, session);
    await sendMessage(from, montarConfirmacao(session.dados, session.duplicata));
    return;
  }

  pendingSessions.delete(from);
  await processarTexto(from, usuario, text);
}

// ─── Processar texto ──────────────────────────────────────────
async function processarTexto(from, usuario, text) {
  const lower = text.toLowerCase();

  if (["ajuda","help","?","oi","olá","ola"].includes(lower)) { await sendHelpMessage(from, usuario); return; }
  if ((lower === "saldo" || lower === "resumo") && usuario.role === "GESTOR") { await sendResumoGestor(from); return; }
  if ((lower.includes("boleto") || lower.includes("vencem")) && usuario.role === "GESTOR") { await responderBoletos(from); return; }

  await sendMessage(from, `🤖 _${BOT_NAME} analisando..._`);
  const parsed = await chamarIA(montarSystemPromptTexto(usuario), `Mensagem: "${text}"\nData: ${hoje()}`);
  await tratarRespostaIA(from, usuario, parsed, text);
}

// ─── Processar mídia ──────────────────────────────────────────
async function processarMidia(from, usuario, message, tipo) {
  await sendMessage(from, `🤖 _${BOT_NAME} lendo documento..._`);
  try {
    const mediaId = message[tipo]?.id || message.document?.id;
    const mediaRes = await axios.get(`https://graph.facebook.com/v22.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
    const imgRes = await axios.get(mediaRes.data.url, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, responseType: "arraybuffer"
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mimeType = imgRes.headers["content-type"] || "image/jpeg";

    const response = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514", max_tokens: 1200,
      system: montarSystemPromptMidia(usuario),
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
        { type: "text", text: `Analise este documento.\nData: ${hoje()}\nUsuário: ${usuario.nome}` }
      ]}]
    }, {
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      timeout: 30000
    });

    const raw = response.data.content[0].text.replace(/```json\n?|\n?```/g, "").trim();
    await tratarRespostaIA(from, usuario, JSON.parse(raw), "[Documento]");
  } catch (err) {
    console.error("Erro mídia:", err.message);
    await sendMessage(from, `🤖 *${BOT_NAME}:* ⚠️ Não consegui ler. Descreva por texto:\n"Boleto Energisa 380 vence dia 20 JP"`);
  }
}

// ─── Tratar resposta da IA ────────────────────────────────────
async function tratarRespostaIA(from, usuario, parsed, rawMessage) {
  if (!parsed?.understood) {
    await sendMessage(from, `🤖 *${BOT_NAME}:*\n\n${parsed?.confirmationMessage || "❓ Não compreendi. Digite *ajuda*."}`);
    return;
  }

  if (parsed.tipoDocumento === "COMPROVANTE") {
    await tratarComprovante(from, usuario, parsed);
    return;
  }

  const duplicata = await verificarDuplicidade(parsed, from);

  if (parsed.isPF && !parsed.categoria) {
    const session = { dados: { ...parsed, rawMessage }, etapa: "CATEGORIA_PF", duplicata };
    pendingSessions.set(from, session);
    setTimeout(() => pendingSessions.delete(from), 600000);
    await sendMessage(from, `🤖 *${BOT_NAME}:*\n\n💳 Gasto pessoal identificado.\n📋 ${parsed.descricao} — ${fmt(parsed.valor)}\n\nQual é a categoria?\nEx: alimentação, delivery, salão, farmácia, vestuário, lazer...`);
    return;
  }

  if (!parsed.entidade) {
    const session = { dados: { ...parsed, rawMessage }, etapa: "ENTIDADE", duplicata };
    pendingSessions.set(from, session);
    setTimeout(() => pendingSessions.delete(from), 600000);
    let msg = `🤖 *${BOT_NAME}:*\n\n🏥 *A qual entidade pertence?*\n\n1️⃣ Clínica João Pessoa\n2️⃣ Clínica Patos\n3️⃣ Conjunta`;
    if (usuario.pf) msg += `\n4️⃣ Paulo\n5️⃣ Milena\n6️⃣ Família`;
    msg += `\n\nResponda com o número ou nome.`;
    await sendMessage(from, msg);
    return;
  }

  const session = { dados: { ...parsed, rawMessage }, etapa: "CONFIRMAR", duplicata };
  pendingSessions.set(from, session);
  setTimeout(() => pendingSessions.delete(from), 600000);
  await sendMessage(from, montarConfirmacao(parsed, duplicata));
}

// ─── Tratar comprovante ───────────────────────────────────────
async function tratarComprovante(from, usuario, parsed) {
  const boletos = await dbSelect("boletos_pendentes", "?status=eq.PENDENTE") || [];
  const candidatos = boletos.filter(b => {
    const mesmoFornecedor = b.fornecedor?.toLowerCase().includes(parsed.fornecedor?.toLowerCase() || "") ||
      parsed.fornecedor?.toLowerCase().includes(b.fornecedor?.toLowerCase() || "");
    const mesmoValor = Math.abs(Number(b.valor) - Number(parsed.valor)) < 1.0;
    return mesmoFornecedor || mesmoValor;
  });

  if (candidatos.length === 0) {
    const session = { dados: { ...parsed, tipo: "DESPESA", tipoLabel: "Despesa Paga", status: "PAGO" }, etapa: "CONFIRMAR", duplicata: null };
    pendingSessions.set(from, session);
    setTimeout(() => pendingSessions.delete(from), 600000);
    await sendMessage(from, `🤖 *${BOT_NAME}:*\n\n📄 Comprovante identificado.\n📋 ${parsed.descricao}\n💵 ${fmt(parsed.valor)}\n\nNão encontrei boleto pendente. Registrar como novo gasto?\n\n*sim* ou *não*`);
    return;
  }

  if (candidatos.length === 1) {
    const session = { dados: parsed, etapa: "ESCOLHER_BAIXA", opcoesBaixa: candidatos };
    pendingSessions.set(from, session);
    setTimeout(() => pendingSessions.delete(from), 600000);
    const b = candidatos[0];
    await sendMessage(from, `🤖 *${BOT_NAME}:*\n\n📄 Comprovante identificado!\n\nBoleto encontrado:\n📋 ${b.descricao}\n💵 ${fmt(b.valor)}\n📅 ${fmtDate(b.vencimento_date)}\n🏥 ${b.entidade}\n\nConfirmar baixa? Responda *1* ou *não*.`);
    return;
  }

  let msg = `🤖 *${BOT_NAME}:*\n\n📄 Comprovante — ${fmt(parsed.valor)}\n\nBoletos similares encontrados:\n\n`;
  candidatos.forEach((b, i) => msg += `*${i+1}.* ${b.descricao} — ${fmt(b.valor)}\n📅 ${fmtDate(b.vencimento_date)} | ${b.entidade}\n\n`);
  msg += `Qual está sendo pago? Responda com o número ou *novo* para novo gasto.`;
  const session = { dados: parsed, etapa: "ESCOLHER_BAIXA", opcoesBaixa: candidatos };
  pendingSessions.set(from, session);
  setTimeout(() => pendingSessions.delete(from), 600000);
  await sendMessage(from, msg);
}

// ─── Executar lançamento ──────────────────────────────────────
async function executarLancamento(from, usuario, session) {
  pendingSessions.delete(from);
  const dados = session.dados;
  const id = gerarId();

  // Parsear data de vencimento
  let vencimentoDate = null;
  if (dados.vencimento) {
    const match = dados.vencimento.match(/(\d{1,2})/);
    if (match) {
      const dia = parseInt(match[1]);
      const d = new Date();
      d.setDate(dia);
      if (d < new Date()) d.setMonth(d.getMonth() + 1);
      vencimentoDate = d.toISOString().split("T")[0];
    }
  }

  const transacao = {
    id, tipo: dados.tipo, tipo_label: dados.tipoLabel || dados.tipo,
    valor: dados.valor, descricao: dados.descricao,
    fornecedor: dados.fornecedor, entidade: dados.entidade,
    vencimento: dados.vencimento, vencimento_date: vencimentoDate,
    parcelas: dados.parcelas, valor_parcela: dados.valorParcela,
    codigo_barras: dados.codigoBarras, categoria: dados.categoria,
    is_pf: dados.isPF || false,
    status: dados.status || "CONFIRMADO",
    raw_message: dados.rawMessage,
    created_by: usuario.nome, created_by_phone: from,
  };

  await dbInsert("transacoes", transacao);

  // Adicionar boleto pendente se for despesa futura
  if (dados.tipo === "DESPESA" && vencimentoDate && dados.status !== "PAGO") {
    await dbInsert("boletos_pendentes", {
      id: `B-${id}`, descricao: dados.descricao, fornecedor: dados.fornecedor,
      valor: dados.valor, entidade: dados.entidade,
      vencimento_date: vencimentoDate, vencimento: dados.vencimento,
      codigo_barras: dados.codigoBarras, status: "PENDENTE",
      created_by: usuario.nome, transacao_id: id,
    });
  }

  let msg = `🤖 *${BOT_NAME}:*\n\n✅ *Registrado!*\n\n🆔 \`${id}\`\n📋 ${dados.descricao}\n💵 ${fmt(dados.valor)}\n🏥 ${dados.entidade}\n📂 ${dados.tipoLabel || dados.tipo}`;
  if (dados.vencimento) msg += `\n📅 Vencimento: ${dados.vencimento}`;
  if (dados.parcelas) msg += `\n📦 ${dados.parcelas}x de ${fmt(dados.valorParcela)}`;
  if (dados.categoria) msg += `\n🏷️ ${dados.categoria}`;
  msg += `\n👤 Por: ${usuario.nome}`;

  await sendMessage(from, msg);
  if (usuario.role === "COLABORADOR") await notificarGestores(usuario, dados, id);
}

// ─── Notificar gestores ───────────────────────────────────────
async function notificarGestores(usuario, dados, id) {
  const msg = `🤖 *${BOT_NAME}:*\n\n🔔 *Novo lançamento — ${usuario.nome}*\n\n📋 ${dados.descricao}\n💵 ${fmt(dados.valor)}\n🏥 ${dados.entidade || "–"}\n🆔 \`${id}\``;
  for (const phone of GESTORES) await sendMessage(phone, msg).catch(() => {});
}

// ─── Verificar duplicidade ────────────────────────────────────
async function verificarDuplicidade(parsed, fromPhone) {
  const seteDias = new Date();
  seteDias.setDate(seteDias.getDate() - 7);
  const txs = await dbSelect("transacoes",
    `?created_at=gte.${seteDias.toISOString()}&fornecedor=ilike.*${encodeURIComponent(parsed.fornecedor || "")}*`
  ) || [];
  return txs.find(t =>
    Math.abs(Number(t.valor) - Number(parsed.valor)) < 0.01 &&
    t.created_by_phone !== fromPhone
  ) || null;
}

// ─── Resumo gestor ────────────────────────────────────────────
async function sendResumoGestor(from) {
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
  const txs = await dbSelect("transacoes", `?status=eq.CONFIRMADO&created_at=gte.${inicioMes.toISOString()}`) || [];
  const boletos = await dbSelect("boletos_pendentes", "?status=eq.PENDENTE") || [];

  const receitas = txs.filter(t => t.tipo === "RECEITA").reduce((s, t) => s + Number(t.valor), 0);
  const despesas = txs.filter(t => t.tipo === "DESPESA").reduce((s, t) => s + Number(t.valor), 0);
  const totalPend = boletos.reduce((s, b) => s + Number(b.valor), 0);

  const mes = new Date().toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  let msg = `🤖 *${BOT_NAME}:*\n\n📊 *Resumo — ${mes.charAt(0).toUpperCase() + mes.slice(1)}*\n\n`;
  msg += `💰 Receitas: ${fmt(receitas)}\n💸 Despesas: ${fmt(despesas)}\n📈 Saldo: ${fmt(receitas - despesas)}\n`;
  msg += `📝 Lançamentos: ${txs.length}\n\n⏳ *Boletos pendentes: ${boletos.length} (${fmt(totalPend)})*`;
  await sendMessage(from, msg);
}

// ─── Boletos pendentes ────────────────────────────────────────
async function responderBoletos(from) {
  const boletos = await dbSelect("boletos_pendentes", "?status=eq.PENDENTE&order=vencimento_date.asc&limit=10") || [];
  if (!boletos.length) { await sendMessage(from, `🤖 *${BOT_NAME}:*\n\n📭 Nenhum boleto pendente.`); return; }

  let msg = `🤖 *${BOT_NAME}:*\n\n📋 *Boletos pendentes:*\n\n`;
  boletos.forEach(b => {
    const d = b.vencimento_date ? diasAteVencimento(b.vencimento_date) : "?";
    const u = d === 0 ? "🔴" : d <= 3 ? "🟡" : "🟢";
    msg += `${u} ${b.descricao} — ${fmt(b.valor)}\n📅 ${fmtDate(b.vencimento_date)} | ${b.entidade}\n\n`;
  });
  await sendMessage(from, msg);
}

// ─── Resolver entidade ────────────────────────────────────────
function resolverEntidade(lower, usuario) {
  const m = {
    "1":"Clínica João Pessoa","jp":"Clínica João Pessoa","joao pessoa":"Clínica João Pessoa","joão pessoa":"Clínica João Pessoa",
    "2":"Clínica Patos","patos":"Clínica Patos",
    "3":"Conjunta","conjunta":"Conjunta","ambas":"Conjunta",
    "4":"Paulo","paulo":"Paulo",
    "5":"Milena","milena":"Milena",
    "6":"Família","familia":"Família","família":"Família",
  };
  return m[lower] || null;
}

// ─── Confirmação ──────────────────────────────────────────────
function montarConfirmacao(dados, duplicata) {
  const e = { DESPESA:"💸", RECEITA:"💰", TRANSFERENCIA:"🔄", CAIXA:"🗃️" };
  let msg = `🤖 *${BOT_NAME}:*\n\n${e[dados.tipo]||"📝"} *${dados.tipoLabel||dados.tipo}*\n\n`;
  msg += `📋 ${dados.descricao}\n💵 ${fmt(dados.valor)}\n`;
  if (dados.parcelas) msg += `📦 ${dados.parcelas}x de ${fmt(dados.valorParcela)}\n`;
  msg += `🏥 ${dados.entidade}\n`;
  if (dados.fornecedor) msg += `🏢 ${dados.fornecedor}\n`;
  if (dados.vencimento) msg += `📅 Vencimento: ${dados.vencimento}\n`;
  if (dados.codigoBarras) msg += `🔢 \`${dados.codigoBarras}\`\n`;
  if (dados.categoria) msg += `🏷️ ${dados.categoria}\n`;
  if (duplicata) msg += `\n⚠️ *Alerta de duplicidade!*\n${duplicata.created_by} registrou algo similar recentemente.\n`;
  msg += `\nConfirmar? *sim* ou *não*`;
  return msg;
}

// ─── System Prompts ───────────────────────────────────────────
function montarSystemPromptTexto(usuario) {
  const isGestor = usuario.role === "GESTOR";
  return `Você é o assistente financeiro "${BOT_NAME}" de clínicas médicas. Tom formal e preciso.
USUÁRIO: ${usuario.nome} (${usuario.role})
ENTIDADES: Clínica João Pessoa (JP), Clínica Patos, Conjunta${isGestor ? ", Paulo, Milena, Família" : ""}
TIPOS: DESPESA (boleto/conta/compra), RECEITA (recebi/entrada/paciente - só gestores), CAIXA (fechamento), TRANSFERENCIA (só gestores)
FORNECEDORES: Energisa (luz), CAGEPA (água), Telly (internet), Aluguel, Folha de Pagamento
GASTOS PF: delivery, restaurante, salão, cabelo, farmácia, mercado, roupa → isPF: true
REGRAS: entidade não clara → null | parcelamento "12x 800" → parcelas:12,valorParcela:800,valor:9600
Responda APENAS JSON:
{"understood":true,"tipoDocumento":"LANCAMENTO","tipo":"DESPESA","tipoLabel":"Despesa","valor":380.0,"descricao":"Conta de Energia","fornecedor":"Energisa","entidade":"Clínica João Pessoa","vencimento":"dia 20","parcelas":null,"valorParcela":null,"codigoBarras":null,"isPF":false,"categoria":null}
Não entendeu: {"understood":false,"confirmationMessage":"❓ Não compreendi. Digite *ajuda*."}`;
}

function montarSystemPromptMidia(usuario) {
  const isGestor = usuario.role === "GESTOR";
  return `Especialista em leitura de documentos financeiros brasileiros.
TIPOS DE DOCUMENTO: BOLETO (pagamento futuro), COMPROVANTE (pagamento já feito), NOTA_FISCAL (compra feita)
USUÁRIO: ${usuario.nome} | ENTIDADES: Clínica JP, Clínica Patos, Conjunta${isGestor ? ", Paulo, Milena, Família" : ""}
FORNECEDORES: Energisa, CAGEPA, Telly, Aluguel, Folha de Pagamento
Extraia: tipo do documento, beneficiário, valor, vencimento/data, código de barras, entidade provável.
Responda APENAS JSON:
{"understood":true,"tipoDocumento":"BOLETO","tipo":"DESPESA","tipoLabel":"Despesa","valor":380.0,"descricao":"Conta Energisa","fornecedor":"Energisa","entidade":"Clínica João Pessoa","vencimento":"20/03/2026","parcelas":null,"valorParcela":null,"codigoBarras":"836600000013800...","isPF":false,"categoria":null}
Não leu: {"understood":false,"confirmationMessage":"⚠️ Não consegui ler. Descreva: \\"Boleto Energisa 380 vence dia 20 JP\\""}`;
}

// ─── Chamar IA ────────────────────────────────────────────────
async function chamarIA(systemPrompt, userMessage) {
  try {
    const response = await axios.post("https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-20250514", max_tokens: 1000, system: systemPrompt, messages: [{ role: "user", content: userMessage }] },
      { headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, timeout: 15000 }
    );
    return JSON.parse(response.data.content[0].text.replace(/```json\n?|\n?```/g, "").trim());
  } catch (err) {
    console.error("Erro IA:", err.message);
    return { understood: false, confirmationMessage: "⚠️ Erro temporário. Tente novamente." };
  }
}

// ─── Enviar mensagem ──────────────────────────────────────────
async function sendMessage(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Erro envio:", err.response?.data || err.message);
  }
}

// ─── Ajuda ────────────────────────────────────────────────────
async function sendHelpMessage(from, usuario) {
  const isGestor = usuario.role === "GESTOR";
  let msg = `🤖 *${BOT_NAME}*\n\n👋 Olá, *${usuario.nome}*!\n\n`;
  msg += `💸 *Despesas:*\n• "Boleto Energisa 380 dia 20 JP"\n• "Conta CAGEPA 95 Patos"\n• "Aluguel 2500 João Pessoa"\n\n`;
  msg += `📄 *Boleto/comprovante:* Envie a foto\n\n🗃️ *Caixa:* "Caixa JP: entrada 1500, saída 300"\n\n`;
  if (isGestor) {
    msg += `💰 *Receitas:* "Recebi paciente 450 Patos"\n\n🔄 *Transferências:* "Transferência Paulo 1000"\n\n`;
    msg += `📊 *Consultas:*\n• *saldo* — resumo do mês\n• *boletos* — pendentes\n\n`;
  }
  msg += `_Sempre confirmarei antes de registrar._`;
  await sendMessage(from, msg);
}

// ─── API para Lovable ─────────────────────────────────────────
app.get("/api/dashboard", async (req, res) => {
  try {
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
    const [txs, boletos] = await Promise.all([
      dbSelect("transacoes", `?status=eq.CONFIRMADO&created_at=gte.${inicioMes.toISOString()}`),
      dbSelect("boletos_pendentes", "?status=eq.PENDENTE"),
    ]);
    const lista = txs || []; const blist = boletos || [];
    const receitas = lista.filter(t => t.tipo === "RECEITA").reduce((s, t) => s + Number(t.valor), 0);
    const despesas = lista.filter(t => t.tipo === "DESPESA").reduce((s, t) => s + Number(t.valor), 0);
    res.json({
      totalReceitas: receitas, totalDespesas: despesas, saldo: receitas - despesas,
      totalLancamentos: lista.length, boletosPendentes: blist.length,
      totalPendente: blist.reduce((s, b) => s + Number(b.valor), 0),
      recentTransactions: lista.slice(-5).reverse(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/transactions", async (req, res) => {
  const { entidade, tipo, status } = req.query;
  let filters = "?order=created_at.desc";
  if (entidade) filters += `&entidade=eq.${entidade}`;
  if (tipo) filters += `&tipo=eq.${tipo}`;
  if (status) filters += `&status=eq.${status}`;
  const data = await dbSelect("transacoes", filters);
  res.json(data || []);
});

app.get("/api/bills", async (req, res) => {
  const data = await dbSelect("boletos_pendentes", "?status=eq.PENDENTE&order=vencimento_date.asc");
  res.json(data || []);
});

// ─── Health ───────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "4.0", db: !!DATABASE_URL, timestamp: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log("🚀 Gestor IA WhatsApp v4 rodando na porta 3000");
  console.log(`🤖 IA: ${ANTHROPIC_API_KEY ? "configurada ✅" : "NÃO configurada ❌"}`);
  console.log(`📱 WhatsApp Token: ${ACCESS_TOKEN ? "configurado ✅" : "NÃO configurado ❌"}`);
  console.log(`🗄️  Banco: ${DATABASE_URL ? "configurado ✅" : "NÃO configurado ❌"}`);
});
