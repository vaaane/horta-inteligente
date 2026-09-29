// Cartão "Água" — água usada pela horta e quanto um timer fixo teria usado
// ESTIMATIVA: não há sensor de fluxo. O ESP32 grava cada rega em
// horta/regas com o tempo de bomba ligada × a vazão de referência, e o
// resumo de cada dia em horta/agua/dias/{AAAA-MM-DD} (gráfico "Água por dia").
//
// Como usar:
//   iniciarAgua(db, document.getElementById("agua"));
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
const KC = 1.0;                     // coeficiente da cultura (igual ao firmware)

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

    <!-- Cota de hoje: quanto a planta perdeu pela ET₀ (o ESP32 para de regar quando enche) -->
    <div data-agua="cota" class="agua-cota" hidden>
      <div class="agua-cota-topo">
        <span class="agua-cota-titulo">Cota de hoje pela ET₀</span>
        <span data-agua="cota-valor" class="agua-cota-valor"></span>
      </div>
      <div class="trilho"><div data-agua="cota-barra" class="barra"></div></div>
      <p data-agua="cota-conta" class="agua-sub"></p>
    </div>
    <p class="agua-nota">Calculado pelo tempo de bomba ligada × vazão de ${numero(VAZAO_L_MIN)} L/min. Sem sensor de fluxo.
      Timer de comparação: ${TIMER_REGAS_POR_DIA} regas por dia de ${TIMER_MINUTOS_POR_REGA} min.</p>

    <section class="agua-dias">
      <h3 class="decisao-subtitulo">Água por dia</h3>
      <div class="agua-periodos" role="group" aria-label="Período do gráfico">
        ${PERIODOS.map((n) => `<button type="button" class="agua-periodo" data-periodo="${n}" aria-pressed="false">${n} dias</button>`).join("")}
      </div>
      <p data-agua="resumo-dias" class="agua-resumo"></p>
      <div class="agua-grafico"><canvas data-agua="grafico-dias" aria-label="Gráfico de barras da água por dia"></canvas></div>
      <p class="agua-nota">Recomendado pela ET₀: ET₀ do dia (mm) × ${numero(AREA_M2, 2)} m² do canteiro (1 mm em 1 m² = 1 L). Dias sem previsão ficam sem essa barra.</p>
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
  let et0Clima = null;        // ET₀ do dia no nó /clima (só para mostrar a conta da cota)
  onValue(ref(db, "clima/et0"), (snap) => {
    et0Clima = typeof snap.val() === "number" ? snap.val() : null;
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

  // Mostra os litros de meio em meio litro, arredondando para baixo:
  // 0 L, 0,5 L, 1 L, 1,5 L… (no Firebase eles continuam com 2 casas)
  const meio = (litros) => Math.floor(litros * 2) / 2;
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

    mostrarCota();
    mostrarDias(vivo);
  }

  // Barra "Cota de hoje pela ET₀": litros usados contra a cota (vêm do ESP32).
  // Entre um envio e outro, se a bomba está ligada, a barra continua subindo.
  function mostrarCota() {
    const cota = estadoAtual.cotaHoje;
    $("cota").hidden = typeof cota !== "number";
    if (typeof cota !== "number") return;

    let litros = Number(estadoAtual.litrosCota) || 0;
    if (bombaLigada && typeof estadoAtual.ts === "number") {
      litros += Math.max(0, agora() - estadoAtual.ts) / 1000 / 60 * VAZAO_L_MIN;
    }
    const cheia = litros >= cota;
    // Enchendo: passos de 0,5 L. Cheia: com uma casa, para não parecer "1,5 de 1,8" quando já encheu
    $("cota-valor").textContent = cheia
      ? `🎯 ${numero(litros, 1)} L de ${numero(cota, 1)} L`
      : `${litrosTela(litros)} de ${numero(cota, 1)} L`;
    $("cota-barra").style.width = cota > 0 ? `${Math.min(100, (litros / cota) * 100)}%` : "100%";

    // A conta em linguagem simples (1 mm em 1 m² = 1 L)
    const umaCasa = (v) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (et0Clima !== null && Math.abs(et0Clima * AREA_M2 * KC - cota) < 0.05) {
      $("cota-conta").textContent =
        `ET₀ ${umaCasa(et0Clima)} mm × ${numero(AREA_M2, 2)} m² × Kc ${umaCasa(KC)} = ${numero(cota, 1)} L`;
    } else {
      $("cota-conta").textContent = `Sem previsão do tempo: cota fixa de ${numero(cota, 1)} L por dia.`;
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
      et0: lista.map((d) => (d.et0 === null ? null : meio(d.et0 * AREA_M2)))
    };
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
            tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${numero(ctx.raw, 1)} L` } }
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
}
