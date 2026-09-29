// Testes do cálculo de horas de sol (web/sol.js)
// Rodar:  node web/sol.test.mjs
// (Precisa de internet: baixa o SunCalc do jsDelivr, a mesma versão do site.)
import assert from "node:assert/strict";
import {
  calcularHorasDeSol, meioDiaLocal, posicoesDoSol, direcaoNoDesenho,
  entradaNoRetangulo, entradaNoCirculo
} from "./sol.js";
import { CULTURAS, sugerirLugares, descreverLugar } from "./culturas.js";

const URL_SUNCALC = "https://cdn.jsdelivr.net/npm/suncalc@1.9.0/suncalc.js";

// Carrega o SunCalc (ele se registra em module.exports quando existe)
const codigo = await (await fetch(URL_SUNCALC)).text();
const modulo = { exports: {} };
new Function("module", "exports", "define", codigo)(modulo, modulo.exports, undefined);
const SunCalc = modulo.exports;

const LAT = -15.90;
const LNG = -47.78;
let passou = 0;
function teste(nome, funcao) {
  funcao();
  passou++;
  console.log(`ok - ${nome}`);
}

teste("interseção com retângulo e círculo", () => {
  const muro = { x: 2, y: 0, largura: 1, profundidade: 4 };
  assert.equal(entradaNoRetangulo(0, 2, 1, 0, muro), 2);    // anda para a direita: entra em x = 2
  assert.equal(entradaNoRetangulo(0, 2, -1, 0, muro), -1);  // anda para a esquerda: não encontra
  const arvore = { x: 5, y: 2, raio: 1 };
  assert.ok(Math.abs(entradaNoCirculo(0, 2, 1, 0, arvore) - 4) < 1e-9);  // entra em x = 4
  assert.equal(entradaNoCirculo(5, 2, 1, 0, arvore), 0);    // já está dentro
});

teste("direção do sol no desenho (norte para cima)", () => {
  // SunCalc: azimute ±π = norte, −π/2 = leste, +π/2 = oeste
  const norte = direcaoNoDesenho(Math.PI, 0);
  assert.ok(Math.abs(norte.dx) < 1e-9 && Math.abs(norte.dy + 1) < 1e-9);  // para cima
  const leste = direcaoNoDesenho(-Math.PI / 2, 0);
  assert.ok(Math.abs(leste.dx - 1) < 1e-9);                                // para a direita
  const girado = direcaoNoDesenho(Math.PI, 90);                             // norte apontando para a direita
  assert.ok(Math.abs(girado.dx - 1) < 1e-9);
});

teste("sem obstáculos, todo ponto tem as horas de sol do dia (±0,5 h)", () => {
  for (const [mes, dia] of [[2, 21], [5, 21], [11, 21]]) {
    const data = meioDiaLocal(2026, mes, dia, LNG);
    const tempos = SunCalc.getTimes(data, LAT, LNG);
    const duracaoDia = (tempos.sunset - tempos.sunrise) / 3600000;
    const mapa = calcularHorasDeSol(SunCalc, {
      largura: 6, comprimento: 4, norte: 0, latitude: LAT, longitude: LNG, obstaculos: []
    }, [data]);
    for (const h of mapa.horas) assert.ok(Math.abs(h - duracaoDia) <= 0.5, `${h} h × dia de ${duracaoDia.toFixed(2)} h`);
    assert.equal(mapa.colunas * mapa.linhas, 24 * 16);  // quadradinhos de 0,25 m
  }
});

teste("muro alto no norte: ao sul dele tem menos sol que ao norte (21/06)", () => {
  // Terreno 6 × 6 m, norte para cima. Muro de 3 m de altura atravessando o
  // terreno em y = 2 a 2,2 m. Os pontos logo abaixo (ao SUL) ficam na sombra.
  const data = meioDiaLocal(2026, 5, 21, LNG);
  const terreno = {
    largura: 6, comprimento: 6, norte: 0, latitude: LAT, longitude: LNG,
    obstaculos: [{ tipo: "retangulo", nome: "Muro", x: 0, y: 2, largura: 6, profundidade: 0.2, altura: 3 }]
  };
  const mapa = calcularHorasDeSol(SunCalc, terreno, [data]);
  const horasEm = (x, y) => mapa.horas[Math.floor(y / mapa.passo) * mapa.colunas + Math.floor(x / mapa.passo)];
  const aoNorte = horasEm(3, 1.1);  // 1 m ao norte do muro
  const aoSul = horasEm(3, 2.6);    // logo ao sul do muro
  console.log(`   ao norte do muro: ${aoNorte} h · ao sul: ${aoSul} h`);
  assert.ok(aoSul < aoNorte);
});

teste("ano todo: cada ponto fica com o menor valor dos 12 meses", () => {
  const terreno = { largura: 2, comprimento: 2, norte: 0, latitude: LAT, longitude: LNG, obstaculos: [] };
  const datas = Array.from({ length: 12 }, (_, mes) => meioDiaLocal(2026, mes, 21, LNG));
  const ano = calcularHorasDeSol(SunCalc, terreno, datas);
  const menor = Math.min(...datas.map((d) => posicoesDoSol(SunCalc, d, LAT, LNG).length * 0.5));
  assert.ok(ano.horas.every((h) => h === menor));
});

teste("sugestão: tomate no sol, alface na meia-sombra, sem dividir quadradinho", () => {
  const data = meioDiaLocal(2026, 5, 21, LNG);
  const terreno = {
    largura: 6, comprimento: 6, norte: 0, latitude: LAT, longitude: LNG,
    obstaculos: [{ tipo: "retangulo", nome: "Muro", x: 0, y: 2, largura: 6, profundidade: 0.2, altura: 3 }]
  };
  const mapa = calcularHorasDeSol(SunCalc, terreno, [data]);
  const cultura = (id) => CULTURAS.find((c) => c.id === id);
  const [alface, tomate] = sugerirLugares(mapa, [
    { cultura: cultura("alface"), area: 0.5 },
    { cultura: cultura("tomate"), area: 0.5 }
  ]);
  assert.ok(tomate.celulas.length > 0 && tomate.celulas.every((i) => mapa.horas[i] >= 6));
  assert.ok(alface.celulas.length > 0 && alface.celulas.every((i) => mapa.horas[i] >= 3));
  assert.ok(alface.horasMedia <= 6, `alface ficou com ${alface.horasMedia} h`);
  assert.ok(!alface.celulas.some((i) => tomate.celulas.includes(i)));
  console.log(`   tomate: ${descreverLugar(tomate.celulas, mapa, terreno)}, ~${tomate.horasMedia.toFixed(1)} h`);
  console.log(`   alface: ${descreverLugar(alface.celulas, mapa, terreno)}, ~${alface.horasMedia.toFixed(1)} h`);
});

console.log(`\n${passou} testes passaram.`);
