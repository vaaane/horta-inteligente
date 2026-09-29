// Cartão "Água" — água usada pela horta e quanto um timer fixo teria usado
// ESTIMATIVA: não há sensor de fluxo. O ESP32 grava cada rega em
// horta/regas com o tempo de bomba ligada × a vazão de referência.
//
// Como usar:
//   iniciarAgua(db, document.getElementById("agua"));
// O elemento raiz já deve ter o título do cartão; o resto é criado aqui.
import {
  ref, onValue, query, orderByChild, startAt, limitToLast, set, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { quando } from "./decisao.js";

// Irrigação por timer fixo que usamos para comparar (uma horta comum):
const TIMER_REGAS_POR_DIA = 2;      // manhã e tarde
const TIMER_MINUTOS_POR_REGA = 5;
const VAZAO_L_MIN = 1.5;            // igual à do firmware
const LITROS_BANHO_5MIN = 45;       // banho de 5 minutos, chuveiro comum (estimativa)
const LITROS_GARRAFAO = 20;

const DIA_MS = 24 * 60 * 60 * 1000;

// Números no jeito brasileiro: 1,5
const numero = (valor, casas = 1) =>
  Number(valor).toLocaleString("pt-BR", { maximumFractionDigits: casas });

// "45 s", "2 min 5 s", "1 h 3 min"
function duracao(segundos) {
  segundos = Math.max(0, Math.round(segundos));
  if (segundos < 60) return `${segundos} s`;
  const min = Math.floor(segundos / 60);
  if (min < 60) return segundos % 60 ? `${min} min ${segundos % 60} s` : `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function iniciarAgua(db, raiz) {
  // Selo "Estimativa" no título
  raiz.querySelector("h2")?.insertAdjacentHTML("beforeend", ` <span class="selo selo-estimativa">Estimativa</span>`);

  raiz.insertAdjacentHTML("beforeend", `
    <p data-agua="regando" class="agua-regando" hidden></p>
    <dl class="agua-valores">
      <div><dt>Água usada</dt><dd data-agua="usada">--</dd><p data-agua="regas" class="agua-sub"></p></div>
      <div><dt>Um timer fixo teria usado</dt><dd data-agua="timer">--</dd><p data-agua="timer-sub" class="agua-sub"></p></div>
      <div><dt>Economia</dt><dd data-agua="economia">--</dd><p data-agua="economia-sub" class="agua-sub"></p></div>
    </dl>
    <p data-agua="traducao" class="agua-traducao" hidden></p>
    <p class="agua-nota">Calculado pelo tempo de bomba ligada × vazão de ${numero(VAZAO_L_MIN)} L/min. Sem sensor de fluxo.
      Timer de comparação: ${TIMER_REGAS_POR_DIA} regas por dia de ${TIMER_MINUTOS_POR_REGA} min.</p>

    <details class="agua-lista">
      <summary>Últimas regas</summary>
      <p data-agua="vazio" class="decisao-vazio">Nenhuma rega registrada ainda.</p>
      <ol data-agua="lista" class="decisao-lista"></ol>
    </details>

    <div class="agua-zerar">
      <button type="button" data-agua="zerar" class="agua-botao">Zerar contagem</button>
      <div data-agua="confirmar" class="agua-confirmar" hidden>
        <span>Começar a medição de agora?</span>
        <button type="button" data-agua="sim" class="agua-botao agua-botao-forte">Sim, zerar</button>
        <button type="button" data-agua="nao" class="agua-botao">Cancelar</button>
      </div>
      <p data-agua="erro" class="controle-status aviso-controle" hidden></p>
    </div>
  `);

  // Procura só dentro deste cartão
  const $ = (nome) => raiz.querySelector(`[data-agua="${nome}"]`);

  let diferencaRelogio = 0;   // relógio do servidor - relógio do celular
  let inicioMedicao = null;   // horta/config/inicioMedicao (null = medir tudo)
  let regas = [];             // regas desde o início da medição
  let bombaLigada = false;
  let regandoDesde = null;    // hora (do servidor) em que a bomba ligou, se soubermos
  let pararDeOuvir = null;    // cancela a leitura das regas quando o início muda

  const agora = () => Date.now() + diferencaRelogio;

  onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
    diferencaRelogio = snap.val() || 0;
  });

  // Início da medição: lê as regas com fim >= inicioMedicao
  onValue(ref(db, "horta/config/inicioMedicao"), (snap) => {
    inicioMedicao = typeof snap.val() === "number" ? snap.val() : null;
    if (pararDeOuvir) pararDeOuvir();
    const consulta = inicioMedicao === null
      ? query(ref(db, "horta/regas"), orderByChild("fim"))
      : query(ref(db, "horta/regas"), orderByChild("fim"), startAt(inicioMedicao));
    pararDeOuvir = onValue(consulta, (snapRegas) => {
      regas = [];
      snapRegas.forEach((filho) => { regas.push(filho.val()); });
      mostrar();
      mostrarLista();
    });
  });

  // Bomba ligada agora? A hora em que ligou vem de duas fontes:
  //  - vimos a bomba passar de desligada para ligada (painel aberto);
  //  - senão, pelas últimas leituras do histórico (a sequência de "ligada" no fim).
  let bombaAnterior = null;
  let ultimasLeituras = [];

  function estimarInicioPelasLeituras() {
    if (!bombaLigada || regandoDesde !== null) return;
    let inicio = null;
    for (let i = ultimasLeituras.length - 1; i >= 0 && ultimasLeituras[i].bomba; i--) {
      inicio = ultimasLeituras[i].ts;
    }
    regandoDesde = inicio;
  }

  onValue(ref(db, "horta/estado"), (snap) => {
    const estado = snap.val();
    bombaLigada = !!(estado && estado.bomba);
    if (bombaLigada && bombaAnterior === false) regandoDesde = estado.ts || agora();
    if (!bombaLigada) regandoDesde = null;
    bombaAnterior = estado ? bombaLigada : null;  // sem estado ainda: não sabemos se estava desligada
    estimarInicioPelasLeituras();
    mostrar();
  });
  onValue(query(ref(db, "horta/leituras"), orderByChild("ts"), limitToLast(60)), (snap) => {
    ultimasLeituras = [];
    snap.forEach((filho) => { ultimasLeituras.push(filho.val()); });
    estimarInicioPelasLeituras();
    mostrar();
  });

  function mostrar() {
    // Água usada
    const litros = regas.reduce((soma, r) => soma + (Number(r.litros) || 0), 0);
    $("usada").textContent = `${numero(litros, 1)} L`;
    $("regas").textContent = regas.length === 1 ? "1 rega" : `${regas.length} regas`;

    // Timer fixo: dias desde o início (o dia de hoje conta pelas horas que já passaram)
    let inicio = inicioMedicao;
    if (inicio === null && regas.length > 0) {
      inicio = Math.min(...regas.map((r) => (typeof r.inicio === "number" ? r.inicio : r.fim)));
    }
    if (inicio === null) {
      $("timer").textContent = "--";
      $("timer-sub").textContent = "começa a contar na primeira rega";
      $("economia").textContent = "--";
      $("economia-sub").textContent = "";
      $("traducao").hidden = true;
    } else {
      const dias = Math.max(0, agora() - inicio) / DIA_MS;
      const timer = dias * TIMER_REGAS_POR_DIA * TIMER_MINUTOS_POR_REGA * VAZAO_L_MIN;
      $("timer").textContent = `${numero(timer, 1)} L`;
      $("timer-sub").textContent = dias < 1
        ? `em ${duracao(dias * DIA_MS / 1000)} de medição`
        : `em ${numero(dias, 1)} dias de medição`;

      // Economia
      const economia = timer - litros;
      const porcento = timer > 0 ? Math.round((economia / timer) * 100) : 0;
      $("economia").textContent = `${numero(economia, 1)} L`;
      $("economia").classList.toggle("agua-negativa", economia < 0);
      if (timer < 0.1) $("economia-sub").textContent = "";
      else if (economia >= 0) $("economia-sub").textContent = `${porcento}% menos que o timer`;
      else $("economia-sub").textContent = `${-porcento}% a mais que o timer`;

      // Tradução em banhos e garrafões (só quando a diferença já aparece: 0,1 L ou mais)
      $("traducao").hidden = false;
      if (economia >= 0.1) {
        const banhos = economia / LITROS_BANHO_5MIN;
        const garrafoes = economia / LITROS_GARRAFAO;
        $("traducao").textContent =
          `≈ ${numero(banhos)} ${banhos >= 2 ? "banhos" : "banho"} de 5 minutos · ` +
          `≈ ${numero(garrafoes)} ${garrafoes >= 2 ? "garrafões" : "garrafão"} de 20 L`;
      } else if (economia <= -0.1) {
        $("traducao").textContent = "Nesta medição a horta usou mais água que o timer.";
      } else {
        $("traducao").hidden = true;
      }
    }

    // Regando agora (essa rega só entra na soma quando terminar)
    $("regando").hidden = !bombaLigada;
    if (bombaLigada) {
      $("regando").textContent = regandoDesde === null
        ? "💧 Regando agora… (entra na soma quando terminar)"
        : `💧 Regando agora… ${duracao((agora() - regandoDesde) / 1000)} (entra na soma quando terminar)`;
    }
  }

  // Lista recolhível: as 10 regas mais recentes
  function mostrarLista() {
    const ultimas = [...regas].sort((a, b) => b.fim - a.fim).slice(0, 10);
    $("vazio").hidden = ultimas.length > 0;
    $("lista").replaceChildren(...ultimas.map((rega) => {
      const li = document.createElement("li");
      const hora = document.createElement("span");
      hora.className = "decisao-hora";
      hora.textContent = quando(rega.fim);
      const texto = document.createElement("span");
      texto.textContent = `${duracao(rega.segundos)} · ${numero(rega.litros, 2)} L`;
      li.append(hora, texto);
      return li;
    }));
  }

  // Zerar contagem: pede confirmação no próprio cartão
  $("zerar").addEventListener("click", () => {
    $("zerar").hidden = true;
    $("confirmar").hidden = false;
  });
  $("nao").addEventListener("click", () => {
    $("confirmar").hidden = true;
    $("zerar").hidden = false;
  });
  $("sim").addEventListener("click", async () => {
    $("erro").hidden = true;
    try {
      await set(ref(db, "horta/config/inicioMedicao"), serverTimestamp());
    } catch (e) {
      $("erro").textContent = "Não consegui zerar: " + e.message +
        (e.code === "PERMISSION_DENIED" ? " (as regras do Firebase foram publicadas?)" : "");
      $("erro").hidden = false;
    }
    $("confirmar").hidden = true;
    $("zerar").hidden = false;
  });

  setInterval(mostrar, 1000);  // o tempo da rega e o timer correm
  mostrar();
}
