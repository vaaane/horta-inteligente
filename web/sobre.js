// Página "Sobre o projeto" — monta os cartões de funcionalidades
// Para mudar o status de um item, troque "proxima" por "funcionando" (ou o contrário).
import { desenharQR } from "./qr.js";

const STATUS = {
  funcionando: { texto: "Funcionando", classe: "selo-funcionando" },
  proxima: { texto: "Próxima etapa", classe: "selo-proxima" }
};

const grupos = [
  {
    titulo: "Decidir quando e quanto regar",
    itens: [
      { titulo: "Rega pela umidade do solo", frase: "Liga abaixo do limite e desliga no nível ideal; tem modo manual.", status: "funcionando" },
      { titulo: "Adiar a rega se vai chover", frase: "Usa a previsão do Open-Meteo: com 60% ou mais de chance de chuva, espera.", status: "funcionando" },
      { titulo: "Confirmar se a chuva caiu", frase: "Sensor de chuva e pluviômetro: se não choveu, rega mesmo assim.", status: "proxima" },
      { titulo: "Horário inteligente", frase: "Evita o sol forte do meio-dia e prioriza manhã cedo e fim de tarde.", status: "proxima" },
      { titulo: "Quanto regar pela ET₀", frase: "Calcula a água a repor pela evapotranspiração do dia.", status: "proxima" },
      { titulo: "Prever quando o solo vai secar", frase: "Mostra algo como \"próxima rega em ~14 h\".", status: "proxima" },
      { titulo: "Limites por tipo de planta", frase: "Zonas separadas para alface, cebolinha e tomate.", status: "proxima" },
      { titulo: "Detecção de falhas", frase: "Bomba ligada e umidade sem subir = reservatório vazio, mangueira solta ou bomba com defeito.", status: "proxima" }
    ]
  },
  {
    titulo: "Economizar e medir",
    itens: [
      { titulo: "Medição da água usada", frase: "Sensor de fluxo YF-S201, comparando com um timer fixo.", status: "proxima" },
      { titulo: "Economia em impacto", frase: "Água economizada em banhos de 5 min e garrafões de 20 L.", status: "proxima" },
      { titulo: "Água da chuva primeiro", frase: "Usa o reservatório de chuva e avisa quando ele está baixo.", status: "proxima" },
      { titulo: "Energia solar", frase: "Placa solar e bateria para o sistema funcionar sozinho.", status: "proxima" }
    ]
  },
  {
    titulo: "Mostrar e avisar",
    itens: [
      { titulo: "Painel web ao vivo", frase: "Umidade, bomba e histórico atualizando sozinhos.", status: "funcionando" },
      { titulo: "Consulta do clima", frase: "Chance de chuva e ET₀ exibidas no painel.", status: "funcionando" },
      { titulo: "Motivo de cada decisão", frase: "\"Não reguei às 17h porque havia 80% de chance de chuva.\"", status: "funcionando" },
      { titulo: "Alertas no celular", frase: "Avisos pelo Telegram.", status: "proxima" },
      { titulo: "Modo demonstração", frase: "Simular \"70% de chance de chuva\" ao vivo, porque no DF setembro e outubro são muito secos.", status: "proxima" },
      { titulo: "Time-lapse de crescimento", frase: "Fotos com a ESP32-CAM (a avaliar).", status: "proxima" },
      { titulo: "Espantalho eletrônico", frase: "Sensor de movimento PIR com buzzer ou LED.", status: "proxima" }
    ]
  },
  {
    titulo: "Planejar a horta",
    itens: [
      { titulo: "Umidade e sol ideais por cultura", frase: "Pleno sol (6 h ou mais), meia-sombra (3 a 6 h) ou sombra.", status: "proxima" },
      { titulo: "Sol suficiente ou não", frase: "O sensor BH1750 conta as horas de sol de cada canteiro (média de vários dias).", status: "proxima" },
      { titulo: "Desenhe sua horta + mapa de sol", frase: "SunCalc a cada 30 min, com obstáculos e suas alturas. No hemisfério sul, a face norte recebe mais sol.", status: "proxima" },
      { titulo: "Melhor lugar para cada planta", frase: "Sugere o canteiro certo para cada cultura.", status: "proxima" },
      { titulo: "Previsto × medido", frase: "Compara o mapa de sol com as medidas na maquete.", status: "proxima" }
    ]
  }
];

// ---------- Cria os cartões na página ----------
const elFuncionalidades = document.getElementById("funcionalidades");

for (const grupo of grupos) {
  const titulo = document.createElement("h3");
  titulo.className = "grupo-titulo";
  titulo.textContent = grupo.titulo;
  elFuncionalidades.append(titulo);

  const lista = document.createElement("div");
  lista.className = "funcionalidades";

  for (const item of grupo.itens) {
    const status = STATUS[item.status];
    const cartao = document.createElement("article");
    cartao.className = "cartao funcionalidade";
    cartao.innerHTML = `
      <span class="selo ${status.classe}">${status.texto}</span>
      <h4>${item.titulo}</h4>
      <p>${item.frase}</p>
    `;
    lista.append(cartao);
  }

  elFuncionalidades.append(lista);
}

// ---------- QR code no fim da página ----------
desenharQR(document.getElementById("qr"));
