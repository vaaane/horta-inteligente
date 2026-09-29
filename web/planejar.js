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

import {
  calcularHorasDeSol, meioDiaLocal, classificar, SOMBRA, MEIA_SOMBRA, PLENO_SOL
} from "./sol.js";
import { CULTURAS, NECESSIDADE } from "./culturas.js";
import { iniciarModoMapa } from "./mapa.js";
import { iniciarPlantas } from "./plantas.js";

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
let modo = "livre";       // "mapa" (sobre o satélite, mapa.js) ou "livre" (este canvas)
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
  if (largura === 0) return false;  // escondido (modo mapa): mede quando aparecer
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
const camadasPorCima = [];  // plantas: por cima dos obstáculos
export function adicionarCamada(funcao, porCima = false) { (porCima ? camadasPorCima : camadas).push(funcao); }

// Desenha no modo atual: por cima do mapa, ou no canvas do Desenho livre
function desenhar() {
  if (modo === "mapa") { modoMapa.redesenhar(); return; }
  desenharLivre();
}

function desenharLivre() {
  if (escala <= 0 || caixa.clientWidth === 0) return;  // escondido (modo mapa)
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
  for (const camada of camadasPorCima) camada(ctx, { paraPxX, paraPxY, escala, terreno });
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
  // Tocou numa planta? (quem cuida é o plantas.js)
  const planta = plantas.tocar({ x: paraMetro(px), y: paraMetro(py) }, { x: px, y: py });
  if (planta === true) { evento.preventDefault(); return; }
  if (planta) {
    arrastando = { tipo: "planta", manipulador: planta };
  } else if (Math.hypot(px - b.x, py - b.y) <= RAIO_BUSSOLA) {
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
  if (arrastando.tipo === "planta") {
    arrastando.manipulador.mover({ x: paraMetro(px), y: paraMetro(py) });
    return;
  }
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
  if (arrastando.tipo === "planta") {
    arrastando.manipulador.soltar();
    arrastando = null;
    if (canvas.hasPointerCapture(evento.pointerId)) canvas.releasePointerCapture(evento.pointerId);
    return;
  }
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
  if (modo === "mapa") { modoMapa.usarFerramenta("retangulo"); return; }
  terreno.obstaculos.push({ tipo: "retangulo", nome: "Muro", x: 0, y: 0,
    largura: Math.min(2, terreno.largura), profundidade: 0.2, altura: 2 });
  selecionado = terreno.obstaculos.length - 1;
  aoMudar({ lista: true, editor: true });
});
$("add-circulo").addEventListener("click", () => {
  if (modo === "mapa") { modoMapa.usarFerramenta("circulo"); return; }
  terreno.obstaculos.push({ tipo: "circulo", nome: "Árvore", x: terreno.largura / 2,
    y: terreno.comprimento / 2, raio: 0.5, altura: 3 });
  selecionado = terreno.obstaculos.length - 1;
  aoMudar({ lista: true, editor: true });
});
$("exemplo").addEventListener("click", () => {
  if (modo === "mapa") { modoMapa.carregarExemplo(); return; }
  terreno = copia(EXEMPLO);
  selecionado = -1;
  preencherCampos();
  aoMudar({ redimensionar: true, lista: true, editor: true });
});
$("zerar").addEventListener("click", () => {
  if (modo === "mapa") { modoMapa.definirDesenho(null, []); salvarMapa(); agendarCalculo(0); return; }
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

// =====================================================================
//  MAPA DE HORAS DE SOL (o cálculo fica em sol.js)
// =====================================================================
const CORES_SOL = { [SOMBRA]: "#253b6e", [MEIA_SOMBRA]: "#6fa8dc", [PLENO_SOL]: "#f4c430" };
const hojeTexto = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let dataEscolhida = hojeTexto();  // "AAAA-MM-DD"
let anoTodo = false;              // true = pior caso dos 12 meses
let mapa = null;                  // resultado de calcularHorasDeSol
let terrenoCalculado = null;      // o terreno (no formato do sol.js) usado nesse cálculo
let ultimaDuracao = 0;            // quanto tempo levou o último cálculo (ms)
let temporizador = null;
const aoCalcularMapa = [];        // quem quer saber quando o mapa fica pronto (sugestões)
export function quandoMapaPronto(funcao) { aoCalcularMapa.push(funcao); }
export const mapaAtual = () => mapa;

// Dias usados no cálculo: o escolhido, ou o dia 21 de cada mês (ano todo)
function diasDoCalculo(longitude) {
  const [ano, mes, dia] = dataEscolhida.split("-").map(Number);
  if (anoTodo) return Array.from({ length: 12 }, (_, m) => meioDiaLocal(ano, m, 21, longitude));
  return [meioDiaLocal(ano, mes - 1, dia, longitude)];
}

// O terreno do modo atual, no formato do sol.js (null = nada desenhado no mapa)
function terrenoDoCalculo() {
  return modo === "mapa" ? modoMapa.terrenoParaCalculo() : terreno;
}

// Espera um pouquinho antes de calcular (enquanto arrasta, não recalcula a cada pixel)
function agendarCalculo(atraso = 150) {
  clearTimeout(temporizador);
  temporizador = setTimeout(() => {
    // Se o último cálculo demorou, avisa antes de começar (e deixa a tela desenhar o aviso)
    if (ultimaDuracao > 100) {
      $("mapa-status").textContent = "calculando…";
      requestAnimationFrame(() => setTimeout(calcularMapa, 0));
    } else {
      calcularMapa();
    }
  }, atraso);
}

function calcularMapa() {
  if (typeof SunCalc === "undefined") {
    $("mapa-status").textContent = "Não consegui carregar a biblioteca do sol (SunCalc). Confira a internet e recarregue a página.";
    return;
  }
  terrenoCalculado = terrenoDoCalculo();
  if (!terrenoCalculado) {
    mapa = null;
    $("mapa-status").textContent = "Desenhe o terreno no mapa (botão \"Desenhar terreno\") para ver as horas de sol.";
    desenhar();
    for (const funcao of aoCalcularMapa) funcao(mapa);
    return;
  }
  if (modo === "mapa") {
    $("centro-terreno").textContent = `O cálculo usa o centro do terreno: latitude ${numero(terrenoCalculado.latitude, 5)}, ` +
      `longitude ${numero(terrenoCalculado.longitude, 5)}.`;
  }
  const inicio = performance.now();
  mapa = calcularHorasDeSol(SunCalc, terrenoCalculado, diasDoCalculo(terrenoCalculado.longitude));
  ultimaDuracao = performance.now() - inicio;
  mostrarStatusDoMapa();
  desenhar();
  for (const funcao of aoCalcularMapa) funcao(mapa);
}

function mostrarStatusDoMapa() {
  let maior = 0;
  let menor = Infinity;
  mapa.horas.forEach((h, i) => {
    if (mapa.ocupado[i]) return;
    maior = Math.max(maior, h);
    menor = Math.min(menor, h);
  });
  if (menor === Infinity) menor = 0;
  const faixa = `de ${numero(menor, 1)} a ${numero(maior, 1)} h de sol (sem nenhuma sombra seriam ${numero(mapa.maximo, 1)} h)`;
  if (anoTodo) {
    $("mapa-status").textContent =
      `Ano todo (pior caso): cada ponto mostra o MENOR valor entre os 12 meses (dia 21 de cada mês), ou seja, o pior mês. ${faixa[0].toUpperCase()}${faixa.slice(1)}.`;
  } else {
    const [ano, mes, dia] = dataEscolhida.split("-");
    $("mapa-status").textContent = `Dia ${dia}/${mes}/${ano}: ${faixa}.`;
  }
  for (const botao of document.querySelectorAll(".planejar-data")) {
    const qual = botao.dataset.data;
    const ativo = anoTodo ? qual === "ano" : qual !== "ano" && dataDoBotao(qual) === dataEscolhida;
    botao.classList.toggle("ativo", ativo);
    botao.setAttribute("aria-pressed", String(ativo));
  }
}

// Cor de um quadradinho: a do mapa de sol, ou (com "Mostrar só as áreas boas
// para…") verde onde é bom para a planta escolhida e cinza onde não é
function corDaCelula(horas) {
  const cultura = plantas.filtroCultura();
  if (!cultura) return CORES_SOL[classificar(horas)];
  const { minimo, maximo } = NECESSIDADE[cultura.sol];
  return horas >= minimo && (maximo === null || horas <= maximo) ? "#1b8a3a" : "#8d8d8d";
}

// Camada do mapa: pinta cada quadradinho com a cor da classificação
adicionarCamada((ctx2, { paraPxX: px, paraPxY: py, escala: esc }) => {
  if (!mapa) return;
  ctx2.save();
  ctx2.globalAlpha = 0.72;
  for (let lin = 0; lin < mapa.linhas; lin++) {
    for (let col = 0; col < mapa.colunas; col++) {
      const i = lin * mapa.colunas + col;
      if (mapa.ocupado[i]) continue;
      ctx2.fillStyle = corDaCelula(mapa.horas[i]);
      const x0 = col * mapa.passo;
      const y0 = lin * mapa.passo;
      const x1 = Math.min(x0 + mapa.passo, terreno.largura);
      const y1 = Math.min(y0 + mapa.passo, terreno.comprimento);
      // +0,5 px para não aparecer risco entre os quadradinhos
      ctx2.fillRect(px(x0), py(y0), (x1 - x0) * esc + 0.5, (y1 - y0) * esc + 0.5);
    }
  }
  ctx2.restore();
});

// Datas rápidas
function dataDoBotao(qual) {
  const ano = Number(dataEscolhida.slice(0, 4));
  if (qual === "hoje") return hojeTexto();
  if (qual === "verao") return `${ano}-12-21`;
  if (qual === "inverno") return `${ano}-06-21`;
  if (qual === "equinocio") return `${ano}-03-21`;
  return dataEscolhida;
}
for (const botao of document.querySelectorAll(".planejar-data")) {
  botao.addEventListener("click", () => {
    if (botao.dataset.data === "ano") {
      anoTodo = true;
    } else {
      anoTodo = false;
      dataEscolhida = dataDoBotao(botao.dataset.data);
      $("data").value = dataEscolhida;
    }
    agendarCalculo(0);
  });
}
$("data").value = dataEscolhida;
$("data").addEventListener("change", () => {
  if (!$("data").value) return;
  dataEscolhida = $("data").value;
  anoTodo = false;
  agendarCalculo(0);
});

// Recalcula quando o terreno muda (com mais espera enquanto arrasta)
quandoTerrenoMudar((opcoes) => agendarCalculo(opcoes.arrastando ? 300 : 150));

// ---------- Dica: "5,5 h de sol" ao passar o mouse ou tocar ----------
// Texto da dica para um ponto (x, y em metros no terreno do cálculo)
function textoDaDica(x, y) {
  if (!mapa || !terrenoCalculado) return null;
  if (x < 0 || y < 0 || x >= terrenoCalculado.largura || y >= terrenoCalculado.comprimento) return null;
  const col = Math.min(Math.floor(x / mapa.passo), mapa.colunas - 1);
  const lin = Math.min(Math.floor(y / mapa.passo), mapa.linhas - 1);
  const i = lin * mapa.colunas + col;
  if (mapa.ocupado[i]) {
    const ob = terrenoCalculado.obstaculos[mapa.ocupado[i] - 1];
    return `${ob ? ob.nome : "Obstáculo"}: ocupado`;
  }
  const h = mapa.horas[i];
  return `${numero(h, 1)} h de sol · ${classificar(h)}${anoTodo ? " (pior mês)" : ""}`;
}

const dica = $("dica-ponto");
let esconderDica = null;
function mostrarDica(evento) {
  if (!mapa || estaArrastando()) { dica.hidden = true; return; }
  const { x, y } = metrosDoEvento(evento);
  const texto = textoDaDica(x, y);
  if (!texto) { dica.hidden = true; return; }
  dica.textContent = texto;
  const rCaixa = caixa.getBoundingClientRect();
  dica.style.left = `${evento.clientX - rCaixa.left}px`;
  dica.style.top = `${evento.clientY - rCaixa.top}px`;
  dica.hidden = false;
  clearTimeout(esconderDica);
  // No toque, a dica some sozinha depois de alguns segundos
  if (evento.pointerType === "touch") esconderDica = setTimeout(() => { dica.hidden = true; }, 2500);
}
canvas.addEventListener("pointermove", mostrarDica);
canvas.addEventListener("pointerdown", mostrarDica);
canvas.addEventListener("pointerleave", (evento) => { if (evento.pointerType !== "touch") dica.hidden = true; });

agendarCalculo(0);

// =====================================================================
//  PLANTAS: o que plantar e onde (a escolha do lugar fica em culturas.js)
// =====================================================================
const CHAVE_PLANTAS = "horta-planejar-plantas-v1";
const AREA_PADRAO = 0.5;  // m²
let escolhidas = carregarPlantas();  // { tomate: 0.5, alface: 1 }

function carregarPlantas() {
  try { return JSON.parse(localStorage.getItem(CHAVE_PLANTAS)) || {}; } catch { return {}; }
}
function salvarPlantas() {
  try { localStorage.setItem(CHAVE_PLANTAS, JSON.stringify(escolhidas)); } catch { /* sem salvar */ }
}


// Lista para marcar as plantas
function montarEscolha() {
  $("escolha-plantas").replaceChildren(...CULTURAS.map((cultura) => {
    const linha = document.createElement("div");
    linha.className = "planejar-planta";
    const marcada = cultura.id in escolhidas;

    const rotulo = document.createElement("label");
    rotulo.className = "planejar-planta-nome";
    const caixaMarcar = document.createElement("input");
    caixaMarcar.type = "checkbox";
    caixaMarcar.checked = marcada;
    const cor = document.createElement("span");
    cor.className = "planejar-cor";
    cor.style.background = cultura.cor;
    const texto = document.createElement("span");
    texto.innerHTML = `<strong></strong> <small></small>`;
    texto.querySelector("strong").textContent = cultura.nome;
    texto.querySelector("small").textContent = NECESSIDADE[cultura.sol].texto;
    rotulo.append(caixaMarcar, cor, texto);

    const rotuloArea = document.createElement("label");
    rotuloArea.className = "planejar-planta-area";
    rotuloArea.textContent = "m² ";
    const area = document.createElement("input");
    area.type = "number";
    area.min = "0.1";
    area.max = "50";
    area.step = "0.1";
    area.value = escolhidas[cultura.id] ?? AREA_PADRAO;
    area.disabled = !marcada;
    area.setAttribute("aria-label", `Área de ${cultura.nome} em metros quadrados`);
    rotuloArea.prepend(area);

    caixaMarcar.addEventListener("change", () => {
      if (caixaMarcar.checked) escolhidas[cultura.id] = Number(area.value) || AREA_PADRAO;
      else delete escolhidas[cultura.id];
      area.disabled = !caixaMarcar.checked;
      salvarPlantas();
      calcularSugestoes();
    });
    area.addEventListener("input", () => {
      const valor = parseFloat(area.value);
      if (Number.isNaN(valor) || !(cultura.id in escolhidas)) return;
      escolhidas[cultura.id] = Math.min(Math.max(valor, 0.1), 50);
      salvarPlantas();
      calcularSugestoes();
    });

    linha.append(rotulo, rotuloArea);
    return linha;
  }));
}

// ---------- Canteiros das plantas (arrastar e girar: plantas.js) ----------
const CHAVE_CANTEIROS = "horta-planejar-canteiros-v1";
let canteirosPorModo = lerCanteiros();  // { livre: { tomate: {...} }, mapa: {...} }
let modoDosCanteiros = null;            // de qual modo são os canteiros que estão no plantas.js

function lerCanteiros() {
  try { return JSON.parse(localStorage.getItem(CHAVE_CANTEIROS)) || { livre: {}, mapa: {} }; } catch { return { livre: {}, mapa: {} }; }
}
function salvarCanteiros() {
  if (modoDosCanteiros !== modo) return;
  canteirosPorModo[modo] = plantas.obterPosicoes();
  try { localStorage.setItem(CHAVE_CANTEIROS, JSON.stringify(canteirosPorModo)); } catch { /* sem salvar */ }
}

const plantas = iniciarPlantas({
  lista: $("sugestoes"),
  vazio: $("sugestoes-vazio"),
  avisos: $("avisos-plantas"),
  resumo: $("resumo-plantas"),
  botaoSugerir: $("sugerir-de-novo"),
  botaoVoltar: $("voltar-sugestao"),
  filtro: $("filtro-planta"),
  filtroNota: $("filtro-nota"),
  aoMudar: (opcoes) => {
    desenhar();
    if (opcoes.salvar) salvarCanteiros();
  }
});

// Depois do cálculo (ou quando mudam as plantas): cada planta ganha ou mantém o seu canteiro
function calcularSugestoes() {
  plantas.atualizar(mapa, terrenoCalculado, escolhidas, anoTodo);
  salvarCanteiros();
  desenhar();
}

// Desenho livre: canteiros por cima dos obstáculos
adicionarCamada((ctx2, { paraPxX: px, paraPxY: py }) => {
  plantas.desenhar(ctx2, (x, y) => ({ x: px(x), y: py(y) }));
}, true);

// Tabela "Umidade e sol por cultura"
$("tabela-culturas").replaceChildren(...CULTURAS.map((cultura) => {
  const tr = document.createElement("tr");
  for (const texto of [cultura.nome, NECESSIDADE[cultura.sol].texto, `${cultura.umidade[0]}–${cultura.umidade[1]}%`]) {
    const td = document.createElement("td");
    td.textContent = texto;
    tr.append(td);
  }
  return tr;
}));

montarEscolha();
quandoMapaPronto(() => calcularSugestoes());

// =====================================================================
//  MODO: "Sobre o mapa" (satélite, em mapa.js) ou "Desenho livre" (canvas)
// =====================================================================
const modoMapa = iniciarModoMapa({
  elemento: $("mapa-satelite"),
  busca: $("busca"),
  buscaTexto: $("busca-texto"),
  buscaStatus: $("busca-status"),
  botaoLocalizacao: $("minha-localizacao"),
  camadaNomes: $("camada-nomes"),
  lista: $("lista-obstaculos"),
  editor: $("editor"),
  ferramentaStatus: $("ferramenta-status"),
  aoMudar: (opcoes) => {
    agendarCalculo(opcoes.arrastando ? 300 : 150);
    if (!opcoes.arrastando) salvarMapa();
  },
  aoMudarVista: () => salvarMapa(),
  textoDoPonto: textoDaDica,
  // Toque numa planta: o plantas.js cuida (e o mapa não anda enquanto ela é arrastada)
  pegarToque: (p) => {
    const t = modoMapa.pontoNoTerreno(p);
    if (!t) return null;
    const manipulador = plantas.tocar(t, p);
    if (!manipulador || manipulador === true) return manipulador;
    return {
      mover: (p2) => manipulador.mover(modoMapa.pontoNoTerreno(p2)),
      soltar: () => manipulador.soltar()
    };
  }
});
for (const botao of document.querySelectorAll("[data-ferramenta]")) {
  botao.addEventListener("click", () => modoMapa.usarFerramenta(botao.dataset.ferramenta));
}

function trocarModo(novo) {
  if (novo === "mapa" && !modoMapa.disponivel) novo = "livre";  // sem Leaflet (sem internet)
  salvarCanteiros();  // guarda os canteiros do modo que está saindo
  modo = novo;
  try { localStorage.setItem(CHAVE_MODO, modo); } catch { /* sem salvar */ }
  document.body.classList.toggle("modo-mapa", modo === "mapa");
  document.body.classList.toggle("modo-livre", modo === "livre");
  for (const botao of document.querySelectorAll(".planejar-modo")) {
    botao.setAttribute("aria-pressed", String(botao.dataset.modo === modo));
  }
  mapa = null;  // o mapa de sol era do outro modo: calcula de novo
  // Cada modo tem os seus canteiros (o terreno é outro)
  plantas.definirPosicoes(canteirosPorModo[modo] || {});
  modoDosCanteiros = modo;
  agendarCalculo(0);
  if (modo === "mapa") {
    modoMapa.mostrar();
  } else {
    modoMapa.usarFerramenta(null);
    medir();
    mostrarLista();
    mostrarEditor();
    desenhar();
  }
}
for (const botao of document.querySelectorAll(".planejar-modo")) {
  botao.addEventListener("click", () => trocarModo(botao.dataset.modo));
}

// ---------- Mapa de sol e plantas por cima da imagem de satélite ----------
// A grade do cálculo segue o terreno (mesmo girado): cada quadradinho vira
// um quadrilátero na tela.
let opacidadeMapa = Number($("opacidade").value) / 100;
$("opacidade").addEventListener("input", () => {
  opacidadeMapa = Number($("opacidade").value) / 100;
  $("opacidade-valor").textContent = `${$("opacidade").value}%`;
  desenhar();
});

modoMapa.adicionarCamada((ctx2, { terreno: noMapa, pixelDaForma }) => {
  if (!mapa || !terrenoCalculado || !noMapa) return;
  const L = terrenoCalculado.largura;
  const C = terrenoCalculado.comprimento;
  // Metros no terreno (x para a direita, y para baixo) -> pixel na tela
  const pixel = (x, y) => pixelDaForma(noMapa, Math.min(x, L) - L / 2, C / 2 - Math.min(y, C));
  // Cantos de todos os quadradinhos (calculados uma vez por desenho)
  const cantos = [];
  for (let lin = 0; lin <= mapa.linhas; lin++) {
    for (let col = 0; col <= mapa.colunas; col++) cantos.push(pixel(col * mapa.passo, lin * mapa.passo));
  }
  const canto = (lin, col) => cantos[lin * (mapa.colunas + 1) + col];
  const pintar = (i) => {
    const lin = Math.floor(i / mapa.colunas);
    const col = i % mapa.colunas;
    const a = canto(lin, col);
    const b = canto(lin, col + 1);
    const c = canto(lin + 1, col + 1);
    const d = canto(lin + 1, col);
    ctx2.beginPath();
    ctx2.moveTo(a.x, a.y);
    ctx2.lineTo(b.x, b.y);
    ctx2.lineTo(c.x, c.y);
    ctx2.lineTo(d.x, d.y);
    ctx2.closePath();
    ctx2.fill();
    ctx2.stroke();  // um contorno da mesma cor esconde os riscos entre os quadradinhos
  };

  ctx2.save();
  ctx2.lineWidth = 1;
  ctx2.globalAlpha = opacidadeMapa;
  for (let i = 0; i < mapa.horas.length; i++) {
    if (mapa.ocupado[i]) continue;
    ctx2.fillStyle = ctx2.strokeStyle = corDaCelula(mapa.horas[i]);
    pintar(i);
  }
  ctx2.restore();
});

// Canteiros das plantas por cima do mapa (e dos obstáculos)
modoMapa.adicionarCamada((ctx2, { terreno: noMapa, pixelDaForma }) => {
  if (!noMapa || !terrenoCalculado) return;
  const L = terrenoCalculado.largura;
  const C = terrenoCalculado.comprimento;
  plantas.desenhar(ctx2, (x, y) => pixelDaForma(noMapa, x - L / 2, C / 2 - y));
}, true);

// =====================================================================
//  SALVAR E COMPARTILHAR
// =====================================================================
const CHAVE_MODO = "horta-planejar-modo-v1";
const CHAVE_MAPA = "horta-planejar-mapa-v1";

// Salva o desenho do mapa (centro, zoom, terreno e obstáculos) no navegador
function salvarMapa() {
  try { localStorage.setItem(CHAVE_MAPA, JSON.stringify(modoMapa.obterEstado())); } catch { /* sem salvar */ }
}
function lerSalvo(chave) {
  try { return JSON.parse(localStorage.getItem(chave)); } catch { return null; }
}

// ---------- Link: o desenho vai inteiro no endereço (#p=...) ----------
// JSON "compacto" (nomes curtos, números arredondados) -> texto em base64.
const arred = (v, casas) => Math.round(v * 10 ** casas) / 10 ** casas;
const ponto = (latlng) => [arred(latlng[0], 7), arred(latlng[1], 7)];

function compactar() {
  const dados = { v: 1, m: modo, p: escolhidas };
  // Canteiros: [x, y, w, h, girada] de cada planta
  dados.k = {};
  for (const [id, r] of Object.entries(plantas.obterPosicoes())) {
    if (r) dados.k[id] = [arred(r.x, 2), arred(r.y, 2), arred(r.w, 2), arred(r.h, 2), r.girada ? 1 : 0];
  }
  if (modo === "mapa") {
    const e = modoMapa.obterEstado();
    dados.c = ponto(e.centro);
    dados.z = e.zoom;
    if (e.terreno) {
      const t = e.terreno;
      dados.t = [...ponto(t.centro), arred(t.largura, 2), arred(t.comprimento, 2), t.angulo || 0];
    }
    dados.o = e.obstaculos.map((ob) => (ob.tipo === "circulo"
      ? ["c", ob.nome, ...ponto(ob.centro), arred(ob.raio, 2), ob.altura]
      : ["r", ob.nome, ...ponto(ob.centro), arred(ob.largura, 2), arred(ob.profundidade, 2), ob.angulo || 0, ob.altura]));
  } else {
    dados.l = terreno;
  }
  return dados;
}

function descompactar(dados) {
  if (!dados || dados.v !== 1) return false;
  if (dados.p && typeof dados.p === "object") escolhidas = dados.p;
  if (dados.k && typeof dados.k === "object") {
    const canteiros = {};
    for (const [id, k] of Object.entries(dados.k)) canteiros[id] = { x: k[0], y: k[1], w: k[2], h: k[3], girada: !!k[4] };
    canteirosPorModo[dados.m === "mapa" ? "mapa" : "livre"] = canteiros;
    try { localStorage.setItem(CHAVE_CANTEIROS, JSON.stringify(canteirosPorModo)); } catch { /* sem salvar */ }
  }
  if (dados.m === "mapa") {
    const t = dados.t;
    modoMapa.aplicarEstado({
      centro: dados.c,
      zoom: dados.z,
      terreno: t ? { centro: [t[0], t[1]], largura: t[2], comprimento: t[3], angulo: t[4] } : null,
      obstaculos: (dados.o || []).map((o) => (o[0] === "c"
        ? { tipo: "circulo", nome: o[1], centro: [o[2], o[3]], raio: o[4], altura: o[5] }
        : { tipo: "retangulo", nome: o[1], centro: [o[2], o[3]], largura: o[4], profundidade: o[5], angulo: o[6], altura: o[7] }))
    });
  } else if (dados.l && typeof dados.l.largura === "number") {
    terreno = dados.l;
  }
  return dados.m === "mapa" ? "mapa" : "livre";
}

// base64 que aceita acentos (UTF-8) e não usa "+" nem "/" (ficam estranhos no link)
function paraBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let binario = "";
  bytes.forEach((b) => { binario += String.fromCharCode(b); });
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function deBase64(codigo) {
  const binario = atob(codigo.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binario, (c) => c.charCodeAt(0)));
}

$("copiar-link").addEventListener("click", async () => {
  const link = `${location.origin}${location.pathname}#p=${paraBase64(JSON.stringify(compactar()))}`;
  try {
    await navigator.clipboard.writeText(link);
    $("link-status").textContent = "Link copiado! Quem abrir vê a mesma horta.";
    $("link-texto").hidden = true;
  } catch {
    // Sem permissão para copiar: mostra o link para copiar à mão
    $("link-status").textContent = "Copie o link abaixo:";
    $("link-texto").value = link;
    $("link-texto").hidden = false;
    $("link-texto").select();
  }
});

// ---------- Ao abrir a página: link compartilhado, ou o que estava salvo ----------
function iniciarModo() {
  let modoInicial = null;
  const codigo = location.hash.match(/[#&]p=([\w-]+)/);
  if (codigo) {
    try {
      modoInicial = descompactar(JSON.parse(deBase64(codigo[1])));
      salvar();
      salvarPlantas();
      montarEscolha();
      preencherCampos();
    } catch {
      modoInicial = null;  // link quebrado: abre normalmente
    }
    history.replaceState(null, "", location.pathname);  // tira o #p= do endereço
  }
  if (!modoInicial) {
    const salvoMapa = lerSalvo(CHAVE_MAPA);
    if (salvoMapa) modoMapa.aplicarEstado(salvoMapa);
    try { modoInicial = localStorage.getItem(CHAVE_MODO); } catch { /* sem salvo */ }
  }
  trocarModo(modoInicial || "mapa");
  if (modoInicial === "mapa" || !modoInicial) salvarMapa();
}
iniciarModo();
