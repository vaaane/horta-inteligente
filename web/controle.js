// Controle da bomba pelo painel — fica dentro do cartão "Bomba d'água"
// Grava em horta/comandos (aberto, sem login) e confere a resposta do ESP32
// em horta/estado. O círculo da bomba (app.js) sempre mostra o estado REAL.
//
// Como usar:
//   const controle = iniciarControle(db, document.getElementById("controle"));
//   controle.definirOffline(true);  // o painel avisa quando o ESP32 está offline
// No celular sem ?demo=1 o painel põe a classe "so-leitura" no <body>: os
// botões somem (CSS) e fica só a linha "Modo: Automático" (data-controle="modo-texto").
import {
  ref, onValue, update, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const TEMPO_MAX_MANUAL_MS = 10 * 60 * 1000;  // o ESP32 volta ao automático depois de 10 min
const ESPERA_RESPOSTA_MS = 5 * 1000;          // tempo para o ESP32 confirmar um pedido

export function iniciarControle(db, raiz) {
  // Monta o conteúdo
  raiz.insertAdjacentHTML("beforeend", `
    <p data-controle="modo-texto" class="controle-modo-texto"></p>
    <div class="controle-modos" role="group" aria-label="Modo da bomba">
      <button type="button" data-controle="auto" class="controle-modo" aria-pressed="false">Automático</button>
      <button type="button" data-controle="manual" class="controle-modo" aria-pressed="false">Manual</button>
    </div>
    <button type="button" data-controle="bomba" class="controle-bomba" hidden>Ligar bomba</button>
    <p data-controle="pedido" class="controle-pedido" hidden></p>
    <p data-controle="contagem" class="controle-contagem" hidden></p>
    <p data-controle="status" class="controle-status" role="status" hidden></p>
    <p data-controle="bloqueio" class="controle-bloqueio"></p>
  `);

  // Procura só dentro deste cartão
  const $ = (nome) => raiz.querySelector(`[data-controle="${nome}"]`);

  // Selo "Modo teste" ao lado do título do cartão (aparece se o ESP32 avisar)
  const selo = document.createElement("span");
  selo.className = "selo-teste";
  selo.textContent = "Modo teste";
  selo.hidden = true;
  const titulo = raiz.closest(".cartao")?.querySelector("h2");
  if (titulo) titulo.append(" ", selo);

  let comandos = null;         // o que está em horta/comandos (null = ainda não carregou)
  let estado = null;           // o que o ESP32 mandou em horta/estado
  let offline = true;          // até o painel dizer o contrário
  let semDados = true;         // o ESP32 ainda não mandou nenhum dado
  let gravando = false;        // esperando o Firebase aceitar a gravação
  let pedido = null;           // último pedido: { modo, bomba, enviadoEm }
  let erroGravacao = "";       // mensagem de erro ao gravar
  let diferencaRelogio = 0;    // relógio do servidor - relógio do celular

  onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
    diferencaRelogio = snap.val() || 0;
  });

  // Modo atual e pedido da bomba (se o nó não existir, é Automático)
  onValue(ref(db, "horta/comandos"), (snap) => {
    comandos = snap.val() || { modo: "auto", bombaManual: false };
    mostrar();
  });

  // Estado real, que o ESP32 manda
  onValue(ref(db, "horta/estado"), (snap) => {
    estado = snap.val();
    semDados = !estado;
    if (pedido && pedidoAtendido()) pedido = null;  // o ESP32 confirmou
    mostrar();
  });

  // O estado real já bate com o que foi pedido?
  function pedidoAtendido() {
    if (!estado) return false;
    const decisao = estado.decisao;  // firmware antigo não manda: só confere a bomba
    if (pedido.modo === "auto") {
      return decisao === undefined || !decisao.startsWith("manual_");
    }
    const esperado = pedido.bomba ? "manual_ligada" : "manual_desligada";
    return estado.bomba === pedido.bomba && (decisao === undefined || decisao === esperado);
  }

  // Grava no Firebase e passa a esperar a resposta do ESP32
  async function gravar(dados, novoPedido) {
    gravando = true;
    erroGravacao = "";
    mostrar();
    try {
      await update(ref(db, "horta/comandos"), dados);
      pedido = { ...novoPedido, enviadoEm: Date.now() };
      if (pedidoAtendido()) pedido = null;  // já estava assim
    } catch (erro) {
      erroGravacao = "Não consegui enviar o pedido: " + erro.message;
      if (erro.code === "PERMISSION_DENIED") {
        erroGravacao += " (as regras do Firebase foram publicadas?)";
      }
    }
    gravando = false;
    mostrar();
  }

  $("manual").addEventListener("click", () => {
    gravar(
      { modo: "manual", bombaManual: false, manualDesde: serverTimestamp(), atualizadoEm: serverTimestamp() },
      { modo: "manual", bomba: false }
    );
  });

  $("auto").addEventListener("click", () => {
    gravar(
      { modo: "auto", bombaManual: false, atualizadoEm: serverTimestamp() },
      { modo: "auto" }
    );
  });

  $("bomba").addEventListener("click", () => {
    const ligar = !comandos.bombaManual;
    gravar(
      { bombaManual: ligar, atualizadoEm: serverTimestamp() },
      { modo: "manual", bomba: ligar }
    );
  });

  // Atualiza botões e mensagens (roda a cada mudança e a cada segundo)
  function mostrar() {
    const manual = comandos !== null && comandos.modo === "manual";
    const bloqueado = offline || semDados || comandos === null;

    // Só leitura (celular): o modo em texto, sem botões
    $("modo-texto").textContent = comandos === null ? "" : `Modo: ${manual ? "Manual" : "Automático"}`;

    // Seletor de modo: o atual fica destacado
    for (const modo of ["auto", "manual"]) {
      const atual = comandos !== null && (modo === "manual") === manual;
      $(modo).classList.toggle("ativo", atual);
      $(modo).setAttribute("aria-pressed", String(atual));
      $(modo).disabled = bloqueado || gravando;
    }

    // Botão grande: só no modo manual, alterna conforme o pedido atual.
    // A legenda deixa claro que é o PEDIDO; o círculo mostra o estado real.
    const pediuLigada = manual && comandos.bombaManual === true;
    $("bomba").hidden = !manual;
    $("pedido").hidden = !manual;
    if (manual) {
      $("bomba").textContent = pediuLigada ? "Desligar bomba" : "Ligar bomba";
      $("bomba").classList.toggle("desligar", pediuLigada);
      $("bomba").disabled = bloqueado || gravando;
      $("pedido").textContent = `Você pediu: ${pediuLigada ? "ligada" : "desligada"}`;
    }

    // Modo teste: selo no título e sem o limite de 10 min do manual
    selo.hidden = !modoTeste();

    // Por que os botões estão desativados
    const bloqueio = $("bloqueio");
    // Sem sinal: só os botões desativados (o motivo já está na faixa "Pode regar agora?")
    bloqueio.textContent = "";
    bloqueio.hidden = bloqueio.textContent === "";

    mostrarContagem(manual);
    mostrarStatus(manual);
  }

  // O ESP32 está em modo teste? (sem pausa e sem limite do manual)
  function modoTeste() {
    return estado !== null && estado.modoTeste === true;
  }

  // "Volta para o automático em X min" (no modo teste o manual não tem limite)
  function mostrarContagem(manual) {
    const contagem = $("contagem");
    const desde = manual && !modoTeste() ? comandos.manualDesde : undefined;
    contagem.hidden = typeof desde !== "number";
    if (contagem.hidden) return;

    const agora = Date.now() + diferencaRelogio;
    const restante = desde + TEMPO_MAX_MANUAL_MS - agora;
    if (restante <= 0) contagem.textContent = "Voltando para o automático…";
    else if (restante < 60 * 1000) contagem.textContent = "Volta para o automático em menos de 1 min";
    else contagem.textContent = `Volta para o automático em ${Math.ceil(restante / 60000)} min`;
  }

  // Retorno do pedido: aguardando, sem resposta, pausa de segurança ou erro
  function mostrarStatus(manual) {
    const status = $("status");
    let texto = "";
    let aviso = false;

    if (erroGravacao) {
      texto = erroGravacao;
      aviso = true;
    } else if (gravando) {
      texto = "Enviando pedido…";
    } else if (manual && estado && estado.decisao === "pausa_seguranca") {
      // A bomba não liga por segurança: é esperado, então mostra o motivo
      texto = "⏸️ " + (estado.motivo || "Pausa de segurança: a bomba está descansando.");
    } else if (pedido) {
      if (Date.now() - pedido.enviadoEm < ESPERA_RESPOSTA_MS) {
        texto = "Pedido enviado… aguardando o ESP32";
      } else {
        texto = "O ESP32 não respondeu. Ele está ligado e com internet?";
        aviso = true;
      }
    }

    status.textContent = texto;
    status.hidden = texto === "";
    status.classList.toggle("aviso-controle", aviso);
  }

  setInterval(mostrar, 1000);  // contagem regressiva e prazo de 15 s
  mostrar();

  return {
    definirOffline(valor) {
      if (offline === valor) return;
      offline = valor;
      mostrar();
    }
  };
}
