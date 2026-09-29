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
//      Se a chuva ficar provável no meio da rega, para. Também não rega
//      no sol forte (10h às 16h), a não ser que o solo esteja seco demais,
//      e para quando já repôs a água do dia (cota pela ET0).
//      O site pode simular a chance de chuva e o horário ("Modo demonstração").
//   4. Cada decisão tem um código e um motivo em português, que aparecem
//      no Serial Monitor e no painel ("Por que regou (ou não)").
//   5. Envia o estado para o Firebase na hora em que a bomba, a decisão
//      ou (no MODO_TESTE) a umidade mudam, e a cada 5 s/30 s sem mudança.
//      O histórico do gráfico vai a cada 10 s/30 s.
//   6. Recebe os comandos do site por streaming: o Firebase avisa na hora
//      quando alguém muda o modo ou liga/desliga a bomba (plano B: pergunta
//      a cada 1 s). Fora do MODO_TESTE, o modo manual volta sozinho para o
//      automático depois de 10 min (o controle pelo site é aberto).
//
//  Se o Wi-Fi ou o Firebase caírem, a rega continua funcionando sozinha,
//  só com o sensor (sem previsão válida, a horta rega normalmente).
//
//  Pinos:
//     LED da bomba (ou relé) .... GPIO 33
//     Potenciômetro / sensor .... GPIO 34
//     LED Wi-Fi ................. GPIO 25
//     LED Firebase .............. GPIO 26
//     LED Clima ................. GPIO 27
//     LED embutido da placa ..... GPIO 2 (acende junto com a bomba)
//   LEDs de status: aceso = OK; pisca lento = em andamento;
//   pisca rápido = erro; apagado = sem Wi-Fi (ou ainda nada a mostrar).
//
//  Montagem de teste (sem bomba e sem sensor de verdade):
//   - LED no lugar do relé: GPIO 33 -> resistor (220 a 330 Ω) -> perna
//     comprida do LED; perna curta -> GND. Use RELE_ATIVO_EM_LOW = false.
//     Os LEDs de status (25, 26 e 27) são ligados do mesmo jeito.
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
#include <driver/rtc_io.h>     // rtc_gpio_deinit(): devolve um pino ao modo digital
#include <soc/gpio_struct.h>   // GPIO.out / GPIO.enable: o que o pino recebe de verdade
#include <soc/rtc_io_struct.h> // RTCIO.pad_dac: GPIO 25 e 26 também são o DAC
#include <time.h>                // hora certa pela internet (NTP), para o resumo por dia
#include "secrets.h"  // copie secrets.example.h -> secrets.h e preencha

// =====================================================================
// MODO_TESTE = true: LED no lugar da bomba. Tudo o mais rápido possível,
// sem pausa de segurança, sem tempo máximo e sem limite do modo manual.
// Quando tiver a bomba de verdade: false.
const bool MODO_TESTE = true;
// =====================================================================

// ---------------------------------------------------------------------
//  PINOS
// ---------------------------------------------------------------------

// Sensor de umidade no GPIO 34. Ele fica no ADC1.
// Atenção: os pinos do ADC2 (ex.: 0, 2, 4, 12–15, 25–27) NÃO funcionam
// como entrada analógica enquanto o Wi-Fi está ligado. Por isso usamos o 34.
const int PINO_SENSOR = 34;

// LED que representa a bomba. Com relé de verdade, pode continuar no 33.
const int PINO_RELE = 33;

// LED azul embutido da placa: acende e apaga junto com a bomba
const int PINO_LED_PLACA = 2;

// LEDs de status na protoboard (cada um com resistor em série)
const int PINO_LED_WIFI     = 25;
const int PINO_LED_FIREBASE = 26;
const int PINO_LED_CLIMA    = 27;

const unsigned long PISCA_LENTO_MS  = 500;  // em andamento
const unsigned long PISCA_RAPIDO_MS = 100;  // erro
const unsigned long REESCRITA_LED_MS = 500; // LEDs fixos (aceso/apagado): reescreve o pino a cada 0,5 s

const bool DEBUG_LEDS = true;  // mostra no Serial o que cada LED de status está fazendo

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

// Sol forte: boa parte da água evapora antes de chegar à raiz.
const int HORA_QUENTE_INICIO = 10;  // a partir das 10h00
const int HORA_QUENTE_FIM    = 16;  // até 15h59

// Só para testar em casa: -1 = usa a previsão real.
// Coloque, por exemplo, 80 para fingir 80% de chance de chuva.
// (O mais prático é o cartão "Modo demonstração" do site, que tem prioridade.)
const int SIMULAR_CHANCE_CHUVA = -1;

// Vazão estimada da bomba, em litros por minuto.
// Para medir: ligue a bomba 1 minuto dentro de uma garrafa/balde graduado.
// (Sem sensor de fluxo, os litros de /horta/regas são tempo ligado × vazão.)
const float VAZAO_L_MIN = 1.5;

// QUANTO REGAR PELA ET0 (evapotranspiração)
// A ET0 diz quantos milímetros de água uma planta de referência perde por
// dia. 1 mm de água sobre 1 m² = 1 litro. Então a horta sabe QUANTO repor
// por dia: cota = ET0 × área × Kc. Quando já repôs a cota do dia, para de
// regar pelo automático, mesmo que o sensor ainda peça: não gasta mais do
// que a planta perdeu. (O solo crítico continua ganhando de tudo.)
const float AREA_M2 = 0.25;      // canteiro da maquete: 0,5 m × 0,5 m
const float KC = 1.0;            // coeficiente da cultura (1,0 = planta de referência)
const float COTA_SEM_ET0 = 2.0;  // litros por dia se não houver previsão

// Simulação de chuva feita pelo site: fora do MODO_TESTE, desliga sozinha
// depois de 15 min (para a horta não ficar sem regar por esquecimento).
const unsigned long TEMPO_MAX_SIMULACAO = 15UL * 60 * 1000;

// Segurança: a bomba nunca fica ligada mais que 60 s seguidos.
// Depois disso ela descansa 5 min (a água precisa de tempo para chegar ao sensor).
// Com MODO_TESTE = true esses dois limites e o do modo manual não valem.
const unsigned long TEMPO_MAX_BOMBA   = 60UL * 1000;
const unsigned long TEMPO_PAUSA_BOMBA = 5UL * 60 * 1000;

// Segurança do site (que é aberto): o modo manual dura no máximo 10 min.
// Depois disso o próprio ESP32 grava "auto" em /horta/comandos.
const unsigned long TEMPO_MAX_MANUAL = 10UL * 60 * 1000;

// ---------------------------------------------------------------------
//  TEMPOS (em milissegundos)
// ---------------------------------------------------------------------
// Com MODO_TESTE tudo fica mais rápido; os valores da direita são os normais.
const unsigned long INTERVALO_SENSOR     = MODO_TESTE ? 300 : 2000;     // leitura do sensor
const unsigned long INTERVALO_ESTADO     = MODO_TESTE ? 5000 : 30000;   // estado sem mudança ("estou vivo")
const unsigned long INTERVALO_MIN_ESTADO = 1000;                        // no máximo um envio do estado por segundo
const unsigned long INTERVALO_HISTORICO  = MODO_TESTE ? 10000 : 30000;  // histórico do gráfico
const unsigned long INTERVALO_POLLING    = 1000;   // plano B: lê os comandos a cada 1 s
const unsigned long ESPERA_RECONEXAO_STREAM = 2000; // streaming caiu: reconecta depois de 2 s
const int FALHAS_PARA_PLANO_B = 5;                  // falhas seguidas do streaming -> plano B
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
int umidadeEnviada = -100;         // -100 = ainda não enviou

// O manual venceu e falta gravar "auto" no Firebase
bool gravarAutoPendente = false;
unsigned long ultimaGravacaoAuto = 0;

// Modo demonstração: chance de chuva simulada pelo site (-1 = usar a previsão real)
int simularChuvaSite = -1;
unsigned long simulacaoDesdeMs = 0;   // millis() de quando a simulação começou/mudou
bool gravarSimulacaoPendente = false; // a simulação venceu e falta gravar -1 no Firebase
int simulacaoVencida = -1;            // valor que venceu (ignorado até o -1 ser gravado)
unsigned long ultimaGravacaoSimulacao = 0;
String codigoParado = "";             // a rega foi interrompida por esta decisão (chuva ou sol)

// Cota do dia: "Recomeçar a cota" do site (zerarCotaEm) guarda quanto já
// tinha sido regado; a cota passa a contar só o que vier depois.
double zerarCotaVisto = -1;     // último zerarCotaEm lido (-1 = ainda não leu)
float litrosNaZeragem = 0;
String diaDaZeragem = "";

// Modo demonstração: hora simulada pelo site (-1 = usar a hora real)
int simularHoraSite = -1;
unsigned long simHoraDesdeMs = 0;
bool gravarSimHoraPendente = false;
int simHoraVencida = -1;
unsigned long ultimaGravacaoSimHora = 0;
bool estadoUrgente = false;           // enviar o estado na próxima volta (ex.: mudou a simulação)

// Login no Firebase
String idToken = "";
String refreshToken = "";
unsigned long tokenObtidoEm = 0;
unsigned long tokenValidade = 0;

// Relógios do millis()
unsigned long ultimaLeitura = 0;
unsigned long ultimoHistorico = 0;
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

// Regas para o histórico /horta/regas (água usada, estimativa).
// Fila de até 5 regas ainda não enviadas (ex.: estava sem Wi-Fi); se
// encher, a mais antiga sai.
struct Rega {
  int64_t fimMs;           // hora do Firebase em que a rega terminou (0 = não sabia)
  unsigned long segundos;  // quanto tempo a bomba ficou ligada
  String motivo;           // código da decisão que ligou a bomba
};
const int TAMANHO_FILA_REGAS = 5;
Rega filaRegas[TAMANHO_FILA_REGAS];
int regasNaFila = 0;
String motivoRegaAtual = "";          // por que a bomba ligou desta vez
unsigned long ultimaTentativaRegas = 0;

// Resumo por dia em /horta/agua/dias/{AAAA-MM-DD}: totais do dia carregado
// (lidos do Firebase ao ligar e ao trocar de dia, para continuar de onde parou)
String diaCarregado = "";      // "" = ainda não leu nenhum dia
float diaLitros = 0;
unsigned long diaSegundos = 0;
int diaRegas = 0;
// Regas que terminaram e ainda não foram somadas no resumo do dia
String pendenteDia = "";       // dia em que a primeira delas terminou ("" = sem hora certa ainda)
float pendenteLitros = 0;
unsigned long pendenteSegundos = 0;
int pendenteRegas = 0;
bool et0Pendente = false;      // chegou previsão nova: gravar a ET0 do dia
unsigned long ultimaTentativaDia = 0;

// Relógio do Firebase: cada envio do estado devolve o "ts" que o servidor
// gravou. Guardamos esse horário e o millis() da hora em que chegou.
int64_t horaServidorMs = 0;           // 0 = ainda não sabe
unsigned long horaServidorEmMillis = 0;


// =====================================================================
//  LEDS DE STATUS — mostram o estado do sistema sem Serial Monitor
//  (o mesmo jeito de piscar do teste-acende)
// =====================================================================
enum EstadoLed { APAGADO, PISCA_LENTO, ACESO, PISCA_RAPIDO };
enum LedStatus { LED_WIFI, LED_FIREBASE, LED_CLIMA, TOTAL_LEDS };

const int pinosStatus[TOTAL_LEDS] = { PINO_LED_WIFI, PINO_LED_FIREBASE, PINO_LED_CLIMA };
EstadoLed estadoStatus[TOTAL_LEDS] = { APAGADO, APAGADO, APAGADO };
bool faseLigada[TOTAL_LEDS] = { false, false, false };  // o LED está aceso neste instante?
unsigned long ultimaTroca[TOTAL_LEDS] = { 0, 0, 0 };

// O que os LEDs usam para decidir (atualizado pelo resto do programa)
bool erroConexaoFirebase = false;  // login, streaming ou polling falhou
bool erroEscritaFirebase = false;  // a última gravação foi recusada (401, "Permission denied"...)
bool pollingOk = false;            // plano B: o último polling respondeu 200
bool climaFalhou = false;          // a última consulta do clima falhou

const char* NOMES_LED[TOTAL_LEDS] = { "Wi-Fi", "Firebase", "Clima" };
const char* NOMES_ESTADO[] = { "APAGADO", "PISCA_LENTO", "ACESO", "PISCA_RAPIDO" };
unsigned long ultimaReescritaLed = 0;

// Os GPIO 25 e 26 são também o DAC (saída analógica) e pinos do RTC.
// Se algum driver "pegar" o pino para o RTC ou ligar o DAC, o digitalWrite()
// continua mudando o registrador, mas o LED não acende. Esta função confere:
// true = o pino continua sendo uma saída digital comum.
bool pinoEhSaidaDigital(int pino) {
  if (((GPIO.enable >> pino) & 1) == 0) return false;  // a saída foi desligada
  if (pino == 25 && (RTCIO.pad_dac[0].mux_sel || RTCIO.pad_dac[0].xpd_dac)) return false;
  if (pino == 26 && (RTCIO.pad_dac[1].mux_sel || RTCIO.pad_dac[1].xpd_dac)) return false;
  return true;
}

// Devolve o pino ao modo de saída digital (se alguém mexeu nele por fora)
void reconfigurarPino(int pino) {
  if (pino == 25 || pino == 26) {
    int i = pino - 25;  // pad_dac[0] = GPIO 25, pad_dac[1] = GPIO 26
    RTCIO.pad_dac[i].xpd_dac = 0;        // desliga o DAC nesse pino
    RTCIO.pad_dac[i].dac_xpd_force = 0;
    rtc_gpio_deinit((gpio_num_t)pino);   // tira do RTC e volta para o digital
  }
  pinMode(pino, OUTPUT);
}

// Muda o estado de um LED. Já acende na hora (mesmo se for piscar),
// para o LED não ficar apagado durante uma operação que trava alguns segundos.
void definirEstadoLed(LedStatus led, EstadoLed estado) {
  if (estadoStatus[led] == estado) return;
  if (DEBUG_LEDS) {
    Serial.printf("[LED] %s: %s -> %s\n", NOMES_LED[led], NOMES_ESTADO[estadoStatus[led]], NOMES_ESTADO[estado]);
  }
  estadoStatus[led] = estado;
  faseLigada[led] = (estado != APAGADO);
  ultimaTroca[led] = millis();
  digitalWrite(pinosStatus[led], faseLigada[led] ? HIGH : LOW);
}

// Faz as piscadas com millis(), sem delay(). Chamada no loop().
// Os LEDs fixos (ACESO/APAGADO) têm o pino reescrito a cada 0,5 s: se algo
// mudar o pino por fora, o LED se corrige sozinho.
void piscarLedsStatus() {
  bool reescrever = millis() - ultimaReescritaLed >= REESCRITA_LED_MS;
  if (reescrever) ultimaReescritaLed = millis();

  for (int i = 0; i < TOTAL_LEDS; i++) {
    unsigned long intervalo;
    if (estadoStatus[i] == PISCA_LENTO)       intervalo = PISCA_LENTO_MS;
    else if (estadoStatus[i] == PISCA_RAPIDO) intervalo = PISCA_RAPIDO_MS;
    else intervalo = 0;  // APAGADO e ACESO não piscam

    if (intervalo > 0 && millis() - ultimaTroca[i] >= intervalo) {
      ultimaTroca[i] = millis();
      faseLigada[i] = !faseLigada[i];
      digitalWrite(pinosStatus[i], faseLigada[i] ? HIGH : LOW);
    }

    if (reescrever) {
      if (!pinoEhSaidaDigital(pinosStatus[i])) {
        Serial.printf("[LED] %s (GPIO %d) tinha perdido a configuração de saída: reconfigurado.\n",
                      NOMES_LED[i], pinosStatus[i]);
        reconfigurarPino(pinosStatus[i]);
      }
      digitalWrite(pinosStatus[i], faseLigada[i] ? HIGH : LOW);
    }
  }
}

// Diagnóstico (DEBUG_LEDS): a cada 5 s mostra o estado guardado de cada LED,
// o nível que o pino recebe de verdade (registrador de saída) e a volta mais
// lenta do loop() nesse período.
unsigned long voltaMaisLenta = 0;
unsigned long ultimoDiagnosticoLeds = 0;

void diagnosticarLeds(unsigned long duracaoVolta) {
  if (!DEBUG_LEDS) return;
  if (duracaoVolta > voltaMaisLenta) voltaMaisLenta = duracaoVolta;
  if (millis() - ultimoDiagnosticoLeds < 5000) return;
  ultimoDiagnosticoLeds = millis();

  Serial.print("[LED]");
  for (int i = 0; i < TOTAL_LEDS; i++) {
    int pino = pinosStatus[i];
    Serial.printf(" %s=%s(pino %lu%s)", NOMES_LED[i], NOMES_ESTADO[estadoStatus[i]],
                  (unsigned long)((GPIO.out >> pino) & 1),
                  pinoEhSaidaDigital(pino) ? "" : ", NÃO É SAÍDA DIGITAL");
  }
  Serial.printf(" | volta mais lenta do loop: %lu ms\n", voltaMaisLenta);
  voltaMaisLenta = 0;
}


// =====================================================================
//  BOMBA
// =====================================================================

// Hora atual no relógio do Firebase (0 se ainda não sabe)
int64_t agoraServidor() {
  if (horaServidorMs == 0) return 0;
  return horaServidorMs + (int64_t)(millis() - horaServidorEmMillis);
}

// Hora certa (NTP) já chegou? Antes disso o relógio do ESP32 marca 1970.
bool horaValida() {
  return time(nullptr) > 1700000000;  // qualquer data depois de nov/2023
}

// Data de hoje em Brasília, ex.: "2026-09-30"
String dataHoje() {
  time_t agora = time(nullptr);
  struct tm local;
  localtime_r(&agora, &local);
  char texto[11];
  strftime(texto, sizeof(texto), "%Y-%m-%d", &local);
  return String(texto);
}

// A bomba desligou: guarda a rega na fila para /horta/regas
void registrarRega(unsigned long duracaoMs) {
  if (duracaoMs < 1000) return;  // menos de 1 s: ruído do potenciômetro na divisa

  if (regasNaFila == TAMANHO_FILA_REGAS) {
    // Fila cheia (muito tempo sem Wi-Fi): descarta a mais antiga
    for (int i = 1; i < TAMANHO_FILA_REGAS; i++) filaRegas[i - 1] = filaRegas[i];
    regasNaFila--;
  }
  Rega& rega = filaRegas[regasNaFila++];
  rega.fimMs = agoraServidor();
  rega.segundos = (duracaoMs + 500) / 1000;  // arredonda
  rega.motivo = motivoRegaAtual;

  Serial.printf("[Água] Rega de %lu s ≈ %.2f L (motivo: %s)\n",
                rega.segundos, rega.segundos / 60.0 * VAZAO_L_MIN, rega.motivo.c_str());

  // Também vai para o resumo do dia. Simplificação: a rega inteira conta no
  // dia em que TERMINOU, mesmo se começou antes da meia-noite.
  if (pendenteRegas == 0) pendenteDia = horaValida() ? dataHoje() : "";
  pendenteLitros += rega.segundos / 60.0 * VAZAO_L_MIN;
  pendenteSegundos += rega.segundos;
  pendenteRegas++;
}

void acionarBomba(bool ligar, const char* motivo) {
  if (ligar == bombaLigada) return;  // já está como queremos

  bombaLigada = ligar;
  if (ligar) {
    bombaLigadaDesde = millis();
    motivoRegaAtual = motivo;  // vai junto com a rega em /horta/regas
  } else {
    registrarRega(millis() - bombaLigadaDesde);
  }

  // Descobre se o pino precisa ir para HIGH ou LOW
  int nivel;
  if (RELE_ATIVO_EM_LOW) nivel = ligar ? LOW : HIGH;
  else                   nivel = ligar ? HIGH : LOW;
  digitalWrite(PINO_RELE, nivel);
  digitalWrite(PINO_LED_PLACA, ligar ? HIGH : LOW);  // LED azul da placa junto

  Serial.printf("[Bomba] %s (motivo: %s)\n", ligar ? "LIGADA" : "DESLIGADA", motivo);
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

  // No MODO_TESTE (leitura a cada 300 ms) só mostra quando a umidade muda
  static int umidadeMostrada = -1;
  if (!MODO_TESTE || umidade != umidadeMostrada) {
    Serial.printf("[Sensor] Umidade: %d%% (valor bruto: %d)\n", umidade, umidadeBruta);
    umidadeMostrada = umidade;
  }
}


// =====================================================================
//  DECISÃO DA REGA
// =====================================================================

// Chance de chuva a usar na decisão, ou -1 se não houver previsão válida
// (nunca consultou, a consulta falhou ou a previsão tem mais de 90 min).
// Prioridade: 1) simulação do site, 2) SIMULAR_CHANCE_CHUVA do código,
// 3) a previsão real do Open-Meteo.
int chanceDeChuva() {
  if (simularChuvaSite >= 0) return simularChuvaSite;           // modo demonstração (site)
  if (SIMULAR_CHANCE_CHUVA >= 0) return SIMULAR_CHANCE_CHUVA;   // teste pelo código
  if (!clima.valido) return -1;
  if (millis() - clima.atualizadoEmMs > VALIDADE_CLIMA) return -1;
  return clima.chanceChuva6h;
}

// A chance usada na decisão é de mentira? (aí o motivo termina com "(simulado)")
bool chuvaSimulada() {
  return simularChuvaSite >= 0 || SIMULAR_CHANCE_CHUVA >= 0;
}

// Hora usada na decisão (0 a 23): a simulada pelo site ou a do relógio da
// internet. -1 = o NTP ainda não respondeu (aí a regra do horário é ignorada).
int horaDaDecisao() {
  if (simularHoraSite >= 0) return simularHoraSite;
  if (!horaValida()) return -1;
  time_t agora = time(nullptr);
  struct tm local;
  localtime_r(&agora, &local);
  return local.tm_hour;
}

// Das 10h00 às 15h59: sol forte
bool horaQuente(int hora) {
  return hora >= HORA_QUENTE_INICIO && hora < HORA_QUENTE_FIM;
}

// "Parei de regar" se a bomba está ligada agora (vai parar) ou se esta mesma
// decisão já tinha interrompido a rega; senão, "Não reguei"
const char* textoParei(const char* codigo) {
  return (bombaLigada || codigoParado == codigo) ? "Parei de regar" : "Não reguei";
}

// A ET0 de hoje veio de uma previsão válida?
bool et0Valido() {
  return clima.valido && millis() - clima.atualizadoEmMs <= VALIDADE_CLIMA;
}

// Litros que a planta precisa hoje: ET0 (mm) × área (m²) × Kc
float cotaHoje() {
  if (!et0Valido()) return COTA_SEM_ET0;
  return clima.et0 * AREA_M2 * KC;
}

// Litros regados hoje: o resumo do dia (Tarefa 1) + regas ainda não somadas
// nele + a rega em andamento. Sem hora certa (NTP) ou antes de ler o dia
// do Firebase, conta só o que o ESP32 viu desde que ligou.
float litrosHoje() {
  String hoje = horaValida() ? dataHoje() : "";
  float litros = 0;
  if (hoje != "" && diaCarregado == hoje) litros += diaLitros;
  if (pendenteRegas > 0 && (pendenteDia == hoje || pendenteDia == "")) litros += pendenteLitros;
  if (bombaLigada) litros += (millis() - bombaLigadaDesde) / 60000.0 * VAZAO_L_MIN;
  return litros;
}

// Litros que contam contra a cota: tudo de hoje, menos o que já tinha sido
// regado quando alguém tocou em "Recomeçar a cota" (só vale no mesmo dia)
float litrosCota() {
  float litros = litrosHoje();
  if (horaValida() && diaDaZeragem == dataHoje()) litros -= litrosNaZeragem;
  return max(litros, 0.0f);
}

// "1,8" (vírgula, como se escreve no Brasil) para os motivos
String decimal(float valor, int casas) {
  String texto = String(valor, casas);
  texto.replace('.', ',');
  return texto;
}

// Modo demonstração: "Recomeçar a cota". Devolve true se recomeçou.
bool aplicarZerarCota(double valor) {
  if (valor <= 0 || valor == zerarCotaVisto) return false;
  bool primeiraLeitura = zerarCotaVisto < 0;
  zerarCotaVisto = valor;
  // Ao ligar, o valor que já estava lá é de um clique antigo: não recomeça.
  // (Simplificação: depois de reiniciar, a cota volta a contar o dia inteiro.)
  if (primeiraLeitura) return false;

  litrosNaZeragem = litrosHoje();
  diaDaZeragem = horaValida() ? dataHoje() : "";
  estadoUrgente = true;
  Serial.printf("[Cota] Recomeçada pelo site (já tinha regado %.2f L hoje).\n", litrosNaZeragem);
  return true;
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
  // No MODO_TESTE (LED) não tem tempo máximo: a pausa nunca começa.
  if (!MODO_TESTE && bombaLigada && agora - bombaLigadaDesde >= TEMPO_MAX_BOMBA) {
    Serial.println("[Bomba] Tempo máximo atingido! Pausa de segurança.");
    acionarBomba(false, "tempo_maximo");
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
  const char* chuvaSim = chuvaSimulada() ? " (simulado)" : "";
  int hora = horaDaDecisao();    // -1 = ainda sem hora certa (ignora a regra do horário)
  const char* horaSim = simularHoraSite >= 0 ? " (simulado)" : "";
  bool querLigar = false;
  const char* codigo;
  char motivo[200];

  // Precisa de água? Abaixo de LIMITE_LIGAR, ou já regando e abaixo de LIMITE_DESLIGAR
  bool precisaAgua = umidade < LIMITE_LIGAR || (bombaLigada && umidade < LIMITE_DESLIGAR);

  if (emPausa) {
    // 1) Pausa de segurança (nunca acontece no MODO_TESTE): não liga de jeito nenhum
    codigo = "pausa_seguranca";
    snprintf(motivo, sizeof(motivo), "Pausa de segurança: a bomba ficou %lu s ligada e está descansando %lu min.",
             TEMPO_MAX_BOMBA / 1000, TEMPO_PAUSA_BOMBA / 60000);

  } else if (modoManual) {
    // 2) Modo manual: obedece o site
    querLigar = bombaManual;
    codigo = bombaManual ? "manual_ligada" : "manual_desligada";
    snprintf(motivo, sizeof(motivo), "Modo manual: bomba %s pelo painel.", bombaManual ? "ligada" : "desligada");

  } else if (!precisaAgua) {
    // 3) Solo úmido o bastante: não rega (ou terminou de regar)
    codigo = "solo_ok";
    snprintf(motivo, sizeof(motivo), "Solo úmido o bastante (%d%%): não precisa regar.", umidade);

  } else if (umidade < LIMITE_CRITICO) {
    // 4a) Seco demais: rega mesmo com chuva prevista ou sol forte
    querLigar = true;
    codigo = "solo_critico";
    snprintf(motivo, sizeof(motivo), "Reguei mesmo assim: o solo chegou a %d%%, abaixo do mínimo de %d%%.",
             umidade, LIMITE_CRITICO);

  } else if (chance >= LIMITE_CHUVA) {
    // 4b) Vai chover: não liga (ou para) e deixa a chuva regar
    codigo = "adiada_chuva";
    snprintf(motivo, sizeof(motivo), "%s: %d%% de chance de chuva nas próximas 6 h.%s",
             textoParei(codigo), chance, chuvaSim);

  } else if (hora >= 0 && horaQuente(hora)) {
    // 4c) Sol forte: boa parte da água evaporaria. Espera o fim do horário quente.
    codigo = "horario_quente";
    snprintf(motivo, sizeof(motivo), "%s: são %dh, sol forte. A água evaporaria. Volto a regar a partir das %dh.%s",
             textoParei(codigo), hora, HORA_QUENTE_FIM, horaSim);

  } else if (litrosCota() >= cotaHoje()) {
    // 4d) Já repôs a água que a planta perdeu hoje: não liga (ou para)
    codigo = "cota_atingida";
    if (et0Valido()) {
      snprintf(motivo, sizeof(motivo), "Já repus %s L hoje (ET₀ %s mm × %s m²). A cota do dia foi atingida.",
               decimal(litrosCota(), 1).c_str(), decimal(clima.et0, 1).c_str(), decimal(AREA_M2, 2).c_str());
    } else {
      snprintf(motivo, sizeof(motivo), "Já repus %s L hoje (sem previsão, a cota é de %s L). A cota do dia foi atingida.",
               decimal(litrosCota(), 1).c_str(), decimal(COTA_SEM_ET0, 1).c_str());
    }

  } else if (chance < 0) {
    // 4e) Sem previsão: rega só pelo sensor, que é o comportamento seguro
    querLigar = true;
    codigo = "sem_previsao";
    snprintf(motivo, sizeof(motivo), "Sem previsão do tempo: reguei só pelo sensor (solo com %d%%).", umidade);

  } else {
    // 4f) Tudo certo para regar
    querLigar = true;
    codigo = "regando";
    if (bombaLigada) {
      snprintf(motivo, sizeof(motivo), "Regando: o solo está com %d%%, vai até %d%%.", umidade, LIMITE_DESLIGAR);
    } else {
      snprintf(motivo, sizeof(motivo), "Regando: o solo chegou a %d%% e a chance de chuva é de %d%%.%s",
               umidade, chance, chuvaSim);
    }
  }

  // Lembra se a rega foi INTERROMPIDA (chuva ou sol) para o motivo dizer
  // "Parei de regar" enquanto essa decisão durar
  if (bombaLigada && !querLigar && (strcmp(codigo, "adiada_chuva") == 0 || strcmp(codigo, "horario_quente") == 0)) {
    codigoParado = codigo;
  }
  if (codigoParado != codigo) codigoParado = "";

  registrarDecisao(codigo, motivo, chance);
  acionarBomba(querLigar, codigo);
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
//  pedido e outro. O estado vai até uma vez por segundo: abrir uma conexão
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
  definirEstadoLed(LED_FIREBASE, PISCA_LENTO);

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
    erroConexaoFirebase = true;
    return false;
  }

  JsonDocument r;
  if (deserializeJson(r, resposta)) {
    Serial.println("[Firebase] Resposta do login inválida.");
    erroConexaoFirebase = true;
    return false;
  }
  idToken = r["idToken"].as<String>();
  refreshToken = r["refreshToken"].as<String>();
  tokenValidade = r["expiresIn"].as<String>().toInt() * 1000UL;  // vem em segundos
  tokenObtidoEm = millis();

  Serial.println("[Firebase] Login OK!");
  erroConexaoFirebase = false;
  return true;
}

bool renovarToken() {
  Serial.println("[Firebase] Renovando o login...");
  definirEstadoLed(LED_FIREBASE, PISCA_LENTO);

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
// histórico (/horta/decisoes). Quem decide quando enviar é cuidarDoEstado().
void enviarEstado(bool avisar) {
  String resposta;

  // PUT substitui o valor anterior
  JsonDocument estado;
  estado["umidade"] = umidade;
  estado["umidadeBruta"] = umidadeBruta;
  estado["bomba"] = bombaLigada;
  estado["modoTeste"] = MODO_TESTE;  // o site esconde a contagem do manual e mostra o selo
  if (horaDaDecisao() >= 0) estado["hora"] = horaDaDecisao();  // "Hora da horta" no painel
  estado["cotaHoje"] = serialized(String(cotaHoje(), 2));      // barra "Cota de hoje pela ET0"
  estado["litrosCota"] = serialized(String(litrosCota(), 2));
  // Com a bomba ligada: quando ela ligou, no relógio do Firebase. O cartão
  // "Água" soma essa rega ao vivo, mesmo para quem abre o painel no meio dela.
  // (Com a bomba desligada o campo não vai, e o PUT apaga o anterior.)
  if (bombaLigada && horaServidorMs > 0) {
    estado["regaDesde"] = agoraServidor() - (int64_t)(millis() - bombaLigadaDesde);
  }
  estado["ts"][".sv"] = "timestamp";  // o Firebase coloca a hora dele
  if (decisaoAtual != "") {
    estado["decisao"] = decisaoAtual;
    estado["motivo"] = motivoAtual;
  }
  String corpoEstado;
  serializeJson(estado, corpoEstado);

  int codigo = requisicaoBanco("PUT", urlBanco("/horta/estado"), corpoEstado, resposta);
  // O envio "estou vivo" (sem mudança) só aparece no Serial se der erro
  if (avisar || codigo != 200) {
    Serial.printf("[Firebase] Estado enviado (código %d, %lu ms)\n", codigo, duracaoPedido);
  }
  if (codigo == 401) idToken = "";  // login recusado: faz de novo no próximo envio
  erroEscritaFirebase = (codigo != 200);  // LED do Firebase pisca rápido se foi recusado
  if (codigo == 200) {
    // A resposta traz o "ts" que o Firebase gravou: acerta o relógio do servidor
    JsonDocument gravado;
    if (!deserializeJson(gravado, resposta) && gravado["ts"].is<int64_t>()) {
      horaServidorMs = gravado["ts"].as<int64_t>();
      horaServidorEmMillis = millis();
    }
    bombaEnviada = bombaLigada;     // agora o painel sabe
    estadoUrgente = false;
    decisaoEnviada = decisaoAtual;
    umidadeEnviada = umidade;
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
    else erroEscritaFirebase = true;
  }
}

// Quando enviar o estado:
//  - na hora, se a bomba mudou, o código da decisão mudou ou (no MODO_TESTE)
//    a umidade mudou 2 pontos ou mais desde o último envio;
//  - no máximo um envio por segundo (vale sempre o valor mais novo);
//  - sem mudanças, a cada 5 s (MODO_TESTE) ou 30 s, para o site saber que o
//    ESP32 está vivo.
void cuidarDoEstado() {
  unsigned long desdeUltimo = millis() - ultimaTentativaEstado;
  bool mudou = estadoUrgente || bombaLigada != bombaEnviada || decisaoAtual != decisaoEnviada ||
               (MODO_TESTE && abs(umidade - umidadeEnviada) >= 2);
  if (!mudou && desdeUltimo < INTERVALO_ESTADO) return;
  if (desdeUltimo < INTERVALO_MIN_ESTADO) return;

  ultimaTentativaEstado = millis();
  if (!prontoParaFirebase()) return;
  enviarEstado(mudou);
}

// Histórico: POST cria uma entrada nova na lista (gráfico do painel)
void enviarLeitura() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[Firebase] Sem Wi-Fi, histórico adiado. A rega continua pelo sensor.");
    voltarParaAutomatico();
    return;
  }
  if (!garantirLogin()) return;

  JsonDocument leitura;
  leitura["umidade"] = umidade;
  leitura["bomba"] = bombaLigada;
  leitura["ts"][".sv"] = "timestamp";
  String corpoLeitura;
  serializeJson(leitura, corpoLeitura);

  String resposta;
  int codigo = requisicaoBanco("POST", urlBanco("/horta/leituras"), corpoLeitura, resposta);
  Serial.printf("[Firebase] Leitura salva no histórico (código %d)\n", codigo);
  if (codigo != 200) erroEscritaFirebase = true;
}

// Envia a rega mais antiga da fila para /horta/regas (uma por vez, a cada
// 3 s no máximo, para não travar o loop). Se falhar, fica na fila.
void enviarRegas() {
  if (regasNaFila == 0) return;
  if (millis() - ultimaTentativaRegas < 3000) return;
  ultimaTentativaRegas = millis();
  if (!prontoParaFirebase()) return;

  Rega& rega = filaRegas[0];
  JsonDocument doc;
  if (rega.fimMs > 0) {
    // Horário calculado pelo ESP32 a partir do relógio do Firebase
    doc["fim"] = rega.fimMs;
    doc["inicio"] = rega.fimMs - (int64_t)rega.segundos * 1000;
  } else {
    // Ainda não sabia a hora do servidor: usa a hora do envio
    doc["fim"][".sv"] = "timestamp";
  }
  doc["segundos"] = rega.segundos;
  doc["litros"] = serialized(String(rega.segundos / 60.0 * VAZAO_L_MIN, 2));
  doc["motivo"] = rega.motivo;
  String corpo;
  serializeJson(doc, corpo);

  String resposta;
  int codigo = requisicaoBanco("POST", urlBanco("/horta/regas"), corpo, resposta);
  Serial.printf("[Água] Rega salva no histórico (código %d)\n", codigo);
  if (codigo != 200) {
    erroEscritaFirebase = true;
    return;
  }
  // Tira da fila
  for (int i = 1; i < regasNaFila; i++) filaRegas[i - 1] = filaRegas[i];
  regasNaFila--;
}

// Lê /horta/agua/dias/{dia} para continuar a soma de onde parou
bool carregarDia(const String& dia) {
  String resposta;
  int codigo = requisicaoBanco("GET", urlBanco(("/horta/agua/dias/" + dia).c_str()), "", resposta);
  JsonDocument doc;
  if (codigo != 200 || deserializeJson(doc, resposta)) {
    Serial.printf("[Água] Não consegui ler o resumo de %s (código %d).\n", dia.c_str(), codigo);
    return false;
  }
  // null = o dia ainda não existe: começa em 0
  diaLitros = doc["litros"] | 0.0;
  diaSegundos = doc["segundos"] | 0UL;
  diaRegas = doc["regas"] | 0;
  diaCarregado = dia;
  Serial.printf("[Água] Resumo de %s: %.2f L em %d regas.\n", dia.c_str(), diaLitros, diaRegas);
  return true;
}

// Resumo por dia: soma as regas pendentes no dia certo e grava a ET0 de hoje.
// Sem hora certa (NTP), espera; a rega continua funcionando normalmente.
void cuidarDoResumoDiario() {
  if (!horaValida()) return;
  if (pendenteRegas > 0 && pendenteDia == "") pendenteDia = dataHoje();  // a hora chegou depois

  String hoje = dataHoje();
  String alvo = pendenteRegas > 0 ? pendenteDia : hoje;
  bool temAlgo = pendenteRegas > 0 || et0Pendente || diaCarregado != alvo;
  if (!temAlgo) return;
  if (millis() - ultimaTentativaDia < 3000) return;
  ultimaTentativaDia = millis();
  if (!prontoParaFirebase()) return;

  // Primeiro lê o dia (ao ligar e ao virar o dia)
  if (diaCarregado != alvo) {
    if (carregarDia(alvo) && alvo == hoje) et0Pendente = true;  // dia novo: grava a ET0 também
    return;
  }

  // Grava os totais já somados (PATCH muda só esses campos)
  float litros = diaLitros + pendenteLitros;
  unsigned long segundos = diaSegundos + pendenteSegundos;
  int regas = diaRegas + pendenteRegas;
  bool comEt0 = alvo == hoje && clima.valido && millis() - clima.atualizadoEmMs <= VALIDADE_CLIMA;

  JsonDocument doc;
  doc["litros"] = serialized(String(litros, 2));
  doc["segundos"] = segundos;
  doc["regas"] = regas;
  if (comEt0) doc["et0"] = serialized(String(clima.et0, 2));
  doc["atualizadoEm"][".sv"] = "timestamp";
  String corpo;
  serializeJson(doc, corpo);

  String resposta;
  int codigo = requisicaoBanco("PATCH", urlBanco(("/horta/agua/dias/" + alvo).c_str()), corpo, resposta);
  if (codigo != 200) {
    Serial.printf("[Água] Não consegui gravar o resumo de %s (código %d).\n", alvo.c_str(), codigo);
    erroEscritaFirebase = true;
    return;  // tenta de novo em 3 s, com os mesmos pendentes
  }
  if (pendenteRegas > 0) {
    Serial.printf("[Água] Resumo de %s: %.2f L em %d regas.\n", alvo.c_str(), litros, regas);
  }
  diaLitros = litros;
  diaSegundos = segundos;
  diaRegas = regas;
  pendenteLitros = 0;
  pendenteSegundos = 0;
  pendenteRegas = 0;
  if (alvo == hoje) et0Pendente = false;
}

// Grava "auto" em /horta/comandos (o site mostra o modo automático de novo).
// PATCH muda só esses campos: a simulação de chuva continua como está.
bool gravarModoAutomatico() {
  String resposta;
  int codigo = requisicaoBanco("PATCH", urlBanco("/horta/comandos"),
                               "{\"modo\":\"auto\",\"bombaManual\":false}", resposta);
  if (codigo != 200) Serial.printf("[Comandos] Não consegui gravar o modo automático (código %d).\n", codigo);
  return codigo == 200;
}


// =====================================================================
//  COMANDOS DO SITE
//  Chegam por streaming (o Firebase avisa na hora). Se o streaming ficar
//  instável, o plano B pergunta a cada 1 s (polling).
// =====================================================================

// O modo manual já passou do limite de 10 min? (nunca no MODO_TESTE)
bool manualVencido() {
  return !MODO_TESTE && millis() - manualDesdeMs >= TEMPO_MAX_MANUAL;
}

// Aplica o que está em /horta/comandos. Devolve true se o modo ou a
// bomba manual mudaram (aí quem chamou decide de novo na hora).
bool aplicarComandos(bool novoManual, bool novaBomba, double desde) {
  if (!novoManual) gravarAutoPendente = false;  // o site já está no automático

  // Entrou no modo manual agora? Marca a hora no millis().
  // Se for o mesmo pedido de antes (mesmo "manualDesde"), mantém a hora
  // antiga: assim uma queda de conexão não "zera" os 10 min.
  if (novoManual && !modoManual && (desde == 0 || desde != sessaoManual)) {
    manualDesdeMs = millis();
    sessaoManual = desde;
  }

  // Passou do tempo máximo do manual? Volta para o automático e grava
  // "auto" no Firebase (feito no loop, em cuidarDoLimiteManual).
  if (novoManual && manualVencido()) {
    Serial.println("[Comandos] Modo manual expirou: voltando para o automático.");
    novoManual = false;
    novaBomba = false;
    gravarAutoPendente = true;
  }

  bool mudou = (novoManual != modoManual) || (novoManual && novaBomba != bombaManual);
  modoManual = novoManual;
  bombaManual = novaBomba;

  if (mudou) {
    if (modoManual) Serial.printf("[Comandos] Modo MANUAL, bomba %s\n", bombaManual ? "ligada" : "desligada");
    else            Serial.println("[Comandos] Modo AUTOMÁTICO");
  }
  return mudou;
}

// Modo demonstração: aplica o "simularChuva" do site (-1 = previsão real).
// Devolve true se mudou (aí quem chamou decide de novo na hora).
bool aplicarSimulacao(int valor) {
  if (valor < -1 || valor > 100) valor = -1;

  // A simulação venceu e ainda estamos gravando -1: ignora o valor velho
  if (gravarSimulacaoPendente) {
    if (valor == simulacaoVencida) return false;
    gravarSimulacaoPendente = false;  // chegou -1 (gravado) ou uma simulação nova
  }
  if (valor == simularChuvaSite) return false;

  simularChuvaSite = valor;
  simulacaoDesdeMs = millis();
  estadoUrgente = true;  // o painel vê o motivo novo na hora
  if (valor >= 0) Serial.printf("[Demo] Simulação de chuva: %d%%\n", valor);
  else            Serial.println("[Demo] Simulação desligada: usando a previsão real");
  return true;
}

// Modo demonstração: aplica o "simularHora" do site (0 a 23, -1 = hora real).
// Devolve true se mudou (aí quem chamou decide de novo na hora).
bool aplicarSimulacaoHora(int valor) {
  if (valor < -1 || valor > 23) valor = -1;
  if (gravarSimHoraPendente) {
    if (valor == simHoraVencida) return false;
    gravarSimHoraPendente = false;
  }
  if (valor == simularHoraSite) return false;

  simularHoraSite = valor;
  simHoraDesdeMs = millis();
  estadoUrgente = true;
  if (valor >= 0) Serial.printf("[Demo] Simulação de horário: %dh\n", valor);
  else            Serial.println("[Demo] Simulação de horário desligada: usando a hora real");
  return true;
}

// Fora do MODO_TESTE, as simulações do site desligam sozinhas em 15 min:
// o ESP32 volta ao valor real e grava -1 no Firebase.
void cuidarDaSimulacao() {
  if (!MODO_TESTE && simularHoraSite >= 0 && millis() - simHoraDesdeMs >= TEMPO_MAX_SIMULACAO) {
    Serial.println("[Demo] A simulação de horário passou de 15 min: voltando para a hora real.");
    simHoraVencida = simularHoraSite;
    aplicarSimulacaoHora(-1);
    gravarSimHoraPendente = true;
    controlarBomba();
  }
  if (gravarSimHoraPendente && millis() - ultimaGravacaoSimHora >= 3000) {
    ultimaGravacaoSimHora = millis();
    String resposta;
    if (prontoParaFirebase() &&
        requisicaoBanco("PATCH", urlBanco("/horta/comandos"), "{\"simularHora\":-1}", resposta) == 200) {
      gravarSimHoraPendente = false;
    }
  }

  if (!MODO_TESTE && simularChuvaSite >= 0 && millis() - simulacaoDesdeMs >= TEMPO_MAX_SIMULACAO) {
    Serial.println("[Demo] A simulação passou de 15 min: voltando para a previsão real.");
    simulacaoVencida = simularChuvaSite;
    aplicarSimulacao(-1);
    gravarSimulacaoPendente = true;
    controlarBomba();
  }
  if (gravarSimulacaoPendente && millis() - ultimaGravacaoSimulacao >= 3000) {
    ultimaGravacaoSimulacao = millis();
    String resposta;
    if (prontoParaFirebase() &&
        requisicaoBanco("PATCH", urlBanco("/horta/comandos"), "{\"simularChuva\":-1}", resposta) == 200) {
      gravarSimulacaoPendente = false;
    }
  }
}

// Confere o limite do manual mesmo sem comando novo, e grava "auto" no
// Firebase quando ele vence (tenta de novo a cada 3 s se falhar).
void cuidarDoLimiteManual() {
  if (modoManual && manualVencido()) {
    if (aplicarComandos(true, bombaManual, sessaoManual)) controlarBomba();
  }
  if (gravarAutoPendente && millis() - ultimaGravacaoAuto >= 3000) {
    ultimaGravacaoAuto = millis();
    if (prontoParaFirebase() && gravarModoAutomatico()) gravarAutoPendente = false;
  }
}

// ---------------------------------------------------------------------
//  Plano B: lê /horta/comandos a cada 1 s, reaproveitando a conexão.
//  Devolve true se o modo, a bomba manual ou a simulação mudaram.
// ---------------------------------------------------------------------
bool lerComandos() {
  if (!prontoParaFirebase()) {
    voltarParaAutomatico();
    return false;
  }

  String resposta;
  int codigo = requisicaoBanco("GET", urlBanco("/horta/comandos"), "", resposta);
  JsonDocument comandos;
  pollingOk = (codigo == 200);
  if (codigo != 200) erroConexaoFirebase = true;
  else erroConexaoFirebase = false;  // (o polling só roda no plano B, com o streaming fechado)
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
  if (duracaoPedido > 2000) Serial.printf("[Comandos] Leitura lenta: %lu ms\n", duracaoPedido);

  // Se ainda não existir nada em /comandos, fica no automático
  const char* modo = comandos["modo"] | "auto";
  bool mudouModo = aplicarComandos(strcmp(modo, "manual") == 0,
                                   comandos["bombaManual"] | false,
                                   comandos["manualDesde"] | 0.0);
  bool mudouSimulacao = aplicarSimulacao(comandos["simularChuva"] | -1);
  bool mudouHora = aplicarSimulacaoHora(comandos["simularHora"] | -1);
  bool zerouCota = aplicarZerarCota(comandos["zerarCotaEm"] | 0.0);
  return mudouModo || mudouSimulacao || mudouHora || zerouCota;
}

// ---------------------------------------------------------------------
//  Streaming (Server-Sent Events) de /horta/comandos
//
//  Uma conexão HTTPS só para isso fica aberta. Sempre que alguém muda os
//  comandos, o Firebase manda na hora um texto assim:
//     event: put
//     data: {"path":"/","data":{"modo":"manual","bombaManual":true}}
//  (linha em branco = fim do evento). Também manda "keep-alive" a cada
//  ~30 s. O loop() só lê o que já chegou (available()): nunca fica parado
//  esperando.
// ---------------------------------------------------------------------
WiFiClientSecure clienteStream;
bool streamAberto = false;
bool planoB = false;               // true = streaming instável, usando o polling de 1 s
int falhasStream = 0;              // quedas/erros seguidos do streaming
String tokenDoStream = "";         // login usado para abrir (se renovar, reabre)
unsigned long streamFechadoEm = 0;
unsigned long esperaStream = 0;    // quanto esperar para abrir de novo
unsigned long ultimoDadoStream = 0;

// Leitura do texto que chega
bool streamChunked = false;  // resposta em pedaços (Transfer-Encoding: chunked)
long faltaNoPedaco = -1;     // bytes que faltam no pedaço (-1 = lendo o tamanho, -2 = fim do pedaço)
String linhaPedaco = "";
String linhaSse = "";
String eventoSse = "";
String dadoSse = "";

// Os comandos como estão no Firebase (o streaming manda só o que mudou)
String cmdModo = "auto";
bool cmdBomba = false;
double cmdDesde = 0;
int cmdSimular = -1;      // modo demonstração: chuva (-1 = previsão real)
int cmdSimularHora = -1;  // modo demonstração: horário (-1 = hora real)
double cmdZerarCota = 0;  // modo demonstração: "Recomeçar a cota" (hora do servidor)

void fecharStream(const char* motivo, unsigned long espera, bool contaFalha) {
  if (streamAberto) Serial.printf("[Stream] Fechado: %s. Reconecto em %lu s.\n", motivo, espera / 1000);
  clienteStream.stop();
  streamAberto = false;
  streamFechadoEm = millis();
  esperaStream = espera;
  if (contaFalha) falhasStream++;
}

// Lê uma linha do cabeçalho da resposta (só na abertura; pode esperar um pouco)
String lerLinhaCabecalho() {
  String linha = "";
  unsigned long inicio = millis();
  while (millis() - inicio < TIMEOUT_HTTP) {
    while (clienteStream.available()) {
      char c = clienteStream.read();
      if (c == '\n') { linha.trim(); return linha; }
      if (linha.length() < 1024) linha += c;
    }
    if (!clienteStream.connected()) break;
    delay(1);
  }
  return "#erro";
}

// Abre a conexão e lê o cabeçalho. O Firebase às vezes responde
// "307 Temporary Redirect" apontando para outro servidor: aí segue o endereço.
bool abrirStream() {
  String url = urlBanco("/horta/comandos");
  unsigned long inicio = millis();
  definirEstadoLed(LED_FIREBASE, PISCA_LENTO);  // conectando

  for (int tentativa = 0; tentativa < 3; tentativa++) {
    // Separa "https://servidor/caminho?auth=..." em servidor e caminho
    String resto = url.substring(url.indexOf("://") + 3);
    int barra = resto.indexOf('/');
    String servidor = resto.substring(0, barra);
    String caminho = resto.substring(barra);

    clienteStream.stop();
    clienteStream.setInsecure();
    if (!clienteStream.connect(servidor.c_str(), 443)) {
      Serial.println("[Stream] Não consegui conectar.");
      erroConexaoFirebase = true;
      return false;
    }
    clienteStream.print(String("GET ") + caminho + " HTTP/1.1\r\n" +
                        "Host: " + servidor + "\r\n" +
                        "Accept: text/event-stream\r\n" +
                        "Connection: keep-alive\r\n\r\n");

    // Primeira linha: "HTTP/1.1 200 OK"
    String status = lerLinhaCabecalho();
    int codigo = status.substring(status.indexOf(' ') + 1).toInt();
    String destino = "";
    streamChunked = false;
    while (true) {
      String linha = lerLinhaCabecalho();
      if (linha == "" || linha == "#erro") break;  // linha vazia = fim do cabeçalho
      String nome = linha.substring(0, linha.indexOf(':'));
      String valor = linha.substring(linha.indexOf(':') + 1);
      valor.trim();
      if (nome.equalsIgnoreCase("Location")) destino = valor;
      if (nome.equalsIgnoreCase("Transfer-Encoding") && valor.indexOf("chunked") >= 0) streamChunked = true;
    }

    if ((codigo == 307 || codigo == 302) && destino != "") {
      url = destino;  // outro servidor do Firebase: tenta lá
      continue;
    }
    if (codigo != 200) {
      Serial.printf("[Stream] O Firebase respondeu código %d.\n", codigo);
      if (codigo == 401) idToken = "";  // login recusado: faz de novo
      erroConexaoFirebase = true;
      clienteStream.stop();
      return false;
    }

    // Deu certo: prepara a leitura
    faltaNoPedaco = -1;
    linhaPedaco = linhaSse = eventoSse = dadoSse = "";
    erroConexaoFirebase = false;
    Serial.printf("[Stream] Conectado em %lu ms (memória livre: %lu bytes).\n",
                  millis() - inicio, (unsigned long)ESP.getFreeHeap());
    return true;
  }
  Serial.println("[Stream] Redirecionamentos demais.");
  clienteStream.stop();
  return false;
}

// Um evento completo chegou
void tratarEventoSse(const String& evento, const String& dado) {
  if (evento == "keep-alive") return;  // só "ainda estou aqui"

  if (evento == "cancel" || evento == "auth_revoked") {
    // cancel: as regras recusaram a leitura. auth_revoked: o login venceu.
    // Nos dois casos faz login de novo e reabre.
    Serial.printf("[Stream] Evento %s: renovando o login.\n", evento.c_str());
    idToken = "";
    erroConexaoFirebase = true;
    fecharStream(evento.c_str(), evento == "cancel" ? 10000 : ESPERA_RECONEXAO_STREAM, true);
    return;
  }
  if (evento != "put" && evento != "patch") return;

  JsonDocument doc;
  if (deserializeJson(doc, dado)) {
    Serial.println("[Stream] Evento com JSON inválido.");
    return;
  }
  String caminho = doc["path"] | "/";
  JsonVariant dados = doc["data"];

  if (caminho == "/") {
    if (evento == "put") {
      // put na raiz = todos os comandos de novo (null = nó apagado)
      cmdModo = dados["modo"] | "auto";
      cmdBomba = dados["bombaManual"] | false;
      cmdDesde = dados["manualDesde"] | 0.0;
      cmdSimular = dados["simularChuva"] | -1;
      cmdSimularHora = dados["simularHora"] | -1;
      cmdZerarCota = dados["zerarCotaEm"] | 0.0;
    } else {
      // patch = só os campos que mudaram
      if (!dados["modo"].isNull()) cmdModo = dados["modo"] | "auto";
      if (!dados["bombaManual"].isNull()) cmdBomba = dados["bombaManual"] | false;
      if (!dados["manualDesde"].isNull()) cmdDesde = dados["manualDesde"] | 0.0;
      if (!dados["simularChuva"].isNull()) cmdSimular = dados["simularChuva"] | -1;
      if (!dados["simularHora"].isNull()) cmdSimularHora = dados["simularHora"] | -1;
      if (!dados["zerarCotaEm"].isNull()) cmdZerarCota = dados["zerarCotaEm"] | 0.0;
    }
  } else if (caminho == "/modo") {
    cmdModo = dados | "auto";
  } else if (caminho == "/bombaManual") {
    cmdBomba = dados | false;
  } else if (caminho == "/manualDesde") {
    cmdDesde = dados | 0.0;
  } else if (caminho == "/simularChuva") {
    cmdSimular = dados | -1;
  } else if (caminho == "/simularHora") {
    cmdSimularHora = dados | -1;
  } else if (caminho == "/zerarCotaEm") {
    cmdZerarCota = dados | 0.0;
  }

  falhasStream = 0;  // o streaming está funcionando
  Serial.printf("[Comandos] recebido por streaming: modo=%s, bomba=%s\n",
                cmdModo.c_str(), cmdBomba ? "ligada" : "desligada");
  bool mudouModo = aplicarComandos(cmdModo == "manual", cmdBomba, cmdDesde);
  bool mudouSimulacao = aplicarSimulacao(cmdSimular);
  bool mudouHora = aplicarSimulacaoHora(cmdSimularHora);
  bool zerouCota = aplicarZerarCota(cmdZerarCota);
  if (mudouModo || mudouSimulacao || mudouHora || zerouCota) controlarBomba();
}

// Monta as linhas do SSE, um caractere de cada vez
void caractereSse(char c) {
  if (c == '\r') return;
  if (c != '\n') {
    if (linhaSse.length() < 2048) linhaSse += c;
    return;
  }
  if (linhaSse.length() == 0) {
    // Linha em branco: o evento terminou
    if (eventoSse != "") tratarEventoSse(eventoSse, dadoSse);
    eventoSse = "";
    dadoSse = "";
  } else if (linhaSse.startsWith("event:")) {
    eventoSse = linhaSse.substring(6);
    eventoSse.trim();
  } else if (linhaSse.startsWith("data:")) {
    dadoSse = linhaSse.substring(5);
    dadoSse.trim();
  }
  linhaSse = "";
}

// Resposta em pedaços: cada pedaço vem como "tamanho em hexadecimal\r\n",
// os dados e "\r\n". Tira essas marcas e passa só os dados para o SSE.
void caracterePedaco(char c) {
  if (faltaNoPedaco > 0) {
    caractereSse(c);
    if (--faltaNoPedaco == 0) faltaNoPedaco = -2;
    return;
  }
  if (faltaNoPedaco == -2) {           // "\r\n" do fim do pedaço
    if (c == '\n') faltaNoPedaco = -1;
    return;
  }
  if (c == '\n') {                      // terminou a linha com o tamanho
    faltaNoPedaco = strtol(linhaPedaco.c_str(), nullptr, 16);
    linhaPedaco = "";
    if (faltaNoPedaco == 0) fecharStream("o servidor encerrou", ESPERA_RECONEXAO_STREAM, true);
    return;
  }
  if (c != '\r' && linhaPedaco.length() < 16) linhaPedaco += c;
}

// Chamada em todo loop(): lê o que chegou, sem esperar, e reconecta se preciso
void cuidarDoStream() {
  if (streamAberto) {
    int limite = 2048;  // lê no máximo isso por volta do loop (o resto fica para a próxima)
    while (streamAberto && clienteStream.available() && limite-- > 0) {
      char c = clienteStream.read();
      ultimoDadoStream = millis();
      if (streamChunked) caracterePedaco(c);
      else caractereSse(c);
    }
    if (!streamAberto) return;

    if (!clienteStream.connected() && !clienteStream.available()) {
      fecharStream("a conexão caiu", ESPERA_RECONEXAO_STREAM, true);
    } else if (millis() - ultimoDadoStream > 70000) {
      // O keep-alive vem a cada ~30 s: 70 s sem nada = conexão "morta"
      fecharStream("nada chegou em 70 s", ESPERA_RECONEXAO_STREAM, true);
    } else if (idToken != "" && idToken != tokenDoStream) {
      // O login foi renovado (~55 min): reabre com o token novo
      fecharStream("login renovado", 0, false);
    }
    return;
  }

  // Fechado: espera um pouco e abre de novo
  if (millis() - streamFechadoEm < esperaStream) return;
  streamFechadoEm = millis();
  esperaStream = ESPERA_RECONEXAO_STREAM;
  if (!prontoParaFirebase()) {
    voltarParaAutomatico();
    return;
  }

  if (abrirStream()) {
    streamAberto = true;
    tokenDoStream = idToken;
    ultimoDadoStream = millis();
    if (planoB) Serial.println("[Stream] Streaming voltou: saindo do plano B.");
    planoB = false;
    return;
  }

  falhasStream++;
  if (!planoB && falhasStream >= FALHAS_PARA_PLANO_B) {
    // Plano B: o streaming falhou várias vezes seguidas (rede instável,
    // pouca memória para duas conexões seguras, etc.). Os comandos passam
    // a ser lidos a cada 1 s, e o streaming é tentado de novo a cada 60 s.
    planoB = true;
    Serial.println("[Stream] Instável: usando o plano B (polling a cada 1 s).");
  }
  if (planoB) esperaStream = 60000;
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
  if (codigo != 200) erroEscritaFirebase = true;
  return codigo;
}

// Confere se já está na hora de consultar o clima
void atualizarClima() {
  if (millis() - ultimaConsultaClima < esperaClima) return;

  // A consulta HTTPS pode travar o loop() por até 10 s. Com a bomba ligada
  // isso atrasaria a segurança do tempo máximo: espera ela desligar.
  // No MODO_TESTE não tem tempo máximo (e o LED pode ficar ligado horas no
  // manual), então consulta mesmo com ele aceso.
  if (bombaLigada && !MODO_TESTE) return;

  ultimaConsultaClima = millis();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[CLIMA] Sem Wi-Fi. Tento de novo em 5 min.");
    esperaClima = INTERVALO_CLIMA_ERRO;
    return;
  }

  definirEstadoLed(LED_CLIMA, PISCA_LENTO);  // consultando (já acende antes de esperar)
  climaFalhou = !consultarOpenMeteo();
  if (climaFalhou) {
    // Mantém os últimos valores válidos (até vencerem) e não grava nada
    Serial.println("[CLIMA] Tento de novo em 5 min.");
    esperaClima = INTERVALO_CLIMA_ERRO;
    return;
  }

  Serial.printf("[CLIMA] Atualizado em %s\n", clima.horaPrevisao.c_str());
  Serial.printf("[CLIMA] Temperatura: %.1f °C | Umidade do ar: %d %%\n", clima.temperatura, clima.umidadeAr);
  Serial.printf("[CLIMA] Chance máx. de chuva nas próximas %d h: %d %%\n", HORAS_CHUVA, clima.chanceChuva6h);
  Serial.printf("[CLIMA] ET0 hoje: %.2f mm\n", clima.et0);
  et0Pendente = true;  // vai também para o resumo do dia
  int codigo = enviarClimaFirebase();
  Serial.printf("[CLIMA] Enviado ao Firebase: %s (%d)\n", codigo == 200 ? "OK" : "ERRO", codigo);

  esperaClima = INTERVALO_CLIMA;
}


// =====================================================================
//  O QUE CADA LED DE STATUS MOSTRA (chamada no loop)
// =====================================================================
void atualizarLedsStatus() {
  bool wifi = WiFi.status() == WL_CONNECTED;

  // Wi-Fi: aceso = conectado; pisca lento = tentando conectar
  definirEstadoLed(LED_WIFI, wifi ? ACESO : PISCA_LENTO);

  // Firebase: aceso = login OK e comandos chegando (streaming conectado ou,
  // no plano B, o último polling respondeu 200); pisca lento = login ou
  // streaming em andamento; pisca rápido = erro; apagado = sem Wi-Fi
  EstadoLed firebase;
  bool comandosOk = streamAberto || (planoB && pollingOk);
  if (!wifi) firebase = APAGADO;
  else if (erroConexaoFirebase || erroEscritaFirebase) firebase = PISCA_RAPIDO;
  else if (idToken != "" && comandosOk) firebase = ACESO;
  else firebase = PISCA_LENTO;
  definirEstadoLed(LED_FIREBASE, firebase);

  // Clima: aceso = previsão válida; pisca rápido = a última consulta falhou;
  // apagado = sem Wi-Fi ou ainda sem previsão (o "pisca lento" de consultando
  // é ligado em atualizarClima, durante a consulta)
  EstadoLed estadoClima;
  bool previsaoValida = clima.valido && millis() - clima.atualizadoEmMs <= VALIDADE_CLIMA;
  if (!wifi) estadoClima = APAGADO;
  else if (climaFalhou) estadoClima = PISCA_RAPIDO;
  else if (previsaoValida) estadoClima = ACESO;
  else estadoClima = APAGADO;
  definirEstadoLed(LED_CLIMA, estadoClima);
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
  pinMode(PINO_LED_PLACA, OUTPUT);
  digitalWrite(PINO_LED_PLACA, LOW);
  for (int i = 0; i < TOTAL_LEDS; i++) {
    pinMode(pinosStatus[i], OUTPUT);
    digitalWrite(pinosStatus[i], LOW);
  }

  // Teste de ligação: bomba, Wi-Fi, Firebase e Clima acendem juntos por 1 s.
  // Só no MODO_TESTE: com bomba de verdade, este teste ligaria a bomba por 1 s.
  if (MODO_TESTE) {
    digitalWrite(PINO_RELE, RELE_ATIVO_EM_LOW ? LOW : HIGH);
    digitalWrite(PINO_LED_PLACA, HIGH);
    for (int i = 0; i < TOTAL_LEDS; i++) digitalWrite(pinosStatus[i], HIGH);
    delay(1000);  // só no boot; no loop() nada de delay()
    digitalWrite(PINO_RELE, RELE_ATIVO_EM_LOW ? HIGH : LOW);
    digitalWrite(PINO_LED_PLACA, LOW);
    for (int i = 0; i < TOTAL_LEDS; i++) digitalWrite(pinosStatus[i], LOW);
  }
  // Depois do teste, o que está guardado bate com os pinos: tudo apagado
  for (int i = 0; i < TOTAL_LEDS; i++) {
    estadoStatus[i] = APAGADO;
    faseLigada[i] = false;
    ultimaTroca[i] = millis();
  }

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

  // Hora certa pela internet (Brasília, UTC-3, sem horário de verão).
  // Ela chega sozinha depois que o Wi-Fi conectar.
  configTime(-3 * 3600, 0, "pool.ntp.org", "time.google.com");

  // Conexão com o banco que fica aberta entre os pedidos (ver requisicaoBanco)
  clienteBanco.setInsecure();
  httpBanco.setReuse(true);
  httpBanco.setConnectTimeout(TIMEOUT_HTTP);
  httpBanco.setTimeout(TIMEOUT_HTTP);

  // Primeiro histórico 5 s depois de ligar (dá tempo do Wi-Fi conectar)
  ultimoHistorico = millis() - INTERVALO_HISTORICO + 5000;

  if (MODO_TESTE) Serial.println("[Teste] MODO_TESTE ativo: sem pausa, sem tempo máximo e sem limite do manual.");

  // O clima só é consultado depois que o Wi-Fi conectar (ver cuidarDoWiFi)
  esperaClima = INTERVALO_CLIMA;

  if (SIMULAR_CHANCE_CHUVA >= 0) {
    Serial.printf("[Teste] SIMULAR_CHANCE_CHUVA ativo: fingindo %d%% de chance de chuva.\n", SIMULAR_CHANCE_CHUVA);
  }
}

void loop() {
  unsigned long inicioVolta = millis();

  // Nada de delay() longo: cada tarefa confere se já chegou a sua hora
  cuidarDoWiFi();

  if (millis() - ultimaLeitura >= INTERVALO_SENSOR) {
    ultimaLeitura = millis();
    lerSensor();
    controlarBomba();
  }

  // Comandos do site: chegam pelo streaming e já decidem na hora
  cuidarDoStream();

  // Plano B (streaming instável): pergunta a cada 1 s
  if (planoB && millis() - ultimaLeituraComandos >= INTERVALO_POLLING) {
    ultimaLeituraComandos = millis();
    if (lerComandos()) controlarBomba();
  }

  cuidarDoLimiteManual();
  cuidarDaSimulacao();

  // Estado para o painel: na hora quando muda, e "estou vivo" sem mudança
  cuidarDoEstado();

  if (millis() - ultimoHistorico >= INTERVALO_HISTORICO) {
    ultimoHistorico = millis();
    enviarLeitura();
  }

  // Regas terminadas (água usada) que ainda não foram para o Firebase
  enviarRegas();
  cuidarDoResumoDiario();

  atualizarClima();

  // LEDs de status: decide o que mostrar e faz as piscadas (sem delay)
  atualizarLedsStatus();
  piscarLedsStatus();
  diagnosticarLeds(millis() - inicioVolta);
}
