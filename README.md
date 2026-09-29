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
- `/horta/decisoes` é o histórico das decisões: cada item tem `decisao`, `motivo`, `umidade`, `chanceChuva` (opcional) e `ts`. Códigos aceitos: `regando`, `solo_ok`, `adiada_chuva`, `solo_critico`, `sem_previsao`, `pausa_seguranca`, `manual_ligada`, `manual_desligada`.
- Só usuários logados podem escrever em `/horta/comandos` (o site ainda não tem login, então por enquanto os comandos são alterados pelo console — veja a dica no final).
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
| | IN | GPIO 26 |

⚠️ **A bomba usa uma fonte separada**, ligada pelos contatos do relé (COM e NA). Nunca alimente a bomba pelo ESP32.

### Montagem de teste com LED e potenciômetro
Para testar tudo na mesa, sem bomba e sem sensor de verdade:

| No lugar de | Use | Ligação |
|---|---|---|
| Módulo relé | LED + resistor de 220 a 330 Ω | GPIO 26 → resistor → perna comprida do LED; perna curta → GND |
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
4. **Solo abaixo de 35%:** olha a previsão do tempo antes de gastar água.
   - Chance de chuva nas próximas 6 h **≥ 60%** e solo **≥ 20%** → **não rega**, deixa a chuva regar. → `adiada_chuva`
   - Chance alta, mas solo **abaixo de 20%** → rega mesmo assim, a planta não pode esperar. → `solo_critico`
   - **Sem previsão** (nunca consultou, a consulta falhou ou a previsão tem mais de 90 min) → rega só pelo sensor, que é o comportamento seguro. → `sem_previsao`
   - Chance baixa → rega. → `regando`
5. **Solo úmido:** não faz nada. → `solo_ok`

Cada decisão tem um **código** e um **motivo** em português (ex.: "Não reguei: 80% de chance de chuva nas próximas 6 h."). O motivo vai junto com o estado para o Firebase e aparece no painel, no cartão **"Por que regou (ou não)"**. Quando o código muda, o ESP32 escreve `[Decisão] <código> — <motivo>` no Serial Monitor e guarda a mudança no histórico `/horta/decisoes` (se estiver sem Wi-Fi, envia a última mudança quando a conexão voltar).

Os limites ficam no bloco **REGRAS DA REGA** do `esp32-horta.ino`: `LIMITE_LIGAR`, `LIMITE_DESLIGAR`, `LIMITE_CHUVA`, `LIMITE_CRITICO` e `VALIDADE_CLIMA`.

A consulta ao clima nunca acontece com a bomba ligada: ela pode travar o programa por até 10 s e atrasaria a segurança do tempo máximo. Sem Wi-Fi ou sem Firebase, a rega continua funcionando; quando a previsão vence, a decisão passa a ser `sem_previsao`.

### Testar a decisão da chuva em casa (`SIMULAR_CHANCE_CHUVA`)
Em setembro e outubro quase não chove no DF, então dá para **fingir** a previsão:

1. No bloco **REGRAS DA REGA**, troque `SIMULAR_CHANCE_CHUVA = -1` por, por exemplo, `SIMULAR_CHANCE_CHUVA = 80` e grave o ESP32. No começo do Serial Monitor aparece `[Teste] SIMULAR_CHANCE_CHUVA ativo`.
2. Deixe o solo entre 20% e 35%: aparece `[Decisão] adiada_chuva — Não reguei: 80% de chance de chuva nas próximas 6 h. (simulado)` e o painel mostra o mesmo motivo.
3. Abaixo de 20% a horta rega mesmo assim (`solo_critico`).

⚠️ **Antes da feira**, volte para `SIMULAR_CHANCE_CHUVA = -1` e grave o ESP32 de novo. Se o Serial Monitor ainda mostrar `[Teste] SIMULAR_CHANCE_CHUVA ativo` ou o painel mostrar "(simulado)", a simulação continua ligada.
## Dica: testar o modo manual
Pelo console do Firebase (Realtime Database → Dados), crie:

```
horta/comandos/modo: "manual"
horta/comandos/bombaManual: true
```

Em até 30 s o ESP32 obedece. Para voltar ao normal, mude `modo` para `"auto"`.

## Controle pelo site
No cartão **"Bomba d'água"** do painel tem dois botões: **Automático** | **Manual**. Não precisa de login.

- **Automático:** o ESP32 decide sozinho (veja "Como a rega funciona").
- **Manual:** aparece o botão **Ligar bomba** / **Desligar bomba**.
- O ESP32 lê os comandos a cada **3 s**. Depois de um clique, o LED/bomba responde e o painel mostra o estado real em poucos segundos. O círculo da bomba sempre mostra o que o ESP32 **fez**, não o que foi pedido; enquanto não bate, aparece "Pedido enviado… aguardando o ESP32". Se passar 15 s sem resposta, o painel avisa.
- **Limites de segurança** (valem também no manual, porque o site é aberto):
  - cada acionamento dura no máximo **60 s**; depois a bomba descansa **5 min** (o painel mostra o motivo);
  - o modo manual dura no máximo **10 min**: depois o ESP32 grava `modo: "auto"` sozinho e volta para o automático (o painel mostra a contagem regressiva);
  - se o ESP32 não conseguir ler o Firebase 3 vezes seguidas (ou ficar sem Wi-Fi), ele volta para o automático.
- Com o ESP32 offline, os botões ficam desativados.
