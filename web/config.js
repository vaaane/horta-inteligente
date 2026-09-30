// Configurações públicas do site. O site é aberto: nada de senha, token ou
// chat id aqui (o token do bot fica só no secrets.h do ESP32).

// Canal do Telegram onde o bot da horta publica os alertas (os visitantes só leem)
export const CANAL_TELEGRAM = "https://t.me/hortainteligenteced";

// Coloca o link do canal em todo elemento com data-canal-telegram
// (botão do painel, item da página Sobre e rodapé de todas as páginas)
export function ligarLinksTelegram(raiz = document) {
  for (const link of raiz.querySelectorAll("[data-canal-telegram]")) {
    link.href = CANAL_TELEGRAM;
    link.target = "_blank";
    link.rel = "noopener";
  }
}
