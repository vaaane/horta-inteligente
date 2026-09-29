// Cartão "Modo demonstração" — simula a chance de chuva pelo site
// Grava horta/comandos/simularChuva (0 a 100, ou -1 = usar a previsão real).
// O ESP32 recebe na hora (streaming) e decide de novo; o motivo aparece no
// cartão "Por que regou (ou não)" com "(simulado)".
//
// Como usar:
//   const demo = iniciarDemo(db, document.getElementById("demo"), document.getElementById("clima"));
//   demo.definirOffline(true);  // o painel avisa quando o ESP32 está offline
import {
  ref, onValue, update, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const LIMITE_CHUVA = 60;        // igual ao firmware: a partir daqui a rega é adiada
const VALOR_INICIAL = 80;       // valor do controle quando a simulação é ligada
const RAPIDOS = [0, 30, 60, 80, 100];

export function iniciarDemo(db, raiz, cartaoClima) {
  // Monta o conteúdo
  raiz.insertAdjacentHTML("beforeend", `
    <p class="demo-explica">Na época da feira quase nunca chove no DF. Simule uma previsão de chuva e veja a horta mudar de decisão.</p>

    <div data-demo="faixa" class="demo-faixa" role="status" hidden>
      <span data-demo="faixa-texto"></span>
      <button type="button" data-demo="voltar" class="demo-voltar">Voltar à previsão real</button>
    </div>

    <label class="demo-chave">
      <input type="checkbox" data-demo="chave" role="switch">
      <span>Simular chuva</span>
    </label>

    <div data-demo="controles" class="demo-controles" hidden>
      <div class="demo-linha">
        <div class="demo-deslizante">
          <input type="range" data-demo="range" min="0" max="100" step="10" value="${VALOR_INICIAL}"
                 aria-label="Chance de chuva simulada (%)">
          <div class="demo-marca" style="left: ${LIMITE_CHUVA}%" aria-hidden="true"></div>
          <p class="demo-marca-texto" style="left: ${LIMITE_CHUVA}%">a partir daqui a rega é adiada</p>
        </div>
        <output data-demo="numero" class="demo-numero">${VALOR_INICIAL}%</output>
      </div>
      <div class="demo-rapidos" role="group" aria-label="Valores rápidos">
        ${RAPIDOS.map((v) => `<button type="button" class="demo-rapido" data-valor="${v}">${v}%</button>`).join("")}
      </div>
    </div>

    <p data-demo="erro" class="controle-status aviso-controle" hidden></p>
    <p data-demo="bloqueio" class="controle-bloqueio"></p>
  `);

  // Procura só dentro deste cartão
  const $ = (nome) => raiz.querySelector(`[data-demo="${nome}"]`);
  const botoesRapidos = [...raiz.querySelectorAll(".demo-rapido")];

  // Linha pequena embaixo do "Clima agora" (o cartão continua com a previsão real)
  const linhaClima = document.createElement("p");
  linhaClima.className = "clima-simulada";
  linhaClima.hidden = true;

  let comandos;             // horta/comandos (undefined = ainda não carregou)
  let simular = -1;         // valor gravado no Firebase (-1 = previsão real)
  let offline = true;       // até o painel dizer o contrário
  let gravando = false;
  let erro = "";

  onValue(ref(db, "horta/comandos"), (snap) => {
    comandos = snap.val();
    const valor = comandos?.simularChuva;
    simular = typeof valor === "number" ? valor : -1;
    // Mostra o valor gravado no controle (se a pessoa não estiver mexendo nele)
    if (simular >= 0 && document.activeElement !== $("range")) $("range").value = simular;
    mostrar();
  });

  // Grava a simulação (-1 = desligar)
  async function gravar(valor) {
    gravando = true;
    erro = "";
    mostrar();
    // As regras exigem modo e bombaManual no nó: se ele ainda não existe, cria no automático
    const dados = comandos
      ? { simularChuva: valor, atualizadoEm: serverTimestamp() }
      : { modo: "auto", bombaManual: false, simularChuva: valor, atualizadoEm: serverTimestamp() };
    try {
      await update(ref(db, "horta/comandos"), dados);
    } catch (e) {
      erro = "Não consegui enviar a simulação: " + e.message;
      if (e.code === "PERMISSION_DENIED") erro += " (as regras do Firebase foram publicadas?)";
    }
    gravando = false;
    mostrar();
  }

  // Chave liga/desliga
  $("chave").addEventListener("change", () => {
    gravar($("chave").checked ? Number($("range").value) : -1);
  });

  // Controle deslizante: o número muda enquanto arrasta ("input"),
  // mas só grava quando solta ("change"), para não fazer dezenas de escritas
  $("range").addEventListener("input", () => {
    $("numero").textContent = $("range").value + "%";
  });
  $("range").addEventListener("change", () => gravar(Number($("range").value)));

  for (const botao of botoesRapidos) {
    botao.addEventListener("click", () => {
      $("range").value = botao.dataset.valor;
      gravar(Number(botao.dataset.valor));
    });
  }

  $("voltar").addEventListener("click", () => gravar(-1));

  function mostrar() {
    const ativa = simular >= 0;
    const bloqueado = offline || comandos === undefined || gravando;

    $("chave").checked = ativa;
    $("controles").hidden = !ativa;
    $("numero").textContent = $("range").value + "%";
    for (const botao of botoesRapidos) {
      botao.classList.toggle("ativo", ativa && Number(botao.dataset.valor) === simular);
    }

    // Faixa âmbar e linha no cartão do clima
    $("faixa").hidden = !ativa;
    $("faixa-texto").textContent = `🌧️ Simulação ativa: ${simular}% de chance de chuva`;
    cartaoClima?.append(linhaClima);  // sempre no fim do cartão (o clima.js monta o dele depois)
    linhaClima.hidden = !ativa;
    linhaClima.textContent = `A decisão está usando uma chance simulada de ${simular}%.`;

    // Botões desativados com o ESP32 offline (como os da bomba)
    for (const el of raiz.querySelectorAll("input, button")) el.disabled = bloqueado;
    $("bloqueio").textContent = offline
      ? "Controles desativados: o ESP32 está offline, a simulação não teria efeito."
      : "";
    $("bloqueio").hidden = $("bloqueio").textContent === "";

    $("erro").textContent = erro;
    $("erro").hidden = erro === "";
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
