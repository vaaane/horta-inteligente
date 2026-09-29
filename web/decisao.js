// Cartão "Por que regou (ou não)" — mostra a decisão atual do ESP32 e as últimas mudanças
// Lê horta/estado (campos decisao e motivo) e horta/decisoes (histórico).
//
// Como usar:
//   iniciarDecisao(db, document.getElementById("decisao"));
// O elemento raiz já deve ter o título do cartão; o resto é criado aqui.
// Se o ESP32 ainda não mandar a decisão (firmware antigo), o cartão fica escondido.
import {
  ref, onValue, query, orderByChild, limitToLast
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

// Um ícone para cada código de decisão
const ICONES = {
  regando: "💧",
  solo_ok: "✅",
  adiada_chuva: "🌧️",
  solo_critico: "⚠️",
  sem_previsao: "📡",
  pausa_seguranca: "⏸️",
  manual_ligada: "🖐️",
  manual_desligada: "🖐️"
};
const icone = (codigo) => ICONES[codigo] || "🌱";

// "hoje 17:05", "ontem 06:40" ou "27/09 09:15"
export function quando(ts) {
  const data = new Date(ts);
  const hora = data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  const hoje = new Date();
  const ontem = new Date();
  ontem.setDate(hoje.getDate() - 1);
  const mesmoDia = (a, b) => a.toDateString() === b.toDateString();

  if (mesmoDia(data, hoje)) return `hoje ${hora}`;
  if (mesmoDia(data, ontem)) return `ontem ${hora}`;
  const dia = data.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  return `${dia} ${hora}`;
}

export function iniciarDecisao(db, raiz) {
  // Monta o conteúdo do cartão
  raiz.insertAdjacentHTML("beforeend", `
    <div class="decisao-atual">
      <span data-decisao="icone" class="decisao-icone" aria-hidden="true"></span>
      <p data-decisao="motivo" class="decisao-motivo"></p>
    </div>
    <h3 class="decisao-subtitulo">Últimas decisões</h3>
    <p data-decisao="vazio" class="decisao-vazio">Nenhuma decisão registrada ainda.</p>
    <ol data-decisao="lista" class="decisao-lista"></ol>
  `);

  // Procura só dentro deste cartão
  const $ = (nome) => raiz.querySelector(`[data-decisao="${nome}"]`);

  // Decisão atual: vem junto com o estado que o ESP32 envia a cada 30 s
  onValue(ref(db, "horta/estado"), (snap) => {
    const estado = snap.val();
    const temDecisao = estado && typeof estado.decisao === "string";
    raiz.hidden = !temDecisao;  // firmware antigo: esconde o cartão
    if (!temDecisao) return;

    $("icone").textContent = icone(estado.decisao);
    $("motivo").textContent = estado.motivo || "";
  });

  // Histórico: as 5 decisões mais recentes, da mais nova para a mais velha
  const ultimas = query(ref(db, "horta/decisoes"), orderByChild("ts"), limitToLast(5));

  onValue(ultimas, (snap) => {
    const itens = [];
    snap.forEach((filho) => {
      itens.push(filho.val());
    });
    itens.reverse();  // o Firebase entrega da mais velha para a mais nova

    $("vazio").hidden = itens.length > 0;
    $("lista").replaceChildren(...itens.map((item) => {
      const li = document.createElement("li");

      const hora = document.createElement("span");
      hora.className = "decisao-hora";
      hora.textContent = quando(item.ts);

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
}
