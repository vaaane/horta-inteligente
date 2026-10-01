// Cartão "Água" — água usada pela horta e quanto um timer fixo teria usado
// ESTIMATIVA: não há sensor de fluxo. O ESP32 grava cada rega em
// horta/regas com o tempo de bomba ligada × a vazão de referência, e o
// resumo de cada dia em horta/agua/dias/{AAAA-MM-DD} (gráfico "Água por dia").
//
// Como usar:
//   const agua = iniciarAgua(db, document.getElementById("agua"), {
//     raizZerar: document.getElementById("zerar-contagem")  // onde fica o "Zerar contagem" (opcional)
//   });
//   agua.aoResumo((r) => …);   // economia, garrafões… (cartão "Água economizada" da aba Agora)
//   agua.redimensionar();      // o gráfico apareceu (aba Água): acerta o tamanho
// O elemento raiz já deve ter o título do cartão; o resto é criado aqui.
import {
  ref, onValue, query, orderByChild, orderByKey, startAt, limitToLast, set, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { quando } from "./decisao.js";

// Irrigação por timer fixo que usamos para comparar (uma horta comum):
const TIMER_REGAS_POR_DIA = 2;      // manhã e tarde
const TIMER_MINUTOS_POR_REGA = 5;
const VAZAO_L_MIN = 1.5;            // igual à do firmware
const LITROS_BANHO_5MIN = 45;       // banho de 5 minutos, chuveiro comum (estimativa)
const LITROS_GARRAFAO = 20;

// Água recomendada pela ET₀: 1 mm de água em 1 m² = 1 litro.
// Então a planta "pede" et0 (mm) × área (m²) litros por dia.
const AREA_M2 = 0.25;               // área do canteiro da maquete (0,5 m × 0,5 m)
const KC = 1.0;                     // Kc inicial (igual ao firmware); o em uso vem de horta/agua/ajuste
const MARGEM_EXTRA = 0.5;           // igual ao firmware: até 50% a mais que a cota, se o solo continuar seco

const DIA_MS = 24 * 60 * 60 * 1000;

// Dias no horário de Brasília (UTC-3, sem horário de verão), igual ao ESP32
const FUSO_MS = 3 * 60 * 60 * 1000;
const chaveDia = (ms) => new Date(ms - FUSO_MS).toISOString().slice(0, 10);  // "2026-09-30"
const inicioDoDia = (chave) => Date.parse(chave + "T00:00:00Z") + FUSO_MS;
const SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const PERIODOS = [7, 14, 30];

// "seg 28", "ter 29"… e "hoje"
function rotuloDia(chave, hoje) {
  if (chave === hoje) return "hoje";
  const data = new Date(chave + "T12:00:00Z");
  return `${SEMANA[data.getUTCDay()]} ${data.getUTCDate()}`;
}

// Mostra os litros de meio em meio litro, arredondando para baixo:
// 0 L, 0,5 L, 1 L, 1,5 L… (no Firebase eles continuam com 2 casas)
const meio = (litros) => Math.floor(litros * 2) / 2;

// "Em coisas do dia a dia": garrafões de 20 L e banhos de 5 min, cada um
// numa linha. Nada de "≈ 0,5 banho": abaixo de 1 é "meio banho"; abaixo de
// meio, só os garrafões (ou os litros, se nem meio garrafão).
export function emCoisas(litros) {
  const garrafoes = litros / LITROS_GARRAFAO;
  const banhos = litros / LITROS_BANHO_5MIN;
  const linhas = [];
  if (garrafoes >= 1) linhas.push(`≈ ${numero(meio(garrafoes), 1)} ${meio(garrafoes) >= 2 ? "garrafões" : "garrafão"} de 20 L`);
  else if (garrafoes >= 0.5) linhas.push("≈ meio garrafão de 20 L");
  else if (litros >= 0.5) linhas.push(`≈ ${numero(meio(litros), 1)} L (menos de meio garrafão)`);
  if (banhos >= 1) linhas.push(`≈ ${numero(meio(banhos), 1)} ${meio(banhos) >= 2 ? "banhos" : "banho"} de 5 minutos`);
  else if (banhos >= 0.5) linhas.push("≈ meio banho de 5 minutos");
  return linhas;
}

// Números no jeito brasileiro: 1,5
export const numero = (valor, casas = 1) =>
  Number(valor).toLocaleString("pt-BR", { maximumFractionDigits: casas });
const umaCasa = (v) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// A conta da cota em linguagem simples: (ET₀ × Kc − chuva) × área. 1 mm em 1 m² = 1 L.
// clima = /clima, ajuste = /horta/agua/ajuste. Também usada na faixa "Pode regar agora?".
export function contaDaCota(cota, clima, ajuste) {
  const kc = typeof ajuste?.kc === "number" ? ajuste.kc : KC;
  const et0 = clima?.et0;
  const chuva = typeof clima?.chuvaHojeMm === "number" ? clima.chuvaHojeMm : 0;
  if (typeof et0 === "number" && Math.abs(Math.max(0, et0 * kc - chuva) * AREA_M2 - cota) < 0.05) {
    return `(ET₀ ${umaCasa(et0)} mm × Kc ${umaCasa(kc)} − chuva ${numero(chuva, 1)} mm) × ${numero(AREA_M2, 2)} m² = ${numero(cota, 2)} L`;
  }
  return `Sem previsão do tempo: cota fixa de ${numero(cota, 2)} L por dia.`;
}

// "45 s", "2 min 5 s", "1 h 3 min"
function duracao(segundos) {
  segundos = Math.max(0, Math.round(segundos));
  if (segundos < 60) return `${segundos} s`;
  const min = Math.floor(segundos / 60);
  if (min < 60) return segundos % 60 ? `${min} min ${segundos % 60} s` : `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function iniciarAgua(db, raiz, opcoes = {}) {
  // Selo "Estimativa" no título
  raiz.querySelector("h2")?.insertAdjacentHTML("beforeend", ` <span class="selo selo-estimativa">Estimativa</span>`);

  raiz.insertAdjacentHTML("beforeend", `
    <p data-agua="regando" class="agua-regando" hidden></p>
    <!-- Na tela grande, duas colunas: os números à esquerda, a água por dia à direita -->
    <div class="agua-colunas">
    <div class="agua-coluna">
    <dl class="agua-valores">
      <div><dt>Água usada</dt><dd data-agua="usada">--</dd><p data-agua="regas" class="agua-sub"></p></div>
      <div><dt>Um timer fixo teria usado</dt><dd data-agua="timer">--</dd><p data-agua="timer-sub" class="agua-sub"></p></div>
      <div><dt>Economia</dt><dd data-agua="economia">--</dd><p data-agua="economia-sub" class="agua-sub"></p></div>
    </dl>
    <div data-agua="coisas" class="agua-coisas" hidden>
      <h3 class="decisao-subtitulo">Em coisas do dia a dia</h3>
      <p data-agua="traducao" class="agua-traducao"></p>
    </div>

    <!-- Cota de hoje: quanto a planta perdeu pela ET₀ (o ESP32 para de regar quando enche) -->
    <div data-agua="cota" class="agua-cota" hidden>
      <div class="agua-cota-topo">
        <span class="agua-cota-titulo">Cota de hoje (ET₀ × Kc − chuva)</span>
        <span data-agua="cota-valor" class="agua-cota-valor"></span>
      </div>
      <!-- A barra vai até 150% da cota: até 100% verde, depois a margem extra listrada -->
      <div class="trilho agua-cota-trilho">
        <div data-agua="cota-barra" class="barra"></div>
        <div data-agua="cota-extra" class="agua-cota-extra"></div>
        <span class="agua-cota-margem">margem extra</span>
      </div>
      <p data-agua="cota-conta" class="agua-sub"></p>
      <p data-agua="cota-kc" class="agua-sub"></p>
    </div>
    <p class="agua-nota">Calculado pelo tempo de bomba ligada × vazão de ${numero(VAZAO_L_MIN)} L/min. Sem sensor de fluxo.
      Timer de comparação: ${TIMER_REGAS_POR_DIA} regas por dia de ${TIMER_MINUTOS_POR_REGA} min.</p>
    </div>

    <section class="agua-dias">
      <h3 class="decisao-subtitulo">Água por dia</h3>
      <div class="agua-periodos" role="group" aria-label="Período do gráfico">
        ${PERIODOS.map((n) => `<button type="button" class="agua-periodo" data-periodo="${n}" aria-pressed="false">${n} dias</button>`).join("")}
      </div>
      <p data-agua="resumo-dias" class="agua-resumo"></p>
      <div class="agua-grafico"><canvas data-agua="grafico-dias" aria-label="Gráfico de barras da água por dia"></canvas></div>
      <p class="agua-nota">Recomendado pela ET₀: a cota do dia, (ET₀ × Kc − chuva) × ${numero(AREA_M2, 2)} m² do canteiro (1 mm em 1 m² = 1 L). Toque na barra para ver os números. Dias sem previsão ficam sem essa barra.</p>
      <details class="agua-tabela">
        <summary>Tabela por dia</summary>
        <div class="tabela-rolagem">
          <table class="tabela-materiais tabela-agua">
            <thead><tr><th>Dia</th><th>Regas</th><th>Tempo de bomba</th><th class="preco">Usado</th><th class="preco">Timer fixo</th><th class="preco">Economia</th></tr></thead>
            <tbody data-agua="tabela-dias"></tbody>
          </table>
        </div>
      </details>
    </section>
    </div>

    <details class="agua-lista">
      <summary>Últimas regas</summary>
      <p data-agua="vazio" class="decisao-vazio">Nenhuma rega registrada ainda.</p>
      <ol data-agua="lista" class="decisao-lista"></ol>
    </details>
  `);

  // "Zerar contagem": no próprio cartão ou onde o painel pedir (aba Demonstração)
  const raizZerar = opcoes.raizZerar || raiz;
  raizZerar.insertAdjacentHTML("beforeend", `
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

  // Procura só dentro deste cartão (e no bloco do "Zerar contagem")
  const $ = (nome) => raiz.querySelector(`[data-agua="${nome}"]`) || raizZerar.querySelector(`[data-agua="${nome}"]`);

  // Quem quer saber do resumo (cartão "Água economizada" da aba Agora)
  const ouvintesResumo = [];
  let ultimoResumo = null;
  function avisarResumo(resumo) {
    const texto = JSON.stringify(resumo);
    if (texto === ultimoResumo) return;  // mostrar() roda a cada segundo
    ultimoResumo = texto;
    for (const ouvinte of ouvintesResumo) ouvinte(resumo);
  }

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
  const jaRegistrada = (desde) => regas.some((r) => r.fim > desde) || regasHoje.some((r) => r.fim > desde);

  // Parte ao vivo: a rega de agora, ou a que acabou e ainda não foi registrada.
  // Devolve { desde, fim, emAndamento } ou null.
  function aoVivo() {
    const inicioAtual = inicioRegaAtual();
    if (inicioAtual !== null && !jaRegistrada(inicioAtual)) {
      return { desde: inicioAtual, fim: agora(), emAndamento: true };
    }
    if (terminada && (jaRegistrada(terminada.desde) || agora() > terminada.ate)) {
      terminada = null;  // o registro chegou: a rega passa a contar entre as fechadas
    }
    return terminada ? { desde: terminada.desde, fim: terminada.fim, emAndamento: false } : null;
  }

  // Litros da parte ao vivo a partir de "corte" (ex.: o zero da medição ou a meia-noite)
  function litrosAoVivoDesde(vivo, corte) {
    if (!vivo) return 0;
    const desde = corte !== null ? Math.max(vivo.desde, corte) : vivo.desde;
    return Math.max(0, vivo.fim - desde) / 1000 / 60 * VAZAO_L_MIN;
  }

  let estadoAtual = {};
  let climaAtual = {};        // /clima: ET₀ e chuva de hoje (só para mostrar a conta da cota)
  onValue(ref(db, "clima"), (snap) => {
    climaAtual = snap.val() || {};
  });
  let ajuste = {};            // /horta/agua/ajuste: Kc aprendido, quando e por quê
  onValue(ref(db, "horta/agua/ajuste"), (snap) => {
    ajuste = snap.val() || {};
    mostrar();
  });
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

  const litrosTela = (litros) => `${numero(meio(litros), 1)} L`;

  function mostrar() {
    const vivo = aoVivo();
    const inicioAtual = inicioRegaAtual();
    const emAndamento = vivo !== null && vivo.emAndamento;
    const desdeAoVivo = vivo ? vivo.desde : null;
    // Se zeraram a contagem no meio da rega, conta só a partir do zero
    const litrosAoVivo = litrosAoVivoDesde(vivo, inicioMedicao);

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
      $("coisas").hidden = true;
      avisarResumo({ comecou: false });
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

      // Em coisas do dia a dia: garrafões e banhos, um por linha
      const linhas = economia < 0 ? ["Nesta medição a horta usou mais água que o timer."] : emCoisas(economia);
      $("traducao").replaceChildren(...linhas.map((linha) => {
        const span = document.createElement("span");
        span.textContent = linha;
        return span;
      }));
      $("coisas").hidden = linhas.length === 0;
      avisarResumo({ comecou: true, economia, porcento, coisas: linhas });
    }

    // Regando agora (a rega já está somando na "Água usada")
    $("regando").hidden = !bombaLigada;
    if (bombaLigada) {
      $("regando").textContent = inicioAtual === null
        ? "💧 Regando agora…"
        : `💧 Regando agora… ${duracao((agora() - inicioAtual) / 1000)}`;
    }

    mostrarCota();
    mostrarDias(vivo);
  }

  // Barra "Cota de hoje pela ET₀": litros usados contra a cota (vêm do ESP32).
  // Entre um envio e outro, se a bomba está ligada, a barra continua subindo.
  // A barra toda vale 150% da cota: até 2/3 é a cota (verde); o resto é a
  // margem extra (listrada), que o ESP32 libera se o solo continuar seco.
  function mostrarCota() {
    const cota = estadoAtual.cotaHoje;
    $("cota").hidden = typeof cota !== "number";
    if (typeof cota !== "number") return;

    let litros = Number(estadoAtual.litrosCota) || 0;
    if (bombaLigada && typeof estadoAtual.ts === "number") {
      litros += Math.max(0, agora() - estadoAtual.ts) / 1000 / 60 * VAZAO_L_MIN;
    }
    const limite = cota * (1 + MARGEM_EXTRA);
    if (cota <= 0) {
      $("cota-valor").textContent = "🎯 hoje não precisa regar";
    } else if (litros < cota) {
      $("cota-valor").textContent = `${litrosTela(litros)} de ${numero(cota, 1)} L recomendados`;
    } else if (litros < limite) {
      $("cota-valor").textContent = `🎯 ${numero(cota, 2)} L + ${numero(litros - cota, 2)} L extra`;
    } else {
      $("cota-valor").textContent = `🎯 ${numero(litros, 1)} L (cota + ${Math.round(MARGEM_EXTRA * 100)}%)`;
    }
    const escala = limite > 0 ? limite : 1;
    $("cota-barra").style.width = `${(Math.min(litros, cota) / escala) * 100}%`;
    const fracaoCota = cota / escala;  // onde começa a margem extra (2/3 da barra)
    $("cota-extra").style.left = `${fracaoCota * 100}%`;
    $("cota-extra").style.width = `${(Math.max(0, Math.min(litros, limite) - cota) / escala) * 100}%`;

    $("cota-conta").textContent = contaDaCota(cota, climaAtual, ajuste);

    // O Kc que a horta aprendeu
    const kc = typeof ajuste.kc === "number" ? ajuste.kc : KC;
    if (typeof ajuste.kc === "number" && ajuste.motivo) {
      const em = typeof ajuste.atualizadoEm === "number" ? ` ${quando(ajuste.atualizadoEm)}` : "";
      $("cota-kc").textContent = `Kc ${umaCasa(ajuste.kc)} — ajustado${em}: ${ajuste.motivo}`;
    } else {
      $("cota-kc").textContent = `Kc ${umaCasa(kc)} (inicial)`;
    }
  }

  // ================= Água por dia (gráfico e tabela) =================
  let dias = {};              // horta/agua/dias: { "2026-09-30": { litros, segundos, regas, et0 } }
  let regasHoje = [];         // regas que terminaram hoje (a barra de hoje é calculada ao vivo)
  let chaveHojeLida = null;   // de que dia é a lista regasHoje
  let pararRegasHoje = null;
  let periodo = 7;
  let grafico = null;
  let ultimosDadosGrafico = "";
  let detalhesEt0 = [];       // "ET₀ 7,1 mm, chuva 0 mm, Kc 1,0" de cada dia (dica da barra)

  onValue(query(ref(db, "horta/agua/dias"), orderByKey(), limitToLast(31)), (snap) => {
    dias = snap.val() || {};
    mostrar();
  });

  // Lê as regas de hoje (e troca a leitura quando vira o dia)
  function acompanharHoje() {
    const hoje = chaveDia(agora());
    if (hoje === chaveHojeLida) return;
    chaveHojeLida = hoje;
    if (pararRegasHoje) pararRegasHoje();
    pararRegasHoje = onValue(
      query(ref(db, "horta/regas"), orderByChild("fim"), startAt(inicioDoDia(hoje))),
      (snap) => {
        regasHoje = [];
        snap.forEach((filho) => { regasHoje.push(filho.val()); });
        mostrar();
      }
    );
  }

  for (const botao of raiz.querySelectorAll(".agua-periodo")) {
    botao.addEventListener("click", () => {
      periodo = Number(botao.dataset.periodo);
      mostrar();
    });
  }

  function mostrarDias(vivo) {
    acompanharHoje();
    const hoje = chaveDia(agora());
    const timerDia = TIMER_REGAS_POR_DIA * TIMER_MINUTOS_POR_REGA * VAZAO_L_MIN;

    // Um item por dia, do mais antigo para hoje
    const lista = [];
    for (let i = periodo - 1; i >= 0; i--) {
      const chave = chaveDia(agora() - i * DIA_MS);
      const resumo = dias[chave] || {};
      const item = {
        chave,
        litros: Number(resumo.litros) || 0,
        segundos: Number(resumo.segundos) || 0,
        regas: Number(resumo.regas) || 0,
        et0: typeof resumo.et0 === "number" ? resumo.et0 : null,
        cota: typeof resumo.cota === "number" ? resumo.cota : null,  // já com Kc e chuva
        chuvaMm: typeof resumo.chuvaMm === "number" ? resumo.chuvaMm : null,
        kc: typeof resumo.kc === "number" ? resumo.kc : null,
        timer: timerDia  // o timer rega todo dia, com ou sem registro
      };
      if (chave === hoje) {
        // Hoje: regas fechadas de hoje + a rega em andamento, ao vivo (mesma conta do cartão)
        const aoVivoHoje = litrosAoVivoDesde(vivo, inicioDoDia(hoje));
        item.litros = regasHoje.reduce((soma, r) => soma + (Number(r.litros) || 0), 0) + aoVivoHoje;
        item.segundos = regasHoje.reduce((soma, r) => soma + (Number(r.segundos) || 0), 0) +
          aoVivoHoje / VAZAO_L_MIN * 60;
        item.regas = regasHoje.length + (vivo && !vivo.emAndamento ? 1 : 0);
        item.emAndamento = vivo !== null && vivo.emAndamento;
      }
      lista.push(item);
    }

    // Frase-resumo do período
    const usado = lista.reduce((soma, d) => soma + d.litros, 0);
    const timer = lista.reduce((soma, d) => soma + d.timer, 0);
    const porcento = timer > 0 ? Math.round(((timer - usado) / timer) * 100) : 0;
    let frase = `Nos últimos ${periodo} dias a horta usou ${litrosTela(usado)}; um timer fixo usaria ${litrosTela(timer)}. `;
    frase += porcento >= 0
      ? `Economia de ${porcento}%.`
      : `A horta gastou ${-porcento}% a mais que o timer nesse período.`;
    $("resumo-dias").textContent = frase;

    // Seletor de período
    for (const botao of raiz.querySelectorAll(".agua-periodo")) {
      const ativo = Number(botao.dataset.periodo) === periodo;
      botao.classList.toggle("ativo", ativo);
      botao.setAttribute("aria-pressed", String(ativo));
    }

    desenharGrafico(lista, hoje);
    preencherTabela(lista, hoje);
  }

  function desenharGrafico(lista, hoje) {
    if (typeof Chart === "undefined") return;  // biblioteca não carregou
    const dados = {
      rotulos: lista.map((d) => rotuloDia(d.chave, hoje)),
      usado: lista.map((d) => meio(d.litros)),
      timer: lista.map((d) => meio(d.timer)),
      // A cota salva no dia (com Kc e chuva). Dias antigos, sem ela: ET₀ × área.
      et0: lista.map((d) => (d.cota !== null ? meio(d.cota) : d.et0 === null ? null : meio(d.et0 * AREA_M2))),
      detalhes: lista.map((d) => {
        if (d.et0 === null) return "";
        const partes = [`ET₀ ${numero(d.et0, 1)} mm`];
        if (d.chuvaMm !== null) partes.push(`chuva ${numero(d.chuvaMm, 1)} mm`);
        if (d.kc !== null) partes.push(`Kc ${numero(d.kc, 2)}`);
        return partes.join(", ");
      })
    };
    detalhesEt0 = dados.detalhes;
    const texto = JSON.stringify(dados);
    if (texto === ultimosDadosGrafico) return;  // nada mudou (roda a cada segundo)
    ultimosDadosGrafico = texto;

    if (!grafico) {
      grafico = new Chart($("grafico-dias"), {
        type: "bar",
        data: {
          labels: [],
          datasets: [
            { label: "Usado pela horta", data: [], backgroundColor: "#2e7d32" },
            { label: "Timer fixo", data: [], backgroundColor: "#9e9e9e" },
            {
              label: "Recomendado pela ET₀", data: [],
              backgroundColor: "rgba(21, 101, 192, 0.25)", borderColor: "#1565c0", borderWidth: 2
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { position: "bottom" },
            tooltip: {
              callbacks: {
                label: (ctx) => `${ctx.dataset.label}: ${numero(ctx.raw, 1)} L`,
                // Na barra da ET₀: de onde veio o número
                afterLabel: (ctx) => (ctx.datasetIndex === 2 ? detalhesEt0[ctx.dataIndex] || "" : "")
              }
            }
          },
          scales: { y: { beginAtZero: true, ticks: { callback: (v) => `${numero(v, 1)} L` } } }
        }
      });
    }
    grafico.data.labels = dados.rotulos;
    grafico.data.datasets[0].data = dados.usado;
    grafico.data.datasets[1].data = dados.timer;
    grafico.data.datasets[2].data = dados.et0;
    grafico.update();
  }

  function preencherTabela(lista, hoje) {
    const linhas = [...lista].reverse().map((d) => {  // hoje primeiro
      const economia = meio(d.timer) - meio(d.litros);
      const porcento = d.timer > 0 ? Math.round(((d.timer - d.litros) / d.timer) * 100) : 0;
      const celulas = [
        d.chave === hoje ? "hoje" : `${rotuloDia(d.chave, hoje)}/${d.chave.slice(5, 7)}`,
        String(d.regas) + (d.emAndamento ? " + 1" : ""),
        d.segundos > 0 ? duracao(d.segundos) : "—",
        litrosTela(d.litros),
        litrosTela(d.timer),
        `${numero(economia, 1)} L (${porcento}%)`
      ];
      const tr = document.createElement("tr");
      celulas.forEach((texto, i) => {
        const td = document.createElement("td");
        td.textContent = texto;
        if (i >= 3) td.className = "preco";  // números alinhados à direita
        tr.append(td);
      });
      return tr;
    });
    $("tabela-dias").replaceChildren(...linhas);
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

  return {
    aoResumo(ouvinte) {
      ouvintesResumo.push(ouvinte);
      if (ultimoResumo) ouvinte(JSON.parse(ultimoResumo));
    },
    redimensionar() {
      grafico?.resize();
    }
  };
}
