// Modo "Sobre o mapa" da página Planeje sua horta
// Mostra a imagem de satélite (Esri World Imagery, pelo Leaflet) para a
// pessoa encontrar o lugar da horta e desenhar por cima.
//
// Bibliotecas (carregadas no HTML): Leaflet 1.9.4 pelo cdnjs.
// Imagens: Esri World Imagery (gratuitas, sem chave).
// Busca de endereço: Nominatim, do OpenStreetMap (uma busca por clique).
//
// Como guardamos o desenho:
//   - Cada forma tem um CENTRO em latitude/longitude, tamanhos em metros e um
//     ÂNGULO (graus, no sentido do relógio a partir do norte) — terrenos e
//     casas de verdade nem sempre estão alinhados ao norte.
//   - Para medir em metros, usamos um "plano" em volta do ponto: 1° de
//     latitude ≈ 111 320 m e 1° de longitude ≈ 111 320 × cos(latitude) m.
//     (É uma aproximação ótima para distâncias de poucas centenas de metros.)
//   - Na imagem, o NORTE É SEMPRE PARA CIMA.

const CENTRO_INICIAL = [-15.90, -47.78];  // São Sebastião (DF)
const ZOOM_INICIAL = 17;

const URL_SATELITE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const URL_NOMES = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const ATRIBUICAO_ESRI = "Imagens © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const URL_BUSCA = "https://nominatim.openstreetmap.org/search";

const M_POR_GRAU = 111320;   // metros em 1° de latitude
const RAD = Math.PI / 180;

// Tipos sugeridos ao criar um obstáculo (altura em metros)
export const TIPOS_OBSTACULO = [
  { nome: "Casa térrea", altura: 3, tipo: "retangulo", largura: 8, profundidade: 6 },
  { nome: "Sobrado", altura: 6, tipo: "retangulo", largura: 8, profundidade: 6 },
  { nome: "Muro", altura: 2, tipo: "retangulo", largura: 6, profundidade: 0.2 },
  { nome: "Árvore média", altura: 5, tipo: "circulo", raio: 2.5 }
];

const numero = (valor, casas = 1) => Number(valor).toLocaleString("pt-BR", { maximumFractionDigits: casas });
const duasCasas = (v) => Math.round(v * 100) / 100;

// ---------- Metros <-> latitude/longitude, em volta de um ponto "ref" ----------
export function paraMetros(latlng, ref) {
  return {
    e: (latlng[1] - ref[1]) * M_POR_GRAU * Math.cos(ref[0] * RAD),  // leste (+) / oeste (−)
    n: (latlng[0] - ref[0]) * M_POR_GRAU                            // norte (+) / sul (−)
  };
}
export function deMetros(e, n, ref) {
  return [ref[0] + n / M_POR_GRAU, ref[1] + e / (M_POR_GRAU * Math.cos(ref[0] * RAD))];
}
// Uma forma girada: (a, b) nos eixos dela (a para a "direita", b para "cima")
// vira leste/norte. O ângulo gira no sentido do relógio a partir do norte.
export function formaParaMetros(a, b, angulo) {
  const c = Math.cos(angulo * RAD);
  const s = Math.sin(angulo * RAD);
  return { e: a * c + b * s, n: -a * s + b * c };
}
export function metrosParaForma(e, n, angulo) {
  const c = Math.cos(angulo * RAD);
  const s = Math.sin(angulo * RAD);
  return { a: e * c - n * s, b: e * s + n * c };
}

export function iniciarModoMapa(opcoes) {
  const {
    elemento, busca, buscaTexto, buscaStatus, botaoLocalizacao, camadaNomes,
    lista, editor, ferramentaStatus, aoMudar, textoDoPonto
  } = opcoes;

  let mapa = null;          // o mapa do Leaflet (criado na primeira vez que aparece)
  let nomes = null;         // camada de nomes de ruas (liga/desliga)
  let canvas = null;        // desenho por cima do mapa
  let ctx = null;

  // O desenho
  let terreno = null;       // { centro: [lat, lng], largura, comprimento, angulo }
  let obstaculos = [];      // { tipo: "retangulo", nome, centro, largura, profundidade, angulo, altura }
                            // { tipo: "circulo", nome, centro, raio, altura }
  let selecionado = null;   // "terreno", um índice de obstáculo, ou null
  let ferramenta = null;    // "terreno" | "retangulo" | "circulo" | null
  let gesto = null;         // o que o dedo/mouse está fazendo agora

  // Quem desenha por baixo das formas (mapa de sol, plantas): outras partes se registram
  const camadas = [];

  // O Leaflet não carregou (sem internet?): o modo mapa não funciona
  const disponivel = typeof L !== "undefined";

  function criarMapa() {
    mapa = L.map(elemento, {
      center: CENTRO_INICIAL,
      zoom: ZOOM_INICIAL,
      maxZoom: 21,
      zoomAnimation: false  // o desenho por cima acompanha o zoom sem "pular"
    });
    L.tileLayer(URL_SATELITE, {
      maxNativeZoom: 19,  // as imagens vão até o zoom 19; depois disso, esticam
      maxZoom: 21,
      attribution: ATRIBUICAO_ESRI
    }).addTo(mapa);
    nomes = L.tileLayer(URL_NOMES, { maxNativeZoom: 19, maxZoom: 21 });
    L.control.scale({ imperial: false }).addTo(mapa);

    // Canvas por cima das imagens (e embaixo dos botões do mapa)
    canvas = document.createElement("canvas");
    canvas.className = "planejar-mapa-desenho";
    elemento.append(canvas);
    ctx = canvas.getContext("2d");
    mapa.on("move zoom resize viewreset", redesenhar);
    mapa.on("resize", medirCanvas);
    medirCanvas();

    // Gestos: "capture" = recebemos antes do Leaflet e decidimos quem fica com o toque
    elemento.addEventListener("pointerdown", aoApertar, true);

    // Dica "5,5 h de sol": passando o mouse, ou tocando (some sozinha)
    dica = document.createElement("p");
    dica.className = "planejar-dica planejar-dica-mapa";
    dica.hidden = true;
    elemento.append(dica);
    elemento.addEventListener("pointermove", (evento) => {
      if (evento.pointerType === "mouse" && evento.buttons === 0) mostrarDica(evento);
    });
    elemento.addEventListener("pointerleave", (evento) => { if (evento.pointerType === "mouse") dica.hidden = true; });
  }

  // ---------- Dica: horas de sol do ponto tocado ----------
  let dica = null;
  let esconderDica = null;
  // Ponto do mapa -> metros no terreno (x para a direita, y para baixo, a partir do canto de cima à esquerda)
  function noTerreno(latlng) {
    const m = paraMetros(latlng, terreno.centro);
    const { a, b } = metrosParaForma(m.e, m.n, terreno.angulo || 0);
    return { x: a + terreno.largura / 2, y: terreno.comprimento / 2 - b };
  }
  function mostrarDica(evento) {
    if (!terreno || gesto || ferramenta) { dica.hidden = true; return; }
    const p = pontoDoEvento(evento);
    const latlng = mapa.containerPointToLatLng(p);
    const { x, y } = noTerreno([latlng.lat, latlng.lng]);
    const texto = x >= 0 && y >= 0 && x < terreno.largura && y < terreno.comprimento ? textoDoPonto(x, y) : null;
    if (!texto) { dica.hidden = true; return; }
    dica.textContent = texto;
    dica.style.left = `${p.x}px`;
    dica.style.top = `${p.y}px`;
    dica.hidden = false;
    clearTimeout(esconderDica);
    if (evento.pointerType !== "mouse") esconderDica = setTimeout(() => { dica.hidden = true; }, 2500);
  }

  // ---------- O desenho no formato do cálculo (sol.js) ----------
  // O cálculo trabalha num plano em metros alinhado aos lados do terreno
  // (a grade segue o terreno, mesmo girado). O giro do terreno vira o
  // "ângulo do norte" desse plano, e cada obstáculo leva o giro dele
  // em relação ao terreno.
  function terrenoParaCalculo() {
    if (!terreno) return null;
    const giro = terreno.angulo || 0;
    const obs = obstaculos.map((ob) => {
      const c = noTerreno(ob.centro);
      if (ob.tipo === "circulo") return { tipo: "circulo", nome: ob.nome, x: c.x, y: c.y, raio: ob.raio, altura: ob.altura };
      return {
        tipo: "retangulo", nome: ob.nome, altura: ob.altura,
        x: c.x - ob.largura / 2, y: c.y - ob.profundidade / 2,
        largura: ob.largura, profundidade: ob.profundidade,
        angulo: (((ob.angulo || 0) - giro) % 360 + 360) % 360
      };
    });
    return {
      largura: terreno.largura,
      comprimento: terreno.comprimento,
      norte: (360 - giro) % 360,          // no plano do terreno, o norte fica girado ao contrário
      latitude: terreno.centro[0],        // o cálculo usa o centro do terreno
      longitude: terreno.centro[1],
      obstaculos: obs
    };
  }

  function medirCanvas() {
    const tamanho = mapa.getSize();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(tamanho.x * dpr);
    canvas.height = Math.round(tamanho.y * dpr);
    canvas.style.width = `${tamanho.x}px`;
    canvas.style.height = `${tamanho.y}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redesenhar();
  }

  // Aparece (ou some) quando a pessoa troca de modo
  function mostrar() {
    if (!disponivel) {
      buscaStatus.textContent = "Não consegui carregar o mapa (sem internet?). Use o Desenho livre.";
      return;
    }
    if (!mapa) criarMapa();
    mapa.invalidateSize();  // o mapa estava escondido: recalcula o tamanho
    medirCanvas();
    mostrarPainel();
  }

  // ---------- Geometria das formas ----------
  // Tamanhos de uma forma retangular (terreno ou obstáculo)
  const tamanhoDe = (forma) => (forma === terreno
    ? { w: forma.largura, d: forma.comprimento }
    : { w: forma.largura, d: forma.profundidade });
  const formaSelecionada = () => (selecionado === "terreno" ? terreno : obstaculos[selecionado] ?? null);

  // Ponto (a, b) nos eixos da forma → pixel na tela
  function pixelDaForma(forma, a, b) {
    const { e, n } = formaParaMetros(a, b, forma.angulo || 0);
    return mapa.latLngToContainerPoint(deMetros(e, n, forma.centro));
  }
  function cantos(forma) {
    const { w, d } = tamanhoDe(forma);
    return [[-w / 2, d / 2], [w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]]
      .map(([a, b]) => pixelDaForma(forma, a, b));
  }
  // Alça de girar: um pouco acima do meio do lado de cima
  function alcaGirar(forma) {
    const { d } = tamanhoDe(forma);
    const centro = mapa.latLngToContainerPoint(forma.centro);
    const topo = pixelDaForma(forma, 0, d / 2);
    const dx = topo.x - centro.x;
    const dy = topo.y - centro.y;
    const comp = Math.hypot(dx, dy) || 1;
    return { x: topo.x + (dx / comp) * 30, y: topo.y + (dy / comp) * 30, topo };
  }
  const pixelsPorMetro = (latlng) => {
    const a = mapa.latLngToContainerPoint(latlng);
    const b = mapa.latLngToContainerPoint(deMetros(1, 0, latlng));
    return Math.hypot(b.x - a.x, b.y - a.y);
  };

  // ---------- Desenho ----------
  function redesenhar() {
    if (!ctx) return;
    const tamanho = mapa.getSize();
    ctx.clearRect(0, 0, tamanho.x, tamanho.y);

    for (const camada of camadas) camada(ctx, ferramentasDeDesenho());
    if (terreno) desenharTerreno();
    obstaculos.forEach((ob, i) => desenharObstaculo(ob, selecionado === i));
    const forma = formaSelecionada();
    if (forma) desenharAlcas(forma);
    if (gesto && gesto.tipo === "criar") desenharPrevia();
  }

  function caminho(pontos) {
    ctx.beginPath();
    pontos.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  }

  function etiqueta(texto, x, y, cor = "#1b2a1c") {
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const largura = ctx.measureText(texto).width + 10;
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.fillRect(x - largura / 2, y - 10, largura, 20);
    ctx.fillStyle = cor;
    ctx.fillText(texto, x, y);
  }

  function desenharTerreno() {
    const pts = cantos(terreno);
    caminho(pts);
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.fill();
    ctx.setLineDash([8, 5]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = selecionado === "terreno" ? "#ffeb3b" : "#ffffff";
    ctx.stroke();
    ctx.setLineDash([]);
    // Medidas: largura no lado de cima, comprimento no lado da direita,
    // um pouco para dentro (do lado de fora fica a alça de girar)
    const centro = mapa.latLngToContainerPoint(terreno.centro);
    const paraDentro = (p, distancia) => {
      const dx = centro.x - p.x;
      const dy = centro.y - p.y;
      const comp = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / comp) * distancia, y: p.y + (dy / comp) * distancia };
    };
    const cima = paraDentro({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, 16);
    const direita = paraDentro({ x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 }, 26);
    etiqueta(`${numero(terreno.largura)} m`, cima.x, cima.y);
    etiqueta(`${numero(terreno.comprimento)} m`, direita.x, direita.y);
  }

  function desenharObstaculo(ob, destacado) {
    ctx.lineWidth = destacado ? 3 : 2;
    if (ob.tipo === "retangulo") {
      caminho(cantos(ob));
      ctx.fillStyle = "rgba(120, 110, 100, 0.75)";
      ctx.strokeStyle = destacado ? "#ffeb3b" : "#3e3a36";
    } else {
      const c = mapa.latLngToContainerPoint(ob.centro);
      ctx.beginPath();
      ctx.arc(c.x, c.y, ob.raio * pixelsPorMetro(ob.centro), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(46, 125, 50, 0.7)";
      ctx.strokeStyle = destacado ? "#ffeb3b" : "#1b5e20";
    }
    ctx.fill();
    ctx.stroke();
    const c = mapa.latLngToContainerPoint(ob.centro);
    etiqueta(`${ob.nome} (${numero(ob.altura)} m)`, c.x, c.y);
  }

  const TAM_ALCA = 9;
  function desenharAlcas(forma) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#1b2a1c";
    ctx.fillStyle = "#ffffff";
    if (forma.tipo === "circulo") {
      const p = pixelDaForma(forma, forma.raio, 0);
      ctx.fillRect(p.x - TAM_ALCA, p.y - TAM_ALCA, TAM_ALCA * 2, TAM_ALCA * 2);
      ctx.strokeRect(p.x - TAM_ALCA, p.y - TAM_ALCA, TAM_ALCA * 2, TAM_ALCA * 2);
      return;
    }
    for (const p of cantos(forma)) {
      ctx.fillRect(p.x - TAM_ALCA, p.y - TAM_ALCA, TAM_ALCA * 2, TAM_ALCA * 2);
      ctx.strokeRect(p.x - TAM_ALCA, p.y - TAM_ALCA, TAM_ALCA * 2, TAM_ALCA * 2);
    }
    // Alça de girar (círculo com seta)
    const g = alcaGirar(forma);
    ctx.beginPath();
    ctx.moveTo(g.topo.x, g.topo.y);
    ctx.lineTo(g.x, g.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(g.x, g.y, TAM_ALCA + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1b2a1c";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("↻", g.x, g.y + 1);
  }

  function desenharPrevia() {
    const { inicio, atual } = gesto;
    const a = mapa.latLngToContainerPoint(inicio);
    const b = mapa.latLngToContainerPoint(atual);
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffeb3b";
    if (ferramenta === "circulo") {
      ctx.beginPath();
      ctx.arc(a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      const m = paraMetros(atual, inicio);
      etiqueta(`${numero(Math.abs(m.e))} × ${numero(Math.abs(m.n))} m`, (a.x + b.x) / 2, Math.min(a.y, b.y) - 14);
    }
    ctx.setLineDash([]);
  }

  // O que as camadas extras recebem para desenhar na grade do terreno
  function ferramentasDeDesenho() {
    return { mapa, terreno, pixelDaForma, pixelsPorMetro };
  }

  // ---------- Gestos (mouse e dedo) ----------
  function pontoDoEvento(evento) {
    const r = elemento.getBoundingClientRect();
    return L.point(evento.clientX - r.left, evento.clientY - r.top);
  }
  const perto = (p, q, raio) => Math.hypot(p.x - q.x, p.y - q.y) <= raio;

  // Está dentro da forma? (ponto em pixels)
  function dentroDaForma(forma, p) {
    const latlng = mapa.containerPointToLatLng(p);
    const m = paraMetros([latlng.lat, latlng.lng], forma.centro);
    if (forma.tipo === "circulo") return Math.hypot(m.e, m.n) <= forma.raio;
    const { a, b } = metrosParaForma(m.e, m.n, forma.angulo || 0);
    const { w, d } = tamanhoDe(forma);
    return Math.abs(a) <= w / 2 && Math.abs(b) <= d / 2;
  }

  function aoApertar(evento) {
    if (!evento.isPrimary || evento.target.closest(".leaflet-control")) return;
    const p = pontoDoEvento(evento);
    const latlng = mapa.containerPointToLatLng(p);
    const aqui = [latlng.lat, latlng.lng];
    const raio = evento.pointerType === "touch" ? 22 : 13;

    if (ferramenta) {
      gesto = { tipo: "criar", inicio: aqui, atual: aqui };
    } else {
      const forma = formaSelecionada();
      if (forma && forma.tipo !== "circulo") {
        if (perto(p, alcaGirar(forma), raio)) gesto = { tipo: "girar", forma };
        const i = cantos(forma).findIndex((c) => perto(p, c, raio));
        if (!gesto && i >= 0) {
          const sinais = [[-1, 1], [1, 1], [1, -1], [-1, -1]][i];
          const { w, d } = tamanhoDe(forma);
          gesto = { tipo: "canto", forma, sinais, w, d, centro: [...forma.centro] };
        }
      } else if (forma && perto(p, pixelDaForma(forma, forma.raio, 0), raio)) {
        gesto = { tipo: "raio", forma };
      }
      if (!gesto) {
        // Tocou numa forma? (obstáculos por cima do terreno)
        let alvo = null;
        for (let i = obstaculos.length - 1; i >= 0 && alvo === null; i--) {
          if (dentroDaForma(obstaculos[i], p)) alvo = i;
        }
        if (alvo === null && terreno && dentroDaForma(terreno, p)) alvo = "terreno";
        if (alvo !== null) {
          selecionar(alvo);
          const forma2 = formaSelecionada();
          gesto = { tipo: "mover", forma: forma2, inicio: aqui, centro: [...forma2.centro] };
        } else if (selecionado !== null) {
          selecionar(null);  // tocou fora: tira a seleção (e o mapa anda normalmente)
        }
      }
    }
    if (!gesto) {
      mostrarDica(evento);  // no toque, mostra as horas de sol do ponto
      return;               // e deixa o Leaflet mover o mapa
    }
    if (dica) dica.hidden = true;

    // Fica com o gesto: o mapa não anda enquanto desenha
    evento.stopPropagation();
    evento.preventDefault();
    mapa.dragging.disable();
    window.addEventListener("pointermove", aoMover);
    window.addEventListener("pointerup", aoSoltar);
    window.addEventListener("pointercancel", aoSoltar);
  }

  function aoMover(evento) {
    if (!gesto || !evento.isPrimary) return;
    const latlng = mapa.containerPointToLatLng(pontoDoEvento(evento));
    const aqui = [latlng.lat, latlng.lng];
    const { forma } = gesto;

    if (gesto.tipo === "criar") {
      gesto.atual = aqui;
    } else if (gesto.tipo === "mover") {
      const m = paraMetros(aqui, gesto.inicio);
      forma.centro = deMetros(m.e, m.n, gesto.centro);
    } else if (gesto.tipo === "girar") {
      const m = paraMetros(aqui, forma.centro);
      let angulo = Math.atan2(m.e, m.n) / RAD;              // a partir do norte, sentido do relógio
      angulo = Math.round((angulo + 360) % 360);
      const multiplo = Math.round(angulo / 15) * 15;        // "gruda" em 0°, 15°, 30°…
      if (Math.abs(angulo - multiplo) <= 3) angulo = multiplo % 360;
      forma.angulo = angulo;
    } else if (gesto.tipo === "canto") {
      // O canto oposto fica parado; este canto segue o dedo
      const [sa, sb] = gesto.sinais;
      const m = paraMetros(aqui, gesto.centro);
      const { a, b } = metrosParaForma(m.e, m.n, forma.angulo || 0);
      const opostoA = -sa * gesto.w / 2;
      const opostoB = -sb * gesto.d / 2;
      const w = Math.max(0.2, sa * (a - opostoA));
      const d = Math.max(0.1, sb * (b - opostoB));
      const novo = formaParaMetros(opostoA + sa * w / 2, opostoB + sb * d / 2, forma.angulo || 0);
      forma.centro = deMetros(novo.e, novo.n, gesto.centro);
      forma.largura = duasCasas(w);
      if (forma === terreno) forma.comprimento = duasCasas(d);
      else forma.profundidade = duasCasas(d);
    } else if (gesto.tipo === "raio") {
      const m = paraMetros(aqui, forma.centro);
      forma.raio = duasCasas(Math.max(0.2, Math.hypot(m.e, m.n)));
    }
    redesenhar();
    atualizarEditor();
    aoMudar({ arrastando: true });
  }

  function aoSoltar(evento) {
    if (!gesto || !evento.isPrimary) return;
    window.removeEventListener("pointermove", aoMover);
    window.removeEventListener("pointerup", aoSoltar);
    window.removeEventListener("pointercancel", aoSoltar);
    mapa.dragging.enable();
    if (gesto.tipo === "criar") criarForma(gesto.inicio, gesto.atual);
    gesto = null;
    redesenhar();
    mostrarPainel();
    aoMudar({});
  }

  // Terminou de desenhar uma forma nova (se foi só um toque, usa um tamanho padrão)
  function criarForma(inicio, fim) {
    const m = paraMetros(fim, inicio);
    const arrastou = Math.hypot(m.e, m.n) >= 0.5;
    const centro = arrastou ? deMetros(m.e / 2, m.n / 2, inicio) : inicio;
    const w = Math.abs(m.e);
    const d = Math.abs(m.n);

    if (ferramenta === "terreno") {
      terreno = arrastou
        ? { centro, largura: duasCasas(Math.max(w, 0.5)), comprimento: duasCasas(Math.max(d, 0.5)), angulo: 0 }
        : { centro, largura: 6, comprimento: 4, angulo: 0 };
      selecionado = "terreno";
    } else if (ferramenta === "retangulo") {
      const tipo = TIPOS_OBSTACULO[0];  // casa térrea (dá para trocar no painel)
      obstaculos.push({
        tipo: "retangulo", nome: tipo.nome, centro, angulo: 0, altura: tipo.altura,
        largura: arrastou ? duasCasas(Math.max(w, 0.2)) : tipo.largura,
        profundidade: arrastou ? duasCasas(Math.max(d, 0.1)) : tipo.profundidade
      });
      selecionado = obstaculos.length - 1;
    } else {
      const tipo = TIPOS_OBSTACULO[3];  // árvore média
      obstaculos.push({
        tipo: "circulo", nome: tipo.nome, centro, altura: tipo.altura,
        raio: arrastou ? duasCasas(Math.max(Math.hypot(m.e, m.n), 0.2)) : tipo.raio
      });
      selecionado = obstaculos.length - 1;
    }
    usarFerramenta(null);
  }

  // Botões "Desenhar terreno", "Casa ou muro", "Árvore"
  const AJUDA_FERRAMENTA = {
    terreno: "Arraste no mapa para desenhar o terreno (ou toque para um de 6 × 4 m).",
    retangulo: "Arraste no mapa para desenhar a casa ou o muro (ou toque para uma casa de 8 × 6 m).",
    circulo: "Toque no centro da árvore e arraste até a borda da copa."
  };
  function usarFerramenta(qual) {
    ferramenta = ferramenta === qual ? null : qual;
    ferramentaStatus.textContent = ferramenta ? AJUDA_FERRAMENTA[ferramenta] : "";
    ferramentaStatus.hidden = !ferramenta;
    elemento.classList.toggle("desenhando", ferramenta !== null);
    document.querySelectorAll("[data-ferramenta]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.ferramenta === ferramenta));
    });
  }

  // ---------- Painel lateral (lista e editor, os mesmos do Desenho livre) ----------
  function selecionar(qual) {
    selecionado = qual;
    redesenhar();
    mostrarPainel();
  }

  function mostrarPainel() {
    // Lista: o terreno e os obstáculos
    const itens = [];
    if (terreno) itens.push(["terreno", `▭ Terreno · ${numero(terreno.largura)} × ${numero(terreno.comprimento)} m`]);
    obstaculos.forEach((ob, i) => {
      itens.push([i, `${ob.tipo === "retangulo" ? "🏠" : "🌳"} ${ob.nome} · ${numero(ob.altura)} m de altura`]);
    });
    lista.replaceChildren(...itens.map(([qual, texto]) => {
      const li = document.createElement("li");
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "planejar-item" + (qual === selecionado ? " ativo" : "");
      botao.textContent = texto;
      botao.addEventListener("click", () => {
        selecionar(qual);
        const forma = formaSelecionada();
        if (forma) mapa.panTo(forma.centro);
      });
      li.append(botao);
      return li;
    }));
    if (!itens.length) {
      const li = document.createElement("li");
      li.className = "planejar-nota";
      li.textContent = "Nada desenhado ainda. Comece por \"Desenhar terreno\".";
      lista.append(li);
    }
    mostrarEditor();
  }

  // Campos: [campo, rótulo, mínimo, máximo, passo]
  const CAMPOS = {
    terreno: [["largura", "Largura (m)", 0.5, 500, 0.1], ["comprimento", "Comprimento (m)", 0.5, 500, 0.1],
      ["angulo", "Giro (° a partir do norte)", 0, 359, 1]],
    retangulo: [["largura", "Largura (m)", 0.2, 200, 0.1], ["profundidade", "Profundidade (m)", 0.1, 200, 0.1],
      ["angulo", "Giro (°)", 0, 359, 1], ["altura", "Altura (m)", 0, 100, 0.5]],
    circulo: [["raio", "Raio da copa (m)", 0.2, 50, 0.1], ["altura", "Altura (m)", 0, 100, 0.5]]
  };

  function mostrarEditor() {
    const forma = formaSelecionada();
    editor.hidden = !forma;
    if (!forma) return;
    editor.replaceChildren();
    const tipo = forma === terreno ? "terreno" : forma.tipo;

    if (forma !== terreno) {
      // Tipo sugerido: preenche nome e altura
      const rotuloTipo = document.createElement("label");
      rotuloTipo.textContent = "Tipo ";
      const escolha = document.createElement("select");
      escolha.className = "planejar-tipo";
      escolha.innerHTML = `<option value="">— escolha —</option>` + TIPOS_OBSTACULO
        .filter((t) => t.tipo === forma.tipo)
        .map((t) => `<option value="${t.nome}">${t.nome} (${numero(t.altura)} m)</option>`).join("");
      escolha.addEventListener("change", () => {
        const t = TIPOS_OBSTACULO.find((x) => x.nome === escolha.value);
        if (!t) return;
        forma.nome = t.nome;
        forma.altura = t.altura;
        aoEditar();
        mostrarPainel();
      });
      rotuloTipo.append(escolha);
      editor.append(rotuloTipo);

      const rotuloNome = document.createElement("label");
      rotuloNome.textContent = "Nome ";
      const nome = document.createElement("input");
      nome.type = "text";
      nome.maxLength = 30;
      nome.value = forma.nome;
      nome.addEventListener("input", () => { forma.nome = nome.value || "Obstáculo"; aoEditar(); });
      rotuloNome.append(nome);
      editor.append(rotuloNome);
    }

    for (const [campo, texto, min, max, passo] of CAMPOS[tipo]) {
      const rotulo = document.createElement("label");
      rotulo.textContent = `${texto} `;
      const entrada = document.createElement("input");
      entrada.type = "number";
      entrada.min = min;
      entrada.max = max;
      entrada.step = passo;
      entrada.value = forma[campo] ?? 0;
      entrada.dataset.campo = campo;
      entrada.addEventListener("input", () => {
        const valor = parseFloat(entrada.value);
        if (Number.isNaN(valor)) return;
        forma[campo] = Math.min(Math.max(valor, min), max);
        aoEditar();
      });
      rotulo.append(entrada);
      editor.append(rotulo);
    }

    const excluir = document.createElement("button");
    excluir.type = "button";
    excluir.className = "planejar-botao planejar-botao-perigo";
    excluir.textContent = forma === terreno ? "Apagar o terreno" : "Excluir";
    excluir.addEventListener("click", () => {
      if (forma === terreno) terreno = null;
      else obstaculos.splice(selecionado, 1);
      selecionado = null;
      aoEditar();
      mostrarPainel();
    });
    editor.append(excluir);
  }

  function atualizarEditor() {
    const forma = formaSelecionada();
    if (!forma) return;
    for (const entrada of editor.querySelectorAll("input[data-campo]")) {
      if (document.activeElement !== entrada) entrada.value = forma[entrada.dataset.campo];
    }
  }

  function aoEditar() {
    redesenhar();
    aoMudar({ lista: true });
    // Atualiza só o texto da lista (sem recriar o editor, que está sendo usado)
    const botoes = lista.querySelectorAll(".planejar-item");
    let k = 0;
    if (terreno && botoes[k]) botoes[k++].textContent = `▭ Terreno · ${numero(terreno.largura)} × ${numero(terreno.comprimento)} m`;
    obstaculos.forEach((ob) => {
      if (botoes[k]) botoes[k++].textContent = `${ob.tipo === "retangulo" ? "🏠" : "🌳"} ${ob.nome} · ${numero(ob.altura)} m de altura`;
    });
  }

  // ---------- Buscar endereço (Nominatim, uma busca por clique) ----------
  busca.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const texto = buscaTexto.value.trim();
    if (!texto || !mapa) return;
    buscaStatus.textContent = "Buscando…";
    try {
      const url = `${URL_BUSCA}?format=jsonv2&limit=1&accept-language=pt-BR&q=${encodeURIComponent(texto)}`;
      const resposta = await fetch(url, { headers: { Accept: "application/json" } });
      if (!resposta.ok) throw new Error(`código ${resposta.status}`);
      const lugares = await resposta.json();
      if (!lugares.length) {
        buscaStatus.textContent = "Não encontrei esse endereço. Tente escrever de outro jeito (rua, bairro, cidade).";
        return;
      }
      mapa.setView([Number(lugares[0].lat), Number(lugares[0].lon)], 19);
      buscaStatus.textContent = `Encontrado: ${lugares[0].display_name}`;
    } catch (erro) {
      buscaStatus.textContent = `Não consegui buscar agora (${erro.message}). Confira a internet.`;
    }
  });

  // ---------- Usar minha localização ----------
  botaoLocalizacao.addEventListener("click", () => {
    if (!mapa) return;
    if (!navigator.geolocation) {
      buscaStatus.textContent = "Este navegador não informa a localização. Busque o endereço no campo acima.";
      return;
    }
    buscaStatus.textContent = "Procurando sua localização…";
    navigator.geolocation.getCurrentPosition(
      (posicao) => {
        mapa.setView([posicao.coords.latitude, posicao.coords.longitude], 19);
        buscaStatus.textContent = `Localização encontrada (precisão de ~${Math.round(posicao.coords.accuracy)} m).`;
      },
      (erro) => {
        buscaStatus.textContent = erro.code === erro.PERMISSION_DENIED
          ? "Você não permitiu usar a localização. Tudo bem: busque o endereço no campo acima."
          : "Não consegui descobrir a localização agora. Busque o endereço no campo acima.";
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });

  // ---------- Nomes de ruas por cima (liga/desliga) ----------
  camadaNomes.addEventListener("change", () => {
    if (!mapa) return;
    if (camadaNomes.checked) nomes.addTo(mapa);
    else nomes.remove();
  });

  return {
    disponivel,
    mostrar,
    mostrarPainel,
    redesenhar,
    usarFerramenta,
    adicionarCamada: (funcao) => camadas.push(funcao),
    obterTerreno: () => terreno,
    terrenoParaCalculo,
    obterObstaculos: () => obstaculos,
    obterMapa: () => mapa,
    // Troca o desenho inteiro (exemplo, "Começar do zero", link compartilhado)
    definirDesenho(novoTerreno, novosObstaculos) {
      terreno = novoTerreno;
      obstaculos = novosObstaculos;
      selecionado = null;
      redesenhar();
      mostrarPainel();
    }
  };
}
