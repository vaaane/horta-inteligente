# 🌱 Horta Inteligente

Projeto da Feira de Ciências do **CED São Bartolomeu (DF)**: uma horta com irrigação automática.

```
ESP32 (sensor + bomba)  →  Firebase Realtime Database  →  site (Cloudflare Pages)
```

O ESP32 mede a umidade do solo, liga a bomba quando a terra está seca e envia os dados para o Firebase a cada 30 s. O site mostra tudo ao vivo.

## Pastas

| Pasta | O que tem |
|---|---|
| `web/` | O site (HTML, CSS e JavaScript puro, sem build) |
| `firmware/esp32-horta/` | O programa do ESP32 (Arduino IDE) |
| `firmware/teste-acende/` | Teste rápido do ESP32: LED acende/apaga e clima |
| `firebase/` | As regras de segurança do banco de dados |

Arquivos do site (`web/`):
- `index.html` + `app.js`: o painel ao vivo (umidade, bomba, clima, motivo da rega e gráfico).
- `sobre.html` + `sobre.js`: a página "Sobre o projeto" para a feira (funcionalidades, materiais, evolução). Para mudar o status de uma funcionalidade, edite a lista no `sobre.js`.
- `clima.js`: o cartão "Clima agora", usado no painel e na `teste.html` (o mesmo código nas duas páginas).
- `controle.js`: o controle da bomba no cartão "Bomba d'água" (Automático | Manual e Ligar/Desligar). Veja "Controle pelo site" no final.
- `demo.js`: o cartão "Modo demonstração": simular a chance de chuva pelo site. Veja "Modo demonstração" no final.
- `agua.js`: o cartão "Água": água usada e economizada (estimativa). Veja "Água (estimativa)" no final.
- `planejar.html` + `planejar.js`: a página "Planeje sua horta" (desenho do terreno, mapa de sol e sugestão de lugar para cada planta).
- `sol.js`: o cálculo das horas de sol (sem mexer na página). Testes: `node web/sol.test.mjs` (precisa de internet para baixar o SunCalc).
- `culturas.js`: sol e umidade de referência de cada planta e a escolha do melhor lugar.
- `decisao.js`: o cartão "Por que regou (ou não)" do painel: motivo da decisão atual do ESP32 e as 5 últimas decisões (`/horta/decisoes`). Fica escondido se o firmware ainda não manda a decisão.
- `qr.js`: desenha o QR code "Abra no seu celular" (no painel só aparece em telas largas; na `sobre.html`, sempre).
- `teste.html`: a página do teste acende/apaga.

---

## Passo a passo

### 1. Criar o projeto no Firebase
1. Entre em <https://console.firebase.google.com> e crie um projeto.
2. **Realtime Database** → *Criar banco de dados* (pode começar no modo bloqueado).
3. **Authentication** → *Vamos começar* → ative o método **E-mail/senha**.

### 2. Criar o usuário do ESP32 e publicar as regras
1. **Authentication → Usuários → Adicionar usuário**: crie um e-mail e senha só para o ESP32 (ex.: `esp32@horta.com`).
2. Copie o **UID do usuário** que aparece na lista.
3. Abra `firebase/database.rules.json` e troque as **três** ocorrências de `UID_DO_ESP32` pelo UID copiado.
4. **Realtime Database → Regras**: apague o que estiver lá, cole o conteúdo do arquivo e clique em **Publicar**.

Resumo das regras:
- Qualquer pessoa pode **ler** `/horta` (o site é público).
- Só o ESP32 pode **escrever** em `/horta/estado`, `/horta/leituras` e `/horta/decisoes`.
- `/horta/estado` pode trazer também a **decisão** da rega (`decisao`, um código da lista abaixo) e o **motivo** em português (`motivo`, até 160 letras). Os dois são opcionais: o firmware antigo continua funcionando.
- `/horta/regas` é o histórico das regas (água usada): só o ESP32 escreve. Cada item tem `fim`, `segundos`, `litros`, `motivo` e `inicio` (opcional).
- `/horta/config/inicioMedicao` tem escrita aberta: é o botão "Zerar contagem" do cartão "Água".
- `/horta/decisoes` é o histórico das decisões: cada item tem `decisao`, `motivo`, `umidade`, `chanceChuva` (opcional) e `ts`. Códigos aceitos: `regando`, `solo_ok`, `adiada_chuva`, `solo_critico`, `sem_previsao`, `pausa_seguranca`, `manual_ligada`, `manual_desligada`.
- `/horta/comandos` é **aberto**: qualquer pessoa com o site pode mudar o modo e ligar/desligar a bomba (decisão da professora, sem login). As regras só aceitam `modo` (`auto` ou `manual`), `bombaManual` (verdadeiro/falso) e, opcionais, `manualDesde` e `atualizadoEm` (horários que não podem estar no futuro). A proteção de verdade fica no firmware: no modo manual a bomba continua limitada a **60 s por acionamento** com pausa de **5 min**, e depois de **10 min** no manual o ESP32 volta sozinho para o automático. Se o Firebase não responder, ele também volta para o automático.
- A umidade precisa ser um número entre 0 e 100.

### 3. Configurar o site
1. **Configurações do projeto → Geral → Seus apps → Web (`</>`)**: registre um app.
2. Copie o objeto `firebaseConfig` e cole em `web/firebase-config.js`.

Essa configuração é pública — não tem problema ela estar no GitHub. A segurança fica nas regras.

### 4. Gravar o ESP32
1. Na Arduino IDE, instale o core **esp32** (da Espressif) e a biblioteca **ArduinoJson** (versão 7).
2. Na pasta `firmware/esp32-horta/`, copie `secrets.example.h` e renomeie a cópia para **`secrets.h`**.
3. Preencha o `secrets.h` com o Wi-Fi (2,4 GHz), a chave de API, o endereço do banco e o e-mail/senha do ESP32.
4. Selecione a placa **ESP32 Dev Module**, grave e abra o **Serial Monitor em 115200**.
5. **Calibração:** anote o "valor bruto" com o sensor seco e dentro de um copo d'água, e coloque em `VALOR_SECO` e `VALOR_MOLHADO` no `.ino`.

O `secrets.h` não vai para o GitHub (está no `.gitignore`).

### 5. Publicar o site no Cloudflare Pages
1. <https://dash.cloudflare.com> → **Workers e Pages → Criar → Pages → Conectar ao Git**.
2. Escolha o repositório `horta-inteligente`.
3. Configure:
   - **Framework preset:** `None`
   - **Build command:** (vazio)
   - **Build output directory:** `web`
4. Salve. A cada `git push` o site é atualizado sozinho.

### 6. Ligações elétricas

| Componente | Pino do componente | ESP32 |
|---|---|---|
| Sensor de umidade | VCC | 3.3 V |
| | GND | GND |
| | AO (saída analógica) | GPIO 34 |
| Módulo relé | VCC | 5 V (VIN) |
| | GND | GND |
| | IN | GPIO 33 |
| LED Wi-Fi (+ resistor) | perna comprida | GPIO 25 |
| LED Firebase (+ resistor) | perna comprida | GPIO 26 |
| LED Clima (+ resistor) | perna comprida | GPIO 27 |
| LED azul embutido da placa | — | GPIO 2 (acende junto com a bomba) |

A perna curta de cada LED vai no GND.

**LEDs de status** (aceso = OK; pisca lento = em andamento; pisca rápido = erro; apagado = sem Wi-Fi):
- **Wi-Fi (25):** aceso = conectado; pisca lento = tentando conectar.
- **Firebase (26):** aceso = login OK e comandos do site chegando; pisca lento = fazendo login ou conectando; pisca rápido = erro (login recusado, "Permission denied" nas regras, etc.).
- **Clima (27):** aceso = previsão válida; pisca lento = consultando; pisca rápido = a última consulta falhou; apagado = sem Wi-Fi ou ainda sem previsão.

No `MODO_TESTE`, ao ligar a placa, o LED da bomba e os três LEDs de status acendem juntos por 1 s (teste das ligações).

⚠️ **A bomba usa uma fonte separada**, ligada pelos contatos do relé (COM e NA). Nunca alimente a bomba pelo ESP32.

### Montagem de teste com LED e potenciômetro
Para testar tudo na mesa, sem bomba e sem sensor de verdade:

| No lugar de | Use | Ligação |
|---|---|---|
| Módulo relé | LED + resistor de 220 a 330 Ω | GPIO 33 → resistor → perna comprida do LED; perna curta → GND |
| Sensor de umidade | Potenciômetro (10 kΩ, por exemplo) | uma ponta no **3V3**, a outra no **GND**, o pino do meio no **GPIO 34** |

- No `esp32-horta.ino`, deixe `RELE_ATIVO_EM_LOW = false` (LED ligado direto no pino). Com um módulo relé de verdade, normalmente é `true`.
- ⚠️ Potenciômetro no **3V3, nunca no 5V**: 5 V queima a entrada do ESP32.
- O GPIO 34 é um pino próprio, marcado "34" ou "D34" na placa. **Não** é o VP (GPIO 36) nem o VN (GPIO 39).
- Girando o potenciômetro, a "umidade" vai de 0% a 100% (com a calibração padrão: valor bruto acima de 3200 = 0%, abaixo de 1300 = 100%). O LED acende abaixo de 35% e apaga acima de 60%.

---

## Teste rápido (acende/apaga)

Um teste mínimo para conferir que o caminho **ESP32 → Firebase → site** está funcionando, antes de montar o sensor e a bomba.

1. **Publique as regras** (`firebase/database.rules.json`) no console do Firebase, como no passo 2.
2. Abra **`/teste.html`** no site (ou pelo link "Página de teste" no rodapé da página principal).
3. Na pasta `firmware/teste-acende/`, copie `secrets.example.h` para **`secrets.h`**, preencha o Wi-Fi e o endereço do banco e grave o `teste-acende.ino` no ESP32.
4. Abra o **Serial Monitor em 115200** (final de linha: "Nova linha") e digite **`acende`**. O círculo do site fica verde e o LED azul da placa acende. Digite **`apaga`** para desligar.

O Serial Monitor mostra o código HTTP de cada envio: **200 = deu certo**.

💡 **Dica:** dá para testar só o site, sem o ESP32: no console do Firebase (Realtime Database → Dados), crie `teste/led` com o valor `true`.

### Clima (Open-Meteo)

O `teste-acende` e o firmware da horta (`esp32-horta`) consultam a previsão do tempo no [Open-Meteo](https://open-meteo.com) logo que o Wi-Fi conecta e depois a cada 30 min (se falhar, tenta de novo em 5 min). O resumo vai para `/clima` no Firebase e aparece no cartão **"Clima agora"** do painel e da `/teste.html`:

- temperatura e umidade do ar;
- maior chance de chuva nas próximas 6 horas;
- **ET₀** (evapotranspiração de referência): quanta água, em mm, uma planta de referência perde no dia. 1 mm = 1 litro por m².

No Serial Monitor aparece um bloco de linhas começando com `[CLIMA]`.

⚠️ **Temporário:** os nós `/teste` e `/clima` têm leitura **e escrita** abertas para qualquer pessoa, porque esse teste do ESP32 não faz login. Depois que tudo funcionar, apague o bloco `/teste` das regras e, no bloco `/clima`, troque `".write": true` por `".write": "auth != null && auth.uid === 'UID_DO_ESP32'"` (o site continua lendo; só o firmware da horta, que faz login, grava). Publique de novo.

---

## Como a rega funciona
A cada leitura do sensor (a cada 2 s) o ESP32 decide o que fazer, nesta ordem:

1. **Pausa de segurança:** a bomba fica no máximo 60 s ligada; depois descansa 5 min. → `pausa_seguranca`
2. **Modo manual:** obedece o site. → `manual_ligada` / `manual_desligada`
3. **Já está regando:** continua até a umidade passar de **60%**. → `regando`
   - Mas se a chance de chuva passar a ser **≥ 60%** (e o solo **≥ 20%**), **para** e deixa a chuva regar. → `adiada_chuva` ("Parei de regar: …")
4. **Solo abaixo de 35%:** olha a previsão do tempo antes de gastar água.
   - Chance de chuva nas próximas 6 h **≥ 60%** e solo **≥ 20%** → **não rega**, deixa a chuva regar. → `adiada_chuva`
   - Chance alta, mas solo **abaixo de 20%** → rega mesmo assim, a planta não pode esperar. → `solo_critico`
   - **Sem previsão** (nunca consultou, a consulta falhou ou a previsão tem mais de 90 min) → rega só pelo sensor, que é o comportamento seguro. → `sem_previsao`
   - Chance baixa → rega. → `regando`
5. **Solo úmido:** não faz nada. → `solo_ok`

Cada decisão tem um **código** e um **motivo** em português (ex.: "Não reguei: 80% de chance de chuva nas próximas 6 h."). O motivo vai junto com o estado para o Firebase e aparece no painel, no cartão **"Por que regou (ou não)"**. Quando o código muda, o ESP32 escreve `[Decisão] <código> — <motivo>` no Serial Monitor e guarda a mudança no histórico `/horta/decisoes` (se estiver sem Wi-Fi, envia a última mudança quando a conexão voltar).

Os limites ficam no bloco **REGRAS DA REGA** do `esp32-horta.ino`: `LIMITE_LIGAR`, `LIMITE_DESLIGAR`, `LIMITE_CHUVA`, `LIMITE_CRITICO` e `VALIDADE_CLIMA`.

Fora do `MODO_TESTE`, a consulta ao clima nunca acontece com a bomba ligada: ela pode travar o programa por até 10 s e atrasaria a segurança do tempo máximo. Sem Wi-Fi ou sem Firebase, a rega continua funcionando; quando a previsão vence, a decisão passa a ser `sem_previsao`.

### Testar a decisão da chuva em casa (`SIMULAR_CHANCE_CHUVA`)
O jeito mais fácil é o cartão **"Modo demonstração"** do painel (veja no final), que tem prioridade sobre esta constante. Pelo código também dá para **fingir** a previsão:

1. No bloco **REGRAS DA REGA**, troque `SIMULAR_CHANCE_CHUVA = -1` por, por exemplo, `SIMULAR_CHANCE_CHUVA = 80` e grave o ESP32. No começo do Serial Monitor aparece `[Teste] SIMULAR_CHANCE_CHUVA ativo`.
2. Deixe o solo entre 20% e 35%: aparece `[Decisão] adiada_chuva — Não reguei: 80% de chance de chuva nas próximas 6 h. (simulado)` e o painel mostra o mesmo motivo.
3. Abaixo de 20% a horta rega mesmo assim (`solo_critico`).

⚠️ **Antes da feira**, volte para `SIMULAR_CHANCE_CHUVA = -1` e grave o ESP32 de novo. Se o Serial Monitor ainda mostrar `[Teste] SIMULAR_CHANCE_CHUVA ativo` ou o painel mostrar "(simulado)", a simulação continua ligada.

## Controle pelo site
No cartão **"Bomba d'água"** do painel tem dois botões: **Automático** | **Manual**. Não precisa de login.

- **Automático:** o ESP32 decide sozinho (veja "Como a rega funciona").
- **Manual:** aparece o botão **Ligar bomba** / **Desligar bomba**.
- O ESP32 recebe os comandos na hora, por streaming. Depois de um clique, o LED/bomba responde e o painel mostra o estado real em poucos segundos. O círculo da bomba sempre mostra o que o ESP32 **fez**, não o que foi pedido ("Você pediu: ligada" fica embaixo do botão); enquanto não bate, aparece "Pedido enviado… aguardando o ESP32". Se passar 5 s sem resposta, o painel avisa.
- **Limites de segurança** (valem também no manual, porque o site é aberto):
  - cada acionamento dura no máximo **60 s**; depois a bomba descansa **5 min** (o painel mostra o motivo);
  - o modo manual dura no máximo **10 min**: depois o ESP32 grava `modo: "auto"` sozinho e volta para o automático (o painel mostra a contagem regressiva);
  - se o ESP32 não conseguir ler o Firebase 3 vezes seguidas (ou ficar sem Wi-Fi), ele volta para o automático.
- Com o ESP32 offline, os botões ficam desativados.

### Modo teste (`MODO_TESTE`)
No topo do `esp32-horta.ino`, `MODO_TESTE = true` é para a montagem com LED: **sem pausa de segurança, sem tempo máximo e sem o limite de 10 min do manual**, e tudo mais rápido (sensor a cada 300 ms, estado na hora quando algo muda e a cada 5 s, histórico a cada 10 s). Os limites de umidade (35% / 60%) e a previsão de chuva continuam valendo. O painel mostra o selo "Modo teste" e considera o ESP32 offline depois de 20 s sem dado novo (no modo normal, 2 min).

⚠️ **Com a bomba de verdade, troque para `MODO_TESTE = false`** e grave de novo: volta a valer tudo acima (60 s, 5 min de pausa, 10 min de manual).

Os comandos do site chegam ao ESP32 por **streaming** (o Firebase avisa na hora). Se o streaming falhar várias vezes seguidas, o ESP32 passa a perguntar a cada 1 s (plano B) e tenta o streaming de novo a cada minuto.

## Modo demonstração
Na época da feira quase nunca chove no DF, então a previsão real marca ~0% e a decisão da chuva nunca aparece. O cartão **"Modo demonstração"** do painel resolve isso:

- Ligue a chave **Simular chuva** e escolha a chance (controle de 0 a 100% ou os botões 0%, 30%, 60%, 80% e 100%). A marca em **60%** mostra a partir de onde a rega é adiada.
- O valor vai para `/horta/comandos/simularChuva` quando você solta o controle, e o ESP32 decide de novo na hora. O motivo no cartão "Por que regou (ou não)" termina com **"(simulado)"**.
- Enquanto a simulação estiver ativa, aparece uma faixa âmbar com o botão **Voltar à previsão real**. O cartão "Clima agora" continua mostrando a previsão **real**, com a linha "A decisão está usando uma chance simulada de X%".
- Prioridade da chance usada na decisão: simulação do site → `SIMULAR_CHANCE_CHUVA` do código → previsão real.
- Com `MODO_TESTE = false`, a simulação do site desliga sozinha em **15 min** (o ESP32 grava `simularChuva: -1`). Com `MODO_TESTE = true`, fica até alguém desligar.
- No Serial Monitor: `[Demo] Simulação de chuva: 80%` e `[Demo] Simulação desligada: usando a previsão real`.

## Água (estimativa)
Ainda **não há sensor de fluxo**. Cada vez que a bomba desliga, o ESP32 grava a rega em `/horta/regas` com o tempo que ela ficou ligada e os litros **estimados**: `segundos / 60 × VAZAO_L_MIN` (1,5 L/min por padrão). Regas com menos de 1 s não contam; sem Wi-Fi, até 5 regas ficam guardadas para enviar depois.

O cartão **"Água"** do painel mostra:
- **Água usada:** soma dos litros e número de regas desde o início da medição;
- **Um timer fixo teria usado:** 2 regas por dia × 5 min × 1,5 L/min, pelo tempo de medição (o dia de hoje conta pelas horas que já passaram);
- **Economia:** a diferença em litros e em %, traduzida em banhos de 5 minutos (45 L) e garrafões de 20 L. Se a horta usou mais que o timer (acontece no teste, com o LED ligado no manual por muito tempo), o cartão diz isso.
- **Zerar contagem** começa a medição de agora (grava `/horta/config/inicioMedicao`).

As constantes do timer e das comparações ficam no topo do `web/agua.js`.

### Como medir a vazão de verdade
1. Coloque a mangueira da bomba dentro de uma garrafa ou balde com marcação de litros.
2. Ligue a bomba por **1 minuto** exato (pelo modo Manual do painel, com um cronômetro).
3. Veja quantos litros caíram: esse é o valor em L/min.
4. Troque `VAZAO_L_MIN` no `esp32-horta.ino` **e** no `web/agua.js` pelo valor medido. Grave o ESP32 e faça `git push`.

Repita 2 ou 3 vezes e use a média. Quando o sensor de fluxo YF-S201 chegar, ele vai medir o valor real.

## Planeje sua horta
Página `planejar.html` (link na navegação). A pessoa desenha o terreno (largura e comprimento), gira a seta do norte e coloca os obstáculos com a altura de cada um: retângulos para muros e casas, círculos para árvores. O botão **Carregar exemplo** monta um terreno de 6 × 4 m com um muro de 2 m no lado norte e uma árvore de 4 m no canto leste. O desenho fica salvo no navegador.

Como o mapa de sol é calculado (`web/sol.js`):
1. O terreno é dividido em quadradinhos de 0,25 m.
2. Do nascer ao pôr do sol, a cada 30 minutos, a biblioteca SunCalc diz a direção e a altura do sol no céu.
3. De cada quadradinho, "olhamos" na direção do sol: se um obstáculo está no caminho e é mais alto que `distância × tan(altura do sol)`, o ponto está na sombra.
4. Cada meia hora sem sombra vale 0,5 h de sol. Menos de 3 h = sombra; 3 a 6 h = meia-sombra; 6 h ou mais = pleno sol.

Dá para ver o mapa de um dia (Hoje, Verão, Inverno, Equinócio) ou do **Ano todo (pior caso)**: o menor valor de cada ponto entre os 12 meses. Em **O que você quer plantar?**, a pessoa marca as plantas e a área de cada uma. As que precisam de mais sol escolhem primeiro; cada uma ganha uma região junta, com as horas de sol que ela precisa, e uma explicação em texto.

**Roteiro para a feira:** Carregar exemplo → mostrar a sombra do muro no mapa → trocar para **Inverno (21/06)** e mostrar a sombra maior (o sol fica mais baixo, ao norte) → marcar tomate e alface → mostrar onde cada um ficou e ler a explicação.
