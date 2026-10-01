// Aba "Água" — água usada pela horta e quanto um timer fixo teria usado
// ESTIMATIVA: não há sensor de fluxo. O ESP32 grava cada rega em
// horta/regas com o tempo de bomba ligada × a vazão de referência, e o
// resumo de cada dia em horta/agua/dias/{AAAA-MM-DD} (a cota pela ET₀).
//
// Um período só para a aba inteira (Desde o início · 7 dias · 30 dias):
// frase, números, equivalências, gráfico, tabela e últimas regas mudam juntos.
// O timer fixo só conta a partir do início da medição: dias (ou partes do
// dia) antes dele ficam de fora, para os dois lados da conta.
// O bloco "Hoje" (cota) é sempre do dia atual.
//
// Como usar:
//   const agua = iniciarAgua(db, document.getElementById("agua"), {
//     raizZerar: document.getElementById("zerar-contagem")  // onde fica o "Zerar contagem" (opcional)
//   });
//   agua.aoResumo((r) => …);   // "desde o início" (cartão "Água economizada" da aba Agora)
//   agua.redimensionar();      // o gráfico apareceu (aba Água): acerta o tamanho
// O elemento raiz já deve ter o título do cartão; o resto é criado aqui.
import {
  ref, onValue, query, orderByChild, orderByKey, startAt, limitToLast, set, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { quandoFoi } from "./tempo.js";

// Irrigação por timer fixo que usamos para comparar (uma horta comum):
const TIMER_REGAS_POR_DIA = 2;      // manhã e tarde
const TIMER_MINUTOS_POR_REGA = 5;
const VAZAO_L_MIN = 1.5;            // igual à do firmware
const LITROS_BANHO_5MIN = 45;       // banho de 5 minutos, chuveiro comum (estimativa)
const LITROS_GARRAFAO = 20;
const TIMER_DIA = TIMER_REGAS_POR_DIA * TIMER_MINUTOS_POR_REGA * VAZAO_L_MIN;  // 15 L por dia

// Água recomendada pela ET₀: 1 mm de água em 1 m² = 1 litro.
// Então a planta "pede" et0 (mm) × área (m²) litros por dia.
const AREA_M2 = 0.25;               // área do canteiro da maquete (0,5 m × 0,5 m)
const KC = 1.0;                     // Kc inicial (igual ao firmware); o em uso vem de horta/agua/ajuste
const MARGEM_EXTRA = 0.5;           // igual ao firmware: até 50% a mais que a cota, se o solo continuar seco

const DIA_MS = 24 * 60 * 60 * 1000;
const MAX_DIAS_GRAFICO = 31;        // "Desde o início" mostra no máximo os últimos 31 dias no gráfico

// Dias no horário de Brasília (UTC-3, sem horário de verão), igual ao ESP32
const FUSO_MS = 3 * 60 * 60 * 1000;
const chaveDia = (ms) => new Date(ms - FUSO_MS).toISOString().slice(0, 10);  // "2026-09-30"
const inicioDoDia = (chave) => Date.parse(chave + "T00:00:00Z") + FUSO_MS;
const SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const PERIODOS = [
  { id: "inicio", rotulo: "Desde o início" },
  { id: "7", rotulo: "7 dias", dias: 7 },
  { id: "30", rotulo: "30 dias", dias: 30 }
];

// "seg 28", "ter 29"… e "hoje"
function rotuloDia(chave, hoje) {
  if (chave === hoje) return "hoje";
  const data = new Date(chave + "T12:00:00Z");
  return `${SEMANA[data.getUTCDay()]} ${data.getUTCDate()}`;
}

// Mostra os litros de meio em meio litro, arredondando para baixo:
// 0 L, 0,5 L, 1 L, 1,5 L… (no Firebase eles continuam com 2 casas)
const meio = (litros) => Math.floor(litros * 2) / 2;

// Números no jeito brasileiro: 1,5
export const numero = (valor, casas = 1) =>
  Number(valor).toLocaleString("pt-BR", { maximumFractionDigits: casas });
const umaCasa = (v) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const litrosTela = (litros) => `${numero(meio(litros), 1)} L`;

// "Em coisas do dia a dia": garrafões de 20 L e banhos de 5 min.
// Acima de 1: número inteiro ou com ",5". Abaixo de 1: "meio garrafão",
// "1/4 de garrafão", "meio banho". Abaixo de 1/4 de garrafão: só os litros.
export function emCoisas(litros) {
  const linhas = [];
  const garrafoes = litros / LITROS_GARRAFAO;
  const banhos = litros / LITROS_BANHO_5MIN;
  if (garrafoes >= 1) linhas.push(`🫙 ≈ ${numero(meio(garrafoes), 1)} ${meio(garrafoes) >= 2 ? "garrafões" : "garrafão"} de 20 L`);
  else if (garrafoes >= 0.5) linhas.push("🫙 ≈ meio garrafão de 20 L");
  else if (garrafoes >= 0.25) linhas.push("🫙 ≈ 1/4 de garrafão de 20 L");
  else if (litros >= 0.5) linhas.push(`🫙 ≈ ${numero(meio(litros), 1)} L`);
  if (banhos >= 1) linhas.push(`🚿 ≈ ${numero(meio(banhos), 1)} ${meio(banhos) >= 2 ? "banhos" : "banho"} de 5 min`);
  else if (banhos >= 0.5) linhas.push("🚿 ≈ meio banho de 5 min");
  return linhas;
}

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

// Gráfico: dias sem medição com hachura cinza e "sem medição"; a cota da
// ET₀ como um traço azul tracejado sobre cada dia (não compete com as barras)
const desenhosAgua = {
  id: "desenhosAgua",
  beforeDatasetsDraw(chart) {
    const extra = chart.$agua;
    if (!extra) return;
    const { ctx, chartArea: area, scales: { x } } = chart;
    const largura = (x.getPixelForValue(1) - x.getPixelForValue(0)) || (area.right - area.left);
    extra.semMedicao.forEach((sem, i) => {
      if (!sem) return;
      const centro = x.getPixelForValue(i);
      const esquerda = centro - largura * 0.4;
      const alto = area.bottom - area.top;
      // Coluna cinza clara com listras
      ctx.save();
      ctx.beginPath();
      ctx.rect(esquerda, area.top, largura * 0.8, alto);
      ctx.fillStyle = "rgba(158, 158, 158, 0.08)";
      ctx.fill();
      ctx.clip();
      ctx.beginPath();
      for (let d = -alto; d < largura + alto; d += 8) {
        ctx.moveTo(esquerda + d, area.bottom);
        ctx.lineTo(esquerda + d + alto, area.top);
      }
      ctx.strokeStyle = "rgba(158, 158, 158, 0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      // "sem medição" de baixo para cima, no meio da coluna
      ctx.save();
      ctx.translate(centro, (area.top + area.bottom) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "#616161";
      ctx.font = `600 ${Chart.defaults.font.size}px ${Chart.defaults.font.family}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("sem medição", 0, 0);
      ctx.restore();
    });
  },
  afterDatasetsDraw(chart) {
    const extra = chart.$agua;
    if (!extra) return;
    const { ctx, scales: { x, y } } = chart;
    const largura = (x.getPixelForValue(1) - x.getPixelForValue(0)) || 60;
    ctx.save();
    ctx.strokeStyle = "#1565c0";
    ctx.lineWidth = 3;
    ctx.setLineDash([7, 5]);
    extra.cota.forEach((valor, i) => {
      if (valor === null) return;
      const centro = x.getPixelForValue(i);
      const altura = y.getPixelForValue(valor);
      ctx.beginPath();
      ctx.moveTo(centro - largura * 0.42, altura);
      ctx.lineTo(centro + largura * 0.42, altura);
      ctx.stroke();
    });
    ctx.restore();
  }
};

export function iniciarAgua(db, raiz, opcoes = {}) {
  // Selo "Estimativa" ao lado do título (uma vez só)
  raiz.querySelector("h2")?.insertAdjacentHTML("beforeend", ` <span class="selo selo-estimativa">Estimativa</span>`);

  raiz.insertAdjacentHTML("beforeend", `
    <div class="agua-topo">
      <div class="agua-periodos" role="group" aria-label="Período da aba Água">
        ${PERIODOS.map((p) => `<button type="button" class="agua-periodo" data-periodo="${p.id}" aria-pressed="false">${p.rotulo}</button>`).join("")}
      </div>
      <p data-agua="periodo-nota" class="agua-periodo-nota"></p>
    </div>
    <p data-agua="regando" class="agua-regando" hidden></p>

    <!-- Na tela grande, duas colunas: o resumo à esquerda, a água por dia à direita -->
    <div class="agua-colunas">
      <div class="agua-coluna">
        <p data-agua="frase" class="agua-frase"></p>
        <dl class="agua-valores">
          <div class="agua-valor"><dt>Horta</dt><dd data-agua="usada">--</dd><p data-agua="regas" class="agua-sub"></p></div>
          <div class="agua-valor"><dt>Timer fixo</dt><dd data-agua="timer">--</dd>
            <p class="agua-sub">${TIMER_REGAS_POR_DIA} × ${TIMER_MINUTOS_POR_REGA} min por dia</p></div>
          <div class="agua-valor agua-valor-economia" data-agua="economia-caixa"><dt>Economia</dt><dd data-agua="economia">--</dd>
            <p data-agua="economia-sub" class="agua-sub"></p></div>
        </dl>
        <p data-agua="coisas" class="agua-coisas" hidden></p>

        <!-- Hoje: sempre o dia atual (não depende do período) -->
        <section data-agua="hoje" class="agua-hoje" hidden>
          <h3 class="agua-hoje-titulo">Hoje <small>a cota é quanto a planta perde de água por dia (ET₀)</small></h3>
          <p data-agua="hoje-linha" class="agua-hoje-linha"></p>
          <div class="agua-hoje-barra" aria-hidden="true">
            <div data-agua="hoje-verde" class="agua-hoje-trecho agua-hoje-verde"></div>
            <div data-agua="hoje-amarelo" class="agua-hoje-trecho agua-hoje-amarelo"></div>
            <div data-agua="hoje-vermelho" class="agua-hoje-trecho agua-hoje-vermelho"></div>
            <span data-agua="marca-cota" class="agua-hoje-marca"><span>cota</span></span>
            <span data-agua="marca-limite" class="agua-hoje-marca"><span>limite</span></span>
          </div>
          <p data-agua="hoje-aviso" class="agua-hoje-aviso" hidden></p>
        </section>
      </div>

      <section class="agua-dias">
        <h3 class="decisao-subtitulo">Água por dia</h3>
        <div class="agua-grafico"><canvas data-agua="grafico-dias" aria-label="Gráfico de barras da água por dia: horta, timer fixo e a cota da ET₀"></canvas></div>
      </section>
    </div>

    <!-- Recolhidos: abrem com um toque (a seta gira) -->
    <details class="agua-detalhe">
      <summary>Como calculamos</summary>
      <ul class="agua-calculo">
        <li data-agua="calculo-cota"></li>
        <li data-agua="calculo-kc"></li>
        <li>Água da horta: tempo de bomba ligada × ${numero(VAZAO_L_MIN)} L/min (vazão estimada; ainda sem sensor de fluxo).</li>
        <li>Timer de comparação: uma horta comum, ${TIMER_REGAS_POR_DIA} regas por dia de ${TIMER_MINUTOS_POR_REGA} min = ${numero(TIMER_DIA)} L por dia.</li>
        <li>Dias (ou partes do dia) sem medição não entram na conta, nem para a horta nem para o timer. O dia em que a medição começou conta pelas horas medidas.</li>
        <li>No gráfico, o traço azul tracejado é a cota do dia pela ET₀ (${numero(AREA_M2, 2)} m² de canteiro; 1 mm em 1 m² = 1 L).</li>
      </ul>
    </details>
    <details class="agua-detalhe">
      <summary>Tabela por dia</summary>
      <div class="tabela-rolagem">
        <table class="tabela-materiais tabela-agua">
          <thead><tr><th>Dia</th><th>Regas</th><th>Tempo de bomba</th><th class="preco">Horta</th><th class="preco">Timer fixo</th><th class="preco">Economia</th></tr></thead>
          <tbody data-agua="tabela-dias"></tbody>
        </table>
      </div>
    </details>
    <details class="agua-detalhe">
      <summary>Últimas regas</summary>
      <p data-agua="vazio" class="decisao-vazio">Nenhuma rega neste período.</p>
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

  let periodo = "inicio";
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

  // Litros da parte ao vivo entre "de" e "ate"
  function litrosAoVivo(vivo, de, ate = Infinity) {
    if (!vivo) return 0;
    const inicio = Math.max(vivo.desde, de ?? -Infinity);
    const fim = Math.min(vivo.fim, ate);
    return Math.max(0, fim - inicio) / 1000 / 60 * VAZAO_L_MIN;
  }

  let estadoAtual = {};
  let climaAtual = {};        // /clima: ET₀ e chuva de hoje (só para a conta da cota)
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

  // Cota salva de cada dia (para o traço azul do gráfico)
  let dias = {};              // horta/agua/dias: { "2026-09-30": { litros, cota, et0… } }
  onValue(query(ref(db, "horta/agua/dias"), orderByKey(), limitToLast(MAX_DIAS_GRAFICO)), (snap) => {
    dias = snap.val() || {};
    mostrar();
  });

  // Início da medição: o "Zerar contagem" ou, sem ele, a primeira rega
  function inicioDaMedicao(vivo) {
    if (inicioMedicao !== null) return inicioMedicao;
    const inicios = regas.map((r) => (typeof r.inicio === "number" ? r.inicio : r.fim));
    if (vivo) inicios.push(vivo.desde);
    return inicios.length ? Math.min(...inicios) : null;
  }

  // Soma horta e timer entre "de" e "ate" (só a parte com medição)
  function somar(de, ate, vivo) {
    const doPeriodo = regas.filter((r) => r.fim >= de && r.fim < ate);
    const litros = doPeriodo.reduce((soma, r) => soma + (Number(r.litros) || 0), 0) + litrosAoVivo(vivo, de, ate);
    const segundos = doPeriodo.reduce((soma, r) => soma + (Number(r.segundos) || 0), 0) + litrosAoVivo(vivo, de, ate) / VAZAO_L_MIN * 60;
    const timer = Math.max(0, ate - de) / DIA_MS * TIMER_DIA;
    return { litros, segundos, regas: doPeriodo.length, timer, lista: doPeriodo };
  }

  // Os dias do período (do mais antigo para hoje), cada um com o que foi medido
  function diasDoPeriodo(inicio, vivo) {
    const fimAgora = agora();
    const hoje = chaveDia(fimAgora);
    const escolhido = PERIODOS.find((p) => p.id === periodo);
    let quantos = escolhido.dias;
    if (!quantos) {
      // Desde o início: do dia em que a medição começou até hoje
      quantos = inicio === null ? 1 : Math.round((inicioDoDia(hoje) - inicioDoDia(chaveDia(inicio))) / DIA_MS) + 1;
    }
    const lista = [];
    for (let i = Math.min(quantos, MAX_DIAS_GRAFICO) - 1; i >= 0; i--) {
      const chave = chaveDia(fimAgora - i * DIA_MS);
      const comecoDia = inicioDoDia(chave);
      const fimDia = Math.min(comecoDia + DIA_MS, fimAgora);
      const de = inicio === null ? fimDia : Math.max(comecoDia, inicio);
      const resumo = dias[chave] || {};
      const item = {
        chave,
        hoje: chave === hoje,
        semMedicao: de >= fimDia,
        cota: typeof resumo.cota === "number" ? resumo.cota
          : typeof resumo.et0 === "number" ? resumo.et0 * AREA_M2 : null  // dias antigos, sem a cota salva
      };
      if (!item.semMedicao) Object.assign(item, somar(de, fimDia, vivo));
      lista.push(item);
    }
    return { lista, quantos };
  }

  function mostrar() {
    const vivo = aoVivo();
    const inicio = inicioDaMedicao(vivo);
    const fimAgora = agora();

    // Regando agora (a rega já está somando)
    const inicioAtual = inicioRegaAtual();
    $("regando").hidden = !bombaLigada;
    if (bombaLigada) {
      $("regando").textContent = inicioAtual === null
        ? "💧 Regando agora…"
        : `💧 Regando agora… ${duracao((fimAgora - inicioAtual) / 1000)}`;
    }

    // Resumo "desde o início" para a aba Agora (não depende do período escolhido)
    if (inicio === null) {
      avisarResumo({ comecou: false });
    } else {
      const total = somar(inicio, fimAgora, vivo);
      const economia = meio(total.timer) - meio(total.litros);
      avisarResumo({ comecou: true, economia, coisas: emCoisas(economia), inicio });
    }

    // Seletor
    for (const botao of raiz.querySelectorAll(".agua-periodo")) {
      const ativo = botao.dataset.periodo === periodo;
      botao.classList.toggle("ativo", ativo);
      botao.setAttribute("aria-pressed", String(ativo));
    }

    const { lista, quantos } = diasDoPeriodo(inicio, vivo);
    mostrarResumo(lista, quantos, inicio, fimAgora, vivo);
    mostrarHoje();
    desenharGrafico(lista);
    preencherTabela(lista);
    mostrarLista(lista);
  }

  function mostrarResumo(lista, quantos, inicio, fimAgora, vivo) {
    const escolhido = PERIODOS.find((p) => p.id === periodo);
    const medidos = lista.filter((d) => !d.semMedicao);
    const semMedicao = escolhido.dias ? escolhido.dias - medidos.length : 0;

    // Nota ao lado do seletor
    if (inicio === null) {
      $("periodo-nota").textContent = "a medição começa na primeira rega";
    } else if (!escolhido.dias) {
      const horas = (fimAgora - inicio) / 3600000;
      $("periodo-nota").textContent = horas < 24
        ? `medindo há ${Math.max(1, Math.floor(horas))} h`
        : `medindo há ${Math.floor(horas / 24)} ${Math.floor(horas / 24) === 1 ? "dia" : "dias"}`;
    } else {
      $("periodo-nota").textContent = semMedicao === 0
        ? "todos os dias com medição"
        : `${semMedicao} ${semMedicao === 1 ? "dia sem medição não entra" : "dias sem medição não entram"} na conta`;
    }

    // Totais do período: soma direta (inclui a parte do dia em que a medição começou)
    let total;
    if (inicio === null) total = null;
    else if (!escolhido.dias) total = somar(inicio, fimAgora, vivo);
    else {
      const comecoJanela = inicioDoDia(chaveDia(fimAgora - (escolhido.dias - 1) * DIA_MS));
      total = somar(Math.max(comecoJanela, inicio), fimAgora, vivo);
    }

    if (!total) {
      $("frase").textContent = "A conta começa na primeira rega.";
      for (const nome of ["usada", "timer", "economia"]) $(nome).textContent = "--";
      $("regas").textContent = "";
      $("economia-sub").textContent = "";
      $("economia-caixa").classList.remove("agua-valor-negativa");
      $("coisas").hidden = true;
      return;
    }

    const usado = meio(total.litros);
    const timer = meio(total.timer);
    const prefixo = escolhido.dias
      ? `Nos últimos ${escolhido.dias} dias (${medidos.length} com medição), a horta usou`
      : "A horta usou";
    $("frase").textContent = `${prefixo} ${numero(usado, 1)} L. Um timer fixo teria usado ${numero(timer, 1)} L.`;

    $("usada").textContent = litrosTela(total.litros);
    const emAndamento = vivo !== null && vivo.emAndamento;
    $("regas").textContent = (total.regas === 1 ? "1 rega" : `${total.regas} regas`) + (emAndamento ? " + 1 agora" : "");
    $("timer").textContent = litrosTela(total.timer);

    // Economia: a diferença entre os dois números da tela (a conta do visitante bate)
    const economia = timer - usado;
    const porcento = total.timer > 0 ? Math.round(((total.timer - total.litros) / total.timer) * 100) : 0;
    const negativa = economia < 0;
    $("economia-caixa").classList.toggle("agua-valor-negativa", negativa);
    $("economia").textContent = negativa ? `${numero(-economia, 1)} L` : `${numero(economia, 1)} L`;
    $("economia-sub").textContent = negativa ? "a mais que o timer" : `${porcento}% menos`;

    // Equivalências numa linha
    const linhas = negativa ? [] : emCoisas(economia);
    $("coisas").textContent = linhas.join("  ·  ");
    $("coisas").hidden = linhas.length === 0;
  }

  // Bloco "Hoje": usado × cota × limite com margem (vêm do ESP32).
  // Entre um envio e outro, se a bomba está ligada, o usado continua subindo.
  function mostrarHoje() {
    const cota = estadoAtual.cotaHoje;
    $("hoje").hidden = typeof cota !== "number";
    if (typeof cota !== "number") return;

    let usado = Number(estadoAtual.litrosCota) || 0;
    if (bombaLigada && typeof estadoAtual.ts === "number") {
      usado += Math.max(0, agora() - estadoAtual.ts) / 1000 / 60 * VAZAO_L_MIN;
    }
    const limite = typeof estadoAtual.cotaLimite === "number" ? estadoAtual.cotaLimite : cota * (1 + MARGEM_EXTRA);

    // Linha principal: o número usado muda de cor (verde até a cota, amarelo até o limite, vermelho acima)
    const cor = usado <= cota ? "verde" : usado <= limite ? "amarelo" : "vermelho";
    const linha = $("hoje-linha");
    linha.replaceChildren();
    const forte = document.createElement("strong");
    forte.className = `agua-hoje-usado agua-hoje-${cor}-texto`;
    forte.textContent = `${numero(usado, 1)} L`;
    linha.append(forte, cota <= 0
      ? " usados · choveu mais do que a planta perdeu: hoje a cota é 0"
      : ` usados · cota ${numero(cota, 1)} L · limite com margem ${numero(limite, 1)} L`);

    // Barra: escala até o maior entre o usado e o limite
    const escala = Math.max(usado, limite, 0.01);
    const pct = (v) => `${(Math.max(0, v) / escala) * 100}%`;
    $("hoje-verde").style.left = "0";
    $("hoje-verde").style.width = pct(Math.min(usado, cota));
    $("hoje-amarelo").style.left = pct(cota);
    $("hoje-amarelo").style.width = pct(Math.min(usado, limite) - cota);
    $("hoje-vermelho").style.left = pct(limite);
    $("hoje-vermelho").style.width = pct(usado - limite);
    $("marca-cota").style.left = pct(cota);
    $("marca-limite").style.left = pct(limite);
    $("marca-cota").hidden = cota <= 0;

    // Passou do limite: o solo continua seco mesmo assim (sensor? canteiro?)
    const passou = usado > limite && limite > 0;
    $("hoje-aviso").hidden = !passou;
    if (passou) {
      const vezes = usado / limite;
      $("hoje-aviso").textContent = estadoAtual.decisao === "cota_atingida" || vezes >= 2
        ? `Passou ${numero(vezes, vezes < 10 ? 1 : 0)} vezes do limite e o solo continua seco: confira o sensor e o canteiro.`
        : "Passou do limite com a margem: a rega automática parou por hoje.";
    }

    // "Como calculamos": os números de hoje
    $("calculo-cota").textContent = `Cota de hoje: ${contaDaCota(cota, climaAtual, ajuste)}; limite com a margem de ${Math.round(MARGEM_EXTRA * 100)}%: ${numero(limite, 2)} L.`;
    const kc = typeof ajuste.kc === "number" ? ajuste.kc : KC;
    if (typeof ajuste.kc === "number" && ajuste.motivo) {
      const em = typeof ajuste.atualizadoEm === "number" ? ` ${quandoFoi(ajuste.atualizadoEm)}` : "";
      $("calculo-kc").textContent = `Kc ${umaCasa(ajuste.kc)}, ajustado${em}: ${ajuste.motivo}`;
    } else {
      $("calculo-kc").textContent = `Kc ${umaCasa(kc)} (inicial).`;
    }
  }

  // ================= Água por dia (gráfico) =================
  let grafico = null;
  let ultimosDadosGrafico = "";

  function desenharGrafico(lista) {
    if (typeof Chart === "undefined") return;  // biblioteca não carregou
    const hoje = chaveDia(agora());
    const dados = {
      rotulos: lista.map((d) => rotuloDia(d.chave, hoje)),
      horta: lista.map((d) => (d.semMedicao ? null : meio(d.litros))),
      timer: lista.map((d) => (d.semMedicao ? null : meio(d.timer))),
      corTimer: lista.map((d) => (d.hoje ? "#d6d6d6" : "#9e9e9e")),  // hoje: dia em andamento
      cota: lista.map((d) => (d.cota === null || d.semMedicao ? null : meio(d.cota))),
      semMedicao: lista.map((d) => d.semMedicao)
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
            { label: "Horta", data: [], backgroundColor: "#2e7d32" },
            { label: "Timer fixo", data: [], backgroundColor: [] },
            // Só para a legenda: o traço é desenhado pelo plugin desenhosAgua
            { type: "line", label: "Recomendado pela ET₀", data: [], borderColor: "#1565c0", backgroundColor: "transparent", borderDash: [7, 5], borderWidth: 3, pointRadius: 0 }
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
                afterBody: (itens) => {
                  const i = itens[0]?.dataIndex;
                  const cota = grafico.$agua?.cota[i];
                  return cota === null || cota === undefined ? "" : `Cota pela ET₀: ${numero(cota, 1)} L`;
                }
              }
            }
          },
          scales: { y: { beginAtZero: true, ticks: { callback: (v) => `${numero(v, 1)} L` } } }
        },
        plugins: [desenhosAgua]
      });
    }
    grafico.$agua = { cota: dados.cota, semMedicao: dados.semMedicao };
    // O eixo Y também precisa caber o traço da cota
    grafico.options.scales.y.suggestedMax = Math.max(0, ...dados.cota.filter((v) => v !== null));
    grafico.data.labels = dados.rotulos;
    grafico.data.datasets[0].data = dados.horta;
    grafico.data.datasets[1].data = dados.timer;
    grafico.data.datasets[1].backgroundColor = dados.corTimer;
    grafico.update();
  }

  function preencherTabela(lista) {
    const hoje = chaveDia(agora());
    const linhas = [...lista].reverse().map((d) => {  // hoje primeiro
      const dia = d.hoje ? "hoje" : `${rotuloDia(d.chave, hoje)}/${d.chave.slice(5, 7)}`;
      let celulas;
      if (d.semMedicao) {
        celulas = [dia, "—", "—", "—", "—", "—"];
      } else {
        const economia = meio(d.timer) - meio(d.litros);
        const porcento = d.timer > 0 ? Math.round(((d.timer - d.litros) / d.timer) * 100) : 0;
        celulas = [dia, String(d.regas), d.segundos > 0 ? duracao(d.segundos) : "—",
          litrosTela(d.litros), litrosTela(d.timer), `${numero(economia, 1)} L (${porcento}%)`];
      }
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

  // Últimas regas do período: as 10 mais recentes
  function mostrarLista(lista) {
    const doPeriodo = lista.flatMap((d) => d.lista || []);
    const ultimas = doPeriodo.sort((a, b) => b.fim - a.fim).slice(0, 10);
    $("vazio").hidden = ultimas.length > 0;
    $("lista").replaceChildren(...ultimas.map((rega) => {
      const li = document.createElement("li");
      const hora = document.createElement("span");
      hora.className = "decisao-hora";
      hora.textContent = quandoFoi(rega.fim);
      const texto = document.createElement("span");
      texto.textContent = `${duracao(rega.segundos)} · ${numero(rega.litros, 2)} L`;
      li.append(hora, texto);
      return li;
    }));
  }

  for (const botao of raiz.querySelectorAll(".agua-periodo")) {
    botao.addEventListener("click", () => {
      periodo = botao.dataset.periodo;
      mostrar();
    });
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
