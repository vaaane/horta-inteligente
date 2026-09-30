// Canteiros das plantas no "Planeje sua horta" — arrastar e girar
// Vale para os dois modos (Sobre o mapa e Desenho livre): cada modo só
// informa como converter "metros no terreno" em pixels na tela.
//
// Cada planta escolhida vira um retângulo alinhado à grade do terreno
// (x, y, w, h em metros; x para a direita, y para baixo), com a área escolhida.
// A cor diz se o lugar é bom para ela, pelas horas de sol (culturas.js):
// verde ✓ Recomendado, amarelo ! Aceitável, vermelho ✕ Não recomendado.
import {
  CULTURAS, NECESSIDADE, NIVEIS, avaliarRegiao, textoAvaliacao, tamanhoDoCanteiro, encaixar, validarCanteiro,
  melhorPosicao, sugerirCanteiros, descreverLugar
} from "./culturas.js";

const culturaDe = (id) => CULTURAS.find((c) => c.id === id);
const numero = (v, casas = 1) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas });
const MOTIVOS = { fora: "Aqui não dá: fora do terreno", obstaculo: "Aqui não dá: obstáculo" };

const VIZINHAS_M = 0.5;  // canteiros a menos de 0,5 m um do outro são vizinhos
const LADO_MINIMO_PX = 40;  // menor que isso na tela: o nome sai para fora, com uma linha

// Duas caixas (x, y, w, h) se encostam?
const baterem = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

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

export function iniciarPlantas({ lista, vazio, avisos, resumo, botaoSugerir, botaoVoltar, filtro, filtroNota, aoMudar }) {
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
    const nomes = [];
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
      const nivel = invalido ? null : NIVEIS[avaliar(id, r).nivel];
      // Sobreposta a outra planta: contorno vermelho
      const cor = invalido ? "#616161" : sobrepostas.has(id) ? "#c62828" : nivel.cor;
      ctx.save();
      ctx.globalAlpha = invalido ? 0.3 : 0.4;       // preenchimento semitransparente
      ctx.fillStyle = invalido ? "#9e9e9e" : nivel.cor;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = id === selecionada || emArraste || sobrepostas.has(id) ? 4 : 3;
      ctx.strokeStyle = cor;
      if (invalido) ctx.setLineDash([6, 4]);        // cinza tracejado: aqui não dá
      else if (sobrepostas.has(id)) ctx.setLineDash([10, 4]);
      ctx.stroke();
      ctx.restore();

      // Nome com o ícone (✓ ! ✕): a avaliação nunca depende só da cor.
      // Os nomes são desenhados depois de todas as regiões (para desviarem uns dos outros).
      const meio = pt(r.x + r.w / 2, r.y + r.h / 2);
      const texto = invalido ? `${cultura.nome} · ${MOTIVOS[arraste.motivo]}` : `${nivel.icone} ${cultura.nome}`;
      const lado = Math.min(Math.hypot(cantos[1].x - cantos[0].x, cantos[1].y - cantos[0].y),
        Math.hypot(cantos[2].x - cantos[1].x, cantos[2].y - cantos[1].y));
      const xs = cantos.map((p) => p.x);
      const ys = cantos.map((p) => p.y);
      nomes.push({ id, texto, cor, meio, lado,
        caixa: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } });

      // Balão com a avaliação: durante o arraste e na planta tocada
      if (emArraste || id === selecionada) {
        const balao = invalido ? MOTIVOS[arraste.motivo] : textoAvaliacao(cultura, avaliar(id, r)) + (anoTodo ? " (pior mês)" : "");
        const ys = cantos.map((p) => p.y);
        const xs = cantos.map((p) => p.x);
        balaoDepois = { texto: balao, x: (Math.min(...xs) + Math.max(...xs)) / 2, topo: Math.min(...ys), base: Math.max(...ys), cor };
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
    espalharNomes(ctx, nomes);
    if (balaoDepois) desenharBalao(ctx, balaoDepois);
  }

  // Põe cada nome no meio da região ou, se ela for pequena na tela (ou o
  // lugar já estiver ocupado por outro nome), do lado de fora com uma linha.
  // Testa posições em volta e fica com a primeira livre.
  function espalharNomes(ctx, nomes) {
    const larguraTela = ctx.canvas.clientWidth || 2000;
    const alturaTela = ctx.canvas.clientHeight || 2000;
    ctx.font = "bold 13px system-ui, sans-serif";
    const ocupadas = [];
    for (const n of nomes) {
      const w = ctx.measureText(n.texto).width + 12;
      const h = 22;
      const { x, y, w: cw, h: ch } = n.caixa;
      const caixaEm = (cx, cy) => ({ x: cx - w / 2, y: cy - h / 2, w, h });
      const candidatos = [];
      if (n.lado >= LADO_MINIMO_PX) candidatos.push([n.meio.x, n.meio.y, false]);
      for (const d of [10, 34, 58]) {
        candidatos.push(
          [x + cw / 2, y - h / 2 - d, true], [x + cw / 2, y + ch + h / 2 + d, true],
          [x + cw + w / 2 + d, y + ch / 2, true], [x - w / 2 - d, y + ch / 2, true],
          [x + cw + w / 2 + d, y - h / 2 - d, true], [x - w / 2 - d, y - h / 2 - d, true],
          [x + cw + w / 2 + d, y + ch + h / 2 + d, true], [x - w / 2 - d, y + ch + h / 2 + d, true]
        );
      }
      const cabe = (c) => c.x >= 2 && c.y >= 2 && c.x + c.w <= larguraTela - 2 && c.y + c.h <= alturaTela - 2;
      let escolhido = candidatos.find(([cx, cy]) => {
        const c = caixaEm(cx, cy);
        return cabe(c) && !ocupadas.some((o) => baterem(c, o));
      }) || candidatos[0];
      const caixa = caixaEm(escolhido[0], escolhido[1]);
      if (escolhido[2]) {
        // Linha fina ligando o nome à região
        ctx.beginPath();
        ctx.moveTo(n.meio.x, n.meio.y);
        ctx.lineTo(escolhido[0], escolhido[1]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = n.cor;
        ctx.stroke();
      }
      ocupadas.push(caixa);
      caixasNomes.push({ id: n.id, ...etiqueta(ctx, n.texto, escolhido[0], escolhido[1], n.cor) });
    }
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
  function mostrarAvisos() {
    const { mensagens } = convivencia();
    avisos.replaceChildren(...mensagens.map((m) => {
      const li = document.createElement("li");
      li.className = `planejar-aviso-${m.tipo}`;
      li.textContent = `${m.tipo === "sobreposicao" ? "✕" : "💧"} ${m.texto}`;
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

  function mostrarLista() {
    mostrarAvisos();
    const idsEscolhidos = CULTURAS.filter((c) => c.id in escolhidas).map((c) => c.id);
    mostrarResumo(idsEscolhidos);
    mostrarControles(idsEscolhidos);
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
        li.append(cor, texto);
      } else {
        // Selo da avaliação (ícone + palavra) e as horas de sol
        const av = avaliar(id, r);
        const selo = document.createElement("span");
        selo.className = `planejar-selo-avaliacao nivel-${av.nivel}`;
        selo.textContent = `${NIVEIS[av.nivel].icone} ${NIVEIS[av.nivel].texto}`;
        const quando = anoTodo ? " no pior mês" : "";
        let frase = `${cultura.nome}: ~${numero(Math.round(av.media * 2) / 2)} h de sol${quando}, ${descreverLugar(celulasDe(r), mapa, terreno)}.`;
        // Nem o melhor lugar serve? Explica o que dá para fazer
        const melhor = sugestoes[id];
        if (av.nivel === "nao" && (!melhor || avaliar(id, melhor).nivel === "nao")) {
          frase += ` Não há sol suficiente para ${cultura.nome.toLowerCase()} neste terreno: o melhor lugar tem ` +
            `${numero(Math.round((melhor ? avaliar(id, melhor).media : 0) * 2) / 2)} h. Tente tirar ou baixar um obstáculo.`;
        }
        texto.textContent = frase;
        li.append(cor, selo, texto);
      }
      li.addEventListener("click", () => { selecionada = id; mostrarLista(); aoMudar({}); });
      return li;
    }));
  }

  return {
    atualizar,
    desenhar,
    tocar,
    obterPosicoes: () => posicoes,
    // Planta do filtro "Mostrar só as áreas boas para…" (ou null)
    filtroCultura: () => (filtroId ? culturaDe(filtroId) : null),
    definirPosicoes: (novas) => { posicoes = novas && typeof novas === "object" ? { ...novas } : {}; selecionada = null; }
  };
}
