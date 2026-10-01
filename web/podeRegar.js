// Faixa "Pode regar agora?" — logo abaixo dos cartões do topo do painel
// Responde em uma frase se a bomba vai regar e mostra os "semáforos" que o
// ESP32 considerou (solo, chuva, horário, cota e falha). O site NÃO recalcula
// a decisão: tudo vem de horta/estado (emCritico, chanceUsada, bloqueio…).
// Firmware antigo, sem esses campos: só a frase, a partir de decisao/motivo.
//
// Como usar:
//   const faixa = iniciarPodeRegar(db, document.getElementById("pode-regar"), {
//     zerarCota, resolverFalha, voltarAoReal   // funções do demo.js e do falha.js
//   });
//   faixa.definirOffline(true);  // o painel avisa quando o ESP32 está offline
import {
  ref, onValue
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { numero, contaDaCota } from "./agua.js";

// Iguais ao firmware (só para os textos e as cores dos chips).
// Exportados: o cartão de umidade e o gráfico do histórico marcam os mesmos limites.
export const LIMITE_LIGAR = 35;
export const LIMITE_DESLIGAR = 60;
export const LIMITE_CRITICO = 20;
const LIMITE_SAIR_CRITICO = 25;
const LIMITE_CHUVA = 60;
const CHUVA_ATENCAO = 40;        // de 40% a 59%: amarelo
const HORA_QUENTE_INICIO = 10;
const HORA_QUENTE_FIM = 16;
const COTA_ATENCAO = 0.8;        // a partir de 80% da cota: amarelo

const CODIGOS_REGANDO = ["regando", "sem_previsao", "cota_extra", "solo_critico"];
const CODIGOS_BLOQUEADO = ["adiada_chuva", "horario_quente", "cota_atingida", "falha_agua"];

// Qual chip mostra cada bloqueio
const CHIP_DO_BLOQUEIO = { falha: "falha", chuva: "chuva", horario: "horario", cota: "cota", chuva_caiu: "cota" };

// "Sem o crítico, ___ impediria."
const QUEM_IMPEDIRIA = {
  chuva: "a chuva", horario: "o sol forte", cota: "a cota do dia", chuva_caiu: "a chuva que caiu"
};

export function iniciarPodeRegar(db, raiz, acoes) {
  raiz.insertAdjacentHTML("beforeend", `
    <p class="pode-titulo">Pode regar agora?</p>
    <p data-pode="resposta" class="pode-resposta" role="status"></p>
    <div data-pode="chips" class="pode-chips"></div>
    <p data-pode="explica" class="pode-explica" hidden></p>
  `);
  const $ = (nome) => raiz.querySelector(`[data-pode="${nome}"]`);

  let estado = null;
  let clima = {};         // /clima e /horta/agua/ajuste: só para a conta da cota
  let ajuste = {};
  let offline = true;     // até o painel dizer o contrário
  let chipAberto = null;  // chip com a explicação aberta

  onValue(ref(db, "horta/estado"), (snap) => { estado = snap.val(); mostrar(); });
  onValue(ref(db, "clima"), (snap) => { clima = snap.val() || {}; mostrar(); });
  onValue(ref(db, "horta/agua/ajuste"), (snap) => { ajuste = snap.val() || {}; mostrar(); });

  // ---------- Linha 1: a resposta ----------
  function resposta(e) {
    const d = e.decisao;
    const u = e.umidade;
    const bloqueio = typeof e.bloqueio === "string" ? e.bloqueio : null;  // null = firmware antigo

    if (d.startsWith("manual_")) return { cor: "neutro", texto: "🖐️ Modo manual: a bomba segue o painel" };
    if (d === "pausa_seguranca") return { cor: "neutro", texto: "⏸️ Pausa de segurança — a bomba está descansando" };

    if (CODIGOS_REGANDO.includes(d)) {
      if (d === "solo_critico" && QUEM_IMPEDIRIA[bloqueio]) {
        return {
          cor: "vermelho",
          texto: `🚨 Regando mesmo assim — solo crítico (${u}%). Sem o crítico, ${QUEM_IMPEDIRIA[bloqueio]} impediria.`
        };
      }
      const curto = {
        regando: `solo com ${u}%, vai até ${LIMITE_DESLIGAR}%`,
        sem_previsao: `sem previsão do tempo, só pelo sensor (${u}%)`,
        cota_extra: `rega extra: a cota acabou, mas o solo continua seco (${u}%)`,
        solo_critico: `solo crítico (${u}%)`
      }[d];
      return { cor: "azul", texto: `💧 Regando agora — ${curto}` };
    }

    if (d === "solo_ok") {
      return { cor: "verde", texto: `✅ Não precisa regar — solo com ${u}% (liga abaixo de ${LIMITE_LIGAR}%)` };
    }

    if (CODIGOS_BLOQUEADO.includes(d)) {
      // Firmware antigo: o próprio motivo, sem o "Não reguei:" do começo
      const frase = bloqueio ? fraseBloqueio(e, bloqueio) : (e.motivo || "").replace(/^(Não reguei|Parei de regar): /, "");
      return { cor: "vermelho", texto: `⛔ Não vai regar — ${frase || "a decisão bloqueou a rega"}` };
    }
    return { cor: "neutro", texto: e.motivo || "" };
  }

  // O motivo do bloqueio, em linguagem simples
  function fraseBloqueio(e, bloqueio) {
    switch (bloqueio) {
      case "falha": return "falha de água: confira o reservatório, a mangueira e a bomba";
      case "chuva": return `vai chover: ${e.chanceUsada}% de chance nas próximas 6 h${e.chuvaSimulada ? " (simulado)" : ""}`;
      case "horario": return `sol forte (${e.hora}h): volta a regar às ${HORA_QUENTE_FIM}h${e.horaSimulada ? " (simulado)" : ""}`;
      case "cota": return `a cota do dia acabou: ${numero(e.litrosCota, 1)} L de ${numero(limiteCota(e), 1)} L com a margem`;
      case "chuva_caiu": return "choveu mais do que a planta perdeu hoje";
      default: return e.motivo;
    }
  }

  const limiteCota = (e) => (typeof e.cotaLimite === "number" ? e.cotaLimite : e.cotaHoje * 1.5);

  // ---------- Linha 2: os semáforos ----------
  // cor: verde = liberado, amarelo = atenção, vermelho = bloqueando, cinza = sem dado/desligado
  function chips(e) {
    const lista = [];
    const u = e.umidade;

    const critico = e.emCritico === true || u < LIMITE_CRITICO;
    lista.push({
      id: "solo", nome: "Solo", icone: critico ? "🚨" : "💧",
      valor: `${u}% · liga < ${LIMITE_LIGAR}%${critico ? " · crítico" : ""}`,
      cor: critico ? "vermelho" : u < LIMITE_SAIR_CRITICO ? "amarelo" : "verde",
      explica: `Liga abaixo de ${LIMITE_LIGAR}% e desliga acima de ${LIMITE_DESLIGAR}%. Abaixo de ${LIMITE_CRITICO}% o solo está crítico: rega mesmo com chuva, sol forte ou cota, até passar de ${LIMITE_SAIR_CRITICO}%.`
    });

    const c = e.chanceUsada;
    lista.push(c < 0 ? {
      id: "chuva", nome: "Chuva", icone: "🌧️", valor: "sem previsão", cor: "cinza",
      explica: "Sem previsão do tempo válida: a horta rega só pelo sensor."
    } : {
      id: "chuva", nome: "Chuva", icone: "🌧️", valor: `${c}%`, simulado: e.chuvaSimulada === true,
      cor: c >= LIMITE_CHUVA ? "vermelho" : c >= CHUVA_ATENCAO ? "amarelo" : "verde",
      explica: `Maior chance de chuva nas próximas 6 h${e.chuvaSimulada ? " (simulada no Modo demonstração)" : ""}. A partir de ${LIMITE_CHUVA}% a rega é adiada.`
    });

    const h = e.hora;
    const temHora = typeof h === "number";
    lista.push({
      id: "horario", nome: "Horário", icone: "☀️",
      valor: temHora ? `${h}h` : "sem hora", simulado: temHora && e.horaSimulada === true,
      cor: !temHora ? "cinza"
        : h >= HORA_QUENTE_INICIO && h < HORA_QUENTE_FIM ? "vermelho"
        : h === HORA_QUENTE_INICIO - 1 ? "amarelo" : "verde",
      explica: temHora
        ? `Das ${HORA_QUENTE_INICIO}h às ${HORA_QUENTE_FIM}h o sol forte evapora a água: a rega espera (menos no solo crítico).`
        : "O ESP32 ainda não sabe a hora (sem internet): a regra do horário fica de fora."
    });

    const cota = e.cotaHoje;
    const litros = Number(e.litrosCota) || 0;
    const limite = limiteCota(e);
    if (typeof cota === "number") {
      let cor = "verde";
      let valor = `${numero(litros, 1)} de ${numero(cota, 1)} L`;
      if (e.bloqueio === "chuva_caiu" || cota <= 0) { cor = "vermelho"; valor = "choveu o bastante"; }
      else if (litros >= limite) { cor = "vermelho"; valor += " · acabou"; }
      else if (litros >= cota) { cor = "amarelo"; valor += " · margem extra"; }
      else if (litros >= cota * COTA_ATENCAO) cor = "amarelo";
      const conta = contaDaCota(cota, clima, ajuste);
      lista.push({
        id: "cota", nome: "Cota", icone: "🎯", valor, cor,
        explica: conta.endsWith(" L")
          ? `${conta} por dia; até ${numero(limite, 1)} L com a margem.`
          : `${conta} Até ${numero(limite, 1)} L com a margem.`
      });
    }

    const detectando = e.detectarFalha !== false;
    lista.push(e.emFalha === true ? {
      id: "falha", nome: "Falha", icone: "⚠️", valor: "falha: confira a água", cor: "vermelho",
      explica: "A última rega não fez a umidade subir: pode faltar água (reservatório, mangueira ou bomba)."
    } : {
      id: "falha", nome: "Falha", icone: "⚠️",
      valor: detectando ? "sem falha" : "detecção desligada", cor: detectando ? "verde" : "cinza",
      explica: detectando
        ? "Se a bomba rega 45 s e a umidade não sobe 3 pontos, a rega automática para e avisa."
        : "A detecção de falha foi desligada no Modo demonstração."
    });
    return lista;
  }

  // Botão ao lado do chip que está bloqueando (reaproveita demo.js e falha.js)
  function acaoDoBloqueio(e) {
    switch (e.bloqueio) {
      case "cota": return { texto: "🎯 Recomeçar a cota (demo)", classe: "demo-voltar", fazer: acoes.zerarCota };
      case "falha": return { texto: "Já resolvi", classe: "falha-botao", fazer: acoes.resolverFalha };
      case "chuva":
        return e.chuvaSimulada ? { texto: "Voltar ao real", classe: "demo-voltar", fazer: () => acoes.voltarAoReal("simularChuva") } : null;
      case "horario":
        return e.horaSimulada ? { texto: "Voltar ao real", classe: "demo-voltar", fazer: () => acoes.voltarAoReal("simularHora") } : null;
      default: return null;
    }
  }

  function mostrar() {
    const temDecisao = estado && typeof estado.decisao === "string";

    // Sem ESP32 (offline ou ainda sem dado): faixa cinza
    if (offline || !temDecisao) {
      raiz.dataset.cor = "cinza";
      $("resposta").textContent = "Sem dados do ESP32";
      $("chips").replaceChildren();
      $("chips").hidden = true;
      $("explica").hidden = true;
      return;
    }

    const r = resposta(estado);
    raiz.dataset.cor = r.cor;
    $("resposta").textContent = r.texto;

    // Firmware antigo (sem os semáforos): só a linha 1
    const temSemaforos = typeof estado.bloqueio === "string";
    $("chips").hidden = !temSemaforos;
    if (!temSemaforos) {
      $("chips").replaceChildren();
      $("explica").hidden = true;
      return;
    }

    // O chip que está bloqueando vai primeiro, com a borda mais grossa
    const lista = chips(estado);
    const idBloqueio = CHIP_DO_BLOQUEIO[estado.bloqueio];
    lista.sort((a, b) => (b.id === idBloqueio) - (a.id === idBloqueio));

    const elementos = [];
    for (const chip of lista) {
      const bloqueando = chip.id === idBloqueio;
      const botao = document.createElement("button");
      botao.type = "button";
      botao.dataset.chip = chip.id;
      botao.className = `pode-chip pode-${chip.cor}${bloqueando ? " bloqueando" : ""}`;
      botao.setAttribute("aria-expanded", String(chipAberto === chip.id));
      const estadoTexto = { verde: "liberado", amarelo: "atenção", vermelho: "bloqueando", cinza: "sem efeito" }[chip.cor];
      botao.setAttribute("aria-label", `${chip.nome}: ${chip.valor}${chip.simulado ? " (simulado)" : ""}, ${estadoTexto}. Toque para explicar.`);
      botao.innerHTML = `<span aria-hidden="true">${chip.icone}</span>
        <span><b></b> <span data-valor></span></span>`;
      botao.querySelector("b").textContent = chip.nome;
      botao.querySelector("[data-valor]").textContent = chip.valor + (chip.simulado ? " (simulado)" : "");
      botao.addEventListener("click", () => {
        chipAberto = chipAberto === chip.id ? null : chip.id;
        mostrar();
      });
      elementos.push(botao);

      if (bloqueando) {
        const acao = acaoDoBloqueio(estado);
        if (acao && acao.fazer) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = `pode-acao ${acao.classe}`;
          b.textContent = acao.texto;
          b.addEventListener("click", () => acao.fazer());
          elementos.push(b);
        }
      }
    }
    // Os chips são refeitos a cada estado: devolve o foco a quem estava nele
    const focado = document.activeElement?.closest?.("[data-chip]")?.dataset.chip;
    $("chips").replaceChildren(...elementos);
    if (focado) $("chips").querySelector(`[data-chip="${focado}"]`)?.focus();

    const aberto = lista.find((chip) => chip.id === chipAberto);
    $("explica").hidden = !aberto;
    $("explica").textContent = aberto ? `${aberto.icone} ${aberto.explica}` : "";
  }

  mostrar();

  return {
    definirOffline(valor) {
      if (offline === valor) return;
      offline = valor;
      mostrar();
    }
  };
}
