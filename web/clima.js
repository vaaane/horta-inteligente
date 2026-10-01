// Cartão "Clima agora" — lê o nó /clima do Firebase (gravado pelo ESP32)
// Usado no painel (index.html) e na página de teste (teste.html).
//
// Como usar:
//   iniciarClima(db, document.getElementById("clima"), { textoSemDados: "..." });
// O elemento raiz já deve ter o título do cartão; o resto é criado aqui.
import { ref, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { semSinal, quandoFoi } from "./tempo.js";

const LIMITE_CLIMA_ANTIGO_MS = 90 * 60 * 1000;  // 90 minutos
const LIMITE_CHUVA_ALTA = 60;                    // % de chance de chuva

const numero = (valor, casas) =>
  Number(valor).toLocaleString("pt-BR", { maximumFractionDigits: casas });

// Escreve o valor grande e a unidade menor (como no cartão de umidade)
function mostrarValor(elemento, valor, unidade) {
  elemento.textContent = valor;
  const pequena = document.createElement("small");
  pequena.textContent = unidade;
  elemento.append(pequena);
}

export function iniciarClima(db, raiz, opcoes = {}) {
  const textoSemDados = opcoes.textoSemDados || "Aguardando dados do ESP32…";
  const mostrarFaixaChuva = opcoes.mostrarFaixaChuva === true;

  // Monta o conteúdo do cartão
  raiz.insertAdjacentHTML("beforeend", `
    <p data-clima="espera" class="clima-explica"></p>
    <div data-clima="dados" hidden>
      <p data-clima="faixa-chuva" class="clima-faixa-chuva" hidden>🌧️ Chance alta de chuva nas próximas horas</p>
      <dl class="clima-valores">
        <div><dt>Temperatura</dt><dd data-clima="temp">--</dd></div>
        <div><dt>Umidade do ar</dt><dd data-clima="umidade">--</dd></div>
        <div><dt>Chuva (6 h)</dt><dd data-clima="chuva">--</dd></div>
        <div><dt>ET₀ hoje</dt><dd data-clima="et0">--</dd></div>
      </dl>
      <p data-clima="explica" class="clima-explica"></p>
      <p data-clima="atualizado" class="clima-rodape"></p>
      <p data-clima="aviso" class="clima-aviso" hidden></p>
    </div>
  `);

  // Procura só dentro deste cartão (assim a página pode ter outros elementos)
  const $ = (nome) => raiz.querySelector(`[data-clima="${nome}"]`);
  $("espera").textContent = textoSemDados;

  let diferencaRelogio = 0;  // relógio do servidor - relógio do celular
  let atualizadoEm = null;   // hora (do servidor) em que o ESP32 gravou o clima

  onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
    diferencaRelogio = snap.val() || 0;
  });

  // Toda vez que o ESP32 gravar um clima novo, esta função roda
  onValue(ref(db, "clima"), (snap) => {
    const c = snap.val();
    const temDados = c && c.temperatura !== undefined;
    $("espera").hidden = temDados;
    $("dados").hidden = !temDados;
    if (!temDados) {
      atualizadoEm = null;
      verificarClimaAntigo();
      return;
    }

    mostrarValor($("temp"), numero(c.temperatura, 1), "°C");
    mostrarValor($("umidade"), c.umidadeAr, "%");
    mostrarValor($("chuva"), c.chanceChuva6h, "%");
    mostrarValor($("et0"), numero(c.et0, 1), "mm");
    $("explica").textContent =
      `A planta de referência perde cerca de ${numero(c.et0, 1)} litros de água por m² hoje.`;

    // Faixa só informativa: a decisão da rega aparece na faixa "Pode regar agora?"
    $("faixa-chuva").hidden = !(mostrarFaixaChuva && c.chanceChuva6h >= LIMITE_CHUVA_ALTA);

    // "Atualizado hoje 14:38" / "ontem 14:38": usa a hora do Firebase; se não tiver, a da previsão
    atualizadoEm = typeof c.atualizadoEm === "number" ? c.atualizadoEm : null;
    $("atualizado").textContent = atualizadoEm !== null
      ? `Atualizado ${quandoFoi(atualizadoEm)}`
      : `Atualizado às ${String(c.horaPrevisao || "").slice(11, 16)}`;

    verificarClimaAntigo();
  });

  // Aviso discreto se o ESP32 parar de mandar o clima
  function verificarClimaAntigo() {
    if (atualizadoEm === null) {
      $("aviso").hidden = true;
      return;
    }
    const agora = Date.now() + diferencaRelogio;
    const antigo = agora - atualizadoEm > LIMITE_CLIMA_ANTIGO_MS;
    $("aviso").hidden = !antigo;
    if (antigo) $("aviso").textContent = `Clima sem atualizar ${semSinal(atualizadoEm, agora)}`;
  }
  setInterval(verificarClimaAntigo, 30000);
}
