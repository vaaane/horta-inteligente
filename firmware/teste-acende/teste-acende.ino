// =====================================================================
//  TESTE ACENDE/APAGA — ESP32 → Firebase → site
//
//  Digite no Serial Monitor (115200):
//    acende  -> grava true  em /teste/led
//    apaga   -> grava false em /teste/led
//  A página teste.html muda na hora, e o LED azul da placa também.
//
//  Sem login e sem biblioteca de Firebase: só um pedido HTTP.
// =====================================================================

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "secrets.h"  // copie secrets.example.h -> secrets.h e preencha

const int PINO_LED = 2;  // LED embutido da maioria das placas ESP32 DevKit

// Grava true ou false em /teste/led e devolve o código HTTP
int gravarLed(bool aceso) {
  // setInsecure(): usa HTTPS sem conferir o certificado.
  // Simplificação aceitável para um projeto escolar.
  WiFiClientSecure cliente;
  cliente.setInsecure();

  HTTPClient http;
  String url = String(FIREBASE_DB_URL) + "/teste/led.json";
  if (!http.begin(cliente, url)) return -1;
  http.addHeader("Content-Type", "application/json");

  int codigo = http.PUT(aceso ? "true" : "false");
  http.end();
  return codigo;
}

void setup() {
  Serial.begin(115200);
  pinMode(PINO_LED, OUTPUT);
  digitalWrite(PINO_LED, LOW);

  Serial.println();
  Serial.println("===== Teste acende/apaga =====");
  Serial.printf("[Wi-Fi] Conectando em \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n[Wi-Fi] Conectado! IP: %s\n", WiFi.localIP().toString().c_str());
  Serial.println("Digite: acende  ou  apaga");
}

void loop() {
  if (!Serial.available()) return;

  String comando = Serial.readStringUntil('\n');
  comando.trim();          // tira espaços e o "\r" do final
  comando.toLowerCase();
  if (comando == "") return;

  bool aceso;
  if (comando == "acende")     aceso = true;
  else if (comando == "apaga") aceso = false;
  else {
    Serial.println("Comando desconhecido. Comandos válidos: acende, apaga");
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[Wi-Fi] Sem conexão, tente de novo em alguns segundos.");
    return;
  }

  Serial.printf("Enviando %s para o Firebase...\n", aceso ? "true" : "false");
  int codigo = gravarLed(aceso);
  Serial.printf("Código HTTP: %d %s\n", codigo, codigo == 200 ? "(ok!)" : "(erro)");

  // Só muda o LED da placa se o Firebase aceitou
  if (codigo == 200) digitalWrite(PINO_LED, aceso ? HIGH : LOW);
}
