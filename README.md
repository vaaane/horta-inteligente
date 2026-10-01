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
- `index.html` + `app.js`: o painel ao vivo, em abas (Agora · Água · Histórico · Demonstração). Veja "O painel" abaixo.
- `abas.js`: as abas do painel (endereço próprio para cada uma, setas do teclado).
- `projetor.js`: o modo projetor (o painel alterna as abas sozinho).
- `podeRegar.js`: a faixa "Pode regar agora?" com os semáforos (solo, chuva, horário, cota, falha).
- `falha.js`: a faixa vermelha de falha e o botão "Já resolvi".
- `cabecalho.js`: o cabeçalho das 3 páginas (no celular, a navegação vira o botão ☰).
- `config.js`: configurações públicas do site, como o link do canal do Telegram (`TELEGRAM_CANAL`). Nada de senha aqui.
- `sobre.html` + `sobre.js`: a página "Sobre o projeto" para a feira (funcionalidades, a tabela "Umidade e sol por cultura", materiais, evolução). Para mudar o status de uma funcionalidade, edite a lista no `sobre.js`. A tabela das culturas é gerada com os dados do `culturas.js` (os mesmos do Planeje).
- `clima.js`: o cartão "Clima agora", usado no painel e na `teste.html` (o mesmo código nas duas páginas).
- `controle.js`: o controle da bomba no cartão "Bomba d'água" (Automático | Manual e Ligar/Desligar). Veja "Controle pelo site" no final.
- `demo.js`: o cartão "Modo demonstração": simular a chance de chuva pelo site. Veja "Modo demonstração" no final.
- `agua.js`: a aba "Água": água usada e economizada (estimativa), com um período só para a aba inteira. Veja "Água (estimativa)" no final.
- `planejar.html` + `planejar.js`: a página "Planeje sua horta" (mapa fixo + etapas em abas: terreno, sombras, plantas e salvar). Veja "Planeje sua horta" no final.
- `plantas.js`: os canteiros das plantas no Planeje (cor da planta, selo da avaliação, número ou nome, arrastar e girar) e a lista "Onde plantar".
- `rotulos.js`: os rótulos dos obstáculos no Planeje, desviando dos das plantas.
- `tempo.js`: os tempos escritos de um jeito só no site inteiro ("há 5 min", "há 18 h", "ontem às 14:48", "seg 28 13:54").
- `mapa.js`: o modo "Sobre o mapa" da página Planeje sua horta (imagem de satélite, busca de endereço e desenho por cima).
- `sol.js`: o cálculo das horas de sol (sem mexer na página). Testes: `node web/sol.test.mjs` (precisa de internet para baixar o SunCalc).
- `culturas.js`: sol e umidade de referência de cada planta e a escolha do melhor lugar.
- `decisao.js`: a lista "Últimas decisões" (aba Histórico, 5 linhas com "Ver mais", repetidas agrupadas) e a linha "Última decisão, 11:31: …" (aba Agora), de `/horta/decisoes`. Fica escondida se o firmware ainda não manda a decisão.
- `qr.js`: desenha os QR codes (o do canal do Telegram no painel; o do site na `sobre.html`).
- `teste.html`: a página do teste acende/apaga. Não tem link no site: abra pelo endereço direto (`/teste.html`).

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
2. Abra **`/teste.html`** no site (digite o endereço: a página não tem link no menu nem no rodapé).
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

Cada decisão tem um **código** e um **motivo** em português (ex.: "Não reguei: 80% de chance de chuva nas próximas 6 h."). O motivo vai junto com o estado para o Firebase e aparece no painel, na faixa **"Pode regar agora?"** (e na lista "Últimas decisões", aba Histórico). Quando o código muda, o ESP32 escreve `[Decisão] <código> — <motivo>` no Serial Monitor e guarda a mudança no histórico `/horta/decisoes` (se estiver sem Wi-Fi, envia a última mudança quando a conexão voltar).

Os limites ficam no bloco **REGRAS DA REGA** do `esp32-horta.ino`: `LIMITE_LIGAR`, `LIMITE_DESLIGAR`, `LIMITE_CHUVA`, `LIMITE_CRITICO` e `VALIDADE_CLIMA`.

Fora do `MODO_TESTE`, a consulta ao clima nunca acontece com a bomba ligada: ela pode travar o programa por até 10 s e atrasaria a segurança do tempo máximo. Sem Wi-Fi ou sem Firebase, a rega continua funcionando; quando a previsão vence, a decisão passa a ser `sem_previsao`.

### Testar a decisão da chuva em casa (`SIMULAR_CHANCE_CHUVA`)
O jeito mais fácil é o cartão **"Modo demonstração"** do painel (veja no final), que tem prioridade sobre esta constante. Pelo código também dá para **fingir** a previsão:

1. No bloco **REGRAS DA REGA**, troque `SIMULAR_CHANCE_CHUVA = -1` por, por exemplo, `SIMULAR_CHANCE_CHUVA = 80` e grave o ESP32. No começo do Serial Monitor aparece `[Teste] SIMULAR_CHANCE_CHUVA ativo`.
2. Deixe o solo entre 20% e 35%: aparece `[Decisão] adiada_chuva — Não reguei: 80% de chance de chuva nas próximas 6 h. (simulado)` e o painel mostra o mesmo motivo.
3. Abaixo de 20% a horta rega mesmo assim (`solo_critico`).

⚠️ **Antes da feira**, volte para `SIMULAR_CHANCE_CHUVA = -1` e grave o ESP32 de novo. Se o Serial Monitor ainda mostrar `[Teste] SIMULAR_CHANCE_CHUVA ativo` ou o painel mostrar "(simulado)", a simulação continua ligada.

## O painel
O `index.html` tem quatro abas, logo abaixo do cabeçalho. Cada uma tem endereço próprio: dá para abrir direto numa delas, e trocar de aba muda o endereço sem recarregar.

| Aba | Endereço | O que tem |
|---|---|---|
| **Agora** | `index.html#agora` (padrão) | faixa "Pode regar agora?" com os semáforos; ao lado, o QR do canal do Telegram; os cartões Umidade do solo (com os tracinhos de liga 35% / desliga 60%), Bomba, Clima agora e Água economizada; a linha "Última decisão" |
| **Água** | `index.html#agua` | um período só (Desde o início · 7 dias · 30 dias) para frase, números, equivalências, gráfico, tabela e regas; o bloco "Hoje" com a cota; "Como calculamos" recolhido |
| **Histórico** | `index.html#historico` | gráfico da umidade com as faixas desliga / liga / crítico, as regas em pontos azuis e o dia das leituras; "Últimas decisões" (5 linhas, "Ver mais", repetidas agrupadas) |
| **Demonstração** | `index.html#demo` | simular chuva e horário, recomeçar a cota, simular fim do dia, detectar falha, zerar contagem e o interruptor do modo projetor |

- **Celular do visitante:** a primeira coisa abaixo do cabeçalho é "Pode regar agora?"; as abas ficam presas embaixo da tela.
- **Tamanhos:** ficam em variáveis no topo do `style.css` (`--fs-gigante`, `--fs-numero`, `--fs-titulo`, `--fs-texto`, `--fs-nota`, `--espaco-cartao`, `--gap`). Os grandes usam `clamp()`: crescem no projetor de 1920 e encolhem em 1280. O texto pequeno nunca fica abaixo de 14 px. A aba Agora cabe sem rolar em 1366×768 e 1280×720 a 100% de zoom (no projetor, use tela cheia: F11).
- **Sem sinal do ESP32:** o aviso diz desde quando ("ESP32 sem sinal há 18 h", o mesmo tempo do rodapé), a faixa vira uma linha e o cartão da bomba mostra "Sem sinal: controle pausado". Os 20 s (modo teste) / 2 min continuam decidindo quando o aviso aparece.
- **Quem pode mexer:** a aba Demonstração e os botões que gravam no Firebase (Manual/Ligar, "Já resolvi", os botões da faixa) só aparecem em telas de **1024 px ou mais** (o computador do projetor). No celular, sem eles, a bomba mostra só "Modo: Automático" ou "Modo: Manual". Para a professora usar os controles no celular: **`index.html?demo=1`** (aparece uma nota avisando que o que mudar aparece para todos).
- **Modo projetor:** **`index.html?tela=projetor`** (ou o interruptor "Modo projetor" na aba Demonstração, guardado no navegador) alterna Agora → Água → Histórico a cada **20 s**. Fica parado na aba Agora enquanto há falha, a bomba está ligada ou a decisão acabou de mudar (30 s). Um toque, clique ou tecla pausa a rotação por **2 min**. Três pontinhos no canto mostram a aba no ar (laranja = pausado). A Demonstração nunca entra na rotação. Em 1920×1080 e 1280×720, cada aba cabe sem rolar (no 720 p os gráficos ficam mais baixos).

## Controle pelo site
No cartão **"Bomba d'água"** do painel tem dois botões: **Automático** | **Manual**. Não precisa de login. No celular, os botões só aparecem com `?demo=1` (veja "O painel").

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

## Alertas no Telegram
O ESP32 manda avisos para o celular por um bot do Telegram.

⚠️ **O token do bot é uma senha.** Ele fica **só** no `secrets.h` (que não vai para o GitHub), **nunca** no site, que é público.

### Criar o bot
1. No Telegram, fale com **@BotFather** → `/newbot` → escolha o nome e o usuário do bot → copie o **token**.
2. Abra o bot novo e toque em **Iniciar** (ou mande qualquer mensagem). Para um grupo ou canal, adicione o bot (no canal, como **administrador**) e mande uma mensagem lá.
3. Abra `https://api.telegram.org/bot<TOKEN>/getUpdates` no navegador e copie o `chat.id`: positivo para conversa pessoal, negativo para grupo ou canal. Se o canal não aparecer, encaminhe uma mensagem do canal para o bot.

### Configurar
No `secrets.h`:
```cpp
#define TELEGRAM_TOKEN "123456:ABC..."
// Até 3 conversas, separadas por vírgula
#define TELEGRAM_CHAT_IDS "123456789,-1001234567890"
```
No `.ino`: `TELEGRAM_ATIVO = false` desliga os alertas. Com o token ou os chat ids vazios, o Telegram desliga sozinho (o Serial avisa uma vez).

### Quais mensagens
Os avisos seguem a **decisão estável** (a que vai para o histórico, depois de 10 s sem mudar), não cada leitura do sensor.

| Evento | Exemplo | No `MODO_TESTE` |
|---|---|---|
| Placa ligou e conectou | 🌱 **Horta ligada** e conectada. Umidade 42%. | sim |
| Rega começou | 💧 **Regando**: solo com 28%, chance de chuva 10%. | só com `TELEGRAM_TUDO_NO_MODO_TESTE` |
| Rega terminou | ✅ Rega encerrada: 1 min 12 s, ~1,8 L. | só com `TELEGRAM_TUDO…` |
| Adiada ou interrompida | 🌧️ / ☀️ / 🎯 com o motivo | só com `TELEGRAM_TUDO…` |
| **Solo crítico** | 🚨 com o motivo | **sim** |
| **Falha** | ⚠️ **Falha**: motivo + "Toque em Já resolvi no painel depois de conferir." | **sim** |
| Falha resolvida | ✅ Falha resolvida: voltando ao automático. | **sim** |
| Manual / automático | 🖐️ Modo manual ativado pelo painel. / 🔄 De volta ao automático. | só com `TELEGRAM_TUDO…` |
| Resumo do dia (na virada do dia) | 📊 **Resumo de ontem**: 3 regas, ~2,4 L (cota 1,8 L; Kc 1,0 → 1,1). Timer fixo usaria 15 L. | sim |

- No modo teste o potenciômetro muda toda hora: por isso, com `TELEGRAM_TUDO_NO_MODO_TESTE = false`, só vão os avisos importantes.
- Decisões simuladas pelo Modo demonstração levam "(simulado)". Toda mensagem termina com o link do painel.
- **Anti-spam:** a mesma mensagem não se repete antes de 60 s. Uma rega de menos de 20 s vira uma mensagem só ("💧 Regou 15 s (~0,4 L).").
- **Envio:** fila de até 8 mensagens, uma a cada 3 s no máximo (cada envio trava o ESP32 ~1 s). Sem Wi-Fi, a fila espera; mensagens com mais de 10 min são descartadas. Se o Telegram responder que o token ou o chat id estão errados, o Serial avisa e os alertas ficam desligados até reiniciar a placa.

### Canal da horta (para os visitantes)
Na feira, o painel mostra o QR de um **canal** do Telegram: quem escaneia entra e passa a receber os avisos. Canal, e não grupo: no canal só o bot publica e a lista de inscritos fica oculta.
1. No Telegram, crie um **canal público** (ex.: `t.me/hortainteligenteced`). Na descrição do canal, coloque o link do site.
2. Em **Administradores**, adicione o bot como administrador, com permissão de publicar mensagens.
3. Publique qualquer mensagem no canal e encaminhe-a para o bot; abra `https://api.telegram.org/bot<TOKEN>/getUpdates` e copie o `chat.id` do canal (negativo, começa com `-100`).
4. Coloque esse número em `TELEGRAM_CHAT_IDS` no `secrets.h` (pode ficar junto com o seu chat pessoal: `"123456789,-1001234567890"`) e grave o ESP32.
5. Coloque o link do canal em `TELEGRAM_CANAL`, no `web/config.js`. Com o link vazio, o cartão "Receba os alertas da horta" não aparece no painel.
6. **Durante a feira, ligue `TELEGRAM_TUDO_NO_MODO_TESTE = true`** no `.ino` (se a placa estiver com `MODO_TESTE = true`): assim quem entrar no canal recebe também as regas e os adiamentos, não só as falhas.

No painel, o cartão **"Receba os alertas da horta"** mostra o QR do canal (tela grande) ou o botão **"Abrir canal no Telegram"** (celular). O QR do site continua na página Sobre.

### Testar (com `MODO_TESTE = true`)
1. Ligue a placa → chega "🌱 Horta ligada".
2. Gire o potenciômetro para 15% e espere 10 s → "🚨" de solo crítico.
3. Com "Detectar falha" ligado, no automático, deixe o potenciômetro parado → uns 55 s depois, "⚠️ Falha".
4. Toque em "Já resolvi" no painel → "✅ Falha resolvida".
5. Troque para `TELEGRAM_TUDO_NO_MODO_TESTE = true`, grave, e simule 80% de chuva com a rega em andamento → "🌧️ Parei de regar… (simulado)".

### Próxima etapa: aviso de "horta sem sinal"
Quando o ESP32 cai (sem energia ou sem Wi-Fi), ele não consegue avisar. Quem avisaria é um **Worker separado** no Cloudflare, sem mexer no site:
1. Criar um Worker novo (ex.: `horta-vigia`) com um **Cron Trigger** a cada 5 min (`*/5 * * * *`).
2. A cada rodada, ler `FIREBASE_DB_URL/horta/estado/ts.json` (a leitura é pública) e calcular há quantos minutos chegou o último dado.
3. Guardar num **KV** (ex.: chave `offline`) se o aviso já foi mandado, para avisar uma vez só:
   - mais de 10 min sem dado e ainda não avisou → "⚠️ A horta está sem sinal há X min" e grava `offline = true`;
   - dado novo e `offline = true` → "✅ A horta voltou" e apaga a chave.
4. O token e os chat ids ficam em *secrets* do Worker (`wrangler secret put TELEGRAM_TOKEN`), **nunca** no código.

Não foi feito agora porque precisa de um Worker e de um KV novos, criados e publicados na conta do Cloudflare.

## Modo demonstração
Na época da feira quase nunca chove no DF, então a previsão real marca ~0% e a decisão da chuva nunca aparece. O cartão **"Modo demonstração"** (aba **Demonstração** do painel) resolve isso:

- Ligue a chave **Simular chuva** e escolha a chance (controle de 0 a 100% ou os botões 0%, 30%, 60%, 80% e 100%). A marca em **60%** mostra a partir de onde a rega é adiada.
- O valor vai para `/horta/comandos/simularChuva` quando você solta o controle, e o ESP32 decide de novo na hora. O motivo na faixa "Pode regar agora?" termina com **"(simulado)"**.
- Enquanto a simulação estiver ativa, aparece uma faixa âmbar com o botão **Voltar à previsão real**. O cartão "Clima agora" continua mostrando a previsão **real**, com a linha "A decisão está usando uma chance simulada de X%".
- Prioridade da chance usada na decisão: simulação do site → `SIMULAR_CHANCE_CHUVA` do código → previsão real.
- Com `MODO_TESTE = false`, a simulação do site desliga sozinha em **15 min** (o ESP32 grava `simularChuva: -1`). Com `MODO_TESTE = true`, fica até alguém desligar.
- No Serial Monitor: `[Demo] Simulação de chuva: 80%` e `[Demo] Simulação desligada: usando a previsão real`.

## Água (estimativa)
Ainda **não há sensor de fluxo**. Cada vez que a bomba desliga, o ESP32 grava a rega em `/horta/regas` com o tempo que ela ficou ligada e os litros **estimados**: `segundos / 60 × VAZAO_L_MIN` (1,5 L/min por padrão). Regas com menos de 1 s não contam; sem Wi-Fi, até 5 regas ficam guardadas para enviar depois.

A aba **Água** do painel tem **um período só para a aba inteira**: **Desde o início** (padrão) · **7 dias** · **30 dias**. O período escolhido muda junto a frase, os 3 números, as equivalências, o gráfico, a tabela por dia e as últimas regas. Ao lado do seletor: "medindo há 2 dias" (Desde o início) ou "5 dias sem medição não entram na conta".

- **Frase:** "A horta usou 2,5 L. Um timer fixo teria usado 45 L." (em 7/30 dias: "Nos últimos 7 dias (4 com medição), a horta usou…").
- **Horta** (litros e regas) · **Timer fixo** (2 regas por dia × 5 min × 1,5 L/min) · **Economia** (litros e "% menos"; se a horta usou mais, "X L a mais que o timer", com fundo de alerta).
- **Equivalências:** garrafões de 20 L e banhos de 5 min (45 L). Abaixo de 1: "meio garrafão", "1/4 de garrafão", "meio banho"; abaixo de 1/4 de garrafão, só os litros.
- **Timer só com medição:** o timer fixo e a horta só contam a partir do início da medição (`/horta/config/inicioMedicao`, ou a primeira rega). Dias sem medição não entram na conta: no gráfico aparecem hachurados com "sem medição" (sem barra de timer) e na tabela com "—". O dia em que a medição começou conta pelas horas medidas.
- **Gráfico "Água por dia":** barras Horta (verde) e Timer fixo (cinza; o de hoje mais claro, porque o dia ainda está em andamento) e a cota pela ET₀ como um traço azul tracejado sobre cada dia.
- **Hoje** (sempre o dia atual): "17,9 L usados · cota 1,5 L · limite com margem 2,2 L", com o usado em verde (até a cota), amarelo (até o limite) ou vermelho (acima), uma barra na mesma escala e o aviso "Passou N vezes do limite e o solo continua seco: confira o sensor e o canteiro".
- **Recolhidos:** Como calculamos (a conta da cota do dia, o Kc, a vazão, o timer e a regra dos dias sem medição), Tabela por dia e Últimas regas.
- O cartão **Água economizada** da aba Agora mostra o mesmo número de "Desde o início".
- **Zerar contagem** (aba Demonstração) começa a medição de agora (grava `/horta/config/inicioMedicao`).

As constantes do timer e das comparações ficam no topo do `web/agua.js`.

### Como medir a vazão de verdade
1. Coloque a mangueira da bomba dentro de uma garrafa ou balde com marcação de litros.
2. Ligue a bomba por **1 minuto** exato (pelo modo Manual do painel, com um cronômetro).
3. Veja quantos litros caíram: esse é o valor em L/min.
4. Troque `VAZAO_L_MIN` no `esp32-horta.ino` **e** no `web/agua.js` pelo valor medido. Grave o ESP32 e faça `git push`.

Repita 2 ou 3 vezes e use a média. Quando o sensor de fluxo YF-S201 chegar, ele vai medir o valor real.

## Planeje sua horta
Página `planejar.html` (link na navegação). A pessoa desenha o terreno, marca o que faz sombra (com a altura) e escolhe as plantas.

**Como a página é montada:** o **mapa fica sempre à vista**. No computador (900 px ou mais) ele fica preso à esquerda (~58%) e as etapas à direita (~42%), rolando sozinhas. No celular o mapa fica preso no topo (~40% da tela), com as abas logo abaixo; o botão **Recolher mapa** dá espaço para o teclado. Na barra do mapa ficam as chaves **Mapa | Desenho** e **Hoje | Verão | Inverno | Equinócio | Ano** (o 📅 escolhe outro dia); embaixo, o status e a legenda.

As etapas são abas, e cada uma tem endereço próprio:

| Aba | Endereço | O que tem |
|---|---|---|
| **1 Terreno** | `planejar.html#terreno` | Mapa: busca, minha localização, nomes de ruas, desenhar terreno. Desenho: largura, comprimento, norte, latitude e longitude. Carregar exemplo e Começar do zero |
| **2 Sombras** | `planejar.html#sombras` | Casa ou muro e Árvore (os mesmos botões nos dois modos), a lista e o editor dos obstáculos |
| **3 Plantas** | `planejar.html#plantas` | "Onde plantar" (uma linha por planta: número, cor, horas, lugar e selo), sugerir de novo, filtro e a escolha das plantas |
| **4 Salvar** | `planejar.html#salvar` | nome, Salvar na nuvem, Abrir pelo código, Salvar planta ▾ (PNG, imprimir, copiar link, backup), Minhas hortas |

A página abre em **Plantas** quando já há terreno (senão, em Terreno). O link antigo com o desenho (`#p=…`) e o da horta na nuvem (`?h=CODIGO`) continuam funcionando.

**No mapa:** cada canteiro tem a **cor da planta** (a mesma da lista, da planta PNG e da folha impressa) e um selo no canto: ✓ recomendado, ! aceitável (também com a borda tracejada), ✕ não recomendado. O rótulo é o nome; sem espaço (canteiro pequeno, mapa estreito ou outro rótulo no lugar), vira o número da planta na lista. Os nomes dos obstáculos desviam dos das plantas (saem da forma, com uma linha). Tocar numa linha da lista destaca o canteiro, e vice-versa.

**Escolha das plantas:** agrupadas por sol (Pleno sol, 4 h ou mais, Meia-sombra). A área (aceita "0,5" e "0.5") e a umidade ideal aparecem quando a planta é marcada. Na lista, o motivo de um "Aceitável" fica claro: "~5 h em média, mas parte do canteiro passa de 6 h" ou "falta ~1,5 h".

A tabela **Umidade e sol por cultura** fica na página Sobre.

O botão **Carregar exemplo** monta um terreno de 6 × 4 m com um muro de 2 m no lado norte e uma árvore no canto leste. O desenho fica salvo no navegador.

Como o mapa de sol é calculado (`web/sol.js`):
1. O terreno é dividido em quadradinhos de 0,25 m.
2. Do nascer ao pôr do sol, a cada 30 minutos, a biblioteca SunCalc diz a direção e a altura do sol no céu.
3. De cada quadradinho, "olhamos" na direção do sol: se um obstáculo está no caminho e é mais alto que `distância × tan(altura do sol)`, o ponto está na sombra.
4. Cada meia hora sem sombra vale 0,5 h de sol. Menos de 3 h = sombra; 3 a 6 h = meia-sombra; 6 h ou mais = pleno sol.

Dá para ver o mapa de um dia (Hoje, Verão, Inverno, Equinócio) ou do **Ano todo (pior caso)**: o menor valor de cada ponto entre os 12 meses. Em **O que você quer plantar?**, a pessoa marca as plantas e a área de cada uma. As que precisam de mais sol escolhem primeiro; cada uma ganha uma região junta, com as horas de sol que ela precisa, e uma explicação em texto.

**Roteiro para a feira:** Carregar exemplo → mostrar a sombra do muro no mapa → trocar para **Inverno** e mostrar a sombra maior (o sol fica mais baixo, ao norte) → aba **3 Plantas**: marcar tomate e alface → mostrar onde cada um ficou (o mapa muda na hora, sem rolar a página) e ler o motivo na lista.

### Modo "Sobre o mapa"
A página abre no modo **Mapa** ("Sobre o mapa"): a imagem de satélite do lugar, para desenhar o terreno por cima. O modo **Desenho** (desenho livre, no canvas) continua existindo, para quem não quer usar o mapa ou está sem internet boa. O zoom vai até 23 (as imagens são até o 19; depois esticam), para uma horta pequena aparecer grande; o exemplo já enquadra o terreno.

- **Encontrar o lugar:** busque o endereço (ex.: "CED São Bartolomeu, São Sebastião, DF") ou toque em **Usar minha localização**. A busca só acontece quando a pessoa toca em **Buscar**.
- **Desenhar:** **Desenhar terreno** (arraste no mapa), **Casa ou muro** e **Árvore**. Toque numa forma para selecionar: os quadradinhos mudam o tamanho, a bolinha ↻ gira e arrastar o meio move. Ao criar, escolha o tipo sugerido (casa térrea 3 m, sobrado 6 m, muro 2 m, árvore média 5 m) e ajuste o nome e a altura no painel. A imagem mostra onde as coisas estão; **a altura você informa**.
- No mapa o **norte é sempre para cima** (rosa dos ventos fixa). O cálculo usa a latitude e a longitude do centro do terreno.
- **Como o cálculo usa o desenho:** tudo vira metros num plano em volta do terreno (1° de latitude ≈ 111 320 m; 1° de longitude ≈ 111 320 × cos(latitude) m). A grade de quadradinhos segue os lados do terreno, mesmo girado, e o `sol.js` faz a mesma conta do Desenho livre.
- O mapa de calor fica por cima da imagem, só dentro do terreno, com a transparência ajustável (30% a 90%).
- **Salvar e compartilhar:** o desenho fica salvo no navegador. **Copiar link** (no menu Salvar planta) põe o desenho inteiro no endereço (`#p=...`): quem abrir o link vê a mesma horta, com as mesmas plantas marcadas.

**Bibliotecas e atribuições (obrigatórias):**
- Mapa: [Leaflet](https://leafletjs.com) 1.9.4, carregado pelo cdnjs.
- Imagens de satélite e nomes de ruas: **Esri World Imagery** e **Esri World Boundaries and Places**, gratuitas e sem chave. Atribuição que aparece no mapa: "Imagens © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community".
- Busca de endereços: **Nominatim**, do **OpenStreetMap** (© colaboradores do OpenStreetMap). Pela regra de uso, no máximo uma busca por clique, sem busca automática enquanto digita.
- Não usamos Google Maps (exige chave e cartão).

**Roteiro para a feira (modo mapa):** buscar "CED São Bartolomeu, São Sebastião, DF" (ou usar minha localização) → desenhar o terreno sobre a imagem → marcar a casa (3 m) e uma árvore (5 m) → ver o mapa de calor → marcar tomate e alface → ver as sugestões → **Copiar link** e abrir numa aba anônima.

### Hortas na nuvem sem login
Em **Salvar e compartilhar**, o botão **Salvar na nuvem** guarda a horta no Firebase **sem criar conta**. Não pedimos nem guardamos dados pessoais: só o nome da horta e o desenho (por isso o aviso para não pôr nome completo ou telefone no nome).

- **Código:** na primeira vez a horta ganha um código de 8 letras e números, como `HX7K-2Q9M` (sem 0/O e 1/I/L, que confundem). Aparece um quadro com o código, o link (`planejar.html?h=HX7K2Q9M`) e o QR code. Em outro aparelho, abra pelo link ou digite o código em **Abrir pelo código** (aba 4 Salvar) (com ou sem hífen, maiúsculas ou minúsculas).
- **Salvamento automático:** depois de salvar uma vez, cada mudança vai para a nuvem 3 s depois que a pessoa para de mexer. Sem internet, fica salvo no aparelho e é enviado quando a conexão volta.
- **Edição ao mesmo tempo:** se outra aba ou aparelho salvar a mesma horta, aparece o aviso para **Recarregar** a versão nova ou **Continuar com a minha** (que salva por cima).
- **Histórico:** as 10 últimas versões (uma a cada **Salvar na nuvem** e uma a cada 5 minutos de edição). **Restaurar esta versão** guarda antes a atual, para poder desfazer.
- **Fazer uma cópia:** cria outra horta, com código novo, a partir da aberta. Serve para o aluno partir da horta do colega sem mexer na dele.
- **Arquivar:** a horta arquivada abre com a faixa "Horta arquivada" e só dá para mudar depois de **Desarquivar**. **Não existe apagar.**
- **Minhas hortas:** a lista guarda, só neste aparelho, os códigos das hortas criadas ou abertas aqui. **Tirar da lista** só esquece o código; a horta continua na nuvem. Projetos antigos (salvos só no navegador) têm o botão **Enviar para a nuvem**.
- **Abrir pelo código:** botão ao lado de **Salvar na nuvem**, que mostra o campo do código.
- **Backup (.json):** no menu **Salvar planta ▾**, **Baixar backup** guarda uma cópia da horta no computador e **Abrir backup** volta a ela (sem internet, ou fora da nuvem). Com uma horta da nuvem aberta, a página pergunta se o backup abre como **horta nova** (sem código, até salvar na nuvem) ou se **substitui a atual** (a atual vai para o histórico).
- **Copiar link** (o desenho inteiro no endereço) continua existindo e não usa a nuvem.

**Limite importante:** quem tem o código pode ver **e alterar** a horta. Não dá para listar as hortas de ninguém: as regras (`firebase/database.rules.json`, parte `hortasPlanejadas`) só deixam abrir quem sabe o código, recusam apagar e conferem cada campo (nome até 60 caracteres, desenho até 300 000, datas que não estão no futuro). Se alguém bagunçar a horta, use o **Histórico** para voltar.
