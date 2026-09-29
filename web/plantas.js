// Canteiros das plantas no "Planeje sua horta" — arrastar e girar
// Vale para os dois modos (Sobre o mapa e Desenho livre): cada modo só
// informa como converter "metros no terreno" em pixels na tela.
//
// Cada planta escolhida vira um retângulo alinhado à grade do terreno
// (x, y, w, h em metros; x para a direita, y para baixo), com a área escolhida.
// A cor diz se o lugar é bom para ela, pelas horas de sol (culturas.js):
// verde ✓ Recomendado, amarelo ! Aceitável, vermelho ✕ Não recomendado.
import {
  CULTURAS, NIVEIS, avaliarRegiao, textoAvaliacao, tamanhoDoCanteiro, encaixar, validarCanteiro,
  melhorPosicao, sugerirCanteiros, descreverLugar
} from "./culturas.js";

const culturaDe = (id) => CULTURAS.find((c) => c.id === id);
const numero = (v, casas = 1) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: casas });
const MOTIVOS = { fora: "Aqui não dá: fora do terreno", obstaculo: "Aqui não dá: obstáculo" };

const VIZINHAS_M = 0.5;  // canteiros a menos de 0,5 m um do outro são vizinhos

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

export function iniciarPlantas({ lista, vazio, avisos, aoMudar }) {
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
    const atuais = lugares();
    const ids = Object.keys(atuais);
    const sobrepostas = new Set();
    const mensagens = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = [culturaDe(ids[i]), culturaDe(ids[j])];
        const [ra, rb] = [atuais[ids[i]], atuais[ids[j]]];
        if (sobrepoe(ra, rb)) {
          sobrepostas.add(ids[i]);
          sobrepostas.add(ids[j]);
          mensagens.push({ tipo: "sobreposicao", texto: `${a.nome} e ${b.nome} estão no mesmo lugar.` });
        } else if (distancia(ra, rb) < VIZINHAS_M && regaIncompativel(a.umidade, b.umidade)) {
          // Só uma dica: não muda a cor da avaliação de sol
          mensagens.push({
            tipo: "rega",
            texto: `${a.nome} (${a.umidade[0]}–${a.umidade[1]}%) ao lado de ${b.nome} (${b.umidade[0]}–${b.umidade[1]}%): ` +
              "precisam de rega diferente. Numa zona de rega só, uma delas vai sofrer."
          });
        }
      }
    }
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

      // Nome com o ícone (✓ ! ✕): a avaliação nunca depende só da cor
      const meio = pt(r.x + r.w / 2, r.y + r.h / 2);
      const texto = invalido ? `${cultura.nome} · ${MOTIVOS[arraste.motivo]}` : `${nivel.icone} ${cultura.nome}`;
      caixasNomes.push({ id, ...etiqueta(ctx, texto, meio.x, meio.y, cor) });

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
    if (balaoDepois) desenharBalao(ctx, balaoDepois);
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

  function mostrarLista() {
    mostrarAvisos();
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
    definirPosicoes: (novas) => { posicoes = novas && typeof novas === "object" ? { ...novas } : {}; selecionada = null; }
  };
}
