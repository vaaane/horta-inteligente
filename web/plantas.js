// Canteiros das plantas no "Planeje sua horta" — arrastar e girar
// Vale para os dois modos (Sobre o mapa e Desenho livre): cada modo só
// informa como converter "metros no terreno" em pixels na tela.
//
// Cada planta escolhida vira um retângulo alinhado à grade do terreno
// (x, y, w, h em metros; x para a direita, y para baixo), com a área escolhida.
// O canteiro tem a COR DA PLANTA (a mesma da lista). Se o lugar é bom, pelas
// horas de sol (culturas.js), aparece num selo no canto: ✓ Recomendado,
// ! Aceitável (e a borda tracejada), ✕ Não recomendado.
// O rótulo é o nome; sem espaço (canteiro pequeno, mapa estreito ou outro
// rótulo no lugar), vira o número da planta na lista "Onde plantar".
import {
  CULTURAS, NECESSIDADE, NIVEIS, avaliarRegiao, textoAvaliacao, tamanhoDoCanteiro, encaixar, validarCanteiro,
  melhorPosicao, sugerirCanteiros, descreverLugar
} from "./culturas.js";

const culturaDe = (id) => CULTURAS.find((c) => c.id === id);
const numero = (v, casas = 1) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas });
const MOTIVOS = { fora: "Aqui não dá: fora do terreno", obstaculo: "Aqui não dá: obstáculo" };

const VIZINHAS_M = 0.5;  // canteiros a menos de 0,5 m um do outro são vizinhos
const MAPA_ESTREITO_PX = 500;  // desenho mais estreito que isso: só números nos canteiros
const CANTEIRO_MINUSCULO_PX = 24; // canteiro menor que isso na tela (terreno grande): alfinete com o número

// Duas caixas (x, y, w, h) se encostam?
const baterem = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Selo da avaliação: bolinha com ✓ ! ✕ na cor do nível (também na planta salva, planta.js)
export function desenharSelo(ctx, x, y, raio, nivelId) {
  const nivel = NIVEIS[nivelId];
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, raio, 0, Math.PI * 2);
  ctx.fillStyle = nivel.cor;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, raio * 0.2);
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.fillStyle = nivelId === "aceitavel" ? "#1b2a1c" : "#ffffff";
  ctx.font = `bold ${Math.round(raio * 1.25)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(nivel.icone, x, y + raio * 0.08);
  ctx.restore();
}

// Ordem das plantas (a mesma da lista "Onde plantar"): o número de cada uma
export const ordemDasPlantas = (escolhidas) => CULTURAS.filter((c) => c.id in escolhidas).map((c) => c.id);

// Os dois canteiros se sobrepõem (por dentro, não só encostando)?
function sobrepoe(a, b) {
  const sx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const sy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return sx > 1e-6 && sy > 1e-6;
}
// Distância entre as bordas de dois canteiros (0 se encostam)
function distancia(a, b) {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(dx, dy);
}
// Faixas de umidade sem nenhuma parte em comum. Encostar só na borda
// (70–90% e 50–70% se tocam em 70) também não dá uma faixa boa para as duas.
const regaIncompativel = (u1, u2) => u1[1] <= u2[0] || u2[1] <= u1[0];

// Convivência entre os canteiros { tomate: {x, y, w, h}, ... }:
// pares no mesmo lugar (sobreposição) e vizinhos com rega diferente.
// Também usada na planta para imprimir (planta.js).
export function convivenciaEntre(atuais) {
  const ids = Object.keys(atuais).filter((id) => atuais[id]);
  const sobrepostas = new Set();
  const pares = [];  // { tipo: "sobreposicao" | "rega", a: id, b: id }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [culturaDe(ids[i]), culturaDe(ids[j])];
      const [ra, rb] = [atuais[ids[i]], atuais[ids[j]]];
      if (sobrepoe(ra, rb)) {
        sobrepostas.add(ids[i]);
        sobrepostas.add(ids[j]);
        pares.push({ tipo: "sobreposicao", a: ids[i], b: ids[j] });
      } else if (distancia(ra, rb) < VIZINHAS_M && regaIncompativel(a.umidade, b.umidade)) {
        pares.push({ tipo: "rega", a: ids[i], b: ids[j] });
      }
    }
  }
  return { sobrepostas, pares };
}

export function iniciarPlantas({ lista, vazio, avisos, resumo, botaoSugerir, botaoVoltar, filtro, filtroNota, aoMudar, aoTocarNaLista = () => {} }) {
  let filtroId = "";        // "Mostrar só as áreas boas para…" (id da planta, ou "")
  let mapa = null;          // horas de sol (sol.js)
  let terreno = null;       // terreno do cálculo
  let escolhidas = {};      // { tomate: 0.5 } (área em m²)
  let anoTodo = false;      // as horas são do pior mês?
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
  // Avaliação de um lugar para a planta (com as horas de sol já calculadas)
  const avaliar = (id, r) => avaliarRegiao(celulasDe(r).map((i) => mapa.horas[i]), culturaDe(id));

  // ---------- Depois de cada cálculo do mapa de sol (ou quando mudam as plantas) ----------
  function atualizar(novoMapa, novoTerreno, novasEscolhidas, novoAnoTodo = false) {
    mapa = novoMapa;
    terreno = novoTerreno;
    escolhidas = novasEscolhidas;
    anoTodo = novoAnoTodo;
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

  // Lugar atual de cada planta (durante o arraste, o lugar para onde está indo)
  function lugares() {
    const saida = {};
    for (const id of Object.keys(escolhidas)) {
      const r = arraste && arraste.id === id ? (arraste.valido ? arraste.candidato : null) : posicoes[id];
      if (r) saida[id] = r;
    }
    return saida;
  }

  // ---------- Convivência: sobreposição e rega ----------
  function convivencia() {
    const { sobrepostas, pares } = convivenciaEntre(lugares());
    const mensagens = pares.map(({ tipo, a: idA, b: idB }) => {
      const [a, b] = [culturaDe(idA), culturaDe(idB)];
      if (tipo === "sobreposicao") return { tipo, texto: `${a.nome} e ${b.nome} estão no mesmo lugar.` };
      // Só uma dica: não muda a cor da avaliação de sol
      return {
        tipo,
        texto: `${a.nome} (${a.umidade[0]}–${a.umidade[1]}%) ao lado de ${b.nome} (${b.umidade[0]}–${b.umidade[1]}%): ` +
          "precisam de rega diferente. Numa zona de rega só, uma delas vai sofrer."
      };
    });
    return { sobrepostas, mensagens };
  }

  // ---------- Desenho (o mesmo nos dois modos) ----------
  // pt(x, y): metros no terreno -> pixel na tela
  let balaoDepois = null;   // o balão é desenhado por último (por cima de tudo)
  function desenhar(ctx, pt) {
    caixasNomes = [];
    botaoGirar = null;
    balaoDepois = null;
    if (!mapa || !terreno) return;
    const { sobrepostas } = convivencia();
    const estreito = (ctx.canvas.clientWidth || 2000) < MAPA_ESTREITO_PX;
    const ordem = ordemDasPlantas(escolhidas);
    const rotulos = [];
    for (const id of ordem) {
      const emArraste = arraste && arraste.id === id;
      const r = emArraste ? arraste.candidato : posicoes[id];
      if (!r) continue;
      const cultura = culturaDe(id);
      const cantos = [pt(r.x, r.y), pt(r.x + r.w, r.y), pt(r.x + r.w, r.y + r.h), pt(r.x, r.y + r.h)];
      ctx.beginPath();
      cantos.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      const invalido = emArraste && !arraste.valido;
      const nivelId = invalido ? null : avaliar(id, r).nivel;
      // Cor da planta; sobreposta a outra planta: contorno vermelho tracejado
      const cor = invalido ? "#616161" : sobrepostas.has(id) ? "#c62828" : cultura.cor;
      ctx.save();
      ctx.globalAlpha = invalido ? 0.3 : 0.45;       // preenchimento semitransparente
      ctx.fillStyle = invalido ? "#9e9e9e" : cultura.cor;
      ctx.fill();
      ctx.globalAlpha = 1;
      // Borda branca por baixo: o canteiro aparece sobre qualquer cor do mapa de sol
      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.stroke();
      ctx.lineWidth = id === selecionada || emArraste || sobrepostas.has(id) ? 4 : 3;
      ctx.strokeStyle = cor;
      if (invalido) ctx.setLineDash([6, 4]);        // cinza tracejado: aqui não dá
      else if (sobrepostas.has(id)) ctx.setLineDash([10, 4]);
      else if (nivelId === "aceitavel") ctx.setLineDash([8, 5]);  // aceitável: não depende só da cor
      ctx.stroke();
      ctx.restore();

      const xs = cantos.map((p) => p.x);
      const ys = cantos.map((p) => p.y);
      const caixa = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const lado = Math.min(Math.hypot(cantos[1].x - cantos[0].x, cantos[1].y - cantos[0].y),
        Math.hypot(cantos[2].x - cantos[1].x, cantos[2].y - cantos[1].y));
      const comprido = Math.max(Math.hypot(cantos[1].x - cantos[0].x, cantos[1].y - cantos[0].y),
        Math.hypot(cantos[2].x - cantos[1].x, cantos[2].y - cantos[1].y));
      rotulos.push({ id, nome: invalido ? `${cultura.nome} · ${MOTIVOS[arraste.motivo]}` : cultura.nome, numero: ordem.indexOf(id) + 1,
        cor, meio: pt(r.x + r.w / 2, r.y + r.h / 2), lado, comprido, caixa, nivelId, canto: cantos[0], forcarNome: invalido });

      // Balão com a avaliação: durante o arraste e na planta tocada
      if (emArraste || id === selecionada) {
        const balao = invalido ? MOTIVOS[arraste.motivo] : textoAvaliacao(cultura, avaliar(id, r)) + (anoTodo ? " (pior mês)" : "");
        balaoDepois = { texto: balao, x: (caixa.x + caixa.x + caixa.w) / 2, topo: caixa.y, base: caixa.y + caixa.h, cor };
      }

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
    colocarRotulos(ctx, rotulos, estreito);
    if (balaoDepois) desenharBalao(ctx, balaoDepois);
  }

  // Rótulo de cada canteiro, dentro dele: o nome se couber e não bater em
  // outro rótulo; senão, o número (o mesmo da lista "Onde plantar").
  // E o selo da avaliação no canto.
  let selosNoDesenho = [];   // onde ficaram os selos (os rótulos dos obstáculos desviam deles também)
  function colocarRotulos(ctx, rotulos, estreito) {
    ctx.font = "bold 13px system-ui, sans-serif";
    const ocupadas = [];
    selosNoDesenho = [];
    for (const n of rotulos) {
      const larguraNome = ctx.measureText(n.nome).width + 12;
      const caixaNome = { x: n.meio.x - larguraNome / 2, y: n.meio.y - 11, w: larguraNome, h: 22 };
      const cabeNome = n.forcarNome || (!estreito && n.comprido >= larguraNome + 4 && n.lado >= 26);
      let caixa;
      let ondeSelo = { x: n.canto.x, y: n.canto.y, raio: n.lado < 30 ? 7 : 9 };
      if (n.comprido < CANTEIRO_MINUSCULO_PX && !n.forcarNome) {
        // Canteiro minúsculo (terreno grande no Mapa): alfinete com o número e a cor da planta;
        // o selo fica ao lado da cabeça do alfinete, nunca em cima do número
        const pino = alfinete(ctx, n.numero, n.meio.x, n.meio.y, n.cor, ocupadas);
        caixa = pino.caixa;
        ondeSelo = { x: pino.cabeca.x + 13, y: pino.cabeca.y - 10, raio: 7 };
      } else if (cabeNome && (n.forcarNome || !ocupadas.some((o) => baterem(caixaNome, o)))) {
        caixa = etiqueta(ctx, n.nome, n.meio.x, n.meio.y, n.cor);
      } else {
        // O número fica no meio do canteiro; se ali já tem outro rótulo, ao lado (com uma linha)
        const raio = 11;
        const { x, y, w, h } = n.caixa;
        const lugares = [[n.meio.x, n.meio.y], [x + w + raio + 4, n.meio.y], [x - raio - 4, n.meio.y],
          [n.meio.x, y - raio - 4], [n.meio.x, y + h + raio + 4], [x + w + raio + 4, y - raio - 4], [x - raio - 4, y + h + raio + 4]];
        const livre = lugares.find(([cx, cy]) => !ocupadas.some((o) => baterem({ x: cx - raio, y: cy - raio, w: 2 * raio, h: 2 * raio }, o))) || lugares[0];
        if (livre !== lugares[0]) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(n.meio.x, n.meio.y);
          ctx.lineTo(livre[0], livre[1]);
          ctx.lineWidth = 2;
          ctx.strokeStyle = n.cor;
          ctx.stroke();
          ctx.restore();
        }
        caixa = numeroNoCanteiro(ctx, n.numero, livre[0], livre[1], n.cor);
      }
      ocupadas.push(caixa);
      caixasNomes.push({ id: n.id, ...caixa });
      if (n.nivelId) {
        const { x, y, raio } = ondeSelo;
        desenharSelo(ctx, x, y, raio, n.nivelId);
        selosNoDesenho.push({ x: x - raio, y: y - raio, w: 2 * raio, h: 2 * raio });
      }
    }
  }

  // Alfinete: a ponta no canteiro, a cabeça (com o número) em cima. Se a cabeça
  // bater em outro rótulo, vai um pouco para o lado.
  function alfinete(ctx, numero, x, y, cor, ocupadas) {
    const raio = 11;
    const lugares = [0, 26, -26, 52, -52].map((dx) => ({ x: x + dx, y: y - 22 }));
    const cabeca = lugares.find((c) => !ocupadas.some((o) => baterem({ x: c.x - raio, y: c.y - raio, w: 2 * raio, h: 2 * raio }, o))) || lugares[0];
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(cabeca.x - 5, cabeca.y + 6);
    ctx.lineTo(cabeca.x + 5, cabeca.y + 6);
    ctx.closePath();
    ctx.fillStyle = cor;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cabeca.x, cabeca.y, raio, 0, Math.PI * 2);
    ctx.fillStyle = cor;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(numero), cabeca.x, cabeca.y + 0.5);
    ctx.restore();
    return { cabeca, caixa: { x: cabeca.x - raio, y: cabeca.y - raio, w: 2 * raio, h: 2 * raio + 12 } };
  }

  // Bolinha branca com o número da planta
  function numeroNoCanteiro(ctx, numero, x, y, cor) {
    const raio = 11;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, raio, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = cor;
    ctx.stroke();
    ctx.fillStyle = "#1b2a1c";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(numero), x, y + 0.5);
    ctx.restore();
    return { x: x - raio, y: y - raio, w: raio * 2, h: raio * 2 };
  }

  // Balão de texto colado à região (em cima; se não couber, embaixo)
  function desenharBalao(ctx, { texto, x, topo, base, cor }) {
    const larguraTela = ctx.canvas.clientWidth || 600;
    ctx.font = "600 13px system-ui, sans-serif";
    const maxLargura = Math.min(280, larguraTela - 16);
    // Quebra o texto em linhas que caibam na largura
    const linhas = [];
    let linha = "";
    for (const palavra of texto.split(" ")) {
      const teste = linha ? `${linha} ${palavra}` : palavra;
      if (ctx.measureText(teste).width > maxLargura - 16 && linha) { linhas.push(linha); linha = palavra; } else linha = teste;
    }
    if (linha) linhas.push(linha);
    const w = Math.max(...linhas.map((l) => ctx.measureText(l).width)) + 16;
    const h = linhas.length * 17 + 12;
    let bx = Math.min(Math.max(x - w / 2, 8), larguraTela - w - 8);
    let by = topo - h - 30;
    if (by < 4) by = base + 30;  // sem espaço em cima: vai para baixo
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.97)";
    ctx.strokeStyle = cor;
    ctx.lineWidth = 2;
    ctx.fillRect(bx, by, w, h);
    ctx.strokeRect(bx, by, w, h);
    ctx.fillStyle = "#1b2a1c";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    linhas.forEach((l, i) => ctx.fillText(l, bx + 8, by + 7 + i * 17));
    ctx.restore();
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
  // Nenhum quadradinho livre fica dentro da meia-sombra (todo o terreno passa de 6 h)?
  function semSombra() {
    if (!mapa) return false;
    const max = NECESSIDADE.meia.maximo;
    const querMeia = Object.keys(escolhidas).some((id) => culturaDe(id)?.sol === "meia");
    if (!querMeia) return false;
    for (let i = 0; i < mapa.horas.length; i++) if (!mapa.ocupado[i] && mapa.horas[i] <= max) return false;
    return true;
  }

  function mostrarAvisos() {
    const { mensagens } = convivencia();
    if (semSombra()) {
      mensagens.push({ tipo: "rega", texto: "Seu terreno não tem sombra: plantas de meia-sombra vão receber sol demais. " +
        "Uma árvore, muro ou tela de sombreamento ajudaria.", icone: "☀️" });
    }
    avisos.replaceChildren(...mensagens.map((m) => {
      const li = document.createElement("li");
      li.className = `planejar-aviso-${m.tipo}`;
      li.textContent = `${m.icone || (m.tipo === "sobreposicao" ? "✕" : "💧")} ${m.texto}`;
      return li;
    }));
    avisos.hidden = mensagens.length === 0;
  }

  // "3 plantas recomendadas, 1 aceitável, 1 não recomendada."
  function mostrarResumo(ids) {
    const conta = { recomendado: 0, aceitavel: 0, nao: 0 };
    for (const id of ids) if (mapa && posicoes[id]) conta[avaliar(id, posicoes[id]).nivel]++;
    const partes = [];
    const total = conta.recomendado + conta.aceitavel + conta.nao;
    if (conta.recomendado) partes.push(`${conta.recomendado} ${conta.recomendado > 1 ? "recomendadas" : "recomendada"}`);
    if (conta.aceitavel) partes.push(`${conta.aceitavel} ${conta.aceitavel > 1 ? "aceitáveis" : "aceitável"}`);
    if (conta.nao) partes.push(`${conta.nao} ${conta.nao > 1 ? "não recomendadas" : "não recomendada"}`);
    // "planta"/"plantas" vai junto do primeiro número
    if (partes.length) partes[0] = partes[0].replace(/^(\d+) /, (_, n) => `${n} ${Number(n) > 1 ? "plantas" : "planta"} `);
    resumo.textContent = partes.length ? `${partes.join(", ")}.` : "";
    resumo.hidden = total === 0;
  }

  // Botões e o filtro "Mostrar só as áreas boas para…"
  function mostrarControles(ids) {
    const sugestao = selecionada ? sugestoes[selecionada] : null;
    const atual = selecionada ? posicoes[selecionada] : null;
    const igual = sugestao && atual && sugestao.x === atual.x && sugestao.y === atual.y && sugestao.w === atual.w;
    botaoVoltar.disabled = !sugestao || igual;
    botaoVoltar.textContent = selecionada ? `↩ Voltar à sugestão (${culturaDe(selecionada).nome})` : "↩ Voltar à sugestão";
    botaoSugerir.disabled = ids.length === 0 || !mapa;
    if (filtroId && !ids.includes(filtroId)) filtroId = "";
    filtro.replaceChildren(new Option("(mapa de sol normal)", ""),
      ...ids.map((id) => new Option(culturaDe(id).nome, id, false, id === filtroId)));
    filtro.value = filtroId;
    const c = filtroId ? culturaDe(filtroId) : null;
    filtroNota.hidden = !c;
    if (c) filtroNota.textContent = `No mapa: verde = bom para ${c.nome.toLowerCase()} (${NECESSIDADE[c.sol].texto}); cinza = não recomendado.`;
  }

  botaoSugerir.addEventListener("click", () => {
    for (const id of Object.keys(escolhidas)) if (sugestoes[id]) posicoes[id] = { ...sugestoes[id] };
    selecionada = null;
    mostrarLista();
    aoMudar({ salvar: true });
  });
  botaoVoltar.addEventListener("click", () => {
    if (!selecionada || !sugestoes[selecionada]) return;
    posicoes[selecionada] = { ...sugestoes[selecionada] };
    mostrarLista();
    aoMudar({ salvar: true });
  });
  filtro.addEventListener("change", () => {
    filtroId = filtro.value;
    mostrarControles(CULTURAS.filter((c) => c.id in escolhidas).map((c) => c.id));
    aoMudar({});
  });

  // Meio em meio: "~6,5 h"
  const horas = (h) => numero(Math.round(h * 2) / 2);

  // "~6,5 h · canto noroeste" e, quando não é recomendado, o porquê
  // (com minimo, maior, media, falta e excesso de avaliarRegiao):
  //   sol demais na média:   "sol demais: ~12 h, o ideal é até 6 h"
  //   sol demais só em parte: "~5 h em média, mas parte do canteiro passa de 6 h"
  //   falta sol:             "falta ~1,5 h: ~4,5 h, precisa de 6 h"
  //   parte com pouco sol:   "~6,5 h em média, mas parte do canteiro fica abaixo de 6 h"
  function infoDoLugar(id, r, av) {
    const cultura = culturaDe(id);
    const { minimo: min, maximo: max } = NECESSIDADE[cultura.sol];
    const pior = anoTodo ? " no pior mês" : "";
    let sol;
    if (av.nivel === "recomendado") sol = `~${horas(av.media)} h${pior}`;
    else if (av.excesso > 0) sol = `sol demais: ~${horas(av.media)} h${pior}, o ideal é até ${max} h`;
    else if (max !== null && av.maior > max) sol = `~${horas(av.media)} h em média${pior}, mas parte do canteiro passa de ${max} h`;
    else if (av.falta > 0) sol = `falta ~${horas(Math.max(av.falta, 0.5))} h: ~${horas(av.media)} h${pior}, precisa de ${min} h`;
    else if (av.minimo < min) sol = `~${horas(av.media)} h em média${pior}, mas parte do canteiro fica abaixo de ${min} h`;
    else sol = `~${horas(av.media)} h${pior}`;
    let texto = `${sol} · ${descreverLugar(celulasDe(r), mapa, terreno)}`;
    // Nem o melhor lugar serve? Diz quanto ele tem
    const melhor = sugestoes[id];
    if (av.nivel === "nao" && (!melhor || avaliar(id, melhor).nivel === "nao")) {
      texto += ` · o melhor lugar do terreno tem ~${horas(melhor ? avaliar(id, melhor).media : 0)} h (tente tirar ou baixar um obstáculo)`;
    }
    return texto;
  }

  // Uma linha por planta: número, cor, nome, horas e lugar, selo no fim
  function mostrarLista() {
    mostrarAvisos();
    const ids = ordemDasPlantas(escolhidas);
    mostrarResumo(ids);
    mostrarControles(ids);
    vazio.hidden = ids.length > 0;
    lista.replaceChildren(...ids.map((id, i) => {
      const cultura = culturaDe(id);
      const r = posicoes[id];
      const li = document.createElement("li");
      li.className = id === selecionada ? "ativo" : "";
      const num = document.createElement("span");
      num.className = "planejar-num";
      num.textContent = String(i + 1);
      num.style.borderColor = cultura.cor;
      const cor = document.createElement("span");
      cor.className = "planejar-cor";
      cor.style.background = cultura.cor;
      const texto = document.createElement("span");
      texto.className = "planejar-sugestao-texto";
      const nome = document.createElement("strong");
      nome.textContent = cultura.nome;
      const info = document.createElement("span");
      info.className = "planejar-sugestao-info";
      texto.append(nome, " ", info);
      li.append(num, cor, texto);
      if (!mapa || !r) {
        info.textContent = mapa ? "não há lugar livre para ela neste terreno" : "";
      } else {
        const av = avaliar(id, r);
        info.textContent = infoDoLugar(id, r, av);
        const selo = document.createElement("span");
        selo.className = `planejar-selo-avaliacao nivel-${av.nivel}`;
        selo.textContent = `${NIVEIS[av.nivel].icone} ${NIVEIS[av.nivel].texto}`;
        li.append(selo);
      }
      // Tocar na linha destaca o canteiro (e o traz para a tela no Mapa); tocar no canteiro destaca a linha
      li.addEventListener("click", () => { selecionada = id; mostrarLista(); aoMudar({}); aoTocarNaLista(id); });
      return li;
    }));
  }

  return {
    atualizar,
    desenhar,
    tocar,
    obterPosicoes: () => posicoes,
    // Onde ficaram os rótulos das plantas no último desenho (os dos obstáculos desviam deles)
    caixasOcupadas: () => [...caixasNomes.map(({ x, y, w, h }) => ({ x, y, w, h })), ...selosNoDesenho],
    // Planta do filtro "Mostrar só as áreas boas para…" (ou null)
    filtroCultura: () => (filtroId ? culturaDe(filtroId) : null),
    definirPosicoes: (novas) => { posicoes = novas && typeof novas === "object" ? { ...novas } : {}; selecionada = null; }
  };
}
