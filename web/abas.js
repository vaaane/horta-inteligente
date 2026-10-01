// Abas do painel: Agora · Água · Histórico · Demonstração
// Cada aba tem endereço próprio (#agora, #agua, #historico, #demo): abrir
// index.html#agua já abre na aba Água, e trocar de aba muda o endereço sem
// recarregar (o botão Voltar do navegador volta para a aba anterior).
// Os módulos continuam rodando com a aba escondida: aqui só se mostra e esconde.
//
// Como usar:
//   const abas = iniciarAbas({
//     padrao: "agora",
//     permitida: (nome) => true,        // false = a aba não pode abrir (ex.: Demonstração no celular)
//     aoMostrar: (nome, peloUsuario) => {}  // ex.: chart.resize() quando o gráfico aparece
//   });
//   abas.mostrar("agua");  abas.atual();  abas.atualizar();  // reavalia "permitida"

export function iniciarAbas({ padrao = "agora", permitida = () => true, aoMostrar = () => {} } = {}) {
  const lista = document.querySelector('[role="tablist"]');
  const botoes = [...lista.querySelectorAll('[role="tab"][data-aba]')];
  const painel = (botao) => document.getElementById(botao.getAttribute("aria-controls"));
  let atual = null;

  const existe = (nome) => botoes.some((b) => b.dataset.aba === nome);
  const visiveis = () => botoes.filter((b) => permitida(b.dataset.aba));

  // hash: "push" (clique: entra no histórico do navegador), "replace" ou "manter"
  function mostrar(nome, { hash = "replace", foco = false, peloUsuario = false } = {}) {
    if (!existe(nome) || !permitida(nome)) nome = padrao;
    for (const botao of botoes) {
      const ativo = botao.dataset.aba === nome;
      botao.setAttribute("aria-selected", String(ativo));
      botao.tabIndex = ativo ? 0 : -1;
      botao.hidden = !permitida(botao.dataset.aba);
      painel(botao).hidden = !ativo;
      if (ativo && foco) botao.focus();
    }
    if (hash !== "manter" && location.hash !== "#" + nome) {
      history[hash === "push" ? "pushState" : "replaceState"](null, "", "#" + nome);
    }
    const mudou = atual !== nome;
    atual = nome;
    if (mudou) aoMostrar(nome, peloUsuario);
  }

  for (const botao of botoes) {
    botao.addEventListener("click", () => mostrar(botao.dataset.aba, { hash: "push", peloUsuario: true }));
  }

  // Setas trocam de aba (padrão de acessibilidade das abas); Home/End vão para a primeira/última
  lista.addEventListener("keydown", (e) => {
    const abertas = visiveis();
    const i = abertas.findIndex((b) => b.dataset.aba === atual);
    let destino = null;
    if (e.key === "ArrowRight") destino = abertas[(i + 1) % abertas.length];
    else if (e.key === "ArrowLeft") destino = abertas[(i - 1 + abertas.length) % abertas.length];
    else if (e.key === "Home") destino = abertas[0];
    else if (e.key === "End") destino = abertas[abertas.length - 1];
    if (!destino) return;
    e.preventDefault();
    mostrar(destino.dataset.aba, { hash: "push", foco: true, peloUsuario: true });
  });

  // Links para "#historico", "#agua"… e o botão Voltar do navegador.
  // Alguns ids das abas são iguais aos dos cartões (#agua, #demo): volta ao topo.
  // (um endereço que não é aba, como "#xyz", vira "#agora")
  window.addEventListener("hashchange", () => {
    mostrar(location.hash.slice(1), { peloUsuario: true });
    window.scrollTo(0, 0);
  });

  mostrar(location.hash.slice(1) || padrao);
  // Ao abrir index.html#agua o navegador rola até o cartão #agua quando a
  // página termina de carregar: volta ao topo depois disso
  if (location.hash) {
    if (document.readyState === "complete") window.scrollTo(0, 0);
    else window.addEventListener("load", () => setTimeout(() => window.scrollTo(0, 0)), { once: true });
  }

  return {
    mostrar: (nome) => mostrar(nome),
    atual: () => atual,
    // A regra de "permitida" mudou (ex.: girou o tablet): esconde/mostra as abas
    atualizar: () => mostrar(atual)
  };
}
