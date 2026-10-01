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
import { CULTURAS, NECESSIDADE, NIVEIS } from "./culturas.js";
import { iniciarModoMapa } from "./mapa.js";
import { iniciarPlantas } from "./plantas.js";
import { desenharPlanta, avaliarPlantas, textoNecessidade, textoUmidade } from "./planta.js";
import {
  EDITOR, formatarCodigo, normalizarCodigo, criarHorta, lerHorta, salvarHorta, marcarArquivada,
  lerVersoes, salvarVersao, ouvirHorta, ouvirConexao
} from "./nuvem.js";
import { desenharQR } from "./qr.js";
import { ligarLinksTelegram } from "./config.js";
import { iniciarCabecalho } from "./cabecalho.js";

iniciarCabecalho();
ligarLinksTelegram();  // link "Alertas no Telegram" do rodapé

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
let aoMudarProjeto = null; // avisado a cada mudança salva (a nuvem usa para o salvamento automático)
const projetoMudou = () => { if (aoMudarProjeto) aoMudarProjeto(); };
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
  projetoMudou();
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
  projetoMudou();
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
  projetoMudou();
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
  projetoMudou();
}
function lerSalvo(chave) {
  try { return JSON.parse(localStorage.getItem(chave)); } catch { return null; }
}

// ---------- Link: o desenho vai inteiro no endereço (#p=...) ----------
// JSON "compacto" (nomes curtos, números arredondados) -> texto em base64.
const arred = (v, casas) => Math.round(v * 10 ** casas) / 10 ** casas;
let exato = false;  // true: sem arredondar as coordenadas (projetos salvos e arquivos)
const ponto = (latlng) => (exato ? [latlng[0], latlng[1]] : [arred(latlng[0], 7), arred(latlng[1], 7)]);

// exato = true guarda as coordenadas inteiras: aberto de novo, o cálculo dá
// exatamente igual (no link, 7 casas bastam e o link fica mais curto)
function compactar(comoEsta = false) {
  exato = comoEsta;
  const dados = { v: 1, m: modo, p: escolhidas, d: dataEscolhida, a: anoTodo ? 1 : 0 };
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
  exato = false;
  return dados;
}

function descompactar(dados) {
  if (!dados || dados.v !== 1) return false;
  escolhidas = dados.p && typeof dados.p === "object" ? dados.p : {};
  // Data do cálculo (links antigos não têm: fica a de hoje)
  if (typeof dados.d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dados.d)) {
    dataEscolhida = dados.d;
    $("data").value = dados.d;
  }
  anoTodo = dados.a === 1;
  const canteiros = {};
  if (dados.k && typeof dados.k === "object") {
    for (const [id, k] of Object.entries(dados.k)) canteiros[id] = { x: k[0], y: k[1], w: k[2], h: k[3], girada: !!k[4] };
  }
  canteirosPorModo[dados.m === "mapa" ? "mapa" : "livre"] = canteiros;
  try { localStorage.setItem(CHAVE_CANTEIROS, JSON.stringify(canteirosPorModo)); } catch { /* sem salvar */ }
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

// ---------- Abrir um projeto (arquivo .json ou "Minhas hortas") ----------
function abrirProjeto(dados) {
  const novoModo = descompactar(dados);
  if (!novoModo) return false;
  selecionado = -1;
  salvar();
  salvarPlantas();
  montarEscolha();
  preencherCampos();
  modoDosCanteiros = null;  // os canteiros do projeto não podem ser trocados pelos que estavam na tela
  trocarModo(novoModo);
  if (novoModo === "mapa") salvarMapa();
  return true;
}

// =====================================================================
//  SALVAR A PLANTA: imagem (PNG), impressão (A4 / PDF) e backup (.json)
// =====================================================================
const NOME_PADRAO = "Minha horta";
const CHAVE_NOME = "horta-planejar-nome-v1";  // nome do projeto que está na tela (rascunho)
// O campo começa vazio ("Minha horta" é só o exemplo apagado); vazio vale "Minha horta"
const nomeDoProjeto = () => $("nome-projeto").value.trim() || NOME_PADRAO;
function definirNome(nome) {
  $("nome-projeto").value = nome && nome !== NOME_PADRAO ? nome : "";
  try { localStorage.setItem(CHAVE_NOME, $("nome-projeto").value); } catch { /* sem salvar */ }
}
try { definirNome(localStorage.getItem(CHAVE_NOME) || ""); } catch { $("nome-projeto").value = ""; }
$("nome-projeto").addEventListener("input", () => {
  try { localStorage.setItem(CHAVE_NOME, $("nome-projeto").value); } catch { /* sem salvar */ }
  projetoMudou();
});

// Dados para o desenho da planta (planta.js). null = ainda não dá para desenhar.
function projetoParaPlanta() {
  if (!mapa && terrenoDoCalculo()) calcularMapa();  // cálculo ainda não rodou
  if (!mapa || !terrenoCalculado) return null;
  return {
    titulo: nomeDoProjeto(),
    terreno: terrenoCalculado,
    mapa,
    escolhidas,
    posicoes: plantas.obterPosicoes(),
    anoTodo,
    data: dataEscolhida
  };
}

// "Minha Horta 8º D" -> "horta-minha-horta-8-d.png"
function nomeDoArquivo(extensao) {
  const simples = nomeDoProjeto().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `horta-${simples || "minha-horta"}.${extensao}`;
}

// Baixa um arquivo (Blob) com o nome dado
function baixar(blob, nome) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = nome;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

const statusSalvar = (texto) => { $("salvar-status").textContent = texto; };
const SEM_TERRENO = "Desenhe o terreno primeiro: sem ele não há planta para salvar.";
const fecharMenuSalvar = () => { $("menu-salvar").open = false; };

// 1) Imagem PNG em alta resolução (lado maior com 2400 pixels)
$("salvar-png").addEventListener("click", () => {
  fecharMenuSalvar();
  const projeto = projetoParaPlanta();
  if (!projeto) { statusSalvar(SEM_TERRENO); return; }
  const imagem = desenharPlanta(document.createElement("canvas"), projeto, { ladoMaior: 2400 });
  imagem.toBlob((blob) => {
    baixar(blob, nomeDoArquivo("png"));
    statusSalvar(`Imagem salva: ${nomeDoArquivo("png")}`);
  }, "image/png");
});

// 2) Imprimir / PDF: mostra a folha A4 na tela; "Imprimir" chama o navegador
function abrirImpressao() {
  const projeto = projetoParaPlanta();
  if (!projeto) { statusSalvar(SEM_TERRENO); return; }
  $("impressao-planta").src = desenharPlanta(document.createElement("canvas"), projeto, { ladoMaior: 2000 }).toDataURL("image/png");
  const linhas = avaliarPlantas(projeto);
  const h = (v) => (v === null ? "—" : `${numero(v, 1)} h`);
  $("impressao-plantas").replaceChildren(...linhas.map((l) => {
    const tr = document.createElement("tr");
    const nivel = l.av ? NIVEIS[l.av.nivel] : null;
    const celulas = [
      l.cultura.nome,
      numero(l.area, 2),
      h(l.av ? l.av.minimo : null),
      h(l.av ? l.av.media : null),
      textoNecessidade(l.cultura),
      textoUmidade(l.cultura),
      nivel ? `${nivel.icone} ${nivel.texto}` : "—",
      l.notas.length ? l.notas.join("; ") : "—"
    ];
    for (const texto of celulas) {
      const td = document.createElement("td");
      td.textContent = texto;
      tr.append(td);
    }
    if (l.av) tr.children[6].className = `impressao-nivel nivel-${l.av.nivel}`;
    return tr;
  }));
  $("impressao-sem-plantas").hidden = linhas.length > 0;
  $("impressao-tabela").hidden = linhas.length === 0;
  $("impressao").hidden = false;
  document.body.classList.add("imprimindo");
  $("imprimir-agora").focus();
}
function fecharImpressao() {
  $("impressao").hidden = true;
  document.body.classList.remove("imprimindo");
}
$("salvar-impressao").addEventListener("click", () => { fecharMenuSalvar(); abrirImpressao(); });
$("imprimir-agora").addEventListener("click", () => window.print());
$("fechar-impressao").addEventListener("click", fecharImpressao);
document.addEventListener("keydown", (evento) => {
  if (evento.key === "Escape" && !$("impressao").hidden) fecharImpressao();
});
// O que a pessoa escreve nos campos aparece como texto na folha impressa
for (const [campo, espelho] of [["impressao-turma", "impressao-turma-texto"], ["impressao-obs", "impressao-obs-texto"]]) {
  $(campo).addEventListener("input", () => { $(espelho).textContent = $(campo).value; });
}

// 3) Backup (.json): uma cópia da horta no computador (fora da nuvem, ou para usar sem internet)
const FORMATO_ARQUIVO = "horta-inteligente-projeto";
$("salvar-arquivo").addEventListener("click", () => {
  fecharMenuSalvar();
  const arquivo = { formato: FORMATO_ARQUIVO, versao: 1, nome: nomeDoProjeto(), salvoEm: new Date().toISOString(), projeto: compactar(true) };
  baixar(new Blob([JSON.stringify(arquivo, null, 2)], { type: "application/json" }), nomeDoArquivo("json"));
  statusSalvar(`Backup salvo: ${nomeDoArquivo("json")}. Para voltar a ele, use "Abrir backup (.json)" no menu Salvar planta.`);
});
$("abrir-arquivo").addEventListener("click", () => { fecharMenuSalvar(); $("arquivo-projeto").click(); });
$("arquivo-projeto").addEventListener("change", async () => {
  const escolhido = $("arquivo-projeto").files[0];
  $("arquivo-projeto").value = "";  // deixa abrir o mesmo arquivo de novo
  if (!escolhido) return;
  try {
    const arquivo = JSON.parse(await escolhido.text());
    if (arquivo.formato !== FORMATO_ARQUIVO || !arquivo.projeto || arquivo.projeto.v !== 1) throw new Error("formato");
    abrirBackup(arquivo);  // (parte da nuvem: pergunta se há uma horta com código aberta)
  } catch {
    statusSalvar("Não consegui abrir: esse arquivo não é um backup da Horta Inteligente.");
  }
});

// ---------- Projetos antigos, salvos só neste navegador (antes da nuvem) ----------
// Cada um: { id, nome, modificadoEm (data ISO), dados (o mesmo do link), miniatura }.
// Na lista "Minhas hortas" cada um tem o botão "Enviar para a nuvem".
const CHAVE_PROJETOS = "horta-planejar-projetos-v1";

function lerProjetos() {
  try {
    const lista = JSON.parse(localStorage.getItem(CHAVE_PROJETOS));
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}
function gravarProjetos(lista) {
  try {
    localStorage.setItem(CHAVE_PROJETOS, JSON.stringify(lista));
    return true;
  } catch {
    return false;
  }
}

// A planta pequenininha, para a lista (JPEG, bem leve)
function miniatura() {
  const projeto = projetoParaPlanta();
  if (!projeto) return null;
  return desenharPlanta(document.createElement("canvas"), projeto, { ladoMaior: 320 }).toDataURL("image/jpeg", 0.7);
}

// "29/09/2026 14:05"
function dataHora(quando) {
  const d = new Date(quando);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const botaoPequeno = (texto, aoClicar, extra = "") => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `planejar-botao planejar-botao-pequeno ${extra}`;
  b.textContent = texto;
  b.addEventListener("click", aoClicar);
  return b;
};

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

// =====================================================================
//  HORTAS NA NUVEM, SEM LOGIN (o banco fica em nuvem.js)
// =====================================================================
// A horta salva ganha um código. Quem tem o código abre e altera.
// Depois de salvar uma vez, cada mudança é enviada sozinha 3 s depois
// que a pessoa para de mexer.
const CHAVE_NUVEM = "horta-planejar-nuvem-v1";  // { codigo, pendente }: a horta aberta nesta tela
const ESPERA_AUTOMATICO = 3000;                  // ms parado antes de enviar
const INTERVALO_VERSAO = 5 * 60 * 1000;          // uma cópia no histórico a cada 5 min de edição

let horta = null;             // { codigo, arquivada } da horta aberta (null = só neste aparelho)
let pararDeOuvir = null;
let conectado = null;         // null = ainda não sei; true / false
let pendente = false;         // tem mudança que não chegou à nuvem (sem conexão)
let ultimoEnviado = null;     // dados (texto) que a nuvem tem
let ultimoNome = null;
let ultimoVisto = null;       // atualizadoEm que esta tela já conhece
let ultimaVersaoEm = 0;
let conflito = null;          // { atualizadoEm } quando outro aparelho salvou por cima
let ultimaManual = null;      // { codigo, slot, quando }: a versão do último "Salvar" (para trocar no mesmo minuto)
let temporizadorNuvem = null;

const dadosAtuais = () => JSON.stringify(compactar(true));
// Mesmo desenho? (ignora só o centro e o zoom da vista do mapa)
function mesmoProjeto(a, b) {
  try {
    const [x, y] = [JSON.parse(a), JSON.parse(b)];
    for (const d of [x, y]) { delete d.c; delete d.z; }
    return JSON.stringify(x) === JSON.stringify(y);
  } catch {
    return a === b;
  }
}
const statusNuvem = (texto) => {
  $("nuvem-status").textContent = texto;
  $("nuvem-status").hidden = !texto;
};
const textoSalvo = () => `Salvo na nuvem ✓ · código ${formatarCodigo(horta.codigo)}`;
const SEM_CONEXAO = "Sem conexão: salvo neste aparelho, envio quando voltar";

function guardarNuvemLocal() {
  try {
    if (horta) localStorage.setItem(CHAVE_NUVEM, JSON.stringify({ codigo: horta.codigo, pendente }));
    else localStorage.removeItem(CHAVE_NUVEM);
  } catch { /* sem salvar */ }
}

// Mensagem de erro que a pessoa entende
function textoDoErro(erro) {
  if (String(erro && (erro.code || erro.message)).toLowerCase().includes("permission")) {
    return "o banco recusou (as regras do Firebase estão publicadas?)";
  }
  return "sem conexão com o banco";
}

// Conexão: quando a internet volta, envia o que ficou pendente
let ouvindoConexao = false;
function iniciarConexao() {
  if (ouvindoConexao) return;
  ouvindoConexao = true;
  const inicio = Date.now();
  ouvirConexao((ligado) => {
    // No começo o Firebase diz "desligado" até conectar: só acredita depois de uns segundos
    if (!ligado && conectado === null && Date.now() - inicio < 4000) return;
    conectado = ligado;
    if (!horta) return;
    if (!ligado) statusNuvem(SEM_CONEXAO);
    else if (pendente) salvarNaNuvem({ forcar: true });
    else if (!conflito) statusNuvem(textoSalvo());
  });
}

// Mostra na tela os botões e a faixa conforme a horta aberta
function mostrarHortaAberta() {
  $("nuvem-acoes").hidden = !horta;
  $("salvar-nuvem").textContent = horta ? "☁ Salvar na nuvem" : "☁ Salvar na nuvem (criar código)";
  if (!horta) {
    $("historico").hidden = true;
    statusNuvem("");
  }
  aplicarArquivada();
}

// Horta arquivada: faixa no topo e nada de editar (até desarquivar)
function aplicarArquivada() {
  const arquivada = !!(horta && horta.arquivada);
  $("faixa-arquivada").hidden = !arquivada;
  $("arquivar").textContent = arquivada ? "📂 Desarquivar" : "🗄 Arquivar";
  for (const parte of document.querySelectorAll(".planejar-modos, .planejar-area:not(.planejar-area-plantas), .planejar-plantas")) {
    parte.inert = arquivada;
    parte.classList.toggle("planejar-travado", arquivada);
  }
}

// ---------- Ouvir a horta aberta: outra aba ou aparelho salvou? ----------
async function ouvir(codigo) {
  if (pararDeOuvir) pararDeOuvir();
  pararDeOuvir = null;
  iniciarConexao();
  try {
    const parar = await ouvirHorta(codigo, (info) => {
      if (!horta || horta.codigo !== codigo) return;
      if (info.editor === EDITOR) {  // fui eu que salvei
        ultimoVisto = info.atualizadoEm;
        return;
      }
      if (info.atualizadoEm !== null && info.atualizadoEm !== ultimoVisto) mostrarConflito(info.atualizadoEm);
    });
    if (horta && horta.codigo === codigo) pararDeOuvir = parar;
    else parar();
  } catch {
    statusNuvem(SEM_CONEXAO);
  }
}

function mostrarConflito(atualizadoEm) {
  clearTimeout(temporizadorNuvem);  // não salva por cima enquanto a pessoa decide
  conflito = { atualizadoEm };
  $("aviso-conflito").hidden = false;
}
function esconderConflito() {
  conflito = null;
  $("aviso-conflito").hidden = true;
}
$("conflito-recarregar").addEventListener("click", async () => {
  const codigo = horta && horta.codigo;
  esconderConflito();
  if (!codigo) return;
  try {
    const valor = await lerHorta(codigo);
    if (valor) mostrarHortaNaTela(codigo, valor);
  } catch (erro) {
    statusNuvem(`Não consegui recarregar: ${textoDoErro(erro)}.`);
  }
});
$("conflito-continuar").addEventListener("click", () => {
  if (conflito) ultimoVisto = conflito.atualizadoEm;
  esconderConflito();
  salvarNaNuvem({ forcar: true });  // a minha versão vai por cima
});

// ---------- Abrir uma horta da nuvem nesta tela ----------
function mostrarHortaNaTela(codigo, valor) {
  let dados;
  try { dados = JSON.parse(valor.dados); } catch { dados = null; }
  if (!dados || !abrirProjeto(dados)) {
    statusCodigo("Essa horta está com os dados estragados; não consegui abrir.");
    return false;
  }
  clearTimeout(temporizadorNuvem);  // abrir não é "mexer": não precisa enviar de volta
  definirNome(valor.nome);
  horta = { codigo, arquivada: valor.arquivada === true };
  pendente = false;
  ultimoEnviado = valor.dados;
  ultimoNome = valor.nome;
  ultimoVisto = valor.atualizadoEm;
  ultimaVersaoEm = Date.now();
  esconderConflito();
  guardarNuvemLocal();
  mostrarHortaAberta();
  statusNuvem(textoSalvo());
  registrarHorta(codigo, valor.nome);
  ouvir(codigo);
  conferirNomeRepetido();
  return true;
}

async function abrirPorCodigo(codigo) {
  statusCodigo("Procurando…");
  await enviarPendencias();  // o que estava na tela antes vai para a nuvem
  try {
    const valor = await lerHorta(codigo);
    if (!valor) {
      statusCodigo("Não encontrei uma horta com esse código.");
      return;
    }
    if (mostrarHortaNaTela(codigo, valor)) {
      statusCodigo(`Horta "${valor.nome}" aberta.`);
      $("codigo-digitado").value = "";
    }
  } catch (erro) {
    statusCodigo(`Não consegui abrir: ${textoDoErro(erro)}.`);
  }
}

$("form-codigo").addEventListener("submit", (evento) => {
  evento.preventDefault();
  const codigo = normalizarCodigo($("codigo-digitado").value);
  if (!codigo) {
    statusCodigo("Código inválido: são 8 letras e números (ex.: HX7K-2Q9M).");
    return;
  }
  abrirPorCodigo(codigo);
});

// ---------- Salvar ----------
// manual: botão "Salvar na nuvem" (também grava uma versão no histórico)
// forcar: envia mesmo sem mudança (depois de voltar a conexão, ou "Continuar com a minha")
async function salvarNaNuvem({ manual = false, forcar = false } = {}) {
  clearTimeout(temporizadorNuvem);
  temporizadorNuvem = null;
  if (!horta || horta.arquivada || conflito) return;
  const codigo = horta.codigo;
  const dados = dadosAtuais();
  const nome = nomeDoProjeto();
  if (!manual && !forcar && dados === ultimoEnviado && nome === ultimoNome) return;
  if (conectado === false) {
    pendente = true;
    guardarNuvemLocal();
    statusNuvem(SEM_CONEXAO);
    return;
  }
  statusNuvem("Salvando…");
  try {
    await salvarHorta(codigo, { nome, dados });
    if (manual) {
      // No máximo uma versão por minuto: outro "Salvar" logo depois troca a do mesmo minuto
      const recente = ultimaManual && ultimaManual.codigo === codigo && Date.now() - ultimaManual.quando < 60000;
      const slot = await gravarVersao(codigo, { nome, dados, tipo: "manual", substituir: recente ? ultimaManual.slot : null });
      if (slot !== null) ultimaManual = { codigo, slot, quando: recente ? ultimaManual.quando : Date.now() };
      ultimaVersaoEm = Date.now();
    } else if (Date.now() - ultimaVersaoEm >= INTERVALO_VERSAO) {
      await gravarVersao(codigo, { nome, dados, tipo: "auto" });
      ultimaVersaoEm = Date.now();
    }
    if (!horta || horta.codigo !== codigo) return;
    ultimoEnviado = dados;
    ultimoNome = nome;
    pendente = false;
    guardarNuvemLocal();
    statusNuvem(textoSalvo());
    registrarHorta(codigo, nome);
  } catch (erro) {
    pendente = true;
    guardarNuvemLocal();
    statusNuvem(`Não consegui salvar na nuvem: ${textoDoErro(erro)}. Continua salvo neste aparelho.`);
  }
}

// Envia já o que estava esperando os 3 s (antes de trocar de horta)
async function enviarPendencias() {
  if (horta && (temporizadorNuvem || pendente)) await salvarNaNuvem({ forcar: pendente });
}

// Salvamento automático: 3 s depois da última mudança
aoMudarProjeto = () => {
  if (!horta || horta.arquivada || conflito) return;
  clearTimeout(temporizadorNuvem);
  temporizadorNuvem = setTimeout(() => salvarNaNuvem(), ESPERA_AUTOMATICO);
};

// Cria uma horta nova na nuvem com o que está na tela e mostra o código
async function criarNaNuvem(nome) {
  if (conectado === false) {
    statusNuvem("Sem conexão: para criar o código é preciso internet. O desenho continua salvo neste aparelho.");
    return false;
  }
  statusNuvem("Criando o código…");
  try {
    const dados = dadosAtuais();
    const codigo = await criarHorta({ nome, dados });
    await gravarVersao(codigo, { nome, dados, tipo: "manual" });
    if (pararDeOuvir) pararDeOuvir();
    pararDeOuvir = null;
    horta = { codigo, arquivada: false };
    pendente = false;
    ultimoEnviado = dados;
    ultimoNome = nome;
    ultimoVisto = null;
    ultimaVersaoEm = Date.now();
    esconderConflito();
    definirNome(nome);
    guardarNuvemLocal();
    mostrarHortaAberta();
    statusNuvem(textoSalvo());
    registrarHorta(codigo, nome);
    ouvir(codigo);
    mostrarQuadroCodigo();
    conferirNomeRepetido();
    return true;
  } catch (erro) {
    statusNuvem(`Não consegui criar o código: ${textoDoErro(erro)}.`);
    return false;
  }
}

$("salvar-nuvem").addEventListener("click", async () => {
  if (!horta) { await criarNaNuvem(nomeDoProjeto()); return; }
  if (horta.arquivada) { statusNuvem("Horta arquivada: desarquive para salvar."); return; }
  if (conflito) { statusNuvem("Escolha antes: recarregar a versão nova ou continuar com a sua."); return; }
  await salvarNaNuvem({ manual: true });
});

// ---------- Quadro com o código, o link e o QR code ----------
const linkDaHorta = (codigo) => `${location.origin}${location.pathname}?h=${codigo}`;
function mostrarQuadroCodigo(codigo = horta && horta.codigo) {
  if (typeof codigo !== "string") return;  // (clique no botão passa o evento)
  const link = linkDaHorta(codigo);
  $("quadro-codigo-texto").textContent = formatarCodigo(codigo);
  $("quadro-link").value = link;
  $("quadro-copiar-status").textContent = "";
  desenharQR($("quadro-qr"), link);
  $("quadro-codigo").hidden = false;
  $("quadro-copiar").focus();
}
const fecharQuadroCodigo = () => { $("quadro-codigo").hidden = true; };
$("mostrar-codigo").addEventListener("click", () => mostrarQuadroCodigo());
$("quadro-fechar").addEventListener("click", fecharQuadroCodigo);
$("quadro-codigo").addEventListener("click", (evento) => { if (evento.target === $("quadro-codigo")) fecharQuadroCodigo(); });
document.addEventListener("keydown", (evento) => {
  if (evento.key === "Escape" && !$("quadro-codigo").hidden) fecharQuadroCodigo();
});
$("quadro-copiar").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("quadro-link").value);
    $("quadro-copiar-status").textContent = "Link copiado!";
  } catch {
    $("quadro-link").select();
    $("quadro-copiar-status").textContent = "Selecionei o link: copie com Ctrl+C (ou segure o dedo e escolha Copiar).";
  }
});

// ---------- Fazer uma cópia (código novo, a original não muda) ----------
$("fazer-copia").addEventListener("click", async () => {
  if (!horta) return;
  await enviarPendencias();
  const nome = `${nomeDoProjeto()} (cópia)`.slice(0, 60);
  if (await criarNaNuvem(nome)) statusSalvar("Cópia criada: este é o código novo. A horta original não mudou.");
});

// ---------- Arquivar / desarquivar ----------
async function trocarArquivada() {
  if (!horta) return;
  const arquivar = !horta.arquivada;
  if (arquivar) await enviarPendencias();
  try {
    await marcarArquivada(horta.codigo, arquivar);
    horta.arquivada = arquivar;
    aplicarArquivada();
    statusNuvem(arquivar ? `Horta arquivada · código ${formatarCodigo(horta.codigo)}` : textoSalvo());
  } catch (erro) {
    statusNuvem(`Não consegui ${arquivar ? "arquivar" : "desarquivar"}: ${textoDoErro(erro)}.`);
  }
}
$("arquivar").addEventListener("click", trocarArquivada);
$("desarquivar-faixa").addEventListener("click", trocarArquivada);

// ---------- Resumo de uma versão: o que tem e o que mudou ----------
// Lê os dados compactos (os mesmos do link) e conta terreno, obstáculos e plantas.
function lerConteudo(texto) {
  let d;
  try { d = typeof texto === "string" ? JSON.parse(texto) : texto; } catch { return null; }
  if (!d) return null;
  let terrenoMedidas = null;
  let obstaculos = [];
  if (d.m === "mapa") {
    if (d.t) terrenoMedidas = [d.t[2], d.t[3]];
    obstaculos = (d.o || []).map((o) => ({ nome: o[1], onde: JSON.stringify(o.slice(2)) }));
  } else if (d.l) {
    terrenoMedidas = [d.l.largura, d.l.comprimento];
    obstaculos = (d.l.obstaculos || []).map((o) => ({ nome: o.nome, onde: JSON.stringify([o.x, o.y, o.largura, o.profundidade, o.raio, o.altura, o.angulo]) }));
  }
  const plantasDaVersao = CULTURAS.filter((c) => d.p && c.id in d.p);
  return { terreno: terrenoMedidas, obstaculos, plantas: plantasDaVersao, canteiros: d.k || {} };
}
const textoPlantas = (n) => `${n} planta${n === 1 ? "" : "s"}`;

// "+ Pimenta, Tomate movido · Terreno 6 × 4 m · 2 obstáculos · 3 plantas (Tomate, Alface, Pimenta)"
function resumoDoProjeto(dados, anteriores = null) {
  const agora = lerConteudo(dados);
  if (!agora) return "";
  const antes = anteriores ? lerConteudo(anteriores) : null;
  const mudou = [];
  if (antes) {
    const [a, b] = [antes.terreno, agora.terreno];
    if (JSON.stringify(a) !== JSON.stringify(b)) mudou.push(b ? "Terreno redimensionado" : "Sem terreno");
    const idsAntes = new Set(antes.plantas.map((c) => c.id));
    const idsAgora = new Set(agora.plantas.map((c) => c.id));
    for (const c of agora.plantas) if (!idsAntes.has(c.id)) mudou.push(`+ ${c.nome}`);
    for (const c of antes.plantas) if (!idsAgora.has(c.id)) mudou.push(`− ${c.nome}`);
    for (const c of agora.plantas) {
      const [ka, kb] = [antes.canteiros[c.id], agora.canteiros[c.id]];
      if (idsAntes.has(c.id) && ka && kb && JSON.stringify(ka) !== JSON.stringify(kb)) mudou.push(`${c.nome} movido`);
    }
    // Obstáculos: pelo nome (entrou, saiu) e pelo lugar (mudou)
    const restantes = [...antes.obstaculos];
    const novos = [];
    for (const o of agora.obstaculos) {
      const i = restantes.findIndex((r) => r.nome === o.nome);
      if (i < 0) novos.push(o);
      else if (restantes.splice(i, 1)[0].onde !== o.onde) mudou.push(`${o.nome} mudou`);
    }
    for (const o of novos) mudou.push(`+ ${o.nome}`);
    for (const o of restantes) mudou.push(`− ${o.nome}`);
  }
  const base = [
    agora.terreno ? `Terreno ${numero(agora.terreno[0], 1)} × ${numero(agora.terreno[1], 1)} m` : "Sem terreno",
    `${agora.obstaculos.length} obstáculo${agora.obstaculos.length === 1 ? "" : "s"}`
  ];
  const nomes = agora.plantas.map((c) => c.nome);
  const comNomes = nomes.length ? `${textoPlantas(nomes.length)} (${nomes.join(", ")})` : "nenhuma planta";
  const montar = (plantasTexto) => [mudou.length ? mudou.slice(0, 3).join(", ") + (mudou.length > 3 ? "…" : "") : null, ...base, plantasTexto]
    .filter(Boolean).join(" · ");
  let texto = montar(comNomes);
  if (texto.length > 120) texto = montar(nomes.length ? textoPlantas(nomes.length) : comNomes);
  return texto.length > 120 ? `${texto.slice(0, 119)}…` : texto;
}

// Grava a versão com o resumo (e não grava se for igual à mais recente)
const gravarVersao = (codigo, { nome, dados, tipo, substituir = null }) =>
  salvarVersao(codigo, { nome, dados, tipo, substituir, resumir: (anteriores) => resumoDoProjeto(dados, anteriores) });

// ---------- Histórico: as versões desta horta ----------
const ETIQUETAS = { manual: "salva por você", auto: "automática", restaurar: "antes de restaurar" };
// "29/09/2026, 21:45:12"
function dataHoraSegundos(quando) {
  const d = new Date(quando);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
const horaSegundos = (quando) => new Date(quando).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function linhaVersao({ titulo, resumo, etiqueta, botao, atual = false }) {
  const li = document.createElement("li");
  if (atual) li.className = "planejar-versao-atual";
  const texto = document.createElement("div");
  texto.className = "planejar-versao-texto";
  const topo = document.createElement("strong");
  topo.textContent = titulo;
  texto.append(topo);
  if (etiqueta) {
    const selo = document.createElement("span");
    selo.className = "planejar-versao-etiqueta";
    selo.textContent = etiqueta;
    texto.append(" ", selo);
  }
  if (resumo) {
    const r = document.createElement("small");
    r.textContent = resumo;
    texto.append(r);
  }
  li.append(texto);
  if (botao) li.append(botao);
  return li;
}

async function mostrarHistorico(mensagem = "") {
  if (!horta) return;
  const codigo = horta.codigo;
  $("historico-codigo").textContent = formatarCodigo(codigo);
  $("historico-status").textContent = mensagem || "Carregando…";
  try {
    const versoes = await lerVersoes(codigo);
    if (!horta || horta.codigo !== codigo) return;
    $("historico-status").textContent = mensagem || (versoes.length ? "" : "Ainda não há versões salvas.");
    // Primeira linha: o que está na tela agora (sem restaurar)
    const atual = linhaVersao({
      titulo: "Atual",
      resumo: resumoDoProjeto(dadosAtuais(), versoes[0] ? versoes[0].dados : null),
      etiqueta: "na tela agora",
      atual: true
    });
    $("lista-versoes").replaceChildren(atual, ...versoes.map((v, i) => {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "planejar-botao planejar-botao-pequeno";
      botao.textContent = "Restaurar esta versão";
      botao.addEventListener("click", () => restaurarVersao(v));
      return linhaVersao({
        titulo: dataHoraSegundos(v.em),
        resumo: v.resumo || "",   // versões antigas não têm resumo: só a data
        etiqueta: ETIQUETAS[v.tipo] || "",
        botao
      });
    }));
  } catch (erro) {
    $("historico-status").textContent = `Não consegui ler o histórico: ${textoDoErro(erro)}.`;
  }
}
async function restaurarVersao(versao) {
  if (!horta) return;
  if (horta.arquivada) { $("historico-status").textContent = "Horta arquivada: desarquive para restaurar."; return; }
  const codigo = horta.codigo;
  try {
    // Antes, guarda a atual como versão (para poder desfazer); se for igual à última, não repete
    await gravarVersao(codigo, { nome: nomeDoProjeto(), dados: dadosAtuais(), tipo: "restaurar" });
    abrirProjeto(JSON.parse(versao.dados));
    definirNome(versao.nome);
    await salvarNaNuvem({ forcar: true });
    const conteudo = lerConteudo(versao.dados);
    const plantasTexto = conteudo ? ` (${textoPlantas(conteudo.plantas.length)})` : "";
    await mostrarHistorico(`Voltou para a versão de ${horaSegundos(versao.em)}${plantasTexto}. A anterior foi guardada.`);
  } catch (erro) {
    $("historico-status").textContent = `Não consegui restaurar: ${textoDoErro(erro)}.`;
  }
}
$("ver-historico").addEventListener("click", () => {
  const abrir = $("historico").hidden;
  $("historico").hidden = !abrir;
  $("ver-historico").setAttribute("aria-expanded", String(abrir));
  if (abrir) mostrarHistorico();
});

// ---------- Sair desta horta (o que fizer depois fica só neste aparelho) ----------
// Deixa de trabalhar na horta da nuvem: o que estiver na tela fica só neste aparelho
function largarHorta() {
  if (pararDeOuvir) pararDeOuvir();
  pararDeOuvir = null;
  clearTimeout(temporizadorNuvem);
  horta = null;
  pendente = false;
  esconderConflito();
  guardarNuvemLocal();
  mostrarHortaAberta();
  mostrarHortas();
}
$("sair-horta").addEventListener("click", async () => {
  if (!horta) return;
  await enviarPendencias();
  const codigo = horta.codigo;
  largarHorta();
  conferirNomeRepetido();
  statusSalvar(`Você saiu da horta ${formatarCodigo(codigo)} (ela continua na nuvem). O que mudar agora fica só neste aparelho.`);
});

// ---------- Abrir backup (.json) ----------
// Sem horta da nuvem aberta: abre direto. Com horta aberta: pergunta se é
// uma horta nova (sem código, até salvar na nuvem) ou se substitui a atual.
let backupEsperando = null;
function abrirBackup(arquivo) {
  if (!horta) { abrirBackupComoNova(arquivo); return; }
  backupEsperando = arquivo;
  const codigo = formatarCodigo(horta.codigo);
  $("escolha-backup-texto").textContent = `Abrir o backup como uma horta nova (sem código, até você salvar na nuvem) ` +
    `ou substituir a horta atual (${codigo})? A atual fica guardada no histórico.`;
  $("backup-substituir").textContent = `Substituir a horta atual (${codigo})`;
  $("escolha-backup").hidden = false;
  $("backup-nova").focus();  // o padrão é horta nova
}
const fecharEscolhaBackup = () => { $("escolha-backup").hidden = true; backupEsperando = null; };

async function abrirBackupComoNova(arquivo) {
  if (horta) {
    await enviarPendencias();  // o que estava na horta da nuvem vai antes para lá
    largarHorta();
  }
  if (!abrirProjeto(arquivo.projeto)) { statusSalvar("Não consegui abrir esse backup."); return; }
  definirNome(arquivo.nome);
  conferirNomeRepetido();
  statusSalvar(`Backup "${arquivo.nome || NOME_PADRAO}" aberto como uma horta nova: ainda sem código. ` +
    "Toque em Salvar na nuvem para criar um.");
}

async function abrirBackupSubstituindo(arquivo) {
  if (!horta) { abrirBackupComoNova(arquivo); return; }
  if (horta.arquivada) { statusSalvar("Horta arquivada: desarquive antes de substituir."); return; }
  const codigo = horta.codigo;
  try {
    // A atual vai para o histórico (para poder voltar)
    await gravarVersao(codigo, { nome: nomeDoProjeto(), dados: dadosAtuais(), tipo: "restaurar" });
    if (!abrirProjeto(arquivo.projeto)) { statusSalvar("Não consegui abrir esse backup."); return; }
    definirNome(arquivo.nome);
    await salvarNaNuvem({ forcar: true });
    statusSalvar(`Backup aberto no lugar da horta ${formatarCodigo(codigo)}. A versão anterior ficou no histórico.`);
    if (!$("historico").hidden) mostrarHistorico();
  } catch (erro) {
    statusSalvar(`Não consegui substituir: ${textoDoErro(erro)}.`);
  }
}
$("backup-nova").addEventListener("click", () => { const a = backupEsperando; fecharEscolhaBackup(); if (a) abrirBackupComoNova(a); });
$("backup-substituir").addEventListener("click", () => { const a = backupEsperando; fecharEscolhaBackup(); if (a) abrirBackupSubstituindo(a); });
$("backup-cancelar").addEventListener("click", fecharEscolhaBackup);
document.addEventListener("keydown", (evento) => {
  if (evento.key === "Escape" && !$("escolha-backup").hidden) fecharEscolhaBackup();
});

// ---------- "Abrir pelo código": mostra o campo ----------
function statusCodigo(texto) {
  $("form-codigo").hidden = false;  // o recado aparece junto do campo
  $("abrir-pelo-codigo").setAttribute("aria-expanded", "true");
  $("codigo-status").textContent = texto;
}
$("abrir-pelo-codigo").addEventListener("click", () => {
  const abrir = $("form-codigo").hidden;
  $("form-codigo").hidden = !abrir;
  $("abrir-pelo-codigo").setAttribute("aria-expanded", String(abrir));
  if (abrir) $("codigo-digitado").focus();
});

// ---------- Minhas hortas: os códigos usados neste aparelho ----------
// Cada uma: { codigo, nome, ultimoAcesso (ms), miniatura }. Só os códigos
// ficam aqui; a horta mesmo está na nuvem.
const CHAVE_HORTAS = "horta-planejar-hortas-v1";

function lerHortas() {
  try {
    const lista = JSON.parse(localStorage.getItem(CHAVE_HORTAS));
    return Array.isArray(lista) ? lista.filter((h) => normalizarCodigo(h.codigo)) : [];
  } catch {
    return [];
  }
}
function gravarHortas(lista) {
  try { localStorage.setItem(CHAVE_HORTAS, JSON.stringify(lista)); } catch { /* sem salvar */ }
}

// Põe (ou atualiza) a horta no topo da lista
function registrarHorta(codigo, nome, desenho = undefined) {
  const lista = lerHortas();
  const antiga = lista.find((h) => h.codigo === codigo);
  // A miniatura é da tela, então só vale se a horta aberta for essa
  const mini = desenho !== undefined ? desenho : horta && horta.codigo === codigo ? miniatura() : antiga?.miniatura || null;
  gravarHortas([{ codigo, nome, ultimoAcesso: Date.now(), miniatura: mini }, ...lista.filter((h) => h.codigo !== codigo)]);
  mostrarHortas();
}

function itemDaLista({ mini, titulo, detalhe, botoes, destaque = false }) {
  const li = document.createElement("li");
  li.className = `planejar-projeto${destaque ? " planejar-projeto-aberto" : ""}`;
  const figura = document.createElement("div");
  figura.className = "planejar-projeto-mini";
  if (mini) {
    const img = document.createElement("img");
    img.src = mini;
    img.alt = "";
    figura.append(img);
  } else {
    figura.textContent = "🌱";
  }
  const info = document.createElement("div");
  info.className = "planejar-projeto-info";
  const nome = document.createElement("strong");
  nome.textContent = titulo;
  const quando = document.createElement("small");
  quando.textContent = detalhe;
  const linha = document.createElement("div");
  linha.className = "planejar-botoes";
  linha.append(...botoes);
  info.append(nome, quando, linha);
  li.append(figura, info);
  return li;
}

// excluindo: id do projeto antigo com a pergunta "Excluir?" aberta
function mostrarHortas(excluindo = null) {
  const hortas = lerHortas();
  const antigos = lerProjetos();
  $("minhas-hortas-vazio").hidden = hortas.length > 0 || antigos.length > 0;

  $("minhas-hortas").replaceChildren(...hortas.map((h) => {
    const aberta = !!(horta && horta.codigo === h.codigo);
    return itemDaLista({
      mini: h.miniatura,
      titulo: `${h.nome} · ${formatarCodigo(h.codigo)}${aberta ? " (aberta agora)" : ""}`,
      detalhe: `Último acesso ${dataHora(h.ultimoAcesso)}`,
      destaque: aberta,
      botoes: [
        botaoPequeno("Abrir", () => {
          abrirPorCodigo(h.codigo);
          document.querySelector(".planejar-modos")?.scrollIntoView({ behavior: "smooth" });
        }, "planejar-botao-forte"),
        botaoPequeno("Tirar da lista", () => {
          gravarHortas(lerHortas().filter((o) => o.codigo !== h.codigo));
          statusSalvar(`"${h.nome}" saiu da lista deste aparelho. Ela continua na nuvem: abra com o código ${formatarCodigo(h.codigo)}.`);
          mostrarHortas();
        })
      ]
    });
  }));

  $("hortas-antigas").hidden = antigos.length === 0;
  $("lista-antigas").replaceChildren(...antigos.map((p) => {
    const botoes = excluindo === p.id
      ? [
        botaoPequeno("Sim, excluir", () => {
          gravarProjetos(lerProjetos().filter((o) => o.id !== p.id));
          statusSalvar(`Projeto "${p.nome}" excluído deste aparelho.`);
          mostrarHortas();
        }, "planejar-botao-perigo"),
        botaoPequeno("Cancelar", () => mostrarHortas())
      ]
      : [
        botaoPequeno("☁ Enviar para a nuvem", () => enviarAntigo(p), "planejar-botao-forte"),
        botaoPequeno("Abrir", () => {
          if (!abrirProjeto(p.dados)) { statusSalvar("Não consegui abrir esse projeto."); return; }
          definirNome(p.nome);
          statusSalvar(`Projeto "${p.nome}" aberto (ainda só neste aparelho).`);
        }),
        botaoPequeno("Excluir", () => mostrarHortas(p.id), "planejar-botao-perigo")
      ];
    return itemDaLista({
      mini: p.miniatura,
      titulo: p.nome,
      detalhe: excluindo === p.id ? `Excluir "${p.nome}"? Não dá para desfazer.` : `Só neste aparelho · salvo em ${dataHora(p.modificadoEm)}`,
      botoes
    });
  }));
}

// ---------- Nome repetido em "Minhas hortas" (avisa, não bloqueia) ----------
// "Teste", " teste " e "TES TE" contam como o mesmo nome
const chaveDoNome = (nome) => String(nome || "").toLowerCase().replace(/\s+/g, "");
let nomeAceito = null;  // "codigo|nome" que a pessoa quis manter mesmo repetido

function conferirNomeRepetido() {
  $("aviso-nome").hidden = true;
  if (!horta) return;
  const nome = nomeDoProjeto();
  if (nomeAceito === `${horta.codigo}|${chaveDoNome(nome)}`) return;
  const hortas = lerHortas();
  const outra = hortas.find((h) => h.codigo !== horta.codigo && chaveDoNome(h.nome) === chaveDoNome(nome));
  if (!outra) return;
  // Sugestão: "Teste (2)", "Teste (3)"… o primeiro que ainda não existe
  let sugestao = nome;
  for (let n = 2; hortas.some((h) => chaveDoNome(h.nome) === chaveDoNome(sugestao)); n++) sugestao = `${nome} (${n})`.slice(0, 60);
  $("aviso-nome-texto").textContent =
    `Você já tem uma horta chamada "${outra.nome}" neste aparelho (código ${formatarCodigo(outra.codigo)}). Quer chamar esta de "${sugestao}"?`;
  $("aviso-nome-usar").textContent = `Usar "${sugestao}"`;
  $("aviso-nome-usar").onclick = () => {
    definirNome(sugestao);
    $("aviso-nome").hidden = true;
    projetoMudou();  // vai para a nuvem com o nome novo
  };
  $("aviso-nome-manter").onclick = () => {
    nomeAceito = `${horta.codigo}|${chaveDoNome(nome)}`;
    $("aviso-nome").hidden = true;
  };
  $("aviso-nome").hidden = false;
}
$("nome-projeto").addEventListener("change", conferirNomeRepetido);

// Projeto antigo -> horta na nuvem com código (sem mexer no que está na tela)
async function enviarAntigo(projeto) {
  if (conectado === false) { statusSalvar("Sem conexão: tente de novo quando a internet voltar."); return; }
  statusSalvar(`Enviando "${projeto.nome}"…`);
  try {
    const nome = String(projeto.nome || NOME_PADRAO).slice(0, 60);
    const dados = JSON.stringify(projeto.dados);
    const codigo = await criarHorta({ nome, dados });
    await gravarVersao(codigo, { nome, dados, tipo: "manual" });
    gravarProjetos(lerProjetos().filter((o) => o.id !== projeto.id));
    registrarHorta(codigo, nome, projeto.miniatura || null);
    statusSalvar(`"${nome}" agora está na nuvem com o código ${formatarCodigo(codigo)}. Anote o código.`);
    mostrarQuadroCodigo(codigo);
  } catch (erro) {
    statusSalvar(`Não consegui enviar: ${textoDoErro(erro)}.`);
  }
}
mostrarHortas();

// ---------- Ao abrir a página: ?h=CODIGO no link, ou a horta que estava aberta ----------
async function iniciarNuvem() {
  mostrarHortaAberta();
  const pedido = new URLSearchParams(location.search).get("h");
  if (pedido !== null) {
    history.replaceState(null, "", location.pathname + location.hash);  // tira o ?h= do endereço
    const codigo = normalizarCodigo(pedido);
    if (codigo) await abrirPorCodigo(codigo);
    else statusCodigo("O código do link está errado: não encontrei uma horta com esse código.");
    return;
  }
  let salvo = null;
  try { salvo = JSON.parse(localStorage.getItem(CHAVE_NUVEM)); } catch { /* nada salvo */ }
  if (!salvo || !normalizarCodigo(salvo.codigo)) return;
  // Continua na horta que estava aberta
  horta = { codigo: salvo.codigo, arquivada: false };
  pendente = salvo.pendente === true;
  mostrarHortaAberta();
  statusNuvem("Conectando à nuvem…");
  try {
    const valor = await lerHorta(salvo.codigo);
    if (!valor) { horta = null; guardarNuvemLocal(); mostrarHortaAberta(); return; }
    horta.arquivada = valor.arquivada === true;
    ultimoEnviado = valor.dados;
    ultimoNome = valor.nome;
    ultimoVisto = valor.atualizadoEm;
    ultimaVersaoEm = Date.now();
    aplicarArquivada();
    statusNuvem(textoSalvo());
    registrarHorta(salvo.codigo, valor.nome);
    ouvir(salvo.codigo);
    if (pendente) salvarNaNuvem({ forcar: true });
    else if (!mesmoProjeto(dadosAtuais(), valor.dados)) mostrarConflito(valor.atualizadoEm);
  } catch {
    iniciarConexao();
    statusNuvem(SEM_CONEXAO);
  }
}
iniciarNuvem();
