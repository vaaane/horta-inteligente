// "Planta da horta": um desenho limpo do projeto, para salvar ou imprimir.
// Não usa a imagem de satélite: só o terreno, os obstáculos, as horas de sol
// e as plantas, com o NORTE SEMPRE PARA CIMA.
//
// O projeto que chega aqui:
//   {
//     titulo: "Minha horta",
//     terreno,        // no formato do sol.js (largura, comprimento, norte, latitude, longitude, obstaculos)
//     mapa,           // resultado de calcularHorasDeSol (ou null, se ainda não calculou)
//     escolhidas,     // { tomate: 0.5 } (área em m²)
//     posicoes,       // { tomate: { x, y, w, h } } (canteiros, em metros no terreno)
//     anoTodo,        // true = pior caso dos 12 meses
//     data            // "AAAA-MM-DD" (dia do cálculo)
//   }
//
// Como girar: no terreno, o norte aponta "norte" graus (sentido do relógio a
// partir do topo). Girando o desenho todo "norte" graus para o outro lado,
// o norte fica para cima.
import { classificar, SOMBRA, MEIA_SOMBRA, PLENO_SOL } from "./sol.js";
import { CULTURAS, NECESSIDADE, NIVEIS, avaliarRegiao, validarCanteiro } from "./culturas.js";
import { convivenciaEntre, desenharSelo, ordemDasPlantas } from "./plantas.js";

export const CORES_SOL = { [SOMBRA]: "#253b6e", [MEIA_SOMBRA]: "#6fa8dc", [PLENO_SOL]: "#f4c430" };
export const LEGENDA_SOL = [
  { classe: SOMBRA, texto: "Sombra (menos de 3 h)" },
  { classe: MEIA_SOMBRA, texto: "Meia-sombra (3 a 6 h)" },
  { classe: PLENO_SOL, texto: "Pleno sol (6 h ou mais)" }
];
export const RODAPE = "Horta Inteligente · CED São Bartolomeu · horta-inteligente.vaane-lucena.workers.dev";

const culturaDe = (id) => CULTURAS.find((c) => c.id === id);
const numero = (v, casas = 1) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas });
const FONTE = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// ---------- Avaliação de cada planta (serve para o desenho e para a tabela) ----------
// Devolve uma linha por planta: cultura, área, canteiro, avaliação e observações.
export function avaliarPlantas(projeto) {
  const { mapa, terreno, escolhidas = {}, posicoes = {} } = projeto;
  const atuais = {};
  for (const id of Object.keys(escolhidas)) if (posicoes[id]) atuais[id] = posicoes[id];
  const { sobrepostas, pares } = convivenciaEntre(atuais);

  return CULTURAS.filter((c) => c.id in escolhidas).map((cultura) => {
    const id = cultura.id;
    const r = atuais[id] || null;
    let av = null;
    if (r && mapa && terreno) {
      const { celulas } = validarCanteiro(mapa, terreno, r);
      av = avaliarRegiao(celulas.map((i) => mapa.horas[i]), cultura);
    }
    // Observações: quem está no mesmo lugar, quem precisa de rega diferente ao lado
    const notas = [];
    for (const p of pares) {
      if (p.a !== id && p.b !== id) continue;
      const outra = culturaDe(p.a === id ? p.b : p.a).nome;
      notas.push(p.tipo === "sobreposicao" ? `no mesmo lugar que ${outra}` : `rega diferente da ${outra} ao lado`);
    }
    if (!r) notas.push("sem lugar livre no terreno");
    return { id, cultura, area: escolhidas[id], r, av, sobreposta: sobrepostas.has(id), notas };
  });
}

// ---------- Padrões para imprimir em preto e branco ----------
// sombra = hachurada, meia-sombra = pontilhada, pleno sol = lisa
function padraoDe(ctx, classe) {
  if (classe === PLENO_SOL) return null;
  const tile = document.createElement("canvas");
  tile.width = tile.height = 10;
  const t = tile.getContext("2d");
  if (classe === SOMBRA) {
    t.strokeStyle = "rgba(255, 255, 255, 0.6)";
    t.lineWidth = 1.6;
    t.beginPath();
    // Diagonais que continuam de um ladrilho para o outro
    t.moveTo(0, 10); t.lineTo(10, 0);
    t.moveTo(-5, 5); t.lineTo(5, -5);
    t.moveTo(5, 15); t.lineTo(15, 5);
    t.stroke();
  } else {
    t.fillStyle = "rgba(0, 0, 0, 0.45)";
    t.beginPath();
    t.arc(5, 5, 1.4, 0, Math.PI * 2);
    t.fill();
  }
  return ctx.createPattern(tile, "repeat");
}

// Pinta uma forma com a cor da classe de sol e, por cima, o padrão
function pintarClasse(ctx, classe, caminho) {
  ctx.fillStyle = CORES_SOL[classe];
  caminho();
  ctx.fill();
  const padrao = padraoDe(ctx, classe);
  if (padrao) {
    ctx.fillStyle = padrao;
    caminho();
    ctx.fill();
  }
}

// ---------- Ajudantes de desenho ----------
function poligono(ctx, pontos) {
  ctx.beginPath();
  pontos.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

// O ponto está dentro do polígono convexo? (os cantos vêm em ordem)
function dentroDoPoligono(p, pontos) {
  let sinal = 0;
  for (let i = 0; i < pontos.length; i++) {
    const a = pontos[i];
    const b = pontos[(i + 1) % pontos.length];
    const cruz = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cruz) < 1e-9) continue;
    if (sinal === 0) sinal = Math.sign(cruz);
    else if (Math.sign(cruz) !== sinal) return false;
  }
  return true;
}

const baterem = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Etiqueta com fundo branco e borda colorida; devolve a caixa ocupada
function etiqueta(ctx, texto, x, y, cor, tamanho) {
  ctx.font = `bold ${tamanho}px ${FONTE}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(texto).width + tamanho * 0.8;
  const h = tamanho * 1.5;
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.fillRect(x - w / 2, y - h / 2, w, h);
  ctx.lineWidth = tamanho * 0.13;
  ctx.strokeStyle = cor;
  ctx.strokeRect(x - w / 2, y - h / 2, w, h);
  ctx.fillStyle = "#1b2a1c";
  ctx.fillText(texto, x, y + tamanho * 0.05);
}

// Data "AAAA-MM-DD" -> "21/06/2026"
const dataBR = (texto) => (texto ? texto.split("-").reverse().join("/") : "");

// ---------- A planta ----------
// Desenha no canvas e devolve o próprio canvas.
// ladoMaior: tamanho em pixels do lado maior da imagem (2400 = boa para imprimir).
export function desenharPlanta(canvas, projeto, { ladoMaior = 2400 } = {}) {
  const { terreno, mapa, anoTodo, data } = projeto;
  const titulo = (projeto.titulo || "Minha horta").trim() || "Minha horta";
  const L = terreno.largura;
  const C = terreno.comprimento;

  // Tudo é desenhado numa folha de 1000 "unidades" de largura; no fim a
  // folha é ampliada para o tamanho pedido (ladoMaior).
  const W = 1000;
  const MARGEM = 40;
  const TOPO_DESENHO = 185;   // abaixo do cabeçalho
  const FOLGA = 105;          // espaço em volta do terreno: medidas, nomes de fora, rosa, escala

  // Giro para o norte ficar para cima
  const giro = (-(terreno.norte || 0) * Math.PI) / 180;
  const cos = Math.cos(giro);
  const sin = Math.sin(giro);
  // Metros no terreno -> "folha" antes de escalar e mover (centro do terreno em 0, 0)
  const girar = (x, y) => {
    const dx = x - L / 2;
    const dy = y - C / 2;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  };

  // Cantos de cada obstáculo (círculo: a caixa em volta dele), em metros
  const cantosObstaculo = (ob) => {
    if (ob.tipo === "circulo") {
      return [[ob.x - ob.raio, ob.y - ob.raio], [ob.x + ob.raio, ob.y - ob.raio], [ob.x + ob.raio, ob.y + ob.raio], [ob.x - ob.raio, ob.y + ob.raio]];
    }
    const cx = ob.x + ob.largura / 2;
    const cy = ob.y + ob.profundidade / 2;
    const a = ((ob.angulo || 0) * Math.PI) / 180;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const ox = (sx * ob.largura) / 2;
      const oy = (sy * ob.profundidade) / 2;
      return [cx + ox * Math.cos(a) - oy * Math.sin(a), cy + ox * Math.sin(a) + oy * Math.cos(a)];
    });
  };

  // Caixa que envolve o terreno (e os obstáculos, que podem ficar fora dele) já girados
  const pontosTodos = [[0, 0], [L, 0], [L, C], [0, C]];
  for (const ob of terreno.obstaculos || []) pontosTodos.push(...cantosObstaculo(ob));
  const girados = pontosTodos.map(([x, y]) => girar(x, y));
  const minX = Math.min(...girados.map((p) => p.x));
  const maxX = Math.max(...girados.map((p) => p.x));
  const minY = Math.min(...girados.map((p) => p.y));
  const maxY = Math.max(...girados.map((p) => p.y));

  // Escala (unidades de folha por metro): cabe na largura, sem ficar alto demais
  const larguraUtil = W - 2 * MARGEM - 2 * FOLGA;
  const ALTURA_MAX = 950;
  let s = larguraUtil / Math.max(maxX - minX, 0.1);
  if ((maxY - minY) * s > ALTURA_MAX) s = ALTURA_MAX / (maxY - minY);
  const alturaDesenho = Math.max((maxY - minY) * s + 2 * FOLGA, 300);
  const baseDesenho = TOPO_DESENHO + alturaDesenho;
  const centro = { x: W / 2 - ((minX + maxX) / 2) * s, y: TOPO_DESENHO + alturaDesenho / 2 - ((minY + maxY) / 2) * s };
  // Metros no terreno -> ponto na folha
  const pt = (x, y) => {
    const g = girar(x, y);
    return { x: centro.x + g.x * s, y: centro.y + g.y * s };
  };

  const TOPO_LEGENDA = baseDesenho + 20;
  const H = Math.round(TOPO_LEGENDA + 110 + 60);

  // Tamanho final do canvas
  const k = ladoMaior / Math.max(W, H);
  canvas.width = Math.round(W * k);
  canvas.height = Math.round(H * k);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = "round";

  // ---------- Cabeçalho ----------
  ctx.fillStyle = "#1b2a1c";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold 38px ${FONTE}`;
  let tituloVisivel = titulo;
  while (ctx.measureText(tituloVisivel).width > W - 2 * MARGEM && tituloVisivel.length > 4) tituloVisivel = `${tituloVisivel.slice(0, -2)}…`;
  ctx.fillText(tituloVisivel, MARGEM, MARGEM + 38);
  ctx.font = `20px ${FONTE}`;
  ctx.fillStyle = "#3d4f3e";
  const quatroCasas = (v) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const local = `Local: latitude ${quatroCasas(terreno.latitude)}, longitude ${quatroCasas(terreno.longitude)}`;
  const quando = anoTodo ? "Horas de sol: ano todo (pior caso)" : `Horas de sol no dia ${dataBR(data)}`;
  ctx.fillText(local, MARGEM, MARGEM + 76);
  ctx.fillText(`${quando} · terreno de ${numero(L)} m × ${numero(C)} m`, MARGEM, MARGEM + 102);
  ctx.strokeStyle = "#1b2a1c";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(MARGEM, TOPO_DESENHO - 24);
  ctx.lineTo(W - MARGEM, TOPO_DESENHO - 24);
  ctx.stroke();

  // ---------- Terreno ----------
  const cantosTerreno = [pt(0, 0), pt(L, 0), pt(L, C), pt(0, C)];
  poligono(ctx, cantosTerreno);
  ctx.fillStyle = "#efe6cf";
  ctx.fill();

  // Mapa de horas de sol: cada quadradinho com a cor (e o padrão) da classe
  if (mapa) {
    for (const { classe } of LEGENDA_SOL) {
      const quadradinhos = [];
      for (let i = 0; i < mapa.horas.length; i++) {
        if (!mapa.ocupado[i] && classificar(mapa.horas[i]) === classe) quadradinhos.push(i);
      }
      if (!quadradinhos.length) continue;
      pintarClasse(ctx, classe, () => {
        ctx.beginPath();
        for (const i of quadradinhos) {
          const x0 = (i % mapa.colunas) * mapa.passo;
          const y0 = Math.floor(i / mapa.colunas) * mapa.passo;
          const x1 = Math.min(x0 + mapa.passo, L);
          const y1 = Math.min(y0 + mapa.passo, C);
          // Um pouquinho maior para não aparecer risco entre os quadradinhos
          const e = 0.3 / s;
          const q = [pt(x0 - e, y0 - e), pt(x1 + e, y0 - e), pt(x1 + e, y1 + e), pt(x0 - e, y1 + e)];
          q.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.closePath();
        }
      });
    }
  }

  // Grade leve de 1 m (de 5 em 5 m se o terreno for muito grande)
  const passoGrade = s >= 8 ? 1 : 5;
  ctx.strokeStyle = "rgba(40, 40, 40, 0.22)";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let x = passoGrade; x < L - 1e-6; x += passoGrade) {
    const a = pt(x, 0); const b = pt(x, C);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  for (let y = passoGrade; y < C - 1e-6; y += passoGrade) {
    const a = pt(0, y); const b = pt(L, y);
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  // Contorno forte
  poligono(ctx, cantosTerreno);
  ctx.strokeStyle = "#1b2a1c";
  ctx.lineWidth = 3.5;
  ctx.stroke();

  // Medidas nos lados: largura no lado mais alto da folha, comprimento no mais à esquerda
  const meioTerreno = pt(L / 2, C / 2);
  const medida = (a, b, texto) => {
    const meio = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dx = meio.x - meioTerreno.x;
    const dy = meio.y - meioTerreno.y;
    const d = Math.hypot(dx, dy) || 1;
    const x = meio.x + (dx / d) * 24;
    const y = meio.y + (dy / d) * 24;
    ctx.font = `bold 19px ${FONTE}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(texto).width + 12;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x - w / 2, y - 13, w, 26);
    ctx.fillStyle = "#1b2a1c";
    ctx.fillText(texto, x, y + 1);
    return { x: x - w / 2, y: y - 13, w, h: 26 };
  };
  const [c0, c1, c2, c3] = cantosTerreno;
  const ladoLargura = (c0.y + c1.y) <= (c3.y + c2.y) ? [c0, c1] : [c3, c2];
  const ladoComprimento = (c0.x + c3.x) <= (c1.x + c2.x) ? [c0, c3] : [c1, c2];
  const ocupadas = [
    medida(...ladoLargura, `${numero(L)} m`),
    medida(...ladoComprimento, `${numero(C)} m`)
  ];

  // ---------- Rosa dos ventos (canto de cima à direita) ----------
  const rosa = { x: W - MARGEM - 40, y: TOPO_DESENHO + 58, r: 30 };
  ctx.save();
  ctx.beginPath();
  ctx.arc(rosa.x, rosa.y, rosa.r, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#1b2a1c";
  ctx.stroke();
  // Seta: metade escura (norte) e metade clara (sul)
  ctx.beginPath();
  ctx.moveTo(rosa.x, rosa.y - rosa.r + 4);
  ctx.lineTo(rosa.x + 9, rosa.y);
  ctx.lineTo(rosa.x - 9, rosa.y);
  ctx.closePath();
  ctx.fillStyle = "#c62828";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(rosa.x, rosa.y + rosa.r - 4);
  ctx.lineTo(rosa.x + 9, rosa.y);
  ctx.lineTo(rosa.x - 9, rosa.y);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#1b2a1c";
  ctx.font = `bold 22px ${FONTE}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText("N", rosa.x, rosa.y - rosa.r - 2);
  ctx.restore();
  ocupadas.push({ x: rosa.x - rosa.r - 4, y: rosa.y - rosa.r - 28, w: rosa.r * 2 + 8, h: rosa.r * 2 + 32 });

  // ---------- Escala gráfica (canto de baixo à esquerda) ----------
  const metrosBarra = [1, 2, 5, 10, 20, 50].find((m) => m * s >= 70) || 50;
  const barra = { x: MARGEM + 10, y: baseDesenho - 34, w: metrosBarra * s, h: 10 };
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#1b2a1c";
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = i === 0 ? "#1b2a1c" : "#ffffff";
    ctx.fillRect(barra.x + (i * barra.w) / 2, barra.y, barra.w / 2, barra.h);
  }
  ctx.strokeRect(barra.x, barra.y, barra.w, barra.h);
  ctx.fillStyle = "#1b2a1c";
  ctx.font = `17px ${FONTE}`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText("0", barra.x - 4, barra.y + barra.h + 4);
  ctx.textAlign = "center";
  ctx.fillText(`${metrosBarra} m`, barra.x + barra.w, barra.y + barra.h + 4);
  ctx.restore();
  ocupadas.push({ x: barra.x - 8, y: barra.y - 6, w: barra.w + 30, h: 40 });

  // Nomes que vão ser colocados no fim (desviando uns dos outros)
  const nomes = [];

  // ---------- Obstáculos: cinza, com nome e altura ----------
  for (const ob of terreno.obstaculos || []) {
    let pontos;
    ctx.beginPath();
    if (ob.tipo === "circulo") {
      const c = pt(ob.x, ob.y);
      ctx.arc(c.x, c.y, ob.raio * s, 0, Math.PI * 2);
      const r = ob.raio * s * 0.7;
      pontos = [{ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y - r }, { x: c.x + r, y: c.y + r }, { x: c.x - r, y: c.y + r }];
    } else {
      pontos = cantosObstaculo(ob).map(([x, y]) => pt(x, y));
      poligono(ctx, pontos);
    }
    ctx.fillStyle = "#9e9e9e";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#424242";
    ctx.stroke();
    const meio = ob.tipo === "circulo" ? pt(ob.x, ob.y) : pt(ob.x + ob.largura / 2, ob.y + ob.profundidade / 2);
    // Círculo: a linha de ligação sai da borda (não do meio da árvore)
    const raio = ob.tipo === "circulo" ? ob.raio * s : 0;
    nomes.push({ texto: `${ob.nome || "Obstáculo"} · ${numero(ob.altura)} m`, cor: "#424242", meio, pontos, tamanho: 15, raio });
  }

  // ---------- Plantas: a cor da planta (a mesma da lista), o selo da avaliação e "1. Alface" ----------
  const ordem = ordemDasPlantas(projeto.escolhidas || {});
  const selos = [];
  for (const linha of avaliarPlantas(projeto)) {
    if (!linha.r || !linha.av) continue;
    const { r } = linha;
    const cor = linha.sobreposta ? "#c62828" : linha.cultura.cor;
    const pontos = [pt(r.x, r.y), pt(r.x + r.w, r.y), pt(r.x + r.w, r.y + r.h), pt(r.x, r.y + r.h)];
    poligono(ctx, pontos);
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = linha.cultura.cor;
    ctx.fill();
    ctx.restore();
    ctx.save();
    // Borda branca por baixo: a região aparece sobre qualquer cor do mapa
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = cor;
    if (linha.sobreposta) ctx.setLineDash([9, 4]);
    else if (linha.av.nivel === "aceitavel") ctx.setLineDash([11, 6]);  // aceitável: não depende só da cor
    ctx.stroke();
    ctx.restore();
    selos.push({ x: pontos[0].x, y: pontos[0].y, nivel: linha.av.nivel });
    nomes.push({ texto: `${ordem.indexOf(linha.id) + 1}. ${linha.cultura.nome}`, cor: linha.cultura.cor,
      meio: pt(r.x + r.w / 2, r.y + r.h / 2), pontos, tamanho: 17 });
  }

  // ---------- Nomes: dentro da região se couber; senão fora, com uma linha ----------
  const limites = { x: MARGEM, y: TOPO_DESENHO - 10, w: W - 2 * MARGEM, h: alturaDesenho + 10 };
  const dentroDaFolha = (c) => c.x >= limites.x && c.y >= limites.y && c.x + c.w <= limites.x + limites.w && c.y + c.h <= limites.y + limites.h;
  const colocados = [];
  for (const n of nomes) {
    ctx.font = `bold ${n.tamanho}px ${FONTE}`;
    const w = ctx.measureText(n.texto).width + n.tamanho * 0.8;
    const h = n.tamanho * 1.5;
    const caixaEm = (cx, cy) => ({ x: cx - w / 2, y: cy - h / 2, w, h });
    const xs = n.pontos.map((p) => p.x);
    const ys = n.pontos.map((p) => p.y);
    const bx = Math.min(...xs);
    const by = Math.min(...ys);
    const bw = Math.max(...xs) - bx;
    const bh = Math.max(...ys) - by;
    const candidatos = [];
    // Dentro: os 4 cantos da etiqueta cabem na região
    const noMeio = caixaEm(n.meio.x, n.meio.y);
    const cabeDentro = [[noMeio.x, noMeio.y], [noMeio.x + w, noMeio.y], [noMeio.x + w, noMeio.y + h], [noMeio.x, noMeio.y + h]]
      .every(([x, y]) => dentroDoPoligono({ x, y }, n.pontos));
    if (cabeDentro) candidatos.push([n.meio.x, n.meio.y, false]);
    for (const d of [12, 40, 70, 100]) {
      candidatos.push(
        [bx + bw / 2, by - h / 2 - d, true], [bx + bw / 2, by + bh + h / 2 + d, true],
        [bx + bw + w / 2 + d, by + bh / 2, true], [bx - w / 2 - d, by + bh / 2, true],
        [bx + bw + w / 2 + d, by - h / 2 - d, true], [bx - w / 2 - d, by - h / 2 - d, true],
        [bx + bw + w / 2 + d, by + bh + h / 2 + d, true], [bx - w / 2 - d, by + bh + h / 2 + d, true]
      );
    }
    const livre = (c) => dentroDaFolha(c) && !ocupadas.some((o) => baterem(c, o));
    const escolhido = candidatos.find(([cx, cy]) => livre(caixaEm(cx, cy))) || candidatos[0];
    ocupadas.push(caixaEm(escolhido[0], escolhido[1]));
    colocados.push({ ...n, x: escolhido[0], y: escolhido[1], fora: escolhido[2] });
  }
  // Primeiro as linhas, depois as etiquetas (as linhas não passam por cima dos nomes)
  for (const n of colocados) {
    if (!n.fora) continue;
    const d = Math.hypot(n.x - n.meio.x, n.y - n.meio.y) || 1;
    const inicio = n.raio
      ? { x: n.meio.x + ((n.x - n.meio.x) / d) * n.raio, y: n.meio.y + ((n.y - n.meio.y) / d) * n.raio }
      : n.meio;
    ctx.beginPath();
    ctx.moveTo(inicio.x, inicio.y);
    ctx.lineTo(n.x, n.y);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = n.cor;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(inicio.x, inicio.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = n.cor;
    ctx.fill();
  }
  for (const n of colocados) etiqueta(ctx, n.texto, n.x, n.y, n.cor, n.tamanho);
  for (const selo of selos) desenharSelo(ctx, selo.x, selo.y, 13, selo.nivel);

  // ---------- Legenda (cores + padrões + valores escritos) ----------
  const quadrado = 26;
  let x = MARGEM;
  let y = TOPO_LEGENDA;
  ctx.font = `17px ${FONTE}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const itemLegenda = (desenharAmostra, texto) => {
    desenharAmostra(x, y);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#1b2a1c";
    ctx.strokeRect(x, y, quadrado, quadrado);
    ctx.fillStyle = "#1b2a1c";
    ctx.font = `17px ${FONTE}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(texto, x + quadrado + 8, y + quadrado / 2 + 1);
    x += quadrado + 8 + ctx.measureText(texto).width + 28;
  };
  for (const { classe, texto } of LEGENDA_SOL) {
    itemLegenda((ax, ay) => pintarClasse(ctx, classe, () => { ctx.beginPath(); ctx.rect(ax, ay, quadrado, quadrado); }), texto);
  }
  x = MARGEM;
  y += quadrado + 16;
  itemLegenda((ax, ay) => { ctx.fillStyle = "#9e9e9e"; ctx.fillRect(ax, ay, quadrado, quadrado); }, "Obstáculo · altura");
  for (const [id, nivel] of Object.entries(NIVEIS)) {
    itemLegenda((ax, ay) => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(ax, ay, quadrado, quadrado);
      desenharSelo(ctx, ax + quadrado / 2, ay + quadrado / 2, 11, id);
    }, nivel.texto);
  }
  y += quadrado + 14;
  ctx.fillStyle = "#3d4f3e";
  ctx.font = `15px ${FONTE}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const grade = passoGrade === 1 ? "Grade de 1 m." : "Grade de 5 m.";
  ctx.fillText(`${grade} Norte para cima. Cada planta tem a sua cor; o selo mostra se o lugar tem o sol que ela precisa.`, MARGEM, y + 8);

  // ---------- Rodapé ----------
  ctx.strokeStyle = "#c9d3c9";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(MARGEM, H - 46);
  ctx.lineTo(W - MARGEM, H - 46);
  ctx.stroke();
  ctx.fillStyle = "#3d4f3e";
  ctx.font = `16px ${FONTE}`;
  ctx.textAlign = "center";
  ctx.fillText(RODAPE, W / 2, H - 24);

  return canvas;
}

// Necessidade de sol e umidade ideal de uma planta, em texto (para a tabela)
export const textoNecessidade = (cultura) => NECESSIDADE[cultura.sol].texto;
export const textoUmidade = (cultura) => `${cultura.umidade[0]}–${cultura.umidade[1]}%`;
