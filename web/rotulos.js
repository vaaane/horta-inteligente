// Rótulos no desenho do Planeje (Desenho livre e Mapa), sem um em cima do outro.
//
// Os das plantas são colocados primeiro (plantas.js); depois vêm os dos
// obstáculos: no meio da forma quando não batem em nada, senão do lado de
// fora da forma (em cima, embaixo ou dos lados), com uma linha até ela.

// Duas caixas (x, y, w, h) se encostam?
export const baterem = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const FONTE_ROTULO = "bold 13px system-ui, sans-serif";
const ALTURA = 20;

// itens: [{ texto, centro: {x, y}, caixa: {x, y, w, h} }] (pixels na tela)
// ocupadas: caixas já usadas (rótulos das plantas); recebe as novas
export function rotularObstaculos(ctx, itens, ocupadas) {
  const largura = ctx.canvas.clientWidth || 2000;
  const altura = ctx.canvas.clientHeight || 2000;
  ctx.save();
  ctx.font = FONTE_ROTULO;
  for (const item of itens) {
    const w = ctx.measureText(item.texto).width + 10;
    const h = ALTURA;
    const em = (cx, cy) => ({ x: cx - w / 2, y: cy - h / 2, w, h });
    const { x, y, w: cw, h: ch } = item.caixa;
    const candidatos = [[item.centro.x, item.centro.y, false]];
    for (const d of [6, 30]) {
      candidatos.push(
        [x + cw / 2, y - h / 2 - d, true], [x + cw / 2, y + ch + h / 2 + d, true],
        [x + cw + w / 2 + d, y + ch / 2, true], [x - w / 2 - d, y + ch / 2, true]
      );
    }
    const cabe = (c) => c.x >= 2 && c.y >= 2 && c.x + c.w <= largura - 2 && c.y + c.h <= altura - 2;
    const escolhido = candidatos.find(([cx, cy]) => {
      const c = em(cx, cy);
      return cabe(c) && !ocupadas.some((o) => baterem(c, o));
    }) || candidatos[0];
    const [lx, ly, fora] = escolhido;
    if (fora) {
      // Linha fina ligando o rótulo à forma
      ctx.beginPath();
      ctx.moveTo(item.centro.x, item.centro.y);
      ctx.lineTo(lx, ly);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(30, 30, 30, 0.8)";
      ctx.stroke();
    }
    const caixa = em(lx, ly);
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.fillRect(caixa.x, caixa.y, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#3e3a36";
    ctx.strokeRect(caixa.x, caixa.y, w, h);
    ctx.fillStyle = "#1b2a1c";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(item.texto, lx, ly + 0.5);
    ocupadas.push(caixa);
  }
  ctx.restore();
}
