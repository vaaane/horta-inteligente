// Cartão "Modo demonstração" — simula a chance de chuva e o horário pelo site
// Grava em horta/comandos:
//   simularChuva: 0 a 100 (%), ou -1 = usar a previsão real
//   simularHora:  0 a 23 (h),  ou -1 = usar a hora real
// O ESP32 recebe na hora (streaming) e decide de novo; o motivo aparece no
// cartão "Por que regou (ou não)" com "(simulado)".
//
// Como usar:
//   const demo = iniciarDemo(db, document.getElementById("demo"), document.getElementById("clima"));
//   demo.definirOffline(true);  // o painel avisa quando o ESP32 está offline
import {
  ref, onValue, update, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

// Iguais ao firmware
const LIMITE_CHUVA = 60;         // a partir daqui a rega é adiada
const HORA_QUENTE_INICIO = 10;   // sol forte das 10h00…
const HORA_QUENTE_FIM = 16;      // …até 15h59

const doisDigitos = (n) => String(n).padStart(2, "0");

// Posição (em %) de um valor no controle deslizante
const posicao = (valor, min, max) => ((valor - min) / (max - min)) * 100;

// As duas simulações. Cada uma vira uma chave + controle deslizante + botões rápidos.
const SIMULACOES = [
  {
    campo: "simularChuva",
    chave: "Simular chuva",
    min: 0, max: 100, passo: 10,
    inicial: 80,                 // valor quando a simulação é ligada
    rapidos: [0, 30, 60, 80, 100],
    formato: (v) => `${v}%`,
    rotuloRapido: (v) => `${v}%`,
    rotuloControle: "Chance de chuva simulada (%)",
    faixa: (v) => `🌧️ Simulação ativa: ${v}% de chance de chuva`,
    voltar: "Voltar à previsão real",
    // Marca em 60%: a partir daqui a rega é adiada
    marcacao: () => `
      <div class="demo-marca" style="left: ${LIMITE_CHUVA}%" aria-hidden="true"></div>
      <p class="demo-marca-texto" style="left: ${LIMITE_CHUVA}%">a partir daqui a rega é adiada</p>`
  },
  {
    campo: "simularHora",
    chave: "Simular horário",
    min: 0, max: 23, passo: 1,
    inicial: 12,
    rapidos: [7, 12, 17],
    formato: (v) => `${doisDigitos(v)}:00`,
    rotuloRapido: (v) => `${doisDigitos(v)}h`,
    rotuloControle: "Hora simulada",
    faixa: (v) => `🕐 Simulação ativa: ${doisDigitos(v)}:00`,
    voltar: "Voltar ao horário real",
    // Faixa laranja das 10h às 16h: sol forte
    marcacao: () => {
      const inicio = posicao(HORA_QUENTE_INICIO, 0, 23);
      const largura = posicao(HORA_QUENTE_FIM, 0, 23) - inicio;
      return `
      <div class="demo-sol" style="left: ${inicio}%; width: ${largura}%" aria-hidden="true"></div>
      <p class="demo-sol-texto" style="left: ${inicio + largura / 2}%">sol forte</p>`;
    }
  }
];

export function iniciarDemo(db, raiz, cartaoClima) {
  // Monta o conteúdo
  raiz.insertAdjacentHTML("beforeend", `
    <p class="demo-explica">Na época da feira quase nunca chove no DF. Simule uma previsão de chuva (ou um horário de sol forte) e veja a horta mudar de decisão.</p>
    <div data-demo="faixas"></div>
    ${SIMULACOES.map((sim) => `
      <div class="demo-simulacao" data-sim="${sim.campo}">
        <label class="demo-chave">
          <input type="checkbox" data-parte="chave" role="switch">
          <span>${sim.chave}</span>
        </label>
        <div data-parte="controles" class="demo-controles" hidden>
          <div class="demo-linha">
            <div class="demo-deslizante">
              <input type="range" data-parte="range" min="${sim.min}" max="${sim.max}" step="${sim.passo}"
                     value="${sim.inicial}" aria-label="${sim.rotuloControle}">
              ${sim.marcacao()}
            </div>
            <output data-parte="numero" class="demo-numero">${sim.formato(sim.inicial)}</output>
          </div>
          <div class="demo-rapidos" role="group" aria-label="Valores rápidos">
            ${sim.rapidos.map((v) => `<button type="button" class="demo-rapido" data-valor="${v}">${sim.rotuloRapido(v)}</button>`).join("")}
          </div>
        </div>
      </div>`).join("")}
    <div class="demo-cota">
      <button type="button" data-demo="zerar-cota" class="demo-voltar">🎯 Recomeçar a cota (demo)</button>
      <span class="agua-sub">A horta volta a contar a água do dia a partir de agora (cartão "Água").</span>
    </div>
    <p data-demo="erro" class="controle-status aviso-controle" hidden></p>
    <p data-demo="bloqueio" class="controle-bloqueio"></p>
  `);

  const $ = (nome) => raiz.querySelector(`[data-demo="${nome}"]`);

  // Faixa âmbar "Simulação ativa" de cada simulação, no alto do cartão
  for (const sim of SIMULACOES) {
    $("faixas").insertAdjacentHTML("beforeend", `
      <div class="demo-faixa" data-faixa="${sim.campo}" role="status" hidden>
        <span data-parte="faixa-texto"></span>
        <button type="button" data-parte="voltar" class="demo-voltar">${sim.voltar}</button>
      </div>`);
    sim.bloco = raiz.querySelector(`[data-sim="${sim.campo}"]`);
    sim.faixaEl = raiz.querySelector(`[data-faixa="${sim.campo}"]`);
    sim.parte = (nome) => sim.bloco.querySelector(`[data-parte="${nome}"]`);
    sim.valor = -1;  // o que está gravado no Firebase (-1 = valor real)
  }

  // Linha pequena embaixo do "Clima agora" (o cartão continua com a previsão real)
  const linhaClima = document.createElement("p");
  linhaClima.className = "clima-simulada";
  linhaClima.hidden = true;

  let comandos;             // horta/comandos (undefined = ainda não carregou)
  let offline = true;       // até o painel dizer o contrário
  let gravando = false;
  let erro = "";

  onValue(ref(db, "horta/comandos"), (snap) => {
    comandos = snap.val();
    for (const sim of SIMULACOES) {
      const valor = comandos?.[sim.campo];
      sim.valor = typeof valor === "number" ? valor : -1;
      // Mostra o valor gravado no controle (se a pessoa não estiver mexendo nele)
      const range = sim.parte("range");
      if (sim.valor >= 0 && document.activeElement !== range) range.value = sim.valor;
    }
    mostrar();
  });

  // Grava uma simulação (-1 = desligar)
  async function gravar(campo, valor) {
    gravando = true;
    erro = "";
    mostrar();
    // As regras exigem modo e bombaManual no nó: se ele ainda não existe, cria no automático
    const dados = comandos
      ? { [campo]: valor, atualizadoEm: serverTimestamp() }
      : { modo: "auto", bombaManual: false, [campo]: valor, atualizadoEm: serverTimestamp() };
    try {
      await update(ref(db, "horta/comandos"), dados);
    } catch (e) {
      erro = "Não consegui enviar a simulação: " + e.message;
      if (e.code === "PERMISSION_DENIED") erro += " (as regras do Firebase foram publicadas?)";
    }
    gravando = false;
    mostrar();
  }

  for (const sim of SIMULACOES) {
    const range = sim.parte("range");

    // Chave liga/desliga
    sim.parte("chave").addEventListener("change", () => {
      gravar(sim.campo, sim.parte("chave").checked ? Number(range.value) : -1);
    });

    // Controle deslizante: o número muda enquanto arrasta ("input"),
    // mas só grava quando solta ("change"), para não fazer dezenas de escritas
    range.addEventListener("input", () => {
      sim.parte("numero").textContent = sim.formato(Number(range.value));
    });
    range.addEventListener("change", () => gravar(sim.campo, Number(range.value)));

    for (const botao of sim.bloco.querySelectorAll(".demo-rapido")) {
      botao.addEventListener("click", () => {
        range.value = botao.dataset.valor;
        gravar(sim.campo, Number(botao.dataset.valor));
      });
    }

    sim.faixaEl.querySelector('[data-parte="voltar"]').addEventListener("click", () => gravar(sim.campo, -1));
  }

  // "Recomeçar a cota": o ESP32 passa a contar a cota do dia a partir de agora
  $("zerar-cota").addEventListener("click", () => gravar("zerarCotaEm", serverTimestamp()));

  function mostrar() {
    const bloqueado = offline || comandos === undefined || gravando;

    for (const sim of SIMULACOES) {
      const ativa = sim.valor >= 0;
      sim.parte("chave").checked = ativa;
      sim.parte("controles").hidden = !ativa;
      sim.parte("numero").textContent = sim.formato(Number(sim.parte("range").value));
      for (const botao of sim.bloco.querySelectorAll(".demo-rapido")) {
        botao.classList.toggle("ativo", ativa && Number(botao.dataset.valor) === sim.valor);
      }
      sim.faixaEl.hidden = !ativa;
      sim.faixaEl.querySelector('[data-parte="faixa-texto"]').textContent = sim.faixa(sim.valor);
    }

    // Linha no cartão do clima (só a chuva mexe na previsão)
    const chuva = SIMULACOES[0].valor;
    cartaoClima?.append(linhaClima);  // sempre no fim do cartão (o clima.js monta o dele depois)
    linhaClima.hidden = chuva < 0;
    linhaClima.textContent = `A decisão está usando uma chance simulada de ${chuva}%.`;

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
