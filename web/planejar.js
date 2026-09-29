// Página "Planeje sua horta" — desenho do terreno e interface
//
// Como o desenho funciona:
//   - O terreno é um retângulo medido em METROS. x cresce para a direita e
//     y cresce para baixo, com (0, 0) no canto de cima à esquerda.
//   - Para desenhar, cada metro vira "escala" pixels (depende do tamanho da tela).
//   - Obstáculos: retângulo (muro, casa) com posição do canto de cima à
//     esquerda, largura e profundidade; ou círculo (árvore) com centro e raio.
//     Todos têm uma altura, que é o que faz sombra.
//   - A seta do norte diz para onde fica o norte no desenho (0° = para cima).

// ---------- Terreno padrão ----------
const PADRAO = {
  largura: 6,          // m (da esquerda para a direita)
  comprimento: 4,      // m (de cima para baixo)
  norte: 0,            // ângulo do norte, em graus, girando no sentido do relógio a partir do topo
  latitude: -15.90,    // São Sebastião (DF)
  longitude: -47.78,
  obstaculos: []
};

// Exemplo pronto para a feira: muro de 2 m no lado norte e árvore de 4 m no canto leste
const EXEMPLO = {
  largura: 6,
  comprimento: 4,
  norte: 0,
  latitude: -15.90,
  longitude: -47.78,
  obstaculos: [
    { tipo: "retangulo", nome: "Muro", x: 0, y: 0, largura: 6, profundidade: 0.2, altura: 2 },
    { tipo: "circulo", nome: "Mangueira", x: 5.3, y: 3.2, raio: 0.6, altura: 4 }
  ]
};

const CHAVE_SALVAR = "horta-planejar-v1";
const MARGEM = 34;       // espaço (px) para a régua em cima e à esquerda
const RAIO_BUSSOLA = 26; // tamanho da seta do norte (px)
const ESPACO_BUSSOLA = RAIO_BUSSOLA * 2 + 16;  // coluna à direita do terreno, só para a seta

const copia = (obj) => JSON.parse(JSON.stringify(obj));
const arredondar = (valor, passo = 0.05) => Number((Math.round(valor / passo) * passo).toFixed(2));
const numero = (valor, casas = 2) => Number(valor).toLocaleString("pt-BR", { maximumFractionDigits: casas });

// ---------- Estado ----------
let terreno = carregar() || copia(PADRAO);
let selecionado = -1;     // índice do obstáculo selecionado (-1 = nenhum)
let arrastando = null;    // { tipo: "obstaculo" | "norte", dx, dy }

const canvas = document.getElementById("terreno");
const ctx = canvas.getContext("2d");
const caixa = canvas.parentElement;
let escala = 60;          // pixels por metro (calculado em medir())
let larguraTela = 0;      // tamanho do canvas em pixels "de CSS"
let alturaTela = 0;

// ---------- Salvar no navegador (localStorage) ----------
// Se o navegador bloquear (aba anônima, por exemplo), a página continua funcionando.
function salvar() {
  try { localStorage.setItem(CHAVE_SALVAR, JSON.stringify(terreno)); } catch { /* sem salvar */ }
}
function carregar() {
  try {
    const texto = localStorage.getItem(CHAVE_SALVAR);
    if (!texto) return null;
    const dados = JSON.parse(texto);
    return typeof dados.largura === "number" && Array.isArray(dados.obstaculos) ? dados : null;
  } catch {
    return null;
  }
}

// ---------- Metros <-> pixels ----------
const paraPxX = (m) => MARGEM + m * escala;
const paraPxY = (m) => MARGEM + m * escala;
const paraMetro = (px) => (px - MARGEM) / escala;

// Centro da seta do norte (canto de cima à direita do desenho)
const centroBussola = () => ({ x: larguraTela - RAIO_BUSSOLA - 6, y: MARGEM + RAIO_BUSSOLA });

// Ajusta o tamanho do canvas à largura da tela, nítido em telas de alta densidade
function medir() {
  const largura = caixa.clientWidth;
  const alturaMax = Math.max(260, window.innerHeight * 0.7);
  escala = Math.min(
    (largura - MARGEM - 12 - ESPACO_BUSSOLA) / terreno.largura,
    (alturaMax - MARGEM - 12) / terreno.comprimento
  );
  // A seta do norte fica numa coluna à direita, fora do terreno
  larguraTela = Math.round(MARGEM + terreno.largura * escala + 12 + ESPACO_BUSSOLA);
  alturaTela = Math.round(MARGEM + terreno.comprimento * escala + 12);

  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${larguraTela}px`;
  canvas.style.height = `${alturaTela}px`;
  canvas.width = Math.round(larguraTela * dpr);
  canvas.height = Math.round(alturaTela * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // desenha em "pixels de CSS"
}

// ---------- Desenho ----------
// Outras partes da página (mapa de sol, sugestões) desenham por cima do chão
// e embaixo dos obstáculos. Elas se registram aqui.
const camadas = [];
export function adicionarCamada(funcao) { camadas.push(funcao); }

function desenhar() {
  ctx.clearRect(0, 0, larguraTela, alturaTela);
  const L = terreno.largura;
  const C = terreno.comprimento;

  // Chão
  ctx.fillStyle = "#efe6cf";
  ctx.fillRect(paraPxX(0), paraPxY(0), L * escala, C * escala);

  // Camadas extras (mapa de sol, lugares sugeridos)
  for (const camada of camadas) camada(ctx, { paraPxX, paraPxY, escala, terreno });

  // Grade leve de 1 m
  ctx.strokeStyle = "rgba(60, 60, 60, 0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < L; x++) { ctx.moveTo(paraPxX(x), paraPxY(0)); ctx.lineTo(paraPxX(x), paraPxY(C)); }
  for (let y = 1; y < C; y++) { ctx.moveTo(paraPxX(0), paraPxY(y)); ctx.lineTo(paraPxX(L), paraPxY(y)); }
  ctx.stroke();

  // Borda do terreno
  ctx.strokeStyle = "#5b4a2a";
  ctx.lineWidth = 2;
  ctx.strokeRect(paraPxX(0), paraPxY(0), L * escala, C * escala);

  desenharRegua(L, C);
  terreno.obstaculos.forEach((ob, i) => desenharObstaculo(ob, i === selecionado));
  desenharBussola();
}

// Régua em metros: em cima (largura) e à esquerda (comprimento)
function desenharRegua(L, C) {
  const passo = escala < 25 ? 2 : 1;  // em terrenos grandes, marca de 2 em 2 m
  ctx.fillStyle = "#5b6b5c";
  ctx.strokeStyle = "#5b6b5c";
  ctx.lineWidth = 1;
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (let x = 0; x <= L + 1e-9; x += passo) {
    ctx.beginPath(); ctx.moveTo(paraPxX(x), MARGEM - 6); ctx.lineTo(paraPxX(x), MARGEM); ctx.stroke();
    ctx.fillText(`${numero(x)}`, paraPxX(x), MARGEM - 8);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let y = 0; y <= C + 1e-9; y += passo) {
    ctx.beginPath(); ctx.moveTo(MARGEM - 6, paraPxY(y)); ctx.lineTo(MARGEM, paraPxY(y)); ctx.stroke();
    ctx.fillText(`${numero(y)}`, MARGEM - 8, paraPxY(y));
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("m", 4, 4);
}

function desenharObstaculo(ob, destacado) {
  ctx.lineWidth = destacado ? 3 : 2;
  if (ob.tipo === "retangulo") {
    ctx.fillStyle = "rgba(120, 110, 100, 0.85)";
    ctx.strokeStyle = destacado ? "#d84315" : "#3e3a36";
    ctx.fillRect(paraPxX(ob.x), paraPxY(ob.y), ob.largura * escala, ob.profundidade * escala);
    ctx.strokeRect(paraPxX(ob.x), paraPxY(ob.y), ob.largura * escala, ob.profundidade * escala);
  } else {
    ctx.fillStyle = "rgba(46, 125, 50, 0.75)";
    ctx.strokeStyle = destacado ? "#d84315" : "#1b5e20";
    ctx.beginPath();
    ctx.arc(paraPxX(ob.x), paraPxY(ob.y), ob.raio * escala, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  // Nome e altura
  const centro = centroObstaculo(ob);
  const texto = `${ob.nome} (${numero(ob.altura, 1)} m)`;
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const px = paraPxX(centro.x);
  const py = paraPxY(centro.y);
  const largura = ctx.measureText(texto).width + 8;
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.fillRect(px - largura / 2, py - 9, largura, 18);
  ctx.fillStyle = "#1b2a1c";
  ctx.fillText(texto, px, py);
}

const centroObstaculo = (ob) => (ob.tipo === "retangulo"
  ? { x: ob.x + ob.largura / 2, y: ob.y + ob.profundidade / 2 }
  : { x: ob.x, y: ob.y });

// Seta do norte: gira com o ângulo. Arraste para girar.
function desenharBussola() {
  const { x, y } = centroBussola();
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.strokeStyle = "#5b6b5c";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, RAIO_BUSSOLA, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.translate(x, y);
  ctx.rotate((terreno.norte * Math.PI) / 180);
  ctx.fillStyle = "#c62828";
  ctx.beginPath();
  ctx.moveTo(0, -RAIO_BUSSOLA + 4);
  ctx.lineTo(7, 4);
  ctx.lineTo(-7, 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#1b2a1c";
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", 0, 13);
  ctx.restore();
}

// ---------- Arrastar (mouse e dedo, com Pointer Events) ----------
function pontoDoEvento(evento) {
  const r = canvas.getBoundingClientRect();
  return { px: evento.clientX - r.left, py: evento.clientY - r.top };
}

// Qual obstáculo está neste ponto (em metros)? O de cima ganha.
export function obstaculoEm(x, y) {
  for (let i = terreno.obstaculos.length - 1; i >= 0; i--) {
    const ob = terreno.obstaculos[i];
    if (ob.tipo === "retangulo") {
      if (x >= ob.x && x <= ob.x + ob.largura && y >= ob.y && y <= ob.y + ob.profundidade) return i;
    } else if (Math.hypot(x - ob.x, y - ob.y) <= ob.raio) {
      return i;
    }
  }
  return -1;
}

canvas.addEventListener("pointerdown", (evento) => {
  const { px, py } = pontoDoEvento(evento);
  const b = centroBussola();
  if (Math.hypot(px - b.x, py - b.y) <= RAIO_BUSSOLA) {
    arrastando = { tipo: "norte" };
  } else {
    const x = paraMetro(px);
    const y = paraMetro(py);
    const i = obstaculoEm(x, y);
    selecionar(i);
    if (i >= 0) {
      const ob = terreno.obstaculos[i];
      arrastando = { tipo: "obstaculo", dx: x - ob.x, dy: y - ob.y };
    }
  }
  if (arrastando) {
    canvas.setPointerCapture(evento.pointerId);
    evento.preventDefault();
  }
});

canvas.addEventListener("pointermove", (evento) => {
  if (!arrastando) return;
  const { px, py } = pontoDoEvento(evento);
  if (arrastando.tipo === "norte") {
    const b = centroBussola();
    // Ângulo a partir do topo, no sentido do relógio
    let graus = (Math.atan2(px - b.x, -(py - b.y)) * 180) / Math.PI;
    terreno.norte = Math.round((graus + 360) % 360);
  } else {
    const ob = terreno.obstaculos[selecionado];
    ob.x = arredondar(paraMetro(px) - arrastando.dx);
    ob.y = arredondar(paraMetro(py) - arrastando.dy);
    manterDentro(ob);
  }
  aoMudar({ arrastando: true });
});

function soltar(evento) {
  if (!arrastando) return;
  arrastando = null;
  if (canvas.hasPointerCapture(evento.pointerId)) canvas.releasePointerCapture(evento.pointerId);
  aoMudar();
}
canvas.addEventListener("pointerup", soltar);
canvas.addEventListener("pointercancel", soltar);

// O obstáculo não sai do terreno
function manterDentro(ob) {
  if (ob.tipo === "retangulo") {
    ob.x = Math.min(Math.max(ob.x, 0), Math.max(0, terreno.largura - ob.largura));
    ob.y = Math.min(Math.max(ob.y, 0), Math.max(0, terreno.comprimento - ob.profundidade));
  } else {
    ob.x = Math.min(Math.max(ob.x, 0), terreno.largura);
    ob.y = Math.min(Math.max(ob.y, 0), terreno.comprimento);
  }
}

// ---------- Painel lateral ----------
const $ = (id) => document.getElementById(id);

function preencherCampos() {
  $("largura").value = terreno.largura;
  $("comprimento").value = terreno.comprimento;
  $("norte").value = terreno.norte;
  $("norte-valor").textContent = `${terreno.norte}°`;
  $("latitude").value = terreno.latitude;
  $("longitude").value = terreno.longitude;
}

// Campos do terreno
for (const [id, campo, min, max] of [
  ["largura", "largura", 1, 100], ["comprimento", "comprimento", 1, 100],
  ["latitude", "latitude", -90, 90], ["longitude", "longitude", -180, 180]
]) {
  $(id).addEventListener("input", () => {
    const valor = parseFloat($(id).value);
    if (Number.isNaN(valor)) return;
    terreno[campo] = Math.min(Math.max(valor, min), max);
    if (campo === "largura" || campo === "comprimento") terreno.obstaculos.forEach(manterDentro);
    aoMudar({ redimensionar: true });
  });
}
$("norte").addEventListener("input", () => {
  terreno.norte = Number($("norte").value);
  aoMudar();
});

// Lista de obstáculos e editor do selecionado
function selecionar(i) {
  selecionado = i;
  mostrarLista();
  mostrarEditor();
  desenhar();
}

function mostrarLista() {
  const lista = $("lista-obstaculos");
  lista.replaceChildren(...terreno.obstaculos.map((ob, i) => {
    const li = document.createElement("li");
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "planejar-item" + (i === selecionado ? " ativo" : "");
    botao.textContent = `${ob.tipo === "retangulo" ? "▭" : "◯"} ${ob.nome} · ${numero(ob.altura, 1)} m de altura`;
    botao.addEventListener("click", () => selecionar(i));
    li.append(botao);
    return li;
  }));
  if (terreno.obstaculos.length === 0) {
    const li = document.createElement("li");
    li.className = "planejar-nota";
    li.textContent = "Nenhum obstáculo. Use os botões acima.";
    lista.append(li);
  }
}

// Campos do editor para cada tipo: [campo, rótulo, mínimo, máximo]
const CAMPOS = {
  retangulo: [["x", "x (m)", 0, 100], ["y", "y (m)", 0, 100], ["largura", "Largura (m)", 0.1, 100],
    ["profundidade", "Profundidade (m)", 0.1, 100], ["altura", "Altura (m)", 0, 50]],
  circulo: [["x", "Centro x (m)", 0, 100], ["y", "Centro y (m)", 0, 100], ["raio", "Raio (m)", 0.1, 50],
    ["altura", "Altura (m)", 0, 50]]
};

function mostrarEditor() {
  const editor = $("editor");
  const ob = terreno.obstaculos[selecionado];
  editor.hidden = !ob;
  if (!ob) return;

  editor.replaceChildren();
  const rotuloNome = document.createElement("label");
  rotuloNome.textContent = "Nome ";
  const nome = document.createElement("input");
  nome.type = "text";
  nome.maxLength = 30;
  nome.value = ob.nome;
  nome.addEventListener("input", () => { ob.nome = nome.value || "Obstáculo"; aoMudar({ lista: true }); });
  rotuloNome.append(nome);
  editor.append(rotuloNome);

  for (const [campo, texto, min, max] of CAMPOS[ob.tipo]) {
    const rotulo = document.createElement("label");
    rotulo.textContent = `${texto} `;
    const entrada = document.createElement("input");
    entrada.type = "number";
    entrada.step = "0.1";
    entrada.min = min;
    entrada.max = max;
    entrada.value = ob[campo];
    entrada.dataset.campo = campo;
    entrada.addEventListener("input", () => {
      const valor = parseFloat(entrada.value);
      if (Number.isNaN(valor)) return;
      ob[campo] = Math.min(Math.max(valor, min), max);
      manterDentro(ob);
      aoMudar({ lista: true, editorSemRecriar: true });
    });
    rotulo.append(entrada);
    editor.append(rotulo);
  }

  const excluir = document.createElement("button");
  excluir.type = "button";
  excluir.className = "planejar-botao planejar-botao-perigo";
  excluir.textContent = "Excluir";
  excluir.addEventListener("click", () => {
    terreno.obstaculos.splice(selecionado, 1);
    selecionado = -1;
    aoMudar({ lista: true, editor: true });
  });
  editor.append(excluir);
}

// Atualiza os números do editor enquanto arrasta (sem recriar os campos)
function atualizarEditor() {
  const ob = terreno.obstaculos[selecionado];
  if (!ob) return;
  for (const entrada of $("editor").querySelectorAll("input[data-campo]")) {
    if (document.activeElement !== entrada) entrada.value = numero(ob[entrada.dataset.campo]).replace(",", ".");
  }
}

// Botões
$("add-retangulo").addEventListener("click", () => {
  terreno.obstaculos.push({ tipo: "retangulo", nome: "Muro", x: 0, y: 0,
    largura: Math.min(2, terreno.largura), profundidade: 0.2, altura: 2 });
  selecionado = terreno.obstaculos.length - 1;
  aoMudar({ lista: true, editor: true });
});
$("add-circulo").addEventListener("click", () => {
  terreno.obstaculos.push({ tipo: "circulo", nome: "Árvore", x: terreno.largura / 2,
    y: terreno.comprimento / 2, raio: 0.5, altura: 3 });
  selecionado = terreno.obstaculos.length - 1;
  aoMudar({ lista: true, editor: true });
});
$("exemplo").addEventListener("click", () => {
  terreno = copia(EXEMPLO);
  selecionado = -1;
  preencherCampos();
  aoMudar({ redimensionar: true, lista: true, editor: true });
});
$("zerar").addEventListener("click", () => {
  terreno = copia(PADRAO);
  selecionado = -1;
  preencherCampos();
  aoMudar({ redimensionar: true, lista: true, editor: true });
});

// ---------- Quando algo muda ----------
// Outras partes da página (mapa de sol) querem saber quando o terreno muda.
const aoMudarTerreno = [];
export function quandoTerrenoMudar(funcao) { aoMudarTerreno.push(funcao); }
export const terrenoAtual = () => terreno;
export const redesenhar = () => desenhar();
export const metrosDoEvento = (evento) => {
  const { px, py } = pontoDoEvento(evento);
  return { x: paraMetro(px), y: paraMetro(py) };
};
export const estaArrastando = () => arrastando !== null;

function aoMudar(opcoes = {}) {
  $("norte-valor").textContent = `${terreno.norte}°`;
  if (Number($("norte").value) !== terreno.norte) $("norte").value = terreno.norte;
  if (opcoes.redimensionar) medir();
  if (opcoes.lista || opcoes.arrastando) mostrarLista();
  if (opcoes.editor) mostrarEditor();
  else atualizarEditor();
  salvar();
  desenhar();
  for (const funcao of aoMudarTerreno) funcao(opcoes);
}

// ---------- Início ----------
preencherCampos();
medir();
mostrarLista();
desenhar();
new ResizeObserver(() => { medir(); desenhar(); }).observe(caixa);
