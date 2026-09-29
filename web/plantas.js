// Canteiros das plantas no "Planeje sua horta" — arrastar e girar
// Vale para os dois modos (Sobre o mapa e Desenho livre): cada modo só
// informa como converter "metros no terreno" em pixels na tela.
//
// Cada planta escolhida vira um retângulo alinhado à grade do terreno
// (x, y, w, h em metros; x para a direita, y para baixo), com a área escolhida.
import {
  CULTURAS, tamanhoDoCanteiro, encaixar, validarCanteiro, melhorPosicao, sugerirCanteiros, descreverLugar
} from "./culturas.js";

const culturaDe = (id) => CULTURAS.find((c) => c.id === id);
const numero = (v, casas = 1) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas });
const MOTIVOS = { fora: "Aqui não dá: fora do terreno", obstaculo: "Aqui não dá: obstáculo" };

export function iniciarPlantas({ lista, vazio, aoMudar }) {
  let mapa = null;          // horas de sol (sol.js)
  let terreno = null;       // terreno do cálculo
  let escolhidas = {};      // { tomate: 0.5 } (área em m²)
  let posicoes = {};        // { tomate: { x, y, w, h, girada } }
  let sugestoes = {};       // o que o site sugeriu (para "Voltar à sugestão")
  let selecionada = null;   // planta tocada (mostra o botão de girar)
  let arraste = null;       // planta sendo arrastada
  let botaoGirar = null;    // onde ficou o ↻ no último desenho (px)
  let caixasNomes = [];     // onde ficaram os nomes no último desenho (px), para tocar neles

  // Tamanho do canteiro pela área (deitado; "girada" = em pé)
  function tamanho(id, girada) {
    const t = tamanhoDoCanteiro(escolhidas[id], mapa.passo);
    return girada ? { w: t.h, h: t.w } : t;
  }
  const valido = (r) => validarCanteiro(mapa, terreno, r);
  const celulasDe = (r) => (r ? valido(r).celulas : []);

  // ---------- Depois de cada cálculo do mapa de sol (ou quando mudam as plantas) ----------
  function atualizar(novoMapa, novoTerreno, novasEscolhidas) {
    mapa = novoMapa;
    terreno = novoTerreno;
    escolhidas = novasEscolhidas;
    for (const id of Object.keys(posicoes)) if (!(id in escolhidas)) delete posicoes[id];
    if (selecionada && !(selecionada in escolhidas)) selecionada = null;
    if (!mapa || !terreno) { mostrarLista(); return; }

    const pedidos = CULTURAS.filter((c) => c.id in escolhidas).map((cultura) => ({ cultura, area: escolhidas[cultura.id] }));
    sugestoes = sugerirCanteiros(mapa, terreno, pedidos);
    for (const r of Object.values(sugestoes)) if (r) r.girada = r.w < r.h;

    // Cada planta fica onde estava (com o tamanho da área atual). Se não tem
    // lugar ainda, ou o lugar deixou de valer (mudou o terreno, entrou um
    // obstáculo), vai para o melhor lugar livre.
    const usados = new Set();
    for (const { cultura } of pedidos) {
      const id = cultura.id;
      let r = posicoes[id];
      if (r) r = { ...encaixar({ x: r.x, y: r.y, ...tamanho(id, r.girada) }, mapa.passo), girada: r.girada };
      if (!r || !valido(r).ok) {
        const t = tamanho(id, false);
        r = melhorPosicao(mapa, terreno, cultura, t.w, t.h, usados);
        if (r) r.girada = r.w < r.h;
      }
      posicoes[id] = r;
      celulasDe(r).forEach((i) => usados.add(i));
    }
    mostrarLista();
  }

  // ---------- Desenho (o mesmo nos dois modos) ----------
  // pt(x, y): metros no terreno -> pixel na tela
  function desenhar(ctx, pt) {
    caixasNomes = [];
    botaoGirar = null;
    if (!mapa || !terreno) return;
    for (const id of Object.keys(escolhidas)) {
      const emArraste = arraste && arraste.id === id;
      const r = emArraste ? arraste.candidato : posicoes[id];
      if (!r) continue;
      const cultura = culturaDe(id);
      const cantos = [pt(r.x, r.y), pt(r.x + r.w, r.y), pt(r.x + r.w, r.y + r.h), pt(r.x, r.y + r.h)];
      ctx.beginPath();
      cantos.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      const invalido = emArraste && !arraste.valido;
      ctx.save();
      ctx.globalAlpha = invalido ? 0.35 : 0.75;
      ctx.fillStyle = invalido ? "#9e9e9e" : cultura.cor;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = id === selecionada || emArraste ? 3 : 2;
      ctx.strokeStyle = invalido ? "#616161" : "#ffffff";
      if (invalido) ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.restore();

      const meio = pt(r.x + r.w / 2, r.y + r.h / 2);
      const texto = invalido ? `${cultura.nome} · ${MOTIVOS[arraste.motivo]}` : cultura.nome;
      caixasNomes.push({ id, ...etiqueta(ctx, texto, meio.x, meio.y, cultura.cor) });

      // Botão ↻ (girar 90°) no canto de cima à direita da planta selecionada
      if (id === selecionada && !emArraste) {
        const canto = cantos[1];
        botaoGirar = { x: canto.x + 12, y: canto.y - 12, raio: 13 };
        ctx.beginPath();
        ctx.arc(botaoGirar.x, botaoGirar.y, botaoGirar.raio, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#1b2a1c";
        ctx.stroke();
        ctx.fillStyle = "#1b2a1c";
        ctx.font = "bold 15px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("↻", botaoGirar.x, botaoGirar.y + 1);
      }
    }
  }

  // Caixinha branca com o nome; devolve onde ficou
  function etiqueta(ctx, texto, x, y, cor) {
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(texto).width + 12;
    const h = 22;
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = cor;
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    ctx.fillStyle = "#1b2a1c";
    ctx.fillText(texto, x, y);
    return { x: x - w / 2, y: y - h / 2, w, h };
  }

  // ---------- Tocar, arrastar, girar ----------
  // t: ponto em metros no terreno; p: ponto em pixels.
  // Devolve: um "arraste" { mover(t), soltar() }, true (toque usado) ou null (não era planta)
  function tocar(t, p) {
    if (!mapa || !terreno) return null;
    if (botaoGirar && Math.hypot(p.x - botaoGirar.x, p.y - botaoGirar.y) <= botaoGirar.raio + 6) {
      girar(selecionada);
      return true;
    }
    let id = null;
    const caixa = [...caixasNomes].reverse().find((c) => p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h);
    if (caixa) id = caixa.id;
    if (!id) {
      id = Object.keys(escolhidas).reverse().find((k) => {
        const r = posicoes[k];
        return r && t.x >= r.x && t.x <= r.x + r.w && t.y >= r.y && t.y <= r.y + r.h;
      }) || null;
    }
    if (!id) {
      if (selecionada) { selecionada = null; mostrarLista(); aoMudar({}); }
      return null;
    }
    selecionada = id;
    const r = posicoes[id];
    arraste = { id, dx: t.x - r.x, dy: t.y - r.y, candidato: { ...r }, valido: true, motivo: null, ultimoValido: { ...r }, moveu: false };
    mostrarLista();
    aoMudar({});
    return {
      mover(t2) {
        if (!t2) return;
        const c = { ...encaixar({ x: t2.x - arraste.dx, y: t2.y - arraste.dy, w: r.w, h: r.h }, mapa.passo), girada: r.girada };
        const v = valido(c);
        arraste.candidato = c;
        arraste.valido = v.ok;
        arraste.motivo = v.motivo;
        arraste.moveu = true;
        if (v.ok) arraste.ultimoValido = c;
        aoMudar({});
      },
      soltar() {
        // Num lugar que não vale, volta para o último lugar válido
        if (arraste.moveu) posicoes[arraste.id] = arraste.valido ? arraste.candidato : arraste.ultimoValido;
        arraste = null;
        mostrarLista();
        aoMudar({ salvar: true });
      }
    };
  }

  // Gira 90° em volta do centro; se não couber, tenta um pouco para os lados
  function girar(id) {
    const r = posicoes[id];
    if (!r) return;
    const t = tamanho(id, !r.girada);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const base = encaixar({ x: cx - t.w / 2, y: cy - t.h / 2, ...t }, mapa.passo);
    for (let d = 0; d <= 8; d++) {
      for (const [dx, dy] of d === 0 ? [[0, 0]] : [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) {
        const c = { ...base, x: base.x + dx * mapa.passo, y: base.y + dy * mapa.passo, girada: !r.girada };
        if (valido(c).ok) {
          posicoes[id] = c;
          mostrarLista();
          aoMudar({ salvar: true });
          return;
        }
      }
    }
  }

  // ---------- Lista ao lado ----------
  function mostrarLista() {
    const ids = CULTURAS.filter((c) => c.id in escolhidas).map((c) => c.id);
    vazio.hidden = ids.length > 0;
    lista.replaceChildren(...ids.map((id) => {
      const cultura = culturaDe(id);
      const r = posicoes[id];
      const li = document.createElement("li");
      li.className = id === selecionada ? "ativo" : "";
      const cor = document.createElement("span");
      cor.className = "planejar-cor";
      cor.style.background = cultura.cor;
      const texto = document.createElement("span");
      if (!mapa || !r) {
        texto.textContent = mapa ? `Não há lugar livre para ${cultura.nome.toLowerCase()} neste terreno.` : cultura.nome;
      } else {
        const celulas = celulasDe(r);
        const horas = celulas.reduce((s, i) => s + mapa.horas[i], 0) / (celulas.length || 1);
        texto.textContent = `${cultura.nome}: ${descreverLugar(celulas, mapa, terreno)}, ~${numero(Math.round(horas * 2) / 2)} h de sol.`;
      }
      li.append(cor, texto);
      li.addEventListener("click", () => { selecionada = id; mostrarLista(); aoMudar({}); });
      return li;
    }));
  }

  return {
    atualizar,
    desenhar,
    tocar,
    obterPosicoes: () => posicoes,
    definirPosicoes: (novas) => { posicoes = novas && typeof novas === "object" ? { ...novas } : {}; selecionada = null; }
  };
}
