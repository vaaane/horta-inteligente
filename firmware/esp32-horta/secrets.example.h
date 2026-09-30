// =====================================================================
//  ARQUIVO DE EXEMPLO — senhas e chaves do projeto
//
//  Como usar:
//   1. Copie este arquivo e renomeie a cópia para "secrets.h"
//      (na mesma pasta do esp32-horta.ino).
//   2. Preencha os valores abaixo.
//
//  O "secrets.h" está no .gitignore: ele NUNCA vai para o GitHub.
// =====================================================================
#pragma once

// Rede Wi-Fi (o ESP32 só funciona em redes de 2,4 GHz)
#define WIFI_SSID "nome-da-rede"
#define WIFI_PASS "senha-da-rede"

// Firebase: Configurações do projeto > Geral > "Chave de API da Web"
#define FIREBASE_API_KEY "cole-a-chave-aqui"

// Firebase: Realtime Database > endereço que aparece no topo (sem "/" no final)
#define FIREBASE_DB_URL "https://xxx-default-rtdb.firebaseio.com"

// Usuário do ESP32 criado em Authentication > Usuários
#define ESP_EMAIL "esp32@horta.com"
#define ESP_SENHA "senha-do-esp32"

// Telegram (alertas no celular). Deixe vazio para desligar.
// Token: @BotFather -> /newbot. É uma senha: nunca coloque no site.
#define TELEGRAM_TOKEN ""
// Até 3 conversas, separadas por vírgula. Ex.: "123456789,-1001234567890"
#define TELEGRAM_CHAT_IDS ""
