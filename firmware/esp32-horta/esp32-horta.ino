// =====================================================================
//  HORTA INTELIGENTE — firmware do ESP32
//  CED São Bartolomeu (DF) — Feira de Ciências
//
//  O que este programa faz:
//   1. Lê o sensor de umidade do solo.
//   2. A cada 30 min consulta a previsão do tempo no Open-Meteo e grava
//      o resumo em /clima (o site mostra no cartão "Clima agora").
//   3. Decide se rega: liga a bomba quando a terra está seca, MAS adia a
//      rega se a chance de chuva nas próximas 6 h for alta (a não ser que
//      o solo esteja seco demais). Desliga quando a terra está molhada.
//   4. Cada decisão tem um código e um motivo em português, que aparecem
//      no Serial Monitor e no painel ("Por que regou (ou não)").
//   5. A cada 30 segundos, envia os dados e a decisão para o Firebase.
//      Quando a bomba liga/desliga ou a decisão muda, envia na hora.
//   6. A cada 3 s lê do Firebase se alguém mudou o modo ou ligou/desligou
//      a bomba pelo site. O modo manual volta sozinho para o automático
//      depois de 10 min (o controle pelo site é aberto, sem login).
//
//  Se o Wi-Fi ou o Firebase caírem, a rega continua funcionando sozinha,
//  só com o sensor (sem previsão válida, a horta rega normalmente).
//
//  Montagem de teste (sem bomba e sem sensor de verdade):
//   - LED no lugar do relé: GPIO 26 -> resistor (220 a 330 Ω) -> perna
//     comprida do LED; perna curta -> GND. Use RELE_ATIVO_EM_LOW = false.
//   - Potenciômetro no lugar do sensor: uma ponta no 3V3, a outra no GND
//     e o pino do meio no GPIO 34. Girando, a "umidade" vai de 0% a 100%.
//     Atenção: use o 3V3, NUNCA o 5V (5 V queima a entrada do ESP32).
//     O GPIO 34 é um pino próprio, marcado "34" ou "D34" na placa:
//     não é o VP (GPIO 36) nem o VN (GPIO 39).
//
//  Placa: ESP32 DevKit (core "esp32" da Espressif na Arduino IDE)
//  Biblioteca extra: ArduinoJson (versão 7), pelo Gerenciador de Bibliotecas
// =====================================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "secrets.h"  // copie secrets.example.h -> secrets.h e preencha

// ---------------------------------------------------------------------
//  PINOS
// ---------------------------------------------------------------------

// Sensor de umidade no GPIO 34. Ele fica no ADC1.
// Atenção: os pinos do ADC2 (ex.: 0, 2, 4, 12–15, 25–27) NÃO funcionam
// como entrada analógica enquanto o Wi-Fi está ligado. Por isso usamos o 34.
const int PINO_SENSOR = 34;

// Módulo relé que liga a bomba.
const int PINO_RELE = 26;

// true = a bomba liga quando o pino vai para LOW (0 V).
// LED de teste ligado direto no pino: false. Módulo relé de verdade: normalmente true.
const bool RELE_ATIVO_EM_LOW = false;

// ---------------------------------------------------------------------
//  CALIBRAÇÃO DO SENSOR
//  Veja no Serial Monitor o "valor bruto" com o sensor:
//   - no ar ou em terra bem seca  -> coloque em VALOR_SECO
//   - dentro de um copo com água  -> coloque em VALOR_MOLHADO
// ---------------------------------------------------------------------
const int VALOR_SECO    = 3200;
const int VALOR_MOLHADO = 1300;

// ---------------------------------------------------------------------
//  REGRAS DA REGA (modo automático)
// ---------------------------------------------------------------------
const int LIMITE_LIGAR    = 35;  // abaixo de 35% -> liga a bomba
const int LIMITE_DESLIGAR = 60;  // acima de 60%  -> desliga a bomba

const int LIMITE_CHUVA   = 60;  // chance de chuva (%) a partir da qual a rega é adiada
const int LIMITE_CRITICO = 20;  // abaixo disso rega mesmo com chuva prevista
const unsigned long VALIDADE_CLIMA = 90UL * 60 * 1000; // previsão mais velha que isso é ignorada

// Só para testar em casa: -1 = usa a previsão real.
// Coloque, por exemplo, 80 para fingir 80% de chance de chuva.
const int SIMULAR_CHANCE_CHUVA = -1;

// Segurança: a bomba nunca fica ligada mais que 60 s seguidos.
// Depois disso ela descansa 5 min (a água precisa de tempo para chegar ao sensor).
const unsigned long TEMPO_MAX_BOMBA   = 60UL * 1000;
const unsigned long TEMPO_PAUSA_BOMBA = 5UL * 60 * 1000;

// Segurança do site (que é aberto): o modo manual dura no máximo 10 min.
// Depois disso o próprio ESP32 grava "auto" em /horta/comandos.
const unsigned long TEMPO_MAX_MANUAL = 10UL * 60 * 1000;

// ---------------------------------------------------------------------
//  TEMPOS (em milissegundos)
// ---------------------------------------------------------------------
const unsigned long INTERVALO_SENSOR   = 2000;   // lê o sensor a cada 2 s
const unsigned long INTERVALO_COMANDOS = 3000;   // lê os comandos do site a cada 3 s
const unsigned long INTERVALO_ENVIO    = 30000;  // envia o histórico ao Firebase a cada 30 s
const unsigned long INTERVALO_WIFI     = 30000;  // só força uma nova conexão depois de 30 s sem Wi-Fi
const int FALHAS_PARA_AUTOMATICO = 3;  // leituras seguidas dos comandos que falharam -> volta ao automático
const unsigned long MARGEM_TOKEN     = 5UL * 60 * 1000; // renova o login 5 min antes de vencer
const unsigned long INTERVALO_CLIMA      = 30UL * 60 * 1000; // consulta o clima a cada 30 min
const unsigned long INTERVALO_CLIMA_ERRO = 5UL * 60 * 1000;  // se falhar, tenta de novo em 5 min
const unsigned long TIMEOUT_HTTP         = 10000;            // espera no máximo 10 s por resposta

// ---------------------------------------------------------------------
//  PREVISÃO DO TEMPO (Open-Meteo, gratuito e sem cadastro)
// ---------------------------------------------------------------------

// Local da horta (CED São Bartolomeu, DF)
const char* LATITUDE  = "-15.90";
const char* LONGITUDE = "-47.78";

// Previsão do Open-Meteo: clima de agora, chance de chuva hora a hora
// e evapotranspiração (ET0) do dia. forecast_days=2 garante que a lista
// de horas sempre tenha as próximas horas, mesmo à noite.
const char* URL_OPEN_METEO =
  "https://api.open-meteo.com/v1/forecast"
  "?latitude=%s&longitude=%s"
  "&current=temperature_2m,relative_humidity_2m,precipitation"
  "&hourly=precipitation_probability"
  "&daily=et0_fao_evapotranspiration,precipitation_probability_max"
  "&timezone=America/Sao_Paulo&forecast_days=2";

const int HORAS_CHUVA = 6;  // olha a chance de chuva nas próximas 6 horas

// ---------------------------------------------------------------------
//  VARIÁVEIS DO PROGRAMA
// ---------------------------------------------------------------------
int umidade = 0;       // em %
int umidadeBruta = 0;  // valor do ADC, de 0 a 4095

bool bombaLigada = false;
unsigned long bombaLigadaDesde = 0;
bool emPausa = false;
unsigned long pausaDesde = 0;

// Comandos que vêm do site
bool modoManual = false;
bool bombaManual = false;
unsigned long manualDesdeMs = 0;   // millis() de quando entrou no modo manual
double sessaoManual = -1;          // "manualDesde" que o site gravou (identifica o pedido)
int falhasComandos = 0;            // leituras seguidas que falharam

// O que o painel já sabe (último estado enviado com sucesso).
// Quando for diferente do atual, o estado é enviado na hora.
bool bombaEnviada = false;
String decisaoEnviada = "";

// Login no Firebase
String idToken = "";
String refreshToken = "";
unsigned long tokenObtidoEm = 0;
unsigned long tokenValidade = 0;

// Relógios do millis()
unsigned long ultimaLeitura = 0;
unsigned long ultimoEnvio = 0;
unsigned long ultimaLeituraComandos = 0;
unsigned long ultimaTentativaEstado = 0;
unsigned long ultimaTentativaWiFi = 0;
unsigned long ultimaConsultaClima = 0;
unsigned long esperaClima = 0;  // quanto esperar até a próxima consulta do clima

// Dados do clima (vêm do Open-Meteo)
struct DadosClima {
  float temperatura = 0;     // °C
  int umidadeAr = 0;         // %
  float chuvaAgoraMm = 0;    // mm de chuva agora
  int chanceChuva6h = 0;     // maior chance de chuva nas próximas 6 h (%)
  float et0 = 0;             // água que a planta de referência perde hoje (mm)
  String horaPrevisao = "";  // hora da previsão, ex.: "2026-09-28T19:30"
  unsigned long atualizadoEmMs = 0;  // millis() da última consulta que deu certo
  bool valido = false;       // true depois da primeira consulta que deu certo
};
DadosClima clima;

// Decisão da rega (vai para o Serial Monitor e para o painel)
String decisaoAtual = "";  // código, ex.: "adiada_chuva"
String motivoAtual = "";   // frase em português

// Fila de um item para o histórico /horta/decisoes: guarda só a última
// mudança de decisão que ainda não foi enviada (ex.: estava sem Wi-Fi).
bool decisaoPendente = false;
String pendenteDecisao = "";
String pendenteMotivo = "";
int pendenteUmidade = 0;
int pendenteChance = -1;   // -1 = não tinha previsão válida


// =====================================================================
//  BOMBA
// =====================================================================

void acionarBomba(bool ligar) {
  if (ligar == bombaLigada) return;  // já está como queremos

  bombaLigada = ligar;
  if (ligar) bombaLigadaDesde = millis();

  // Descobre se o pino precisa ir para HIGH ou LOW
  int nivel;
  if (RELE_ATIVO_EM_LOW) nivel = ligar ? LOW : HIGH;
  else                   nivel = ligar ? HIGH : LOW;
  digitalWrite(PINO_RELE, nivel);

  Serial.println(ligar ? "[Bomba] LIGADA" : "[Bomba] DESLIGADA");
}


// =====================================================================
//  SENSOR
// =====================================================================

void lerSensor() {
  // Faz a média de 10 leituras para o valor não ficar pulando
  long soma = 0;
  for (int i = 0; i < 10; i++) {
    soma += analogRead(PINO_SENSOR);
    delay(5);
  }
  umidadeBruta = soma / 10;

  // Converte o valor bruto em porcentagem (seco = 0%, molhado = 100%)
  umidade = map(umidadeBruta, VALOR_SECO, VALOR_MOLHADO, 0, 100);
  umidade = constrain(umidade, 0, 100);

  Serial.printf("[Sensor] Umidade: %d%% (valor bruto: %d)\n", umidade, umidadeBruta);
}


// =====================================================================
//  DECISÃO DA REGA
// =====================================================================

// Chance de chuva a usar na decisão, ou -1 se não houver previsão válida
// (nunca consultou, a consulta falhou ou a previsão tem mais de 90 min).
int chanceDeChuva() {
  if (SIMULAR_CHANCE_CHUVA >= 0) return SIMULAR_CHANCE_CHUVA;  // modo de teste
  if (!clima.valido) return -1;
  if (millis() - clima.atualizadoEmMs > VALIDADE_CLIMA) return -1;
  return clima.chanceChuva6h;
}

// Guarda a decisão. Quando o CÓDIGO muda, avisa no Serial Monitor e
// coloca a mudança na fila para o histórico (/horta/decisoes).
// (O motivo muda a cada leitura porque tem a umidade; o código não.)
void registrarDecisao(const char* codigo, const char* motivo, int chance) {
  motivoAtual = motivo;
  if (decisaoAtual == codigo) return;

  decisaoAtual = codigo;
  Serial.printf("[Decisão] %s — %s\n", codigo, motivo);

  decisaoPendente = true;  // se já tinha uma na fila, a nova substitui
  pendenteDecisao = codigo;
  pendenteMotivo = motivo;
  pendenteUmidade = umidade;
  pendenteChance = chance;
}

void controlarBomba() {
  unsigned long agora = millis();

  // Segurança: ligada tempo demais? Desliga e entra em pausa.
  if (bombaLigada && agora - bombaLigadaDesde >= TEMPO_MAX_BOMBA) {
    Serial.println("[Bomba] Tempo máximo atingido! Pausa de segurança.");
    acionarBomba(false);
    emPausa = true;
    pausaDesde = agora;
  }

  // Fim da pausa?
  if (emPausa && agora - pausaDesde >= TEMPO_PAUSA_BOMBA) {
    emPausa = false;
    Serial.println("[Bomba] Fim da pausa de segurança.");
  }

  // O que a bomba deveria fazer agora, e por quê?
  int chance = chanceDeChuva();  // -1 = sem previsão válida
  bool querLigar = false;
  const char* codigo;
  char motivo[200];

  if (emPausa) {
    // 1) Durante a pausa de segurança a bomba não liga de jeito nenhum
    codigo = "pausa_seguranca";
    snprintf(motivo, sizeof(motivo), "Pausa de segurança: a bomba ficou %lu s ligada e está descansando %lu min.",
             TEMPO_MAX_BOMBA / 1000, TEMPO_PAUSA_BOMBA / 60000);

  } else if (modoManual) {
    // 2) Modo manual: obedece o site
    querLigar = bombaManual;
    codigo = bombaManual ? "manual_ligada" : "manual_desligada";
    snprintf(motivo, sizeof(motivo), "Modo manual: bomba %s pelo painel.", bombaManual ? "ligada" : "desligada");

  } else if (bombaLigada && umidade < LIMITE_DESLIGAR) {
    // 3) Já está regando: continua até passar de LIMITE_DESLIGAR.
    querLigar = true;
    // Se ligou por "solo crítico" ou "sem previsão", mantém esse motivo até
    // terminar a rega. Senão ele seria trocado por "regando" 2 s depois e
    // o motivo mais importante sumiria do painel e do histórico.
    if (decisaoAtual == "solo_critico" || decisaoAtual == "sem_previsao") {
      acionarBomba(true);
      return;
    }
    codigo = "regando";
    snprintf(motivo, sizeof(motivo), "Regando: o solo está com %d%%, vai até %d%%.", umidade, LIMITE_DESLIGAR);

  } else if (umidade < LIMITE_LIGAR) {
    // 4) Solo seco: olha a previsão antes de gastar água
    if (chance < 0) {
      // Sem previsão: rega, que é o comportamento seguro
      querLigar = true;
      codigo = "sem_previsao";
      snprintf(motivo, sizeof(motivo), "Sem previsão do tempo: reguei só pelo sensor (solo com %d%%).", umidade);
    } else if (chance >= LIMITE_CHUVA && umidade >= LIMITE_CRITICO) {
      // Vai chover: deixa a chuva regar
      codigo = "adiada_chuva";
      snprintf(motivo, sizeof(motivo), "Não reguei: %d%% de chance de chuva nas próximas 6 h.%s",
               chance, SIMULAR_CHANCE_CHUVA >= 0 ? " (simulado)" : "");
    } else if (chance >= LIMITE_CHUVA) {
      // Vai chover, mas o solo está seco demais para esperar
      querLigar = true;
      codigo = "solo_critico";
      snprintf(motivo, sizeof(motivo), "Reguei mesmo com %d%% de chance de chuva: o solo chegou a %d%%.", chance, umidade);
    } else {
      // Chance de chuva baixa: rega
      querLigar = true;
      codigo = "regando";
      snprintf(motivo, sizeof(motivo), "Regando: o solo chegou a %d%% e a chance de chuva é de %d%%.", umidade, chance);
    }

  } else {
    // 5) Solo úmido: nada a fazer
    codigo = "solo_ok";
    snprintf(motivo, sizeof(motivo), "Solo úmido o bastante (%d%%): não precisa regar.", umidade);
  }

  registrarDecisao(codigo, motivo, chance);
  acionarBomba(querLigar);
}


// =====================================================================
//  WI-FI
// =====================================================================

void cuidarDoWiFi() {
  static bool estavaConectado = false;
  bool conectado = WiFi.status() == WL_CONNECTED;

  if (conectado && !estavaConectado) {
    Serial.printf("[Wi-Fi] Conectado! IP: %s\n", WiFi.localIP().toString().c_str());
    // Ainda sem clima? Consulta logo que o Wi-Fi conectar.
    if (!clima.valido) esperaClima = 0;
  }
  if (!conectado && estavaConectado) {
    Serial.println("[Wi-Fi] Conexão perdida.");
    ultimaTentativaWiFi = millis();  // dá 30 s para a reconexão automática
  }
  estavaConectado = conectado;

  // A reconexão automática (setAutoReconnect) costuma resolver sozinha.
  // No roteador do celular a entrega do IP pode demorar mais de 10 s, então
  // só recomeçamos do zero depois de 30 s sem conectar.
  if (!conectado && millis() - ultimaTentativaWiFi >= INTERVALO_WIFI) {
    ultimaTentativaWiFi = millis();
    Serial.printf("[Wi-Fi] Tentando conectar em \"%s\"...\n", WIFI_SSID);
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
}

// Chamada pelo sistema do Wi-Fi sempre que a conexão cai (ou uma tentativa
// falha). Mostra o código do motivo e uma explicação para os mais comuns.
void aoDesconectarWiFi(arduino_event_id_t evento, arduino_event_info_t info) {
  int motivo = info.wifi_sta_disconnected.reason;
  const char* explicacao = "";
  switch (motivo) {
    case 2:
    case 15:  explicacao = "senha errada ou rede com segurança WPA3; use WPA2"; break;
    case 201: explicacao = "rede não encontrada (nome errado ou rede em 5 GHz)"; break;
    case 8:   explicacao = "o roteador desconectou o ESP32"; break;
    case 200:
    case 202: explicacao = "sinal fraco ou falha de autenticação"; break;
  }
  Serial.printf("[Wi-Fi] Desconectado (motivo %d) %s\n", motivo, explicacao);
}


// =====================================================================
//  HTTP — faz um pedido para um endereço da internet
//  Devolve o código HTTP (200 = deu certo) e guarda a resposta.
// =====================================================================

int requisicao(const char* metodo, const String& url, const String& corpo,
               const char* tipoConteudo, String& resposta) {
  // setInsecure(): usa HTTPS, mas sem conferir o certificado do servidor.
  // É uma simplificação aceitável para um projeto escolar.
  WiFiClientSecure cliente;
  cliente.setInsecure();

  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(cliente, url)) return -1;
  if (corpo.length() > 0) http.addHeader("Content-Type", tipoConteudo);

  int codigo = http.sendRequest(metodo, corpo);
  resposta = (codigo > 0) ? http.getString() : "";
  http.end();
  return codigo;
}

// ---------------------------------------------------------------------
//  Conexão com o banco (Realtime Database) que fica ABERTA entre um
//  pedido e outro. Os comandos são lidos a cada 3 s: abrir uma conexão
//  HTTPS nova toda vez demora (a "apresentação" segura leva ~1 s) e gasta
//  memória. Com setReuse(true) o http.end() não fecha a conexão e o
//  próximo pedido usa a mesma. Se ela cair, o HTTPClient abre outra.
//  (O login e o Open-Meteo são outros endereços: usam requisicao().)
// ---------------------------------------------------------------------
WiFiClientSecure clienteBanco;
HTTPClient httpBanco;
unsigned long duracaoPedido = 0;  // quanto tempo levou o último pedido (ms)

int pedidoBanco(const char* metodo, const String& url, const String& corpo, String& resposta) {
  if (!httpBanco.begin(clienteBanco, url)) return -1;
  if (corpo.length() > 0) httpBanco.addHeader("Content-Type", "application/json");
  int codigo = httpBanco.sendRequest(metodo, corpo);
  resposta = (codigo > 0) ? httpBanco.getString() : "";
  httpBanco.end();                     // com setReuse(true), a conexão continua aberta
  if (codigo < 0) clienteBanco.stop(); // deu erro: fecha, a próxima abre uma nova
  return codigo;
}

int requisicaoBanco(const char* metodo, const String& url, const String& corpo, String& resposta) {
  unsigned long inicio = millis();
  bool reaproveitando = clienteBanco.connected();
  int codigo = pedidoBanco(metodo, url, corpo, resposta);

  // O servidor pode ter fechado a conexão velha sem avisar: o primeiro
  // pedido falha. Nesse caso tenta mais uma vez, já com uma conexão nova.
  if (codigo < 0 && reaproveitando) {
    codigo = pedidoBanco(metodo, url, corpo, resposta);
  }
  duracaoPedido = millis() - inicio;
  return codigo;
}


// =====================================================================
//  LOGIN NO FIREBASE (Authentication, via API REST)
// =====================================================================

bool fazerLogin() {
  Serial.println("[Firebase] Fazendo login...");

  JsonDocument pedido;
  pedido["email"] = ESP_EMAIL;
  pedido["password"] = ESP_SENHA;
  pedido["returnSecureToken"] = true;
  String corpo;
  serializeJson(pedido, corpo);

  String url = String("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=") + FIREBASE_API_KEY;
  String resposta;
  int codigo = requisicao("POST", url, corpo, "application/json", resposta);
  if (codigo != 200) {
    Serial.printf("[Firebase] Falha no login (código %d): %s\n", codigo, resposta.c_str());
    return false;
  }

  JsonDocument r;
  if (deserializeJson(r, resposta)) {
    Serial.println("[Firebase] Resposta do login inválida.");
    return false;
  }
  idToken = r["idToken"].as<String>();
  refreshToken = r["refreshToken"].as<String>();
  tokenValidade = r["expiresIn"].as<String>().toInt() * 1000UL;  // vem em segundos
  tokenObtidoEm = millis();

  Serial.println("[Firebase] Login OK!");
  return true;
}

bool renovarToken() {
  Serial.println("[Firebase] Renovando o login...");

  String url = String("https://securetoken.googleapis.com/v1/token?key=") + FIREBASE_API_KEY;
  String corpo = "grant_type=refresh_token&refresh_token=" + refreshToken;
  String resposta;
  int codigo = requisicao("POST", url, corpo, "application/x-www-form-urlencoded", resposta);
  if (codigo != 200) {
    Serial.printf("[Firebase] Falha ao renovar (código %d).\n", codigo);
    return false;
  }

  JsonDocument r;
  if (deserializeJson(r, resposta)) return false;
  idToken = r["id_token"].as<String>();
  refreshToken = r["refresh_token"].as<String>();
  tokenValidade = r["expires_in"].as<String>().toInt() * 1000UL;
  tokenObtidoEm = millis();

  Serial.println("[Firebase] Login renovado!");
  return true;
}

// Garante que temos um login válido antes de mandar dados
bool garantirLogin() {
  if (idToken == "") return fazerLogin();

  // O login vale 1 hora. Renovamos 5 min antes de vencer (~55 min).
  if (tokenValidade < MARGEM_TOKEN) tokenValidade = 3600UL * 1000;
  if (millis() - tokenObtidoEm >= tokenValidade - MARGEM_TOKEN) {
    if (renovarToken()) return true;
    idToken = "";          // renovação falhou: faz login do zero
    return fazerLogin();
  }
  return true;
}


// =====================================================================
//  COMUNICAÇÃO COM O BANCO (Realtime Database, via API REST)
// =====================================================================

String urlBanco(const char* caminho) {
  return String(FIREBASE_DB_URL) + caminho + ".json?auth=" + idToken;
}

// Se o Firebase não responder, a horta volta para o modo automático
void voltarParaAutomatico() {
  if (modoManual) Serial.println("[Comandos] Sem conexão: voltando para o modo automático.");
  modoManual = false;
}

// Tem Wi-Fi e login? (sem isso não dá para falar com o banco)
bool prontoParaFirebase() {
  return WiFi.status() == WL_CONNECTED && garantirLogin();
}

// Estado atual (/horta/estado) e, se houver, a mudança de decisão para o
// histórico (/horta/decisoes). Chamada a cada 30 s e também na hora em que
// a bomba liga/desliga ou a decisão muda.
void enviarEstado() {
  String resposta;

  // PUT substitui o valor anterior
  JsonDocument estado;
  estado["umidade"] = umidade;
  estado["umidadeBruta"] = umidadeBruta;
  estado["bomba"] = bombaLigada;
  estado["ts"][".sv"] = "timestamp";  // o Firebase coloca a hora dele
  if (decisaoAtual != "") {
    estado["decisao"] = decisaoAtual;
    estado["motivo"] = motivoAtual;
  }
  String corpoEstado;
  serializeJson(estado, corpoEstado);

  int codigo = requisicaoBanco("PUT", urlBanco("/horta/estado"), corpoEstado, resposta);
  Serial.printf("[Firebase] Estado enviado (código %d, %lu ms)\n", codigo, duracaoPedido);
  if (codigo == 401) idToken = "";  // login recusado: faz de novo no próximo ciclo
  if (codigo == 200) {
    bombaEnviada = bombaLigada;     // agora o painel sabe
    decisaoEnviada = decisaoAtual;
  }

  // Histórico das decisões: só quando o código mudou (fila de um item)
  if (decisaoPendente) {
    JsonDocument decisao;
    decisao["decisao"] = pendenteDecisao;
    decisao["motivo"] = pendenteMotivo;
    decisao["umidade"] = pendenteUmidade;
    if (pendenteChance >= 0) decisao["chanceChuva"] = pendenteChance;  // só com previsão válida
    decisao["ts"][".sv"] = "timestamp";
    String corpoDecisao;
    serializeJson(decisao, corpoDecisao);

    codigo = requisicaoBanco("POST", urlBanco("/horta/decisoes"), corpoDecisao, resposta);
    Serial.printf("[Firebase] Decisão salva no histórico (código %d)\n", codigo);
    if (codigo == 200) decisaoPendente = false;  // se falhou, tenta de novo depois
  }
}

// A cada 30 s: estado + uma leitura nova no histórico (gráfico do painel)
void enviarDados() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[Firebase] Sem Wi-Fi, envio adiado. A rega continua pelo sensor.");
    voltarParaAutomatico();
    return;
  }
  if (!garantirLogin()) {
    voltarParaAutomatico();
    return;
  }

  enviarEstado();

  // Histórico: POST cria uma entrada nova na lista
  JsonDocument leitura;
  leitura["umidade"] = umidade;
  leitura["bomba"] = bombaLigada;
  leitura["ts"][".sv"] = "timestamp";
  String corpoLeitura;
  serializeJson(leitura, corpoLeitura);

  String resposta;
  int codigo = requisicaoBanco("POST", urlBanco("/horta/leituras"), corpoLeitura, resposta);
  Serial.printf("[Firebase] Leitura salva no histórico (código %d)\n", codigo);
}

// A bomba ligou/desligou ou a decisão mudou? Envia o estado na hora, sem
// esperar os 30 s, para o painel mostrar o estado real em poucos segundos.
// Se o envio falhar, tenta de novo a cada 3 s.
void enviarMudancas() {
  if (bombaLigada == bombaEnviada && decisaoAtual == decisaoEnviada) return;
  if (millis() - ultimaTentativaEstado < INTERVALO_COMANDOS) return;
  ultimaTentativaEstado = millis();
  if (!prontoParaFirebase()) return;

  Serial.println("[Firebase] A bomba ou a decisão mudou: enviando o estado agora.");
  enviarEstado();
}

// Grava "auto" em /horta/comandos (o site mostra o modo automático de novo)
bool gravarModoAutomatico() {
  String resposta;
  int codigo = requisicaoBanco("PUT", urlBanco("/horta/comandos"),
                               "{\"modo\":\"auto\",\"bombaManual\":false}", resposta);
  if (codigo != 200) Serial.printf("[Comandos] Não consegui gravar o modo automático (código %d).\n", codigo);
  return codigo == 200;
}

// A cada 3 s: lê o que o site pediu em /horta/comandos.
// Devolve true se o modo ou a bomba manual mudaram.
bool lerComandos() {
  if (!prontoParaFirebase()) {
    voltarParaAutomatico();
    return false;
  }

  String resposta;
  int codigo = requisicaoBanco("GET", urlBanco("/horta/comandos"), "", resposta);
  JsonDocument comandos;
  if (codigo != 200 || deserializeJson(comandos, resposta)) {
    if (codigo == 401) idToken = "";
    falhasComandos++;
    Serial.printf("[Comandos] Não consegui ler (código %d, falha %d de %d).\n",
                  codigo, falhasComandos, FALHAS_PARA_AUTOMATICO);
    // Uma falha solta não desliga o manual; várias seguidas, sim
    if (falhasComandos >= FALHAS_PARA_AUTOMATICO) voltarParaAutomatico();
    return false;
  }
  falhasComandos = 0;

  // Medição: o tempo de cada leitura aparece no Serial quando o comando
  // muda. Com a conexão reaproveitada ela é bem mais rápida do que abrindo
  // uma conexão HTTPS nova. Aqui só avisa se ficar lenta.
  if (duracaoPedido > 2000) Serial.printf("[Comandos] Leitura lenta: %lu ms\n", duracaoPedido);

  // Se ainda não existir nada em /comandos, fica no automático
  const char* modo = comandos["modo"] | "auto";
  bool novoManual = strcmp(modo, "manual") == 0;
  bool novaBomba = comandos["bombaManual"] | false;
  double desde = comandos["manualDesde"] | 0.0;  // hora do servidor em que o site pediu o manual

  // Entrou no modo manual agora? Marca a hora no millis().
  // Se for o mesmo pedido de antes (mesmo "manualDesde"), mantém a hora
  // antiga: assim uma queda de conexão não "zera" os 10 min.
  if (novoManual && !modoManual && (desde == 0 || desde != sessaoManual)) {
    manualDesdeMs = millis();
    sessaoManual = desde;
  }

  // Passou do tempo máximo do manual? Volta para o automático.
  if (novoManual && millis() - manualDesdeMs >= TEMPO_MAX_MANUAL) {
    Serial.println("[Comandos] Modo manual expirou: voltando para o automático.");
    gravarModoAutomatico();  // se falhar, na próxima leitura ele expira de novo e tenta outra vez
    novoManual = false;
    novaBomba = false;
  }

  bool mudou = (novoManual != modoManual) || (novoManual && novaBomba != bombaManual);
  modoManual = novoManual;
  bombaManual = novaBomba;

  if (mudou) {
    if (modoManual) {
      Serial.printf("[Comandos] Modo MANUAL, bomba %s (leitura em %lu ms)\n",
                    bombaManual ? "ligada" : "desligada", duracaoPedido);
    } else {
      Serial.printf("[Comandos] Modo AUTOMÁTICO (leitura em %lu ms)\n", duracaoPedido);
    }
  }
  return mudou;
}


// =====================================================================
//  CLIMA — consulta o Open-Meteo e guarda o resultado em "clima"
//  Devolve true se deu tudo certo.
// =====================================================================

bool consultarOpenMeteo() {
  char url[400];
  snprintf(url, sizeof(url), URL_OPEN_METEO, LATITUDE, LONGITUDE);

  WiFiClientSecure cliente;
  cliente.setInsecure();

  HTTPClient http;
  http.setConnectTimeout(TIMEOUT_HTTP);
  http.setTimeout(TIMEOUT_HTTP);
  http.useHTTP10(true);  // resposta "inteira", sem pedaços: dá para ler direto do stream
  if (!http.begin(cliente, url)) {
    Serial.println("[CLIMA] Erro: não consegui abrir a conexão.");
    return false;
  }

  int codigo = http.GET();
  if (codigo != 200) {
    Serial.printf("[CLIMA] Erro: Open-Meteo respondeu código %d\n", codigo);
    http.end();
    return false;
  }

  // Filtro: só guarda na memória os campos que vamos usar
  JsonDocument filtro;
  filtro["current"]["time"] = true;
  filtro["current"]["temperature_2m"] = true;
  filtro["current"]["relative_humidity_2m"] = true;
  filtro["current"]["precipitation"] = true;
  filtro["hourly"]["time"] = true;
  filtro["hourly"]["precipitation_probability"] = true;
  filtro["daily"]["et0_fao_evapotranspiration"] = true;

  JsonDocument doc;
  DeserializationError erro = deserializeJson(doc, http.getStream(), DeserializationOption::Filter(filtro));
  http.end();
  if (erro) {
    Serial.printf("[CLIMA] Erro ao ler o JSON: %s\n", erro.c_str());
    return false;
  }

  JsonObject agora = doc["current"];
  JsonArray horas = doc["hourly"]["time"];
  JsonArray chances = doc["hourly"]["precipitation_probability"];
  JsonVariant et0 = doc["daily"]["et0_fao_evapotranspiration"][0];
  if (agora["time"].isNull() || agora["temperature_2m"].isNull() || horas.isNull() || chances.isNull() || et0.isNull()) {
    Serial.println("[CLIMA] Erro: faltam campos na resposta.");
    return false;
  }

  // Acha a hora atual na lista de horas comparando "AAAA-MM-DDTHH"
  // (os 13 primeiros caracteres). Não depende do relógio do ESP32.
  String horaAtual = agora["time"].as<String>();
  int posicao = -1;
  for (size_t i = 0; i < horas.size(); i++) {
    if (strncmp(horas[i] | "", horaAtual.c_str(), 13) == 0) {
      posicao = i;
      break;
    }
  }
  if (posicao < 0) {
    Serial.println("[CLIMA] Erro: não achei a hora atual na lista de horas.");
    return false;
  }

  // Maior chance de chuva da hora atual até 5 horas depois (6 h no total)
  int chanceMax = 0;
  int fim = min(posicao + HORAS_CHUVA, (int)chances.size());
  for (int i = posicao; i < fim; i++) {
    chanceMax = max(chanceMax, chances[i].as<int>());
  }

  // Deu tudo certo: guarda os novos valores
  clima.temperatura = agora["temperature_2m"];
  clima.umidadeAr = agora["relative_humidity_2m"];
  clima.chuvaAgoraMm = agora["precipitation"];
  clima.chanceChuva6h = chanceMax;
  clima.et0 = et0;
  clima.horaPrevisao = horaAtual;
  clima.atualizadoEmMs = millis();
  clima.valido = true;
  return true;
}

// Grava o clima no Firebase em /clima, tudo numa escrita só (com o login do ESP32).
// Devolve o código HTTP (200 = deu certo).
int enviarClimaFirebase() {
  if (!garantirLogin()) return -1;

  JsonDocument doc;
  // serialized(String(valor, casas)) evita números como 27.2999992
  doc["temperatura"] = serialized(String(clima.temperatura, 1));
  doc["umidadeAr"] = clima.umidadeAr;
  doc["chuvaAgoraMm"] = serialized(String(clima.chuvaAgoraMm, 2));
  doc["chanceChuva6h"] = clima.chanceChuva6h;
  doc["et0"] = serialized(String(clima.et0, 2));
  doc["horaPrevisao"] = clima.horaPrevisao;
  doc["atualizadoEm"][".sv"] = "timestamp";  // o Firebase coloca a hora dele
  String json;
  serializeJson(doc, json);

  String resposta;
  int codigo = requisicaoBanco("PUT", urlBanco("/clima"), json, resposta);
  if (codigo == 401) idToken = "";  // login recusado: faz de novo no próximo envio
  return codigo;
}

// Confere se já está na hora de consultar o clima
void atualizarClima() {
  if (millis() - ultimaConsultaClima < esperaClima) return;

  // A consulta HTTPS pode travar o loop() por até 10 s. Com a bomba ligada
  // isso atrasaria a segurança do tempo máximo: espera ela desligar.
  if (bombaLigada) return;

  ultimaConsultaClima = millis();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[CLIMA] Sem Wi-Fi. Tento de novo em 5 min.");
    esperaClima = INTERVALO_CLIMA_ERRO;
    return;
  }

  if (!consultarOpenMeteo()) {
    // Mantém os últimos valores válidos (até vencerem) e não grava nada
    Serial.println("[CLIMA] Tento de novo em 5 min.");
    esperaClima = INTERVALO_CLIMA_ERRO;
    return;
  }

  Serial.printf("[CLIMA] Atualizado em %s\n", clima.horaPrevisao.c_str());
  Serial.printf("[CLIMA] Temperatura: %.1f °C | Umidade do ar: %d %%\n", clima.temperatura, clima.umidadeAr);
  Serial.printf("[CLIMA] Chance máx. de chuva nas próximas %d h: %d %%\n", HORAS_CHUVA, clima.chanceChuva6h);
  Serial.printf("[CLIMA] ET0 hoje: %.2f mm\n", clima.et0);
  int codigo = enviarClimaFirebase();
  Serial.printf("[CLIMA] Enviado ao Firebase: %s (%d)\n", codigo == 200 ? "OK" : "ERRO", codigo);

  esperaClima = INTERVALO_CLIMA;
}


// =====================================================================
//  SETUP e LOOP
// =====================================================================

void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("===== Horta Inteligente =====");

  // Começa com a bomba desligada
  pinMode(PINO_RELE, OUTPUT);
  digitalWrite(PINO_RELE, RELE_ATIVO_EM_LOW ? HIGH : LOW);

  analogReadResolution(12);  // leituras de 0 a 4095

  // Wi-Fi mais estável (principalmente no roteador do celular):
  WiFi.persistent(false);       // não grava a rede na memória flash a cada conexão
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);  // se cair, o próprio Wi-Fi tenta voltar
  WiFi.setSleep(false);         // sem economia de energia: responde mais rápido
  WiFi.onEvent(aoDesconectarWiFi, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);  // mostra o motivo das quedas
  Serial.printf("[Wi-Fi] Conectando em \"%s\"...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  ultimaTentativaWiFi = millis();

  // Conexão com o banco que fica aberta entre os pedidos (ver requisicaoBanco)
  clienteBanco.setInsecure();
  httpBanco.setReuse(true);
  httpBanco.setConnectTimeout(TIMEOUT_HTTP);
  httpBanco.setTimeout(TIMEOUT_HTTP);

  // Primeiro envio 5 s depois de ligar (dá tempo do Wi-Fi conectar)
  ultimoEnvio = millis() - INTERVALO_ENVIO + 5000;

  // O clima só é consultado depois que o Wi-Fi conectar (ver cuidarDoWiFi)
  esperaClima = INTERVALO_CLIMA;

  if (SIMULAR_CHANCE_CHUVA >= 0) {
    Serial.printf("[Teste] SIMULAR_CHANCE_CHUVA ativo: fingindo %d%% de chance de chuva.\n", SIMULAR_CHANCE_CHUVA);
  }
}

void loop() {
  // Nada de delay() longo: cada tarefa confere se já chegou a sua hora
  cuidarDoWiFi();

  if (millis() - ultimaLeitura >= INTERVALO_SENSOR) {
    ultimaLeitura = millis();
    lerSensor();
    controlarBomba();
  }

  // Comandos do site a cada 3 s. Se mudaram, decide na hora (sem esperar
  // a próxima leitura do sensor), e enviarMudancas() avisa o painel.
  if (millis() - ultimaLeituraComandos >= INTERVALO_COMANDOS) {
    ultimaLeituraComandos = millis();
    if (lerComandos()) controlarBomba();
  }

  enviarMudancas();

  if (millis() - ultimoEnvio >= INTERVALO_ENVIO) {
    ultimoEnvio = millis();
    enviarDados();
  }

  atualizarClima();
}
