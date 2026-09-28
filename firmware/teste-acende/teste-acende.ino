// =====================================================================
//  TESTE ACENDE/APAGA + CLIMA — ESP32 → Firebase → site
//
//  1. LED: digite no Serial Monitor (115200, "Nova linha"):
//       acende  -> grava true  em /teste/led
//       apaga   -> grava false em /teste/led
//     A página teste.html muda na hora, e o LED azul da placa também.
//
//  2. CLIMA: a cada 30 min o ESP32 consulta a previsão do tempo no
//     Open-Meteo e grava o resumo em /clima (o site mostra num cartão).
//
//  Sem login e sem biblioteca de Firebase: só pedidos HTTP (API REST).
//  Bibliotecas: core "esp32" da Espressif + ArduinoJson (versão 7).
// =====================================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "secrets.h"  // copie secrets.example.h -> secrets.h e preencha

// ---------------------------------------------------------------------
//  CONFIGURAÇÕES
// ---------------------------------------------------------------------

const int PINO_LED = 2;  // LED embutido da maioria das placas ESP32 DevKit

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

// Tempos (em milissegundos)
const unsigned long INTERVALO_WIFI       = 10000;           // tenta reconectar a cada 10 s
const unsigned long INTERVALO_CLIMA      = 30UL * 60 * 1000; // consulta o clima a cada 30 min
const unsigned long INTERVALO_CLIMA_ERRO = 5UL * 60 * 1000;  // se falhar, tenta de novo em 5 min
const unsigned long TIMEOUT_HTTP         = 10000;           // espera no máximo 10 s por resposta

const int HORAS_CHUVA = 6;  // olha a chance de chuva nas próximas 6 horas

// ---------------------------------------------------------------------
//  DADOS DO CLIMA (serão usados depois na decisão de rega)
// ---------------------------------------------------------------------
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

// Relógios do millis()
unsigned long ultimaTentativaWiFi = 0;
unsigned long ultimaConsultaClima = 0;
unsigned long esperaClima = 0;  // quanto esperar até a próxima consulta


// =====================================================================
//  HTTP — grava um valor no Firebase (Realtime Database, via REST)
//  Devolve o código HTTP (200 = deu certo).
// =====================================================================
int gravarNoFirebase(const char* caminho, const String& json) {
  // setInsecure(): usa HTTPS sem conferir o certificado.
  // Simplificação aceitável para um projeto escolar.
  WiFiClientSecure cliente;
  cliente.setInsecure();

  HTTPClient http;
  http.setConnectTimeout(TIMEOUT_HTTP);
  http.setTimeout(TIMEOUT_HTTP);
  String url = String(FIREBASE_DB_URL) + caminho + ".json";
  if (!http.begin(cliente, url)) return -1;
  http.addHeader("Content-Type", "application/json");

  int codigo = http.PUT(json);
  http.end();
  return codigo;
}


// =====================================================================
//  WI-FI — conecta e reconecta sozinho, sem travar o programa
// =====================================================================
void conectarWifi() {
  static bool estavaConectado = false;
  bool conectado = WiFi.status() == WL_CONNECTED;

  if (conectado && !estavaConectado) {
    Serial.printf("[Wi-Fi] Conectado! IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.println("Digite: acende  ou  apaga");
    // Ainda sem clima? Consulta logo que o Wi-Fi conectar.
    if (!clima.valido) esperaClima = 0;
  }
  if (!conectado && estavaConectado) {
    Serial.println("[Wi-Fi] Conexão perdida.");
  }
  estavaConectado = conectado;

  if (!conectado && millis() - ultimaTentativaWiFi >= INTERVALO_WIFI) {
    ultimaTentativaWiFi = millis();
    Serial.printf("[Wi-Fi] Tentando conectar em \"%s\"...\n", WIFI_SSID);
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
}


// =====================================================================
//  LED — lê o comando digitado no Serial Monitor
// =====================================================================
void lerComandoSerial() {
  if (!Serial.available()) return;

  String comando = Serial.readStringUntil('\n');
  comando.trim();          // tira espaços e o "\r" do final
  comando.toLowerCase();
  if (comando == "") return;

  if (comando == "acende")     atualizarLed(true);
  else if (comando == "apaga") atualizarLed(false);
  else Serial.println("Comando desconhecido. Comandos válidos: acende, apaga");
}

// Grava o estado do LED no Firebase e espelha no LED da placa
void atualizarLed(bool aceso) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[Wi-Fi] Sem conexão, tente de novo em alguns segundos.");
    return;
  }

  Serial.printf("Enviando %s para o Firebase...\n", aceso ? "true" : "false");
  int codigo = gravarNoFirebase("/teste/led", aceso ? "true" : "false");
  Serial.printf("Código HTTP: %d %s\n", codigo, codigo == 200 ? "(ok!)" : "(erro)");

  // Só muda o LED da placa se o Firebase aceitou
  if (codigo == 200) digitalWrite(PINO_LED, aceso ? HIGH : LOW);
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

// Grava o clima no Firebase em /clima, tudo numa escrita só
bool enviarClimaFirebase() {
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

  return gravarNoFirebase("/clima", json) == 200;
}

// Confere se já está na hora de consultar o clima
void atualizarClima() {
  if (millis() - ultimaConsultaClima < esperaClima) return;
  ultimaConsultaClima = millis();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[CLIMA] Erro: sem Wi-Fi. Tento de novo em 5 min.");
    esperaClima = INTERVALO_CLIMA_ERRO;
    return;
  }

  // Uma conexão segura de cada vez: acompanhamos a memória livre
  unsigned long heapAntes = ESP.getFreeHeap();
  bool ok = consultarOpenMeteo();
  unsigned long heapDepois = ESP.getFreeHeap();

  if (!ok) {
    // Mantém os últimos valores válidos e não grava nada no Firebase
    Serial.printf("[CLIMA] Heap livre: antes %lu / depois %lu\n", heapAntes, heapDepois);
    Serial.println("[CLIMA] Tento de novo em 5 min.");
    esperaClima = INTERVALO_CLIMA_ERRO;
    return;
  }

  Serial.printf("[CLIMA] Atualizado em %s\n", clima.horaPrevisao.c_str());
  Serial.printf("[CLIMA] Temperatura: %.1f °C | Umidade do ar: %d %%\n", clima.temperatura, clima.umidadeAr);
  Serial.printf("[CLIMA] Chovendo agora: %.2f mm\n", clima.chuvaAgoraMm);
  Serial.printf("[CLIMA] Chance máx. de chuva nas próximas %d h: %d %%\n", HORAS_CHUVA, clima.chanceChuva6h);
  Serial.printf("[CLIMA] ET0 hoje: %.2f mm\n", clima.et0);
  Serial.printf("[CLIMA] Heap livre: antes %lu / depois %lu\n", heapAntes, heapDepois);
  Serial.printf("[CLIMA] Enviado ao Firebase: %s\n", enviarClimaFirebase() ? "OK" : "ERRO");

  esperaClima = INTERVALO_CLIMA;
}


// =====================================================================
//  SETUP e LOOP
// =====================================================================
void setup() {
  Serial.begin(115200);
  pinMode(PINO_LED, OUTPUT);
  digitalWrite(PINO_LED, LOW);

  Serial.println();
  Serial.println("===== Teste acende/apaga + clima =====");
  Serial.printf("[Wi-Fi] Conectando em \"%s\"...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  ultimaTentativaWiFi = millis();

  // Só consulta o clima depois que o Wi-Fi conectar (ver conectarWifi)
  esperaClima = INTERVALO_CLIMA;
}

void loop() {
  // Nada de delay(): cada tarefa confere se já chegou a sua hora
  conectarWifi();
  lerComandoSerial();
  atualizarClima();
}
