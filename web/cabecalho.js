// Cabeçalho comum (painel, Planeje sua horta e Sobre): no celular (≤ 600px)
// a navegação vira um botão ☰ que abre a lista de páginas.
// Sem JavaScript, a lista continua sempre aberta (a classe "com-js" é que esconde).
//
// Como usar:  iniciarCabecalho();  (no módulo de cada página)
export function iniciarCabecalho() {
  const topo = document.querySelector(".topo");
  const botao = topo?.querySelector(".menu-botao");
  if (!botao) return;
  topo.classList.add("com-js");

  const abrir = (aberto) => {
    botao.setAttribute("aria-expanded", String(aberto));
    botao.textContent = aberto ? "✕" : "☰";
  };
  botao.addEventListener("click", () => abrir(botao.getAttribute("aria-expanded") !== "true"));

  // Esc ou um toque fora fecham o menu
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && botao.getAttribute("aria-expanded") === "true") {
      abrir(false);
      botao.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!topo.contains(e.target)) abrir(false);
  });
}
