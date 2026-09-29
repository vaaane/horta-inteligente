// Horta Inteligente — lê os dados do Firebase e mostra na página
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getDatabase, ref, onValue, query, orderByChild, limitToLast
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { iniciarClima } from "./clima.js";
import { iniciarDecisao } from "./decisao.js";
import { iniciarControle } from "./controle.js";
import { desenharQR } from "./qr.js";

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

// ---------- Controle da bomba no cartão "Bomba d'água" (código em controle.js) ----------
const controle = iniciarControle(db, document.getElementById("controle"));

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

  ultimoTs = estado.ts;
  modoTeste = estado.modoTeste === true;
  atualizarTempo();
});

// ---------- "Última atualização: há X s" ----------
function atualizarTempo() {
  if (ultimoTs === null) return;

  const agora = Date.now() + diferencaRelogio;
  const segundos = Math.max(0, Math.round((agora - ultimoTs) / 1000));

  let texto;
  if (segundos < 60) texto = `há ${segundos} s`;
  else if (segundos < 3600) texto = `há ${Math.floor(segundos / 60)} min`;
  else texto = `há ${Math.floor(segundos / 3600)} h`;
  elAtualizacao.textContent = `Última atualização: ${texto}`;

  const limite = modoTeste ? LIMITE_OFFLINE_TESTE_MS : LIMITE_OFFLINE_MS;
  const online = agora - ultimoTs < limite;
  elOffline.textContent = `⚠️ ESP32 offline — nenhum dado novo há mais de ${modoTeste ? "20 segundos" : "2 minutos"}.`;
  elOffline.hidden = online;
  controle.definirOffline(!online);  // sem ESP32, os botões ficam desativados
}
setInterval(atualizarTempo, 1000);

// ---------- Cartão "Clima agora" (código em clima.js) ----------
iniciarClima(db, document.getElementById("clima"), {
  textoSemDados: "Previsão do tempo indisponível no momento.",
  mostrarFaixaChuva: true
});

// ---------- Cartão "Por que regou (ou não)" (código em decisao.js) ----------
iniciarDecisao(db, document.getElementById("decisao"));

// ---------- QR code "Abra no seu celular" (só aparece na tela grande) ----------
desenharQR(document.getElementById("qr"));

// ---------- Gráfico com as últimas 50 leituras ----------
const grafico = new Chart(document.getElementById("grafico"), {
  type: "line",
  data: {
    labels: [],
    datasets: [{
      label: "Umidade do solo (%)",
      data: [],
      borderColor: "#2e7d32",
      backgroundColor: "rgba(46, 125, 50, 0.12)",
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 3
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false } },
    scales: {
      y: { min: 0, max: 100, ticks: { callback: (v) => v + "%" } },
      x: { ticks: { maxTicksLimit: 6 } }
    }
  }
});

const ultimasLeituras = query(ref(db, "horta/leituras"), orderByChild("ts"), limitToLast(50));

onValue(ultimasLeituras, (snap) => {
  const horarios = [];
  const valores = [];

  snap.forEach((filho) => {
    const leitura = filho.val();
    const hora = new Date(leitura.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    horarios.push(hora);
    valores.push(leitura.umidade);
  });

  grafico.data.labels = horarios;
  grafico.data.datasets[0].data = valores;
  grafico.update();
});
