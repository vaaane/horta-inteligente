// QR code com o endereço do site, para o visitante abrir no celular.
// Usa a biblioteca qrcode-generator (carregada no HTML antes deste arquivo).
// O desenho é feito aqui mesmo no navegador, em SVG — nenhuma imagem vem de fora.

export function desenharQR(elemento) {
  const endereco = location.origin + "/";

  const qr = qrcode(0, "M");  // 0 = tamanho automático; "M" = correção de erro média
  qr.addData(endereco);
  qr.make();

  elemento.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  elemento.querySelector("svg").setAttribute("aria-label", `QR code para ${endereco}`);
}
