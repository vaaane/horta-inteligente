// =====================================================================
//  HORTA INTELIGENTE — firmware do ESP32
//  CED São Bartolomeu (DF) — Feira de Ciências
//
//  O que este programa faz:
//   1. Lê o sensor de umidade do solo.
//   2. Liga a bomba quando a terra está seca e desliga quando está molhada.
//   3. A cada 30 segundos, envia os dados para o Firebase pela internet.
//   4. Lê do Firebase se alguém mandou ligar/desligar a bomba na mão.
//
//  Se o Wi-Fi ou o Firebase caírem, a rega continua funcionando sozinha,
//  só com o sensor.
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

// Muitos módulos relé ligam quando o pino vai para LOW (0 V).
// Se o seu relé funcionar ao contrário, troque para false.
const bool RELE_ATIVO_EM_LOW = true;

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

// Segurança: a bomba nunca fica ligada mais que 60 s seguidos.
// Depois disso ela descansa 5 min (a água precisa de tempo para chegar ao sensor).
const unsigned long TEMPO_MAX_BOMBA   = 60UL * 1000;
const unsigned long TEMPO_PAUSA_BOMBA = 5UL * 60 * 1000;

// ---------------------------------------------------------------------
//  TEMPOS (em milissegundos)
// ---------------------------------------------------------------------
const unsigned long INTERVALO_SENSOR = 2000;   // lê o sensor a cada 2 s
const unsigned long INTERVALO_ENVIO  = 30000;  // envia ao Firebase a cada 30 s
const unsigned long INTERVALO_WIFI   = 10000;  // tenta reconectar a cada 10 s
const unsigned long MARGEM_TOKEN     = 5UL * 60 * 1000; // renova o login 5 min antes de vencer

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

// Login no Firebase
String idToken = "";
String refreshToken = "";
unsigned long tokenObtidoEm = 0;
unsigned long tokenValidade = 0;

// Relógios do millis()
unsigned long ultimaLeitura = 0;
unsigned long ultimoEnvio = 0;
unsigned long ultimaTentativaWiFi = 0;


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

  // O que a bomba deveria fazer agora?
  bool querLigar;
  if (modoManual) {
    querLigar = bombaManual;  // obedece o site
  } else if (bombaLigada) {
    querLigar = umidade < LIMITE_DESLIGAR;  // continua até passar de 60%
  } else {
    querLigar = umidade < LIMITE_LIGAR;     // só liga se cair abaixo de 35%
  }

  // Durante a pausa de segurança a bomba não liga de jeito nenhum
  if (emPausa) querLigar = false;

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
  }
  if (!conectado && estavaConectado) {
    Serial.println("[Wi-Fi] Conexão perdida.");
  }
  estavaConectado = conectado;

  // Se caiu, tenta de novo a cada 10 s (sem travar o resto do programa)
  if (!conectado && millis() - ultimaTentativaWiFi >= INTERVALO_WIFI) {
    ultimaTentativaWiFi = millis();
    Serial.printf("[Wi-Fi] Tentando conectar em \"%s\"...\n", WIFI_SSID);
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
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

  String resposta;

  // 1) Estado atual: PUT substitui o valor anterior
  JsonDocument estado;
  estado["umidade"] = umidade;
  estado["umidadeBruta"] = umidadeBruta;
  estado["bomba"] = bombaLigada;
  estado["ts"][".sv"] = "timestamp";  // o Firebase coloca a hora dele
  String corpoEstado;
  serializeJson(estado, corpoEstado);

  int codigo = requisicao("PUT", urlBanco("/horta/estado"), corpoEstado, "application/json", resposta);
  Serial.printf("[Firebase] Estado enviado (código %d)\n", codigo);
  if (codigo == 401) idToken = "";  // login recusado: faz de novo no próximo ciclo

  // 2) Histórico: POST cria uma entrada nova na lista
  JsonDocument leitura;
  leitura["umidade"] = umidade;
  leitura["bomba"] = bombaLigada;
  leitura["ts"][".sv"] = "timestamp";
  String corpoLeitura;
  serializeJson(leitura, corpoLeitura);

  codigo = requisicao("POST", urlBanco("/horta/leituras"), corpoLeitura, "application/json", resposta);
  Serial.printf("[Firebase] Leitura salva no histórico (código %d)\n", codigo);

  // 3) Comandos do site
  codigo = requisicao("GET", urlBanco("/horta/comandos"), "", "", resposta);
  JsonDocument comandos;
  if (codigo != 200 || deserializeJson(comandos, resposta)) {
    Serial.printf("[Comandos] Não consegui ler (código %d).\n", codigo);
    voltarParaAutomatico();
    return;
  }

  // Se ainda não existir nada em /comandos, fica no automático
  const char* modo = comandos["modo"] | "auto";
  modoManual = strcmp(modo, "manual") == 0;
  bombaManual = comandos["bombaManual"] | false;

  if (modoManual) {
    Serial.printf("[Comandos] Modo MANUAL, bomba %s\n", bombaManual ? "ligada" : "desligada");
  } else {
    Serial.println("[Comandos] Modo AUTOMÁTICO");
  }
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

  WiFi.mode(WIFI_STA);
  Serial.printf("[Wi-Fi] Conectando em \"%s\"...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  ultimaTentativaWiFi = millis();

  // Primeiro envio 5 s depois de ligar (dá tempo do Wi-Fi conectar)
  ultimoEnvio = millis() - INTERVALO_ENVIO + 5000;
}

void loop() {
  // Nada de delay() longo: cada tarefa confere se já chegou a sua hora
  cuidarDoWiFi();

  if (millis() - ultimaLeitura >= INTERVALO_SENSOR) {
    ultimaLeitura = millis();
    lerSensor();
    controlarBomba();
  }

  if (millis() - ultimoEnvio >= INTERVALO_ENVIO) {
    ultimoEnvio = millis();
    enviarDados();
  }
}
