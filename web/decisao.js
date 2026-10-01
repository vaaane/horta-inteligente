// Cartão "Últimas decisões" (aba Histórico) e a linha "Última decisão" (aba Agora)
// Lê horta/decisoes (histórico). A decisão de agora, com o motivo, já aparece
// grande na faixa "Pode regar agora?": aqui não se repete.
// Mostra 5 linhas; "Ver mais" traz mais 10 de cada vez (até 50 decisões).
// Decisões seguidas iguais viram uma linha só: "… · ×3 · 12:04–13:39".
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


// "(simulado)" sai do texto e vira uma etiqueta
const SIMULADO = /\s*\(simulado\)\s*$/;

// Decisões seguidas com o mesmo código e o mesmo motivo viram uma linha só
// (a lista vem da mais nova para a mais velha)
function agrupar(itens) {
  const grupos = [];
  for (const item of itens) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.decisao === item.decisao && ultimo.motivo === item.motivo) {
      ultimo.vezes++;
      ultimo.primeiroTs = item.ts;
    } else {
      grupos.push({ decisao: item.decisao, motivo: item.motivo, ts: item.ts, primeiroTs: item.ts, vezes: 1 });
    }
  }
  return grupos;
}

const MOSTRAR_NO_INICIO = 5;
const MOSTRAR_A_MAIS = 10;
const MAXIMO = 50;  // decisões lidas do Firebase

export function iniciarDecisao(db, raiz, opcoes = {}) {
  // Monta o conteúdo do cartão
  raiz.insertAdjacentHTML("beforeend", `
    <p data-decisao="vazio" class="decisao-vazio">Nenhuma decisão registrada ainda.</p>
    <ol data-decisao="lista" class="decisao-lista"></ol>
    <button type="button" data-decisao="mais" class="decisao-mais" hidden>Ver mais</button>
  `);

  // Procura só dentro deste cartão
  const $ = (nome) => raiz.querySelector(`[data-decisao="${nome}"]`);

  // Firmware antigo (sem decisão no estado): esconde o cartão
  onValue(ref(db, "horta/estado"), (snap) => {
    const estado = snap.val();
    raiz.hidden = !(estado && typeof estado.decisao === "string");
  });

  let grupos = [];
  let quantas = MOSTRAR_NO_INICIO;  // linhas (já agrupadas) na tela

  // Histórico: as 50 decisões mais recentes, da mais nova para a mais velha
  const ultimas = query(ref(db, "horta/decisoes"), orderByChild("ts"), limitToLast(MAXIMO));
  onValue(ultimas, (snap) => {
    const itens = [];
    snap.forEach((filho) => {
      itens.push(filho.val());
    });
    itens.reverse();  // o Firebase entrega da mais velha para a mais nova

    mostrarUltima(itens[0]);
    grupos = agrupar(itens);
    mostrarLista();
  });

  $("mais").addEventListener("click", () => {
    quantas += MOSTRAR_A_MAIS;
    mostrarLista();
  });

  function mostrarLista() {
    $("vazio").hidden = grupos.length > 0;
    $("mais").hidden = quantas >= grupos.length;
    $("lista").replaceChildren(...grupos.slice(0, quantas).map((grupo) => {
      const li = document.createElement("li");

      const hora = document.createElement("span");
      hora.className = "decisao-hora";
      hora.textContent = quandoFoi(grupo.ts);

      const simbolo = document.createElement("span");
      simbolo.className = "decisao-lista-icone";
      simbolo.setAttribute("aria-hidden", "true");
      simbolo.textContent = icone(grupo.decisao);

      const texto = document.createElement("span");
      texto.className = "decisao-texto";
      const simulado = SIMULADO.test(grupo.motivo || "");
      texto.append((grupo.motivo || "").replace(SIMULADO, ""));
      if (simulado) {
        const etiqueta = document.createElement("span");
        etiqueta.className = "etiqueta-simulado";
        etiqueta.textContent = "simulado";
        texto.append(" ", etiqueta);
      }
      // Repetidas: "· ×3 · 12:04–13:39"
      if (grupo.vezes > 1) {
        const repeticao = document.createElement("span");
        repeticao.className = "decisao-repeticao";
        repeticao.textContent = ` · ×${grupo.vezes} · ${horaDe(grupo.primeiroTs)}–${horaDe(grupo.ts)}`;
        texto.append(repeticao);
      }

      li.append(hora, simbolo, texto);
      return li;
    }));
  }

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
