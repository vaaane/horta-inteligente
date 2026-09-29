// Plantas da horta: quanto sol e quanta umidade cada uma gosta,
// e a função que sugere o melhor lugar para cada uma no terreno.
//
// valores aproximados de referência; variam com clima e variedade

// sol: "meia"   = meia-sombra (3 a 6 h de sol)
//      "quatro" = 4 h de sol ou mais
//      "pleno"  = pleno sol (6 h ou mais)
// umidade: faixa ideal do sensor de umidade do solo (calibrado), em %
export const CULTURAS = [
  { id: "alface", nome: "Alface", sol: "meia", umidade: [60, 80], cor: "#7cb342" },
  { id: "rucula", nome: "Rúcula", sol: "meia", umidade: [60, 80], cor: "#33691e" },
  { id: "salsa", nome: "Salsa", sol: "meia", umidade: [50, 70], cor: "#00897b" },
  { id: "hortela", nome: "Hortelã", sol: "meia", umidade: [70, 90], cor: "#26a69a" },
  { id: "cebolinha", nome: "Cebolinha", sol: "quatro", umidade: [50, 70], cor: "#8e24aa" },
  { id: "couve", nome: "Couve", sol: "quatro", umidade: [60, 80], cor: "#3949ab" },
  { id: "tomate", nome: "Tomate", sol: "pleno", umidade: [60, 80], cor: "#d32f2f" },
  { id: "pimenta", nome: "Pimenta", sol: "pleno", umidade: [50, 70], cor: "#bf360c" },
  { id: "manjericao", nome: "Manjericão", sol: "pleno", umidade: [50, 70], cor: "#1b5e20" },
  { id: "morango", nome: "Morango", sol: "pleno", umidade: [60, 80], cor: "#c2185b" },
  { id: "cenoura", nome: "Cenoura", sol: "pleno", umidade: [60, 75], cor: "#e65100" }
];

// O que cada tipo de sol precisa
export const NECESSIDADE = {
  pleno: { minimo: 6, texto: "pleno sol (6 h ou mais)" },
  quatro: { minimo: 4, texto: "4 h ou mais" },
  meia: { minimo: 3, texto: "meia-sombra (3–6 h)" }
};

// Quem escolhe primeiro: as mais exigentes (precisam de mais sol)
const ORDEM = { pleno: 0, quatro: 1, meia: 2 };

// "Nota" de um quadradinho para a planta (maior = melhor lugar)
function nota(horas, sol) {
  if (sol === "pleno") return horas;                          // quanto mais sol, melhor
  if (sol === "quatro") return horas <= 6 ? horas : 6 - (horas - 6) * 0.5;  // gosta de ~6 h
  // Meia-sombra: prefere 3 a 6 h. Um lugar de pleno sol só é usado se não
  // houver mais meia-sombra livre (para não "gastar" o sol de quem precisa).
  if (horas <= 6) return 10 - Math.abs(horas - 4.5);
  return 5 - (horas - 6);
}

// ---------------------------------------------------------------------
// Sugere uma região para cada planta.
//   mapa: resultado de calcularHorasDeSol (sol.js)
//   pedidos: [{ cultura, area }]  (área em m²)
// Devolve, na ordem dos pedidos:
//   { cultura, area, celulas: [índices], areaConseguida, horasMedia, melhorHoras }
// Como funciona: as mais exigentes escolhem primeiro. Cada planta começa no
// melhor quadradinho livre para ela e vai crescendo para os vizinhos (assim a
// região fica junta), sempre pegando o vizinho de melhor nota.
// ---------------------------------------------------------------------
export function sugerirLugares(mapa, pedidos) {
  const { colunas, linhas, horas, ocupado, passo } = mapa;
  const total = colunas * linhas;
  const livre = new Uint8Array(total);
  for (let i = 0; i < total; i++) livre[i] = ocupado[i] ? 0 : 1;
  const areaQuadradinho = passo * passo;

  // Desempate: entre lugares de nota igual, prefere os mais perto do centro
  const pertoDoCentro = (i) => {
    const col = i % colunas;
    const lin = Math.floor(i / colunas);
    return -Math.hypot((col + 0.5) / colunas - 0.5, (lin + 0.5) / linhas - 0.5) * 0.01;
  };

  // Melhor ponto livre do terreno (para explicar quando não há sol suficiente)
  let melhorDoTerreno = 0;
  for (let i = 0; i < total; i++) if (livre[i]) melhorDoTerreno = Math.max(melhorDoTerreno, horas[i]);

  const ordenados = pedidos
    .map((pedido, posicao) => ({ ...pedido, posicao }))
    .sort((a, b) => ORDEM[a.cultura.sol] - ORDEM[b.cultura.sol]);
  const resultados = new Array(pedidos.length);

  for (const pedido of ordenados) {
    const { cultura } = pedido;
    const minimo = NECESSIDADE[cultura.sol].minimo;
    const precisa = Math.max(1, Math.round(pedido.area / areaQuadradinho));
    const serve = (i) => livre[i] && horas[i] >= minimo;
    const regiao = [];
    const naRegiao = new Uint8Array(total);
    let fronteira = new Set();

    const adicionar = (i) => {
      regiao.push(i);
      naRegiao[i] = 1;
      fronteira.delete(i);
      const lin = Math.floor(i / colunas);
      const col = i % colunas;
      // Vizinhos de cima, de baixo, da esquerda e da direita
      for (const [l, c] of [[lin - 1, col], [lin + 1, col], [lin, col - 1], [lin, col + 1]]) {
        if (l < 0 || c < 0 || l >= linhas || c >= colunas) continue;
        const v = l * colunas + c;
        if (!naRegiao[v] && serve(v)) fronteira.add(v);
      }
    };

    while (regiao.length < precisa) {
      let escolhido = -1;
      let melhorNota = -Infinity;
      if (fronteira.size > 0) {
        // Cresce pelo melhor vizinho
        for (const v of fronteira) {
          const n = nota(horas[v], cultura.sol) + pertoDoCentro(v);
          if (n > melhorNota) { melhorNota = n; escolhido = v; }
        }
      } else {
        // Começa (ou recomeça) no melhor quadradinho livre que serve
        for (let i = 0; i < total; i++) {
          if (naRegiao[i] || !serve(i)) continue;
          const n = nota(horas[i], cultura.sol) + pertoDoCentro(i);
          if (n > melhorNota) { melhorNota = n; escolhido = i; }
        }
      }
      if (escolhido < 0) break;  // acabaram os lugares que servem
      adicionar(escolhido);
    }

    for (const i of regiao) livre[i] = 0;  // a próxima planta não pode usar
    const soma = regiao.reduce((s, i) => s + horas[i], 0);
    resultados[pedido.posicao] = {
      cultura,
      area: pedido.area,
      celulas: regiao,
      areaConseguida: regiao.length * areaQuadradinho,
      horasMedia: regiao.length ? soma / regiao.length : 0,
      melhorHoras: melhorDoTerreno
    };
  }
  return resultados;
}

// ---------------------------------------------------------------------
// Onde fica a região, em palavras: "lado norte, perto do centro"
//   norteGraus: ângulo da seta do norte no desenho
// ---------------------------------------------------------------------
const DIRECOES = ["norte", "nordeste", "leste", "sudeste", "sul", "sudoeste", "oeste", "noroeste"];

export function descreverLugar(celulas, mapa, terreno) {
  let sx = 0;
  let sy = 0;
  for (const i of celulas) {
    sx += ((i % mapa.colunas) + 0.5) * mapa.passo;
    sy += (Math.floor(i / mapa.colunas) + 0.5) * mapa.passo;
  }
  const dx = sx / celulas.length - terreno.largura / 2;
  const dy = sy / celulas.length - terreno.comprimento / 2;
  // Quão longe do centro (0 = no centro, 1 = na borda)
  const distancia = Math.hypot(dx / (terreno.largura / 2), dy / (terreno.comprimento / 2));
  if (distancia < 0.3) return "no centro do terreno";

  // Ângulo no desenho (a partir do topo, sentido do relógio) menos o ângulo do
  // norte = rumo de bússola (0° = norte, 90° = leste…)
  const noDesenho = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const rumo = (noDesenho - terreno.norte + 720) % 360;
  const indice = Math.round(rumo / 45) % 8;
  const lado = indice % 2 === 1 ? `canto ${DIRECOES[indice]}` : `lado ${DIRECOES[indice]}`;  // diagonais = canto
  return distancia < 0.65 ? `${lado}, perto do centro` : lado;
}
