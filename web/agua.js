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

  // Rega em andamento: entra na soma AO VIVO (segundos × vazão).
  // A hora em que a bomba ligou vem, em ordem de preferência:
  //  1) do campo regaDesde que o ESP32 manda no estado (hora do servidor);
  //  2) de ter visto a bomba passar de desligada para ligada (painel aberto);
  //  3) das últimas leituras do histórico (a sequência de "ligada" no fim).
  let bombaAnterior = null;
  let desdeVisto = null;       // (2)
  let ultimasLeituras = [];
  // Rega que acabou de terminar, mas cujo registro ainda não chegou em
  // horta/regas: continua na soma até chegar (para o valor não "pular").
  let terminada = null;        // { desde, fim, ate }

  function inicioPelasLeituras() {
    let inicio = null;
    for (let i = ultimasLeituras.length - 1; i >= 0 && ultimasLeituras[i].bomba; i--) {
      inicio = ultimasLeituras[i].ts;
    }
    return inicio;
  }

  function inicioRegaAtual() {
    if (!bombaLigada) return null;
    if (typeof estadoAtual.regaDesde === "number") return estadoAtual.regaDesde;
    return desdeVisto ?? inicioPelasLeituras();
  }

  // A rega que começou em "desde" já está entre as fechadas? (o registro chegou)
  const jaRegistrada = (desde) => regas.some((r) => r.fim > desde);

  let estadoAtual = {};
  onValue(ref(db, "horta/estado"), (snap) => {
    const estado = snap.val();
    const desdeAntes = inicioRegaAtual();
    estadoAtual = estado || {};
    bombaLigada = !!(estado && estado.bomba);

    if (bombaLigada && bombaAnterior === false) desdeVisto = estado.ts || agora();
    if (!bombaLigada && bombaAnterior === true && desdeAntes !== null) {
      // Acabou de desligar: guarda até o registro chegar (no máximo 2 min)
      terminada = { desde: desdeAntes, fim: estado.ts || agora(), ate: agora() + 2 * 60 * 1000 };
    }
    if (!bombaLigada) desdeVisto = null;
    bombaAnterior = estado ? bombaLigada : null;  // sem estado ainda: não sabemos se estava desligada
    mostrar();
  });
  onValue(query(ref(db, "horta/leituras"), orderByChild("ts"), limitToLast(60)), (snap) => {
    ultimasLeituras = [];
    snap.forEach((filho) => { ultimasLeituras.push(filho.val()); });
    mostrar();
  });

  // Mostra os litros de meio em meio litro, arredondando para baixo:
  // 0 L, 0,5 L, 1 L, 1,5 L… (no Firebase eles continuam com 2 casas)
  const meio = (litros) => Math.floor(litros * 2) / 2;
  const litrosTela = (litros) => `${numero(meio(litros), 1)} L`;

  function mostrar() {
    // Parte ao vivo: a rega de agora (ou a que acabou e ainda não foi registrada)
    let desdeAoVivo = null;
    let fimAoVivo = null;
    let emAndamento = false;
    const inicioAtual = inicioRegaAtual();
    if (inicioAtual !== null && !jaRegistrada(inicioAtual)) {
      desdeAoVivo = inicioAtual;
      fimAoVivo = agora();
      emAndamento = true;
    } else if (terminada && (jaRegistrada(terminada.desde) || agora() > terminada.ate)) {
      terminada = null;  // o registro chegou: a rega passa a contar entre as fechadas
    }
    if (!emAndamento && terminada) {
      desdeAoVivo = terminada.desde;
      fimAoVivo = terminada.fim;
    }
    let litrosAoVivo = 0;
    if (desdeAoVivo !== null) {
      // Se zeraram a contagem no meio da rega, conta só a partir do zero
      const desde = inicioMedicao !== null ? Math.max(desdeAoVivo, inicioMedicao) : desdeAoVivo;
      litrosAoVivo = Math.max(0, fimAoVivo - desde) / 1000 / 60 * VAZAO_L_MIN;
    }

    // Água usada = regas fechadas + a parte ao vivo
    const litros = regas.reduce((soma, r) => soma + (Number(r.litros) || 0), 0) + litrosAoVivo;
    $("usada").textContent = litrosTela(litros);
    const fechadas = regas.length + (!emAndamento && terminada ? 1 : 0);
    $("regas").textContent = (fechadas === 1 ? "1 rega" : `${fechadas} regas`) +
      (emAndamento ? " + 1 em andamento" : "");

    // Timer fixo: dias desde o início (o dia de hoje conta pelas horas que já passaram).
    // Sem "Zerar contagem", começa na primeira rega, fechada ou em andamento.
    let inicio = inicioMedicao;
    if (inicio === null) {
      const inicios = regas.map((r) => (typeof r.inicio === "number" ? r.inicio : r.fim));
      if (desdeAoVivo !== null) inicios.push(desdeAoVivo);
      if (inicios.length > 0) inicio = Math.min(...inicios);
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
      $("timer").textContent = litrosTela(timer);
      $("timer-sub").textContent = dias < 1
        ? `em ${duracao(dias * DIA_MS / 1000)} de medição`
        : `em ${numero(dias, 1)} dias de medição`;

      // Economia: a diferença entre os dois números da tela (assim a conta
      // do visitante bate), já em passos de 0,5 L. A % usa os valores exatos.
      const economia = meio(timer) - meio(litros);
      const porcento = timer > 0 ? Math.round(((timer - litros) / timer) * 100) : 0;
      $("economia").textContent = `${numero(economia, 1)} L`;
      $("economia").classList.toggle("agua-negativa", economia < 0);
      if (timer < 0.5) $("economia-sub").textContent = "";
      else if (economia >= 0) $("economia-sub").textContent = `${porcento}% menos que o timer`;
      else $("economia-sub").textContent = `${-porcento}% a mais que o timer`;

      // Tradução em banhos e garrafões, também de meio em meio
      const banhos = meio(economia / LITROS_BANHO_5MIN);
      const garrafoes = meio(economia / LITROS_GARRAFAO);
      const partes = [];
      if (banhos > 0) partes.push(`≈ ${numero(banhos, 1)} ${banhos >= 2 ? "banhos" : "banho"} de 5 minutos`);
      if (garrafoes > 0) partes.push(`≈ ${numero(garrafoes, 1)} ${garrafoes >= 2 ? "garrafões" : "garrafão"} de 20 L`);
      if (economia < 0) {
        $("traducao").textContent = "Nesta medição a horta usou mais água que o timer.";
      } else {
        $("traducao").textContent = partes.join(" · ");
      }
      $("traducao").hidden = $("traducao").textContent === "";
    }

    // Regando agora (a rega já está somando na "Água usada")
    $("regando").hidden = !bombaLigada;
    if (bombaLigada) {
      $("regando").textContent = inicioAtual === null
        ? "💧 Regando agora…"
        : `💧 Regando agora… ${duracao((agora() - inicioAtual) / 1000)}`;
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
