// Horta Inteligente — lê os dados do Firebase e mostra na página
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getDatabase, ref, onValue, query, orderByChild, limitToLast
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { iniciarClima } from "./clima.js";
import { iniciarDecisao } from "./decisao.js";
import { iniciarControle } from "./controle.js";
import { iniciarDemo } from "./demo.js";
import { iniciarAgua, numero } from "./agua.js";
import { iniciarFalha } from "./falha.js";
import { iniciarPodeRegar, LIMITE_LIGAR, LIMITE_DESLIGAR, LIMITE_CRITICO } from "./podeRegar.js";
import { desenharQR } from "./qr.js";
import { TELEGRAM_CANAL, arrobaDoCanal, ligarLinksTelegram } from "./config.js";
import { iniciarCabecalho } from "./cabecalho.js";
import { iniciarAbas } from "./abas.js";
import { iniciarProjetor } from "./projetor.js";
import { haQuanto, semSinal, quandoFoi, hora as horaDe } from "./tempo.js";

iniciarCabecalho();

// ---------- Quem pode mexer nos controles ----------
// Tela grande (o computador do projetor) ou ?demo=1 na URL (a professora no
// celular). No celular do visitante, nada que escreva no Firebase aparece:
// sem aba Demonstração, sem Manual/Ligar, sem "Já resolvi" e sem os botões da
// faixa (a classe "so-leitura" no <body> esconde tudo isso pelo CSS).
const demoNaUrl = new URLSearchParams(location.search).get("demo") === "1";
const telaGrande = matchMedia("(min-width: 1024px)");
const podeControlar = () => telaGrande.matches || demoNaUrl;
function aplicarPermissao() {
  document.body.classList.toggle("so-leitura", !podeControlar());
  document.getElementById("nota-demo").hidden = !(demoNaUrl && !telaGrande.matches);
}
aplicarPermissao();

// Gráficos: letras de pelo menos 14 px na tela grande (no projetor, ~10 px não dá para ler)
if (typeof Chart !== "undefined") {
  Chart.defaults.font.size = matchMedia("(min-width: 1400px)").matches ? 16 : telaGrande.matches ? 14 : 12;
}

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Sem dado novo por um tempo, consideramos o ESP32 offline.
// No modo teste ele manda o estado a cada 5 s: 20 s sem nada já é offline.
// No modo normal ele manda a cada 30 s: aí esperamos 2 min.
const LIMITE_OFFLINE_TESTE_MS = 20 * 1000;
const LIMITE_OFFLINE_MS = 2 * 60 * 1000;

// Elementos da página
const elUmidade = document.getElementById("umidade");
const elBarra = document.getElementById("barra");
const elBomba = document.getElementById("bomba");
const elAtualizacao = document.getElementById("atualizacao");
const elOffline = document.getElementById("offline");
const elHoraHorta = document.getElementById("hora-horta");

// ---------- Controle da bomba no cartão "Bomba d'água" (código em controle.js) ----------
const controle = iniciarControle(db, document.getElementById("controle"));

// ---------- Cartão "Modo demonstração" (código em demo.js) ----------
const demo = iniciarDemo(db, document.getElementById("demo"), document.getElementById("clima"));

let ultimoTs = null;     // horário (do servidor) do último dado recebido
let modoTeste = false;   // o ESP32 está com MODO_TESTE ligado?
let diferencaRelogio = 0; // diferença entre o relógio do servidor e o do computador

// O Firebase informa a diferença entre o relógio dele e o nosso,
// assim o "há X s" fica certo mesmo se o relógio do celular estiver errado.
onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
  diferencaRelogio = snap.val() || 0;
});

// ---------- Estado atual (atualiza sozinho a cada envio do ESP32) ----------
onValue(ref(db, "horta/estado"), (snap) => {
  const estado = snap.val();
  if (!estado) {
    elAtualizacao.textContent = "Aguardando o primeiro dado do ESP32...";
    return;
  }

  // Chegou o primeiro dado: troca o "Aguardando o ESP32…" pelos valores
  document.querySelectorAll("[data-espera]").forEach((el) => { el.hidden = true; });
  document.querySelectorAll("[data-com-dados]").forEach((el) => { el.hidden = false; });

  elUmidade.textContent = estado.umidade;
  elBarra.style.width = estado.umidade + "%";

  elBomba.textContent = estado.bomba ? "Ligada 💧" : "Desligada";
  elBomba.classList.toggle("ligada", estado.bomba);

  // "Hora da horta": a hora que o ESP32 está usando na decisão
  horaHorta = typeof estado.hora === "number" ? estado.hora : null;
  mostrarHoraHorta();

  ultimoTs = estado.ts;
  modoTeste = estado.modoTeste === true;
  atualizarTempo();
});

// ---------- "Hora da horta: 14h (simulada)" no cabeçalho ----------
let horaHorta = null;      // hora usada pelo ESP32 (vem no estado)
let horaSimulada = -1;     // hora que o site está simulando (-1 = hora real)
onValue(ref(db, "horta/comandos/simularHora"), (snap) => {
  horaSimulada = typeof snap.val() === "number" ? snap.val() : -1;
  mostrarHoraHorta();
});
function mostrarHoraHorta() {
  elHoraHorta.hidden = horaHorta === null;
  // "(simulada)" só quando o ESP32 já está usando a hora simulada
  const simulada = horaSimulada >= 0 && horaHorta === horaSimulada;
  elHoraHorta.textContent = `🕐 ${horaHorta}h${simulada ? " (simulada)" : ""}`;
  elHoraHorta.title = "Hora que a horta está usando na decisão";
}

// ---------- "Última atualização: há X s" ----------
function atualizarTempo() {
  if (ultimoTs === null) return;

  const agora = Date.now() + diferencaRelogio;
  elAtualizacao.textContent = `Última atualização: ${haQuanto(ultimoTs, agora)}`;

  // O limite (20 s no modo teste, 2 min no normal) decide QUANDO o aviso
  // aparece; o texto diz o tempo de verdade, igual ao rodapé
  const limite = modoTeste ? LIMITE_OFFLINE_TESTE_MS : LIMITE_OFFLINE_MS;
  const online = agora - ultimoTs < limite;
  elOffline.textContent = `⚠️ ESP32 sem sinal ${semSinal(ultimoTs, agora)}.`;
  elOffline.hidden = online;
  controle.definirOffline(!online);  // sem ESP32, os botões ficam desativados
  demo.definirOffline(!online);
  podeRegar.definirOffline(!online);
}
setInterval(atualizarTempo, 1000);

// ---------- Cartão "Clima agora" (código em clima.js) ----------
iniciarClima(db, document.getElementById("clima"), {
  textoSemDados: "Previsão do tempo indisponível no momento.",
  mostrarFaixaChuva: true
});

// ---------- "Últimas decisões" (Histórico) e "Última decisão" (Agora) (código em decisao.js) ----------
iniciarDecisao(db, document.getElementById("decisao"), { ultima: document.getElementById("ultima-decisao") });

// ---------- Faixa vermelha de falha, no topo e no cartão da bomba (código em falha.js) ----------
const falha = iniciarFalha(db, [document.getElementById("falha"), document.getElementById("falha-bomba")]);

// ---------- Faixa "Pode regar agora?" (código em podeRegar.js) ----------
// Os botões ao lado do bloqueio usam as mesmas funções do Modo demonstração e da falha
const podeRegar = iniciarPodeRegar(db, document.getElementById("pode-regar"), {
  zerarCota: demo.zerarCota,
  voltarAoReal: demo.voltarAoReal,
  resolverFalha: falha.resolver
});

// ---------- Cartão "Água" (código em agua.js) ----------
// O "Zerar contagem" fica na aba Demonstração
const agua = iniciarAgua(db, document.getElementById("agua"), { raizZerar: document.getElementById("zerar-contagem") });

// ---------- Cartão "Água economizada" (aba Agora): o mesmo número da aba Água ----------
const elEconomia = document.getElementById("cartao-economia");
agua.aoResumo((resumo) => {
  const valor = elEconomia.querySelector('[data-economia="valor"]');
  const coisas = elEconomia.querySelector('[data-economia="coisas"]');
  if (!resumo.comecou) {
    valor.textContent = "--";
    coisas.textContent = "começa a contar na primeira rega";
    elEconomia.querySelector(".economia-mais").textContent = "comparado a um timer fixo · ver detalhes ›";
    return;
  }
  valor.textContent = `${numero(resumo.economia, 1)} L`;
  elEconomia.querySelector(".economia-mais").textContent = `desde ${quandoFoi(resumo.inicio)} · ver detalhes ›`;
  valor.classList.toggle("agua-negativa", resumo.economia < 0);
  coisas.textContent = resumo.economia < 0
    ? "a horta usou mais água que o timer"
    : resumo.coisas.find((linha) => linha.includes("garraf")) || resumo.coisas[0] || "";
});

// ---------- Tracinhos de liga/desliga na barra de umidade ----------
document.querySelector('[data-marca="ligar"]').style.left = `${LIMITE_LIGAR}%`;
document.querySelector('[data-marca="desligar"]').style.left = `${LIMITE_DESLIGAR}%`;
document.querySelector("[data-limites]").textContent = `liga ${LIMITE_LIGAR}% · desliga ${LIMITE_DESLIGAR}%`;

// ---------- Cartão "Receba os alertas da horta" (canal do Telegram) ----------
// Quem olha o projetor já está vendo o site: o QR é o do canal, não o do painel.
// QR na tela grande; no celular, o botão "Abrir canal no Telegram".
if (TELEGRAM_CANAL) {
  document.getElementById("cartao-telegram").hidden = false;
  document.querySelector("[data-telegram-arroba]").textContent = arrobaDoCanal();
  desenharQR(document.getElementById("qr-telegram"), TELEGRAM_CANAL);  // link fixo: aparece até no localhost
}
ligarLinksTelegram();  // botão do cartão e link do rodapé

// ---------- Gráfico com as últimas 50 leituras (aba Histórico) ----------
// Faixas de fundo com os limites da rega: a cor vai antes da curva; o
// rótulo vai por cima, no canto da faixa mais longe da linha (com fundo claro)
const FAIXAS = [
  { de: LIMITE_DESLIGAR, ate: 100, fundo: "rgba(46, 125, 50, 0.12)", texto: `desliga (acima de ${LIMITE_DESLIGAR}%)`, cor: "#1b5e20" },
  { de: LIMITE_CRITICO, ate: LIMITE_LIGAR, fundo: "rgba(249, 168, 37, 0.18)", texto: `liga (abaixo de ${LIMITE_LIGAR}%)`, cor: "#7a4f00" },
  { de: 0, ate: LIMITE_CRITICO, fundo: "rgba(229, 57, 53, 0.14)", texto: `crítico (abaixo de ${LIMITE_CRITICO}%)`, cor: "#b71c1c" }
];
const faixasUmidade = {
  id: "faixasUmidade",
  beforeDraw(chart) {
    const { ctx, chartArea: area, scales: { y } } = chart;
    if (!area) return;
    ctx.save();
    for (const f of FAIXAS) {
      const topo = y.getPixelForValue(f.ate);
      ctx.fillStyle = f.fundo;
      ctx.fillRect(area.left, topo, area.right - area.left, y.getPixelForValue(f.de) - topo);
    }
    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const { ctx, chartArea: area, scales: { y } } = chart;
    if (!area) return;
    // Pontos da linha (e o meio de cada trecho) para saber onde ela passa
    const pontos = [];
    const dados = chart.getDatasetMeta(0).data;
    dados.forEach((p, i) => {
      pontos.push(p);
      if (dados[i + 1]) pontos.push({ x: (p.x + dados[i + 1].x) / 2, y: (p.y + dados[i + 1].y) / 2 });
    });
    const colide = (r) => pontos.some((p) => p.x >= r.x - 6 && p.x <= r.x + r.w + 6 && p.y >= r.y - 6 && p.y <= r.y + r.h + 6);

    ctx.save();
    const tamanho = Chart.defaults.font.size;
    ctx.font = `600 ${tamanho}px ${Chart.defaults.font.family}`;
    ctx.textBaseline = "middle";
    for (const f of FAIXAS) {
      const topo = y.getPixelForValue(f.ate);
      const base = y.getPixelForValue(f.de);
      const w = ctx.measureText(f.texto).width + 12;
      const h = Math.min(tamanho + 8, base - topo);
      const direita = area.right - w - 6;
      const esquerda = area.left + 6;
      // Tenta os quatro cantos; se todos colidirem, fica no canto de cima à direita
      const cantos = [
        { x: direita, y: topo + 3 }, { x: direita, y: base - h - 3 },
        { x: esquerda, y: topo + 3 }, { x: esquerda, y: base - h - 3 }
      ].map((c) => ({ ...c, w, h }));
      const lugar = cantos.find((c) => !colide(c)) || cantos[0];
      ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
      ctx.fillRect(lugar.x, lugar.y, w, h);
      ctx.fillStyle = f.cor;
      ctx.fillText(f.texto, lugar.x + 6, lugar.y + h / 2);
    }
    ctx.restore();
  }
};

const grafico = new Chart(document.getElementById("grafico"), {
  type: "line",
  data: {
    labels: [],
    datasets: [{
      label: "Umidade do solo (%)",
      data: [],
      borderColor: "#2e7d32",
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 3
    }, {
      // Regas: pontos azuis sobre a curva (sem linha)
      label: "Rega",
      data: [],
      showLine: false,
      pointRadius: 7,
      pointHoverRadius: 9,
      pointBackgroundColor: "#1565c0",
      pointBorderColor: "#fff",
      pointBorderWidth: 2
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        position: "bottom",
        labels: { filter: (item) => item.datasetIndex === 1, usePointStyle: true }
      }
    },
    scales: {
      y: { min: 0, max: 100, ticks: { callback: (v) => v + "%" } },
      x: { ticks: { maxTicksLimit: 6 } }
    }
  },
  plugins: [faixasUmidade]
});

let leiturasGrafico = [];   // [{ ts, umidade }]
let regasGrafico = [];      // [{ inicio, fim }] de /horta/regas

// Marca as leituras que caíram durante cada rega. Rega curta, sem leitura
// no meio, marca a leitura mais perto do fim dela.
function desenharUmidade() {
  const marcadas = new Set();
  const primeira = leiturasGrafico[0]?.ts;
  const ultima = leiturasGrafico[leiturasGrafico.length - 1]?.ts;
  for (const rega of regasGrafico) {
    if (primeira === undefined || rega.fim < primeira || rega.inicio > ultima) continue;
    let achou = false;
    leiturasGrafico.forEach((l, i) => {
      if (l.ts >= rega.inicio && l.ts <= rega.fim) { marcadas.add(i); achou = true; }
    });
    if (!achou) {
      let perto = 0;
      leiturasGrafico.forEach((l, i) => {
        if (Math.abs(l.ts - rega.fim) < Math.abs(leiturasGrafico[perto].ts - rega.fim)) perto = i;
      });
      marcadas.add(perto);
    }
  }
  grafico.data.labels = leiturasGrafico.map((l) => horaDe(l.ts));
  grafico.data.datasets[0].data = leiturasGrafico.map((l) => l.umidade);
  grafico.data.datasets[1].data = leiturasGrafico.map((l, i) => (marcadas.has(i) ? l.umidade : null));
  // A legenda "Rega" só aparece se houver rega no intervalo do gráfico
  grafico.options.plugins.legend.display = marcadas.size > 0;
  grafico.update();

  // "ontem, 14:41–14:48 · 50 leituras · uma a cada 30 s (10 s no modo teste)"
  const info = document.getElementById("grafico-info");
  if (primeira === undefined) {
    info.textContent = "Nenhuma leitura ainda.";
    return;
  }
  const dia = quandoFoi(ultima).split(" ").slice(0, -1).join(" ");  // "hoje", "ontem", "seg 28"
  const n = leiturasGrafico.length;
  info.textContent = `${dia}, ${horaDe(primeira)}–${horaDe(ultima)} · ${n} ${n === 1 ? "leitura" : "leituras"} · ` +
    "uma a cada 30 s (10 s no modo teste)";
}

onValue(query(ref(db, "horta/leituras"), orderByChild("ts"), limitToLast(50)), (snap) => {
  leiturasGrafico = [];
  snap.forEach((filho) => {
    const leitura = filho.val();
    leiturasGrafico.push({ ts: leitura.ts, umidade: leitura.umidade });
  });
  desenharUmidade();
});

onValue(query(ref(db, "horta/regas"), orderByChild("fim"), limitToLast(30)), (snap) => {
  regasGrafico = [];
  snap.forEach((filho) => {
    const rega = filho.val();
    const inicio = typeof rega.inicio === "number" ? rega.inicio : rega.fim - (Number(rega.segundos) || 0) * 1000;
    regasGrafico.push({ inicio, fim: rega.fim });
  });
  desenharUmidade();
});

// ---------- Abas (código em abas.js) ----------
// Gráfico criado com a aba escondida fica com tamanho zero: acerta quando ela aparece
const abas = iniciarAbas({
  padrao: "agora",
  permitida: (nome) => nome !== "demo" || podeControlar(),
  aoMostrar: (nome) => {
    if (nome === "historico") grafico.resize();
    if (nome === "agua") agua.redimensionar();
  }
});
telaGrande.addEventListener("change", () => {
  aplicarPermissao();
  abas.atualizar();
});

// ---------- Modo projetor: alterna as abas sozinho (código em projetor.js) ----------
iniciarProjetor(db, abas, document.getElementById("chave-projetor"));
