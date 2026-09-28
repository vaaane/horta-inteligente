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
| `firebase/` | As regras de segurança do banco de dados |

---

## Passo a passo

### 1. Criar o projeto no Firebase
1. Entre em <https://console.firebase.google.com> e crie um projeto.
2. **Realtime Database** → *Criar banco de dados* (pode começar no modo bloqueado).
3. **Authentication** → *Vamos começar* → ative o método **E-mail/senha**.

### 2. Criar o usuário do ESP32 e publicar as regras
1. **Authentication → Usuários → Adicionar usuário**: crie um e-mail e senha só para o ESP32 (ex.: `esp32@horta.com`).
2. Copie o **UID do usuário** que aparece na lista.
3. Abra `firebase/database.rules.json` e troque as **duas** ocorrências de `UID_DO_ESP32` pelo UID copiado.
4. **Realtime Database → Regras**: apague o que estiver lá, cole o conteúdo do arquivo e clique em **Publicar**.

Resumo das regras:
- Qualquer pessoa pode **ler** `/horta` (o site é público).
- Só o ESP32 pode **escrever** em `/horta/estado` e `/horta/leituras`.
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

---

## Como a rega funciona
- Abaixo de **35%** de umidade → liga a bomba.
- Acima de **60%** → desliga.
- **Segurança:** a bomba fica no máximo 60 s ligada; depois descansa 5 min.
- Sem Wi-Fi ou sem Firebase, a rega continua funcionando só pelo sensor.

## Dica: testar o modo manual
Pelo console do Firebase (Realtime Database → Dados), crie:

```
horta/comandos/modo: "manual"
horta/comandos/bombaManual: true
```

Em até 30 s o ESP32 obedece. Para voltar ao normal, mude `modo` para `"auto"`.
