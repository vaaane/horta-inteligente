// Tempos escritos do mesmo jeito no site inteiro (nada de "há 1115 min").
//
//   haQuanto(ts)   → "há 12 s", "há 5 min", "há 3 h", "ontem às 14:48", "há 3 dias"
//                    (serve depois de "Última atualização:" e de "ESP32 sem sinal")
//   semSinal(ts)   → "há 3 min" ou "desde ontem às 14:48" (aviso de offline)
//   quandoFoi(ts)  → "hoje 13:54", "ontem 13:54", "seg 28 13:54" (listas)
//   hora(ts)       → "13:54"
//
// "agora" é a hora do servidor quando o painel souber (relógio do celular errado).

const SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MIN = 60 * 1000;
const HORA = 60 * MIN;

export const hora = (ts) => new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

// Quantos dias de calendário separam ts de agora (0 = hoje, 1 = ontem…)
function diasAtras(ts, agora) {
  const meiaNoite = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  return Math.round((meiaNoite(agora) - meiaNoite(ts)) / (24 * HORA));
}

export function haQuanto(ts, agora = Date.now()) {
  const ms = Math.max(0, agora - ts);
  if (ms < MIN) return `há ${Math.floor(ms / 1000)} s`;
  if (ms < HORA) return `há ${Math.floor(ms / MIN)} min`;
  if (ms < 24 * HORA) return `há ${Math.floor(ms / HORA)} h`;
  const dias = diasAtras(ts, agora);
  if (dias <= 1) return `ontem às ${hora(ts)}`;
  return `há ${dias} dias`;
}

export function semSinal(ts, agora = Date.now()) {
  const texto = haQuanto(ts, agora);
  return texto.startsWith("há") ? texto : `desde ${texto}`;
}

export function quandoFoi(ts, agora = Date.now()) {
  const dias = diasAtras(ts, agora);
  if (dias === 0) return `hoje ${hora(ts)}`;
  if (dias === 1) return `ontem ${hora(ts)}`;
  const data = new Date(ts);
  if (dias < 7) return `${SEMANA[data.getDay()]} ${data.getDate()} ${hora(ts)}`;
  return `${data.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${hora(ts)}`;
}
