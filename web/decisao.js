// Cartão "Últimas decisões" (aba Histórico) e a linha "Última decisão" (aba Agora)
// Lê horta/decisoes (histórico). A decisão de agora, com o motivo, já aparece
// grande na faixa "Pode regar agora?": aqui não se repete.
//
// Como usar:
//   iniciarDecisao(db, document.getElementById("decisao"), {
//     ultima: document.getElementById("ultima-decisao")  // "Última decisão, 11:31: …" (opcional)
//   });
// O elemento raiz já deve ter o título do cartão; o resto é criado aqui.
// Se o ESP32 ainda não mandar a decisão (firmware antigo), o cartão fica escondido.
import {
  ref, onValue, query, orderByChild, limitToLast
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { quandoFoi, hora as horaDe } from "./tempo.js";

// Um ícone para cada código de decisão
const ICONES = {
  regando: "💧",
  solo_ok: "✅",
  adiada_chuva: "🌧️",
  horario_quente: "☀️",
  cota_atingida: "🎯",
  cota_extra: "➕",
  falha_agua: "⚠️",
  solo_critico: "🚨",
  sem_previsao: "📡",
  pausa_seguranca: "⏸️",
  manual_ligada: "🖐️",
  manual_desligada: "🖐️"
};
const icone = (codigo) => ICONES[codigo] || "🌱";


export function iniciarDecisao(db, raiz, opcoes = {}) {
  // Monta o conteúdo do cartão
  raiz.insertAdjacentHTML("beforeend", `
    <p data-decisao="vazio" class="decisao-vazio">Nenhuma decisão registrada ainda.</p>
    <ol data-decisao="lista" class="decisao-lista"></ol>
  `);

  // Procura só dentro deste cartão
  const $ = (nome) => raiz.querySelector(`[data-decisao="${nome}"]`);

  // Firmware antigo (sem decisão no estado): esconde o cartão
  onValue(ref(db, "horta/estado"), (snap) => {
    const estado = snap.val();
    raiz.hidden = !(estado && typeof estado.decisao === "string");
  });

  // Histórico: as 8 decisões mais recentes, da mais nova para a mais velha
  const ultimas = query(ref(db, "horta/decisoes"), orderByChild("ts"), limitToLast(8));

  onValue(ultimas, (snap) => {
    const itens = [];
    snap.forEach((filho) => {
      itens.push(filho.val());
    });
    itens.reverse();  // o Firebase entrega da mais velha para a mais nova

    $("vazio").hidden = itens.length > 0;
    mostrarUltima(itens[0]);
    $("lista").replaceChildren(...itens.map((item) => {
      const li = document.createElement("li");

      const hora = document.createElement("span");
      hora.className = "decisao-hora";
      hora.textContent = quandoFoi(item.ts);

      const simbolo = document.createElement("span");
      simbolo.className = "decisao-lista-icone";
      simbolo.setAttribute("aria-hidden", "true");
      simbolo.textContent = icone(item.decisao);

      const texto = document.createElement("span");
      texto.textContent = item.motivo;

      li.append(hora, simbolo, texto);
      return li;
    }));
  });

  // "Última decisão, 11:31: <motivo> · ver histórico" (aba Agora)
  function mostrarUltima(item) {
    const linha = opcoes.ultima;
    if (!linha) return;
    linha.hidden = !item;
    if (!item) return;
    const hoje = new Date(item.ts).toDateString() === new Date().toDateString();
    const hora = hoje ? horaDe(item.ts) : quandoFoi(item.ts);
    linha.replaceChildren();
    const texto = document.createElement("span");
    texto.textContent = `${icone(item.decisao)} Última decisão, ${hora}: ${item.motivo} `;
    const link = document.createElement("a");
    link.href = "#historico";
    link.textContent = "ver histórico";
    linha.append(texto, link);
  }
}
