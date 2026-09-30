// Hortas na nuvem SEM LOGIN (Planeje sua horta)
//
// Cada horta salva ganha um CÓDIGO de 8 letras/números (ex.: HX7K-2Q9M).
// Quem tem o código pode abrir e alterar a horta. Ninguém consegue listar
// todas as hortas (as regras do banco não deixam), e nenhum dado pessoal é
// guardado: só o nome da horta e o desenho.
//
// No banco (Firebase Realtime Database):
//   /hortasPlanejadas/{codigo} = {
//     nome, dados (o projeto em texto JSON), criadoEm, atualizadoEm,
//     editor (identificador aleatório DA ABA, para perceber edição em dois lugares),
//     arquivada,
//     versoes: { "0".."9": { nome, dados, em } }   (as 10 últimas cópias, em rodízio)
//   }
//
// O Firebase só é carregado quando precisa (import dinâmico): sem internet,
// o resto da página continua funcionando.
import { firebaseConfig } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/12.19.0";
const CAMINHO = "hortasPlanejadas";
const MAX_VERSOES = 10;

// ---------- Código ----------
// Sem 0/O e 1/I/L, para ninguém confundir ao copiar do quadro
export const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const TAMANHO_CODIGO = 8;
const FORMATO = /^[A-HJKMNP-Z2-9]{8}$/;  // o mesmo das regras do banco

// Sorteia um código com crypto.getRandomValues (sorteio bom, não Math.random)
export function gerarCodigo() {
  const sorteio = new Uint32Array(TAMANHO_CODIGO);
  crypto.getRandomValues(sorteio);
  return Array.from(sorteio, (n) => ALFABETO[n % ALFABETO.length]).join("");
}

// "HX7K2Q9M" -> "HX7K-2Q9M" (mais fácil de ler e de ditar)
export const formatarCodigo = (codigo) => `${codigo.slice(0, 4)}-${codigo.slice(4)}`;

// O que a pessoa digitou -> código (ou null se não for um código válido).
// Aceita minúsculas, espaços e hífen: " hx7k-2q9m " vira "HX7K2Q9M".
export function normalizarCodigo(texto) {
  const codigo = String(texto || "").toUpperCase().replace(/[\s-]/g, "");
  return FORMATO.test(codigo) ? codigo : null;
}

// Identificador desta ABA (não é da pessoa): muda a cada vez que a página abre
export const EDITOR = gerarCodigo() + gerarCodigo();

// ---------- Conexão com o Firebase (carregado só quando precisa) ----------
let carregando = null;
function banco() {
  if (!carregando) {
    carregando = Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-database.js`)])
      .then(([app, database]) => ({ ...database, db: database.getDatabase(app.initializeApp(firebaseConfig)) }))
      .catch((erro) => {
        carregando = null;  // tenta de novo na próxima vez (a internet pode voltar)
        throw erro;
      });
  }
  return carregando;
}
const caminho = (codigo, resto = "") => `${CAMINHO}/${codigo}${resto ? `/${resto}` : ""}`;

// Avisa quando a conexão com o banco cai ou volta: aoMudar(true | false)
export async function ouvirConexao(aoMudar) {
  try {
    const f = await banco();
    f.onValue(f.ref(f.db, ".info/connected"), (s) => aoMudar(s.val() === true));
  } catch {
    aoMudar(false);  // nem conseguiu carregar o Firebase: sem internet
  }
}

// ---------- Criar, ler e salvar ----------
// Cria uma horta nova e devolve o código. A transação só grava se o lugar
// estiver vazio; se o código já existir (muito improvável), sorteia outro.
export async function criarHorta({ nome, dados }) {
  const f = await banco();
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const codigo = gerarCodigo();
    const agora = f.serverTimestamp();
    const nova = { nome, dados, criadoEm: agora, atualizadoEm: agora, editor: EDITOR, arquivada: false };
    const resultado = await f.runTransaction(f.ref(f.db, caminho(codigo)), (atual) => (atual === null ? nova : undefined));
    if (resultado.committed) return codigo;
  }
  throw new Error("Não consegui criar um código novo.");
}

// A horta inteira (ou null se o código não existe)
export async function lerHorta(codigo) {
  const f = await banco();
  const s = await f.get(f.ref(f.db, caminho(codigo)));
  return s.exists() ? s.val() : null;
}

// Salva o nome e os dados (e marca quem salvou e quando)
export async function salvarHorta(codigo, { nome, dados }) {
  const f = await banco();
  await f.update(f.ref(f.db, caminho(codigo)), { nome, dados, atualizadoEm: f.serverTimestamp(), editor: EDITOR });
}

export async function marcarArquivada(codigo, arquivada) {
  const f = await banco();
  await f.update(f.ref(f.db, caminho(codigo)), { arquivada, atualizadoEm: f.serverTimestamp(), editor: EDITOR });
}

// ---------- Versões (as 10 últimas, em rodízio) ----------
// Lista das versões, da mais nova para a mais velha: [{ slot, nome, dados, em }]
export async function lerVersoes(codigo) {
  const f = await banco();
  const s = await f.get(f.ref(f.db, caminho(codigo, "versoes")));
  const versoes = s.val() || {};
  return Object.entries(versoes)
    .map(([slot, v]) => ({ slot, ...v }))
    .filter((v) => typeof v.dados === "string")
    .sort((a, b) => (b.em || 0) - (a.em || 0));
}

// Grava uma cópia numa das 10 gavetas: a primeira vazia ou a mais velha
export async function salvarVersao(codigo, { nome, dados }) {
  const f = await banco();
  const versoes = await lerVersoes(codigo);
  const usadas = new Set(versoes.map((v) => v.slot));
  let slot = null;
  for (let n = 0; n < MAX_VERSOES && slot === null; n++) if (!usadas.has(String(n))) slot = String(n);
  if (slot === null) slot = versoes[versoes.length - 1].slot;  // todas cheias: troca a mais velha
  await f.set(f.ref(f.db, caminho(codigo, `versoes/${slot}`)), { nome, dados, em: f.serverTimestamp() });
}

// ---------- Ouvir mudanças (outra aba ou outro aparelho) ----------
// aoMudar({ atualizadoEm, editor, arquivada }) sempre que um deles mudar.
// Ouve só esses campos pequenos (não baixa os dados a cada mudança).
// Devolve uma função que para de ouvir.
export async function ouvirHorta(codigo, aoMudar) {
  const f = await banco();
  const atual = { atualizadoEm: null, editor: null, arquivada: false };
  let aviso = null;
  // Os três campos chegam separados: espera um instante para juntar
  const avisar = () => {
    clearTimeout(aviso);
    aviso = setTimeout(() => aoMudar({ ...atual }), 250);
  };
  const cancelar = ["atualizadoEm", "editor", "arquivada"].map((campo) =>
    f.onValue(f.ref(f.db, caminho(codigo, campo)), (s) => {
      atual[campo] = campo === "arquivada" ? s.val() === true : s.val();
      avisar();
    })
  );
  return () => {
    clearTimeout(aviso);
    cancelar.forEach((parar) => parar());
  };
}
