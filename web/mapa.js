// Modo "Sobre o mapa" da página Planeje sua horta
// Mostra a imagem de satélite (Esri World Imagery, pelo Leaflet) para a
// pessoa encontrar o lugar da horta e desenhar por cima.
//
// Bibliotecas (carregadas no HTML): Leaflet 1.9.4 pelo cdnjs.
// Imagens: Esri World Imagery (gratuitas, sem chave).
// Busca de endereço: Nominatim, do OpenStreetMap (uma busca por clique).

const CENTRO_INICIAL = [-15.90, -47.78];  // São Sebastião (DF)
const ZOOM_INICIAL = 17;

const URL_SATELITE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const URL_NOMES = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const ATRIBUICAO_ESRI = "Imagens © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const URL_BUSCA = "https://nominatim.openstreetmap.org/search";

export function iniciarModoMapa({ elemento, busca, buscaTexto, buscaStatus, botaoLocalizacao, camadaNomes }) {
  let mapa = null;          // o mapa do Leaflet (criado na primeira vez que aparece)
  let nomes = null;         // camada de nomes de ruas (liga/desliga)

  // O Leaflet não carregou (sem internet?): o modo mapa não funciona
  const disponivel = typeof L !== "undefined";

  function criarMapa() {
    mapa = L.map(elemento, {
      center: CENTRO_INICIAL,
      zoom: ZOOM_INICIAL,
      maxZoom: 21,
      zoomAnimation: false  // o desenho por cima acompanha o zoom sem "pular"
    });
    L.tileLayer(URL_SATELITE, {
      maxNativeZoom: 19,  // as imagens vão até o zoom 19; depois disso, esticam
      maxZoom: 21,
      attribution: ATRIBUICAO_ESRI
    }).addTo(mapa);
    nomes = L.tileLayer(URL_NOMES, { maxNativeZoom: 19, maxZoom: 21 });
    L.control.scale({ imperial: false }).addTo(mapa);
  }

  // Aparece (ou some) quando a pessoa troca de modo
  function mostrar() {
    if (!disponivel) {
      buscaStatus.textContent = "Não consegui carregar o mapa (sem internet?). Use o Desenho livre.";
      return;
    }
    if (!mapa) criarMapa();
    mapa.invalidateSize();  // o mapa estava escondido: recalcula o tamanho
  }

  // ---------- Buscar endereço (Nominatim, uma busca por clique) ----------
  busca.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const texto = buscaTexto.value.trim();
    if (!texto || !mapa) return;
    buscaStatus.textContent = "Buscando…";
    try {
      const url = `${URL_BUSCA}?format=jsonv2&limit=1&accept-language=pt-BR&q=${encodeURIComponent(texto)}`;
      const resposta = await fetch(url, { headers: { Accept: "application/json" } });
      if (!resposta.ok) throw new Error(`código ${resposta.status}`);
      const lugares = await resposta.json();
      if (!lugares.length) {
        buscaStatus.textContent = "Não encontrei esse endereço. Tente escrever de outro jeito (rua, bairro, cidade).";
        return;
      }
      mapa.setView([Number(lugares[0].lat), Number(lugares[0].lon)], 19);
      buscaStatus.textContent = `Encontrado: ${lugares[0].display_name}`;
    } catch (erro) {
      buscaStatus.textContent = `Não consegui buscar agora (${erro.message}). Confira a internet.`;
    }
  });

  // ---------- Usar minha localização ----------
  botaoLocalizacao.addEventListener("click", () => {
    if (!mapa) return;
    if (!navigator.geolocation) {
      buscaStatus.textContent = "Este navegador não informa a localização. Busque o endereço no campo acima.";
      return;
    }
    buscaStatus.textContent = "Procurando sua localização…";
    navigator.geolocation.getCurrentPosition(
      (posicao) => {
        mapa.setView([posicao.coords.latitude, posicao.coords.longitude], 19);
        buscaStatus.textContent = `Localização encontrada (precisão de ~${Math.round(posicao.coords.accuracy)} m).`;
      },
      (erro) => {
        buscaStatus.textContent = erro.code === erro.PERMISSION_DENIED
          ? "Você não permitiu usar a localização. Tudo bem: busque o endereço no campo acima."
          : "Não consegui descobrir a localização agora. Busque o endereço no campo acima.";
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });

  // ---------- Nomes de ruas por cima (liga/desliga) ----------
  camadaNomes.addEventListener("change", () => {
    if (!mapa) return;
    if (camadaNomes.checked) nomes.addTo(mapa);
    else nomes.remove();
  });

  return { disponivel, mostrar };
}
