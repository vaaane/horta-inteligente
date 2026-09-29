// QR code com o endereço do site, para o visitante abrir no celular.
// Usa a biblioteca qrcode-generator (carregada no HTML antes deste arquivo).
// O desenho é feito aqui mesmo no navegador, em SVG — nenhuma imagem vem de fora.

export function desenharQR(elemento) {
  // No computador (localhost ou arquivo aberto direto) o endereço não
  // funcionaria no celular do visitante: mostramos um aviso no lugar do QR.
  const host = location.hostname;
  if (host === "" || host === "localhost" || host === "127.0.0.1") {
    elemento.innerHTML = '<p class="qr-aviso">O QR code aparece quando o site estiver publicado.</p>';
    return;
  }

  const endereco = location.origin + "/";

  const qr = qrcode(0, "M");  // 0 = tamanho automático; "M" = correção de erro média
  qr.addData(endereco);
  qr.make();

  elemento.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  elemento.querySelector("svg").setAttribute("aria-label", `QR code para ${endereco}`);

  // Endereço por extenso embaixo, sem "https://" e sem a barra final
  const legenda = document.createElement("p");
  legenda.className = "qr-endereco";
  legenda.textContent = endereco.replace(/^https?:\/\//, "").replace(/\/$/, "");
  elemento.append(legenda);
}
