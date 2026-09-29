// Mapa de horas de sol — só o CÁLCULO (não mexe na página, dá para testar no Node)
//
// A ideia, em 4 passos:
//   1. O terreno é dividido em quadradinhos (0,25 m × 0,25 m).
//   2. Do nascer ao pôr do sol, a cada 30 minutos, a biblioteca SunCalc diz
//      onde o sol está: a direção (azimute) e a altura no céu (altitude).
//   3. De cada quadradinho, "olhamos" na direção do sol. Se um obstáculo está
//      no caminho e é alto o bastante para tapar o sol, o quadradinho está na
//      sombra. Conta: o obstáculo tapa se  altura > distância × tan(altitude).
//   4. Cada meia hora sem sombra vale 0,5 h de sol.
//
// O SunCalc é passado como parâmetro (no site vem do jsDelivr; no teste, também).

export const PASSO_MINIMO = 0.25;       // m: tamanho padrão do quadradinho
export const MAX_QUADRADINHOS = 4000;   // mais que isso fica lento: aumenta o quadradinho
export const INTERVALO_MIN = 30;        // de quanto em quanto tempo olhamos o sol

// Tamanho do quadradinho: 0,25 m, ou maior em terrenos grandes
export function tamanhoDoQuadradinho(largura, comprimento) {
  let passo = PASSO_MINIMO;
  while (Math.ceil(largura / passo) * Math.ceil(comprimento / passo) > MAX_QUADRADINHOS) {
    passo = Math.round((passo + 0.05) * 100) / 100;
  }
  return passo;
}

// Meio-dia (aproximado) do dia escolhido no lugar da horta. É esse instante
// que vai para o SunCalc, assim o "dia" é o dia certo em qualquer fuso.
export function meioDiaLocal(ano, mes, dia, longitude) {
  // O sol anda 15° de longitude por hora: em -47,78° o meio-dia solar é ~15h11 UTC
  return new Date(Date.UTC(ano, mes, dia, 12) - (longitude / 15) * 3600 * 1000);
}

// ---------------------------------------------------------------------
// Direção do sol no DESENHO
//
// No SunCalc, o azimute é medido a partir do SUL, girando para o OESTE, em
// radianos (0 = sul, +π/2 = oeste, −π/2 = leste, ±π = norte).
// 1) Rumo de bússola (0° = norte, 90° = leste, 180° = sul, 270° = oeste):
//      rumo = azimute em graus + 180
// 2) No desenho, a seta do norte está girada "norte" graus a partir do topo
//    (sentido do relógio). Então o sol aparece no ângulo  norte + rumo.
// 3) Com x para a direita e y para baixo:  dx = sen(ângulo), dy = −cos(ângulo)
// ---------------------------------------------------------------------
export function direcaoNoDesenho(azimuteSunCalc, norteGraus) {
  const rumo = ((azimuteSunCalc * 180) / Math.PI + 180 + 360) % 360;
  const angulo = ((norteGraus + rumo) * Math.PI) / 180;
  return { dx: Math.sin(angulo), dy: -Math.cos(angulo), rumo };
}

// Posições do sol no dia: no meio de cada meia hora entre o nascer e o pôr.
// Cada posição vale 0,5 h de sol (se não houver sombra).
export function posicoesDoSol(SunCalc, data, latitude, longitude) {
  const tempos = SunCalc.getTimes(data, latitude, longitude);
  const nascer = tempos.sunrise.getTime();
  const por = tempos.sunset.getTime();
  const posicoes = [];
  if (Number.isNaN(nascer) || Number.isNaN(por)) return posicoes;  // (dia/noite polar)
  const meiaHora = INTERVALO_MIN * 60 * 1000;
  for (let t = nascer + meiaHora / 2; t < por; t += meiaHora) {
    const p = SunCalc.getPosition(new Date(t), latitude, longitude);
    if (p.altitude > 0) posicoes.push({ altitude: p.altitude, azimute: p.azimuth });
  }
  return posicoes;
}

// ---------------------------------------------------------------------
// Onde a linha em direção ao sol ENTRA no obstáculo?
// A linha sai do ponto (px, py) e anda na direção (dx, dy): ponto = p + t·d.
// Devolve t (a distância em metros), ou -1 se a linha não passa pelo obstáculo.
// ---------------------------------------------------------------------

// Retângulo: x, y (canto de cima à esquerda), largura, profundidade
export function entradaNoRetangulo(px, py, dx, dy, r) {
  let tEntra = 0;
  let tSai = Infinity;
  // Faixa em x (entre as paredes esquerda e direita) e depois em y
  for (const [p, d, min, max] of [[px, dx, r.x, r.x + r.largura], [py, dy, r.y, r.y + r.profundidade]]) {
    if (Math.abs(d) < 1e-12) {
      if (p < min || p > max) return -1;  // anda paralelo e está fora da faixa
    } else {
      let t1 = (min - p) / d;
      let t2 = (max - p) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tEntra = Math.max(tEntra, t1);
      tSai = Math.min(tSai, t2);
      if (tEntra > tSai) return -1;
    }
  }
  return tEntra;
}

// Círculo: x, y (centro), raio
export function entradaNoCirculo(px, py, dx, dy, c) {
  const ox = px - c.x;
  const oy = py - c.y;
  const b = ox * dx + oy * dy;
  const cc = ox * ox + oy * oy - c.raio * c.raio;
  if (cc <= 0) return 0;              // o ponto está dentro do círculo
  const delta = b * b - cc;
  if (delta < 0) return -1;           // a linha passa longe
  const t = -b - Math.sqrt(delta);    // primeiro encontro
  return t >= 0 ? t : -1;             // (se for negativo, o círculo está "atrás")
}

export function entradaNoObstaculo(px, py, dx, dy, ob) {
  return ob.tipo === "retangulo" ? entradaNoRetangulo(px, py, dx, dy, ob) : entradaNoCirculo(px, py, dx, dy, ob);
}

export function dentroDoObstaculo(x, y, ob) {
  if (ob.tipo === "retangulo") {
    return x >= ob.x && x <= ob.x + ob.largura && y >= ob.y && y <= ob.y + ob.profundidade;
  }
  return Math.hypot(x - ob.x, y - ob.y) <= ob.raio;
}

// ---------------------------------------------------------------------
// O cálculo completo.
//   terreno: { largura, comprimento, norte, latitude, longitude, obstaculos }
//   datas: lista de dias (Date). Com vários dias, cada quadradinho fica com o
//          MENOR valor (o pior caso: "ano todo").
// Devolve: { passo, colunas, linhas, horas, ocupado, maximo }
//   horas[i]   = horas de sol do quadradinho i (linha a linha, de cima para baixo)
//   ocupado[i] = 0 se está livre, ou (número do obstáculo + 1) se está dentro de um
// ---------------------------------------------------------------------
export function calcularHorasDeSol(SunCalc, terreno, datas) {
  const passo = tamanhoDoQuadradinho(terreno.largura, terreno.comprimento);
  const colunas = Math.ceil(terreno.largura / passo);
  const linhas = Math.ceil(terreno.comprimento / passo);
  const total = colunas * linhas;
  const horas = new Float32Array(total).fill(Infinity);
  const ocupado = new Int16Array(total);
  const obstaculos = terreno.obstaculos.filter((ob) => ob.altura > 0);

  // Centro de cada quadradinho, e quais estão dentro de um obstáculo
  const cx = new Float32Array(total);
  const cy = new Float32Array(total);
  for (let lin = 0; lin < linhas; lin++) {
    for (let col = 0; col < colunas; col++) {
      const i = lin * colunas + col;
      cx[i] = Math.min((col + 0.5) * passo, terreno.largura);
      cy[i] = Math.min((lin + 0.5) * passo, terreno.comprimento);
      const dentro = terreno.obstaculos.findIndex((ob) => dentroDoObstaculo(cx[i], cy[i], ob));
      ocupado[i] = dentro + 1;
    }
  }

  let maximo = 0;  // horas de sol do dia sem nenhuma sombra (no pior dia)
  const contagem = new Uint16Array(total);
  for (const data of datas) {
    // Direção e inclinação do sol em cada meia hora (calculado uma vez por dia)
    const sois = posicoesDoSol(SunCalc, data, terreno.latitude, terreno.longitude).map((p) => ({
      ...direcaoNoDesenho(p.azimute, terreno.norte),
      tanAltitude: Math.tan(p.altitude)
    }));
    maximo = maximo === 0 ? sois.length * 0.5 : Math.min(maximo, sois.length * 0.5);

    contagem.fill(0);
    for (let i = 0; i < total; i++) {
      if (ocupado[i]) continue;
      for (const sol of sois) {
        let sombra = false;
        for (const ob of obstaculos) {
          const d = entradaNoObstaculo(cx[i], cy[i], sol.dx, sol.dy, ob);
          // Tapa o sol se a altura do obstáculo passa da "altura do raio de sol" ali
          if (d >= 0 && ob.altura > d * sol.tanAltitude) { sombra = true; break; }
        }
        if (!sombra) contagem[i]++;
      }
      horas[i] = Math.min(horas[i], contagem[i] * 0.5);
    }
  }
  for (let i = 0; i < total; i++) if (ocupado[i] || horas[i] === Infinity) horas[i] = 0;

  return { passo, colunas, linhas, horas, ocupado, maximo };
}

// Classificação usada no mapa e nas plantas
export const SOMBRA = "sombra";
export const MEIA_SOMBRA = "meia-sombra";
export const PLENO_SOL = "pleno sol";
export function classificar(horas) {
  if (horas >= 6) return PLENO_SOL;
  if (horas >= 3) return MEIA_SOMBRA;
  return SOMBRA;
}
