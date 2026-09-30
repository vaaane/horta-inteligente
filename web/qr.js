// QR code com o endereço do site, para o visitante abrir no celular.
// Usa a biblioteca qrcode-generator (carregada no HTML antes deste arquivo).
// O desenho é feito aqui mesmo no navegador, em SVG — nenhuma imagem vem de fora.

// endereco: o link do QR (se não vier, é o endereço do site)
export function desenharQR(elemento, endereco = null) {
  // No computador (localhost ou arquivo aberto direto) o endereço não
  // funcionaria no celular do visitante: mostramos um aviso no lugar do QR.
  const host = location.hostname;
  if (!endereco && (host === "" || host === "localhost" || host === "127.0.0.1")) {
    elemento.innerHTML = '<p class="qr-aviso">O QR code aparece quando o site estiver publicado.</p>';
    return;
  }
  if (typeof qrcode === "undefined") {  // biblioteca não carregou (sem internet)
    elemento.innerHTML = "";
    return;
  }

  endereco = endereco || location.origin + "/";

  const qr = qrcode(0, "M");  // 0 = tamanho automático; "M" = correção de erro média
  qr.addData(endereco);
  qr.make();

  elemento.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  elemento.querySelector("svg").setAttribute("aria-label", `QR code para ${endereco}`);

  // Endereço por extenso embaixo, sem "https://" e sem a barra final
  const legenda = document.createElement("p");
  legenda.className = "qr-endereco";
  // (depois de cada "/" pode quebrar a linha: "t.me/" + "hortainteligenteced")
  legenda.textContent = endereco.replace(/^https?:\/\//, "").replace(/\/$/, "").replaceAll("/", "/\u200B");
  elemento.append(legenda);
}
