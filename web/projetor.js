// Modo projetor: ninguém clica no projetor, então o painel alterna sozinho
// Agora → Água → Histórico a cada 20 s (a Demonstração nunca entra).
//  - Fica parado na aba Agora enquanto houver falha, a bomba estiver ligada
//    ou a decisão tiver acabado de mudar (30 s).
//  - Qualquer toque, clique ou tecla pausa a rotação por 2 min.
//  - Três pontinhos no canto mostram qual aba está no ar.
// Liga com index.html?tela=projetor ou pelo interruptor da aba Demonstração
// (guardado neste navegador).
// Encaixe: como não sabemos a resolução do projetor, a aba visível ganha um
// zoom (no <main>) para caber na altura da janela (mínimo 0,6). A conta é
// refeita ao trocar de aba, ao redimensionar a janela e quando chega dado novo.
// Fora do modo projetor, nada de zoom.
//
// Como usar:
//   const projetor = iniciarProjetor(db, abas, document.getElementById("chave-projetor"), {
//     aoEncaixar: () => {}  // depois do zoom: resize() nos gráficos
//   });
//   projetor.encaixar();     // a aba mudou
import { ref, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const ROTACAO = ["agora", "agua", "historico"];
const NOMES = { agora: "Agora", agua: "Água", historico: "Histórico" };
const TEMPO_POR_ABA_MS = 20 * 1000;
const TRAVA_DECISAO_MS = 30 * 1000;
const PAUSA_TOQUE_MS = 2 * 60 * 1000;
const CHAVE_LOCAL = "horta-modo-projetor";

// localStorage pode não existir (aba anônima, bloqueado): aí só vale a URL
function lerLocal() {
  try { return localStorage.getItem(CHAVE_LOCAL) === "1"; } catch { return false; }
}
function gravarLocal(ligado) {
  try { localStorage.setItem(CHAVE_LOCAL, ligado ? "1" : "0"); } catch { /* sem localStorage */ }
}

const ZOOM_MINIMO = 0.6;

export function iniciarProjetor(db, abas, interruptor, { aoEncaixar = () => {} } = {}) {
  let ativo = new URLSearchParams(location.search).get("tela") === "projetor" || lerLocal();
  let abaDesde = Date.now();     // quando a aba atual entrou no ar
  let pausadoAte = 0;            // toque/clique: rotação parada até esta hora
  let travadoAte = 0;            // a decisão mudou: fica na aba Agora até esta hora
  let emFalha = false;
  let bombaLigada = false;
  let ultimaDecisao = null;

  // Indicador discreto: um pontinho por aba da rotação
  const indicador = document.createElement("div");
  indicador.className = "projetor-indicador";
  indicador.setAttribute("aria-hidden", "true");
  indicador.innerHTML = ROTACAO.map((nome) => `<span data-ponto="${nome}" title="${NOMES[nome]}"></span>`).join("");
  document.body.append(indicador);

  // ---------- Encaixar a aba visível na altura da janela ----------
  const principal = document.querySelector("main");
  let pedidoEncaixe = null;
  function encaixar() {
    cancelAnimationFrame(pedidoEncaixe);
    pedidoEncaixe = requestAnimationFrame(() => {
      const antes = principal.style.zoom;
      principal.style.zoom = "";
      if (ativo) {
        const topo = principal.getBoundingClientRect().top + window.scrollY;  // cabeçalho + abas
        const cabe = window.innerHeight - topo;
        const altura = principal.scrollHeight;
        if (altura > cabe) principal.style.zoom = String(Math.max(ZOOM_MINIMO, Math.floor((cabe / altura) * 1000) / 1000));
      }
      if (principal.style.zoom !== antes) aoEncaixar();
    });
  }
  window.addEventListener("resize", encaixar);

  onValue(ref(db, "horta/estado"), (snap) => {
    const estado = snap.val() || {};
    encaixar();  // dado novo: a altura da aba pode ter mudado
    emFalha = estado.emFalha === true;
    bombaLigada = estado.bomba === true;
    if (ultimaDecisao !== null && estado.decisao !== ultimaDecisao) travadoAte = Date.now() + TRAVA_DECISAO_MS;
    ultimaDecisao = estado.decisao ?? "";
  });

  // Quem está mexendo na tela pausa a rotação
  const pausar = () => { if (ativo) pausadoAte = Date.now() + PAUSA_TOQUE_MS; };
  for (const evento of ["pointerdown", "keydown", "wheel"]) {
    document.addEventListener(evento, pausar, { passive: true });
  }

  function mostrarAba(nome) {
    abas.mostrar(nome);
    abaDesde = Date.now();
    encaixar();
  }

  function passo() {
    indicador.hidden = !ativo;
    document.body.classList.toggle("projetor", ativo);
    if (!ativo) return;

    const agora = Date.now();
    const pausado = agora < pausadoAte;
    const travado = emFalha || bombaLigada || agora < travadoAte;
    if (pausado) {
      abaDesde = agora;  // quando a pausa acabar, a aba atual ainda fica 20 s
    } else if (travado) {
      if (abas.atual() !== "agora") mostrarAba("agora");
      abaDesde = agora;
    } else if (agora - abaDesde >= TEMPO_POR_ABA_MS) {
      const i = ROTACAO.indexOf(abas.atual());  // -1 (Demonstração) volta para Agora
      mostrarAba(ROTACAO[(i + 1) % ROTACAO.length]);
    }

    // Pontinhos: a aba que está no ar agora (laranja = pausado)
    indicador.classList.toggle("pausado", pausado);
    for (const ponto of indicador.children) {
      ponto.classList.toggle("ativo", ponto.dataset.ponto === abas.atual());
    }
  }

  if (interruptor) {
    interruptor.checked = ativo;
    interruptor.addEventListener("change", () => {
      ativo = interruptor.checked;
      gravarLocal(ativo);
      pausadoAte = 0;
      abaDesde = Date.now();
      passo();
      encaixar();
    });
  }

  setInterval(passo, 1000);
  passo();
  encaixar();

  return { encaixar };
}
