// Faixa vermelha "Falha": a bomba regou e a umidade não subiu
// (reservatório vazio, mangueira solta ou bomba com defeito). O ESP32
// bloqueia a rega automática e avisa em horta/estado/emFalha.
// O botão "Já resolvi" grava horta/comandos/resetFalhaEm, e o ESP32 libera.
//
// Como usar:
//   iniciarFalha(db, [document.getElementById("falha"), document.getElementById("falha-bomba")]);
// Cada elemento vira uma faixa (no topo do painel e no cartão da bomba).
import {
  ref, onValue, update, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

export function iniciarFalha(db, faixas) {
  faixas = faixas.filter(Boolean);
  for (const faixa of faixas) {
    faixa.insertAdjacentHTML("beforeend", `
      <p class="falha-titulo">⚠️ Falha: a umidade não subiu durante a rega.</p>
      <p data-falha="motivo" class="falha-motivo"></p>
      <div class="falha-acoes">
        <button type="button" data-falha="resolvi" class="falha-botao">Já resolvi</button>
        <span data-falha="status" class="falha-status"></span>
      </div>
    `);
  }
  const todos = (nome) => faixas.map((f) => f.querySelector(`[data-falha="${nome}"]`));

  let emFalha = false;
  let motivo = "";
  let comandos;             // horta/comandos (para saber se o nó já existe)
  let pedidoEnviado = false;
  let erro = "";

  onValue(ref(db, "horta/estado"), (snap) => {
    const estado = snap.val() || {};
    emFalha = estado.emFalha === true;
    motivo = estado.decisao === "falha_agua" && estado.motivo
      ? estado.motivo
      : "A rega automática está bloqueada. O modo Manual continua funcionando.";
    if (!emFalha) pedidoEnviado = false;  // o ESP32 liberou
    mostrar();
  });
  onValue(ref(db, "horta/comandos"), (snap) => {
    comandos = snap.val();
  });

  async function resolver() {
    erro = "";
    pedidoEnviado = true;
    mostrar();
    // As regras exigem modo e bombaManual no nó: se ele ainda não existe, cria no automático
    const dados = comandos
      ? { resetFalhaEm: serverTimestamp(), atualizadoEm: serverTimestamp() }
      : { modo: "auto", bombaManual: false, resetFalhaEm: serverTimestamp(), atualizadoEm: serverTimestamp() };
    try {
      await update(ref(db, "horta/comandos"), dados);
    } catch (e) {
      pedidoEnviado = false;
      erro = "Não consegui enviar: " + e.message +
        (e.code === "PERMISSION_DENIED" ? " (as regras do Firebase foram publicadas?)" : "");
    }
    mostrar();
  }
  for (const botao of todos("resolvi")) botao.addEventListener("click", resolver);

  function mostrar() {
    for (const faixa of faixas) faixa.hidden = !emFalha;
    for (const el of todos("motivo")) el.textContent = motivo;
    for (const botao of todos("resolvi")) botao.disabled = pedidoEnviado;
    for (const el of todos("status")) {
      el.textContent = erro || (pedidoEnviado ? "Pedido enviado… aguardando o ESP32" : "");
    }
  }
  mostrar();
}
