// Configurações públicas do site. O site é aberto: nada de senha, token ou
// chat id aqui (o token do bot fica só no secrets.h do ESP32).

// Canal do Telegram onde o bot da horta publica os alertas (canal, não grupo:
// só o bot publica e a lista de inscritos fica oculta).
// Vazio ("") = o painel não mostra o cartão nem os links do canal.
export const TELEGRAM_CANAL = "https://t.me/hortainteligenteced";

// "@hortainteligenteced", a partir do link do canal
export const arrobaDoCanal = () => (TELEGRAM_CANAL ? "@" + TELEGRAM_CANAL.replace(/\/+$/, "").split("/").pop() : "");

// Coloca o link do canal em todo elemento com data-canal-telegram (botão do
// painel no celular, item da página Sobre e rodapé). Sem canal, esconde todos.
export function ligarLinksTelegram(raiz = document) {
  for (const link of raiz.querySelectorAll("[data-canal-telegram]")) {
    if (!TELEGRAM_CANAL) {
      link.hidden = true;
      continue;
    }
    link.href = TELEGRAM_CANAL;
    link.target = "_blank";
    link.rel = "noopener";
  }
}
